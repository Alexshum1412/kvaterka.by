/**
 * Avatar upload.
 *
 * Mirrors `POST /api/uploads` (listing photos) closely on purpose — the two
 * endpoints receive the same kind of untrusted bytes and must refuse the same
 * kinds of bad input the same way — but differs in the three places a profile
 * picture actually differs from a listing photo:
 *
 *   1. There is no listing to own. The row updated is the caller's own
 *      `app_user`, identified from the session rather than a request field,
 *      so nobody can point this endpoint at somebody else's account.
 *   2. A profile picture is small. The cap here is well under the listing
 *      cap — nobody's face needs 10 MB — so a person cannot use "it's just
 *      an avatar" as a way to push an oversized file through a lighter-
 *      reviewed path.
 *   3. Uploading a new one replaces the old one. A landlord's listing photos
 *      accumulate; a person has exactly one current avatar, so the previous
 *      file is deleted once the new key is recorded — best-effort, because a
 *      stray orphaned file is a disk-space problem and a failed request over
 *      a photo that just successfully replaced it is a much worse one.
 *
 * Same three rules as the listing route: the storage key is server-generated
 * (never client-supplied), the content type is decided by sniffing the first
 * bytes rather than trusting the declared one, and EXIF/metadata is stripped
 * before anything touches disk — a phone selfie carries GPS same as a phone
 * photo of a flat does.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentUser } from '@/server/session.ts';
import { ready } from '@/server/runtime.ts';
import { exceedsPixelBudget, stripMetadata } from '@/server/domain/image.ts';
import { DEV_MEDIA_ROOT } from '@/app/api/uploads/route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Well under the listing cap (10 MB) — a profile photo is one face, not a gallery. */
const MAX_BYTES = 3 * 1024 * 1024;

/** Multipart framing around the file itself: boundaries, headers, field names. */
const FORM_OVERHEAD = 64 * 1024;

interface Sniffed {
  readonly ext: 'jpg' | 'png' | 'webp';
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
}

/** Identify by content, not by claim. Returns null for anything unknown.
 *  Duplicated from `uploads/route.ts` rather than imported: that module
 *  keeps it private, and the two sniffers must never drift by sharing a
 *  mutable dependency neither route asked for. */
function sniff(buf: Buffer): Sniffed | null {
  if (buf.length > 24 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg', ...jpegSize(buf) };
  }
  if (
    buf.length > 24 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { ext: 'png', mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (
    buf.length > 16 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp', width: null, height: null };
  }
  return null;
}

/** Walk JPEG segments to the first start-of-frame, which carries the size. */
function jpegSize(buf: Buffer): { width: number | null; height: number | null } {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length <= 0) break;
    offset += 2 + length;
  }
  return { width: null, height: null };
}

function fail(status: number, message: string): Response {
  return Response.json({ error: { code: 'UPLOAD_FAILED', message } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return fail(401, 'Войдите, чтобы загрузить фото профиля');

  // Same reasoning as the listing route: refuse an oversized body before
  // `formData()` materialises the whole thing in memory.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES + FORM_OVERHEAD) {
    return fail(413, 'Файл больше 3 МБ — уменьшите его и попробуйте снова');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, 'Не удалось прочитать файл');
  }

  const file = form.get('file');
  if (!(file instanceof File)) return fail(400, 'Файл не выбран');
  if (file.size === 0) return fail(400, 'Файл пустой');
  if (file.size > MAX_BYTES) return fail(413, 'Файл больше 3 МБ — уменьшите его и попробуйте снова');

  const original = Buffer.from(await file.arrayBuffer());
  const kind = sniff(original);
  if (!kind) return fail(415, 'Поддерживаются только JPEG, PNG и WebP');

  if (exceedsPixelBudget(kind.width, kind.height)) {
    return fail(413, 'Изображение слишком большое по размерам — уменьшите его и попробуйте снова');
  }

  // Strip EXIF/XMP/IPTC before the bytes ever touch disk — a selfie taken
  // with location services on carries exact coordinates same as a listing
  // photo does.
  const bytes = stripMetadata(original, kind.ext);

  // Storage is not configured for production yet — see uploads/route.ts for
  // the full reasoning. Saying so is the whole point: a person must never be
  // told their photo was saved when it was not.
  if (process.env.MEDIA_BUCKET_URL) {
    return fail(501, 'Загрузка в объектное хранилище ещё не подключена. Обратитесь в поддержку.');
  }

  const storageKey = `avatars/${user.userId}/${randomUUID()}.${kind.ext}`;
  const absolute = path.join(DEV_MEDIA_ROOT, storageKey);

  try {
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  } catch {
    return fail(500, 'Не удалось сохранить файл');
  }

  const db = await ready();

  // The row this replaces, read BEFORE the update so the old file can be
  // cleaned up afterwards — a plain PATCH-style column update, the same
  // pattern `PATCH /me/profile` already uses directly against `ctx.db`
  // rather than through a dedicated service for a single-column change.
  const { rows: existing } = await db.query<{ avatar_storage_key: string | null }>(
    `SELECT avatar_storage_key FROM app_user WHERE id=$1`,
    [user.userId],
  );
  const previousKey = existing[0]?.avatar_storage_key ?? null;

  await db.query(`UPDATE app_user SET avatar_storage_key=$1 WHERE id=$2`, [storageKey, user.userId]);

  if (previousKey) {
    try {
      await unlink(path.join(DEV_MEDIA_ROOT, previousKey));
    } catch {
      // Best-effort: the old file being already gone must never fail a
      // request that just successfully replaced it.
    }
  }

  return Response.json(
    {
      storageKey,
      url: `/media/${storageKey}`,
      width: kind.width,
      height: kind.height,
      byteSize: bytes.byteLength,
      contentType: kind.mime,
    },
    { status: 200 },
  );
}
