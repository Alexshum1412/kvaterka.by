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
import { bucketForUser, checkRateLimit } from '@/server/api/rate-limit.ts';
import { exceedsPixelBudget, sniffImage, stripMetadata } from '@/server/domain/image.ts';
import { DEV_MEDIA_ROOT } from '@/app/api/uploads/route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Well under the listing cap (10 MB) — a profile photo is one face, not a gallery. */
const MAX_BYTES = 3 * 1024 * 1024;

/* ponytail: a flat per-account ceiling, like the listing route's. A person has one
   avatar, so ten replacements an hour is generous and bounds one account at
   ~30 MB/hour of written bytes. */
const AVATARS_PER_HOUR = 10;

/** Multipart framing around the file itself: boundaries, headers, field names. */
const FORM_OVERHEAD = 64 * 1024;

function fail(status: number, message: string): Response {
  return Response.json({ error: { code: 'UPLOAD_FAILED', message } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return fail(401, 'Войдите, чтобы загрузить фото профиля');

  // Outside the route table, so its limiter never saw this handler. Counted per
  // account before the body is read, same bucket convention as the listing route.
  const db = await ready();
  const limit = await checkRateLimit(db, bucketForUser('upload:avatar', user.userId), AVATARS_PER_HOUR, 3600);
  if (!limit.allowed) return fail(429, 'Слишком много загрузок подряд. Попробуйте через час.');

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
  const kind = sniffImage(original);
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
  const discard = () => unlink(absolute).catch(() => {});

  try {
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  } catch {
    return fail(500, 'Не удалось сохранить файл');
  }

  /* Swap the new key in only if the row still holds the key just read. Reading
     the previous key and then updating unconditionally let parallel uploads all
     read the same predecessor: one file was unlinked and the rest stayed on disk
     with nothing referencing them. With the read in the WHERE clause, a request
     that lost the race matches no row and reads again, so every key that is ever
     replaced is replaced by exactly one request, which is the one that unlinks
     it. Each lost round means another upload succeeded, so the loop ends; the
     limit above bounds how many can be in flight. */
  let previousKey: string | null | undefined;
  try {
    for (let attempt = 0; attempt < AVATARS_PER_HOUR && previousKey === undefined; attempt += 1) {
      const { rows: current } = await db.query<{ avatar_storage_key: string | null }>(
        `SELECT avatar_storage_key FROM app_user WHERE id=$1 AND deleted_at IS NULL`,
        [user.userId],
      );
      if (!current[0]) break;
      const { rows: swapped } = await db.query(
        `UPDATE app_user SET avatar_storage_key=$1
          WHERE id=$2 AND deleted_at IS NULL AND avatar_storage_key IS NOT DISTINCT FROM $3::text
        RETURNING id`,
        [storageKey, user.userId, current[0].avatar_storage_key],
      );
      if (swapped.length === 1) previousKey = current[0].avatar_storage_key;
    }
  } catch {
    // Nothing references the file unless the row was written.
    await discard();
    return fail(500, 'Не удалось сохранить файл');
  }

  if (previousKey === undefined) {
    // The account was closed between the session check and the write, or
    // every attempt lost to a newer upload: either way this file is unreferenced.
    await discard();
    return fail(409, 'Фото профиля не сохранено. Обновите страницу и попробуйте снова.');
  }

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
