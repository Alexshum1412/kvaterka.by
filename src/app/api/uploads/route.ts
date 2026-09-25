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
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { currentUser } from '@/server/session.ts';
import { ready, readyServices } from '@/server/runtime.ts';
import { bucketForUser, checkRateLimit } from '@/server/api/rate-limit.ts';
import { DomainError } from '@/server/services/errors.ts';
import { exceedsPixelBudget, sniffImage, stripMetadata } from '@/server/domain/image.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 10 * 1024 * 1024;

/* ponytail: a flat per-account ceiling, not a disk quota. 60 photos an hour is
   two full listings' worth (the per-listing cap is 30) and bounds one account
   at ~600 MB/hour of stored bytes; a real quota, or object storage with its own
   limits, replaces it if a landlord legitimately needs more. */
const UPLOADS_PER_HOUR = 60;

/** Multipart framing around the file itself: boundaries, headers, field names. */
const FORM_OVERHEAD = 64 * 1024;

/** Where development bytes live. Never inside `public/` — these are served
 *  through the media route so the same access rules apply in both modes. */
export const DEV_MEDIA_ROOT = process.env.DEV_MEDIA_DIR ?? path.join(process.cwd(), '.media');

function fail(status: number, message: string): Response {
  return Response.json({ error: { code: 'UPLOAD_FAILED', message } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return fail(401, 'Войдите, чтобы загрузить фотографии');

  /* This handler sits outside the route table, so the table's rate limiter
     never saw it: one account could write 10 MB per request for as long as it
     liked. Counted per account before the body is even read. */
  const limit = await checkRateLimit(await ready(), bucketForUser('upload:photo', user.userId), UPLOADS_PER_HOUR, 3600);
  if (!limit.allowed) return fail(429, 'Слишком много загрузок подряд. Попробуйте через час.');

  /* Refuse an oversized body BEFORE parsing it.
   *
   * `formData()` materialises the whole upload in memory, so a size check
   * after it has already run is a check that happens too late: an authenticated
   * client could hand the process a body of any size and the cap below would
   * only observe the damage. Content-Length can be absent or a lie, which is
   * why the real check further down stays — this one exists to make the honest
   * case cheap and the dishonest case bounded. */
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES + FORM_OVERHEAD) {
    return fail(413, 'Файл больше 10 МБ — уменьшите его и попробуйте снова');
  }

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

  const original = Buffer.from(await file.arrayBuffer());
  const kind = sniffImage(original);
  if (!kind) return fail(415, 'Поддерживаются только JPEG, PNG и WebP');

  /* A decompression bomb is small on disk and enormous once decoded — a
     30000x30000 PNG is 25 KB compressed and 3.6 GB in memory. Nothing here
     decodes it, but the browsers of everyone who opens the listing would.
     Refusing by dimension is the cheap defence available without an image
     library, and the dimensions were already parsed above. */
  if (exceedsPixelBudget(kind.width, kind.height)) {
    return fail(413, 'Изображение слишком большое по размерам — уменьшите его и попробуйте снова');
  }

  /* Strip EXIF, XMP and IPTC before the bytes are ever stored.
     A phone photograph carries the flat's exact coordinates, and this product
     deliberately withholds the exact position until a booking is confirmed —
     publishing the original bytes handed that address to every visitor. */
  const bytes = stripMetadata(original, kind.ext);

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
    /* The bytes were written before addPhoto checked ownership and the
       30-photo cap, so a refusal used to leave the file behind: any signed-in
       account could POST to somebody else's listing id and fill the disk one
       rejected 10 MB upload at a time. Nothing references the file unless the
       row exists, so it goes whenever the row does not. */
    await unlink(absolute).catch(() => {});
    if (error instanceof DomainError) return fail(error.status, error.message);
    return fail(500, 'Не удалось добавить фотографию');
  }
}
