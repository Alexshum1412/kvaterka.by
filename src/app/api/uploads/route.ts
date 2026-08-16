/**
 * Photo upload.
 *
 * The domain already had `addPhoto`, but it takes a storage key and
 * nothing in the system ever produced one — there was no way to get
 * bytes into the product at all. This is that missing half.
 *
 * It sits outside the JSON route table on purpose: that dispatcher
 * validates a JSON body with Zod, and this endpoint receives multipart
 * form data. Everything the table would have given it is done here
 * explicitly — authentication, ownership, size and type limits.
 *
 * Three rules:
 *
 *   1. The storage key is generated on the server. A client-supplied key
 *      is a path-traversal and overwrite primitive, so the client never
 *      gets a say in where its bytes land.
 *   2. The declared content type is not trusted. The first bytes of the
 *      file decide what it is, because `image/png` in a header costs an
 *      attacker nothing.
 *   3. Success is reported only after bytes are on disk AND the row is
 *      written. If object storage is configured but unimplemented, this
 *      returns an error rather than a cheerful lie.
 *
 * Identity documents never come through here. They belong to the
 * separate private bucket behind `document.read`, and runtime.ts refuses
 * to boot if the two buckets are ever configured to the same place.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentUser } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { DomainError } from '@/server/services/errors.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 10 * 1024 * 1024;

/** Where development bytes live. Never inside `public/` — these are served
 *  through the media route so the same access rules apply in both modes. */
export const DEV_MEDIA_ROOT = process.env.DEV_MEDIA_DIR ?? path.join(process.cwd(), '.media');

interface Sniffed {
  readonly ext: 'jpg' | 'png' | 'webp';
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
}

/** Identify by content, not by claim. Returns null for anything unknown. */
function sniff(buf: Buffer): Sniffed | null {
  if (buf.length > 24 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg', ...jpegSize(buf) };
  }
  if (
    buf.length > 24 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    // IHDR is always the first chunk, so the dimensions sit at a fixed offset.
    return { ext: 'png', mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (
    buf.length > 16 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    // WebP has three sub-formats with different headers; the dimensions are
    // not worth three parsers, and the column is nullable.
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
    // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
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
  if (!user) return fail(401, 'Войдите, чтобы загрузить фотографии');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, 'Не удалось прочитать файл');
  }

  const propertyId = form.get('propertyId');
  const file = form.get('file');
  if (typeof propertyId !== 'string' || !/^[0-9a-f-]{36}$/i.test(propertyId)) {
    return fail(400, 'Не указано объявление');
  }
  if (!(file instanceof File)) return fail(400, 'Файл не выбран');
  if (file.size === 0) return fail(400, 'Файл пустой');
  if (file.size > MAX_BYTES) return fail(413, 'Файл больше 10 МБ — уменьшите его и попробуйте снова');

  const bytes = Buffer.from(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) return fail(415, 'Поддерживаются только JPEG, PNG и WebP');

  // Storage is not configured for production yet. Saying so is the whole
  // point — a landlord must never be told a photo was uploaded when it
  // was not.
  if (process.env.MEDIA_BUCKET_URL) {
    return fail(
      501,
      'Загрузка в объектное хранилище ещё не подключена. Обратитесь в поддержку.',
    );
  }

  const storageKey = `listings/${propertyId}/${randomUUID()}.${kind.ext}`;
  const absolute = path.join(DEV_MEDIA_ROOT, storageKey);

  try {
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  } catch {
    return fail(500, 'Не удалось сохранить файл');
  }

  try {
    // addPhoto verifies ownership; a landlord cannot attach bytes to
    // somebody else's listing even though the file is already written.
    const services = await readyServices();
    const photo = await services.listings.addPhoto(propertyId, user.userId, {
      storageKey,
      width: kind.width ?? undefined,
      height: kind.height ?? undefined,
      byteSize: bytes.byteLength,
      contentHash: createHash('sha256').update(bytes).digest(),
    });

    return Response.json(
      {
        id: photo.id,
        storageKey,
        url: `/media/${storageKey}`,
        width: kind.width,
        height: kind.height,
        byteSize: bytes.byteLength,
        contentType: kind.mime,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof DomainError) return fail(error.status, error.message);
    return fail(500, 'Не удалось добавить фотографию');
  }
}
