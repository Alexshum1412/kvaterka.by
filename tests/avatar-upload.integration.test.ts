/**
 * `POST /api/uploads/avatar`.
 *
 * A close sibling of `uploads.integration.test.ts` (listing photos): same
 * kind of untrusted bytes, same sniff-by-content and metadata-stripping
 * pipeline, exercised the same way — called directly with a constructed
 * `Request`, because it is a Next.js route handler rather than a table
 * route reachable through `ApiTestClient`.
 *
 * What is actually different from the listing route, and therefore what
 * this file is FOR: the size cap is smaller, there is no listing to own (the
 * row updated is the caller's own `app_user`), and a second upload replaces
 * the first rather than accumulating.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { uuidv7 } from '@/lib/id.ts';

const session = vi.hoisted(() => ({ current: null as { userId: string; displayName: string } | null }));
const runtime = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/server/session.ts', () => ({
  currentUser: async () => session.current,
  signInUrl: (next: string) => `/login?next=${next}`,
}));

vi.mock('@/server/runtime.ts', () => ({
  ready: async () => runtime.db,
}));

const MEDIA_ROOT = path.join(process.cwd(), '.media-test-avatar');
process.env.DEV_MEDIA_DIR = MEDIA_ROOT;

const { POST } = await import('@/app/api/uploads/avatar/route.ts');

let db: TestDb;
let userId: string;

beforeAll(async () => {
  db = await createTestDb();
  runtime.db = db;
}, 120_000);

afterAll(async () => {
  await db?.close();
  await rm(MEDIA_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.truncateAll();
  delete process.env.MEDIA_BUCKET_URL;

  userId = uuidv7();
  await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,'Тэставы Карыстальнік')`, [
    userId,
    `${userId}@example.by`,
  ]);
  session.current = { userId, displayName: 'Тэставы Карыстальнік' };
});

afterEach(() => {
  session.current = null;
});

/* ------------------------------------------------------------------ */

function jpegOf(width: number, height: number): Buffer {
  const sofPayload = Buffer.alloc(9);
  sofPayload.writeUInt8(8, 0);
  sofPayload.writeUInt16BE(height, 1);
  sofPayload.writeUInt16BE(width, 3);
  const sof = Buffer.alloc(4);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(sofPayload.length + 2, 2);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    sofPayload,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 0, 0, 0x3f, 0]),
    Buffer.from([0x11, 0x22, 0x33]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function jpegWithGps(): Buffer {
  const exif = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from('II*\0GPSLatitude=53.9045 GPSLongitude=27.5615', 'latin1'),
  ]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt8(0xff, 0);
  app1.writeUInt8(0xe1, 1);
  app1.writeUInt16BE(exif.length + 2, 2);

  const sofPayload = Buffer.alloc(9);
  sofPayload.writeUInt8(8, 0);
  sofPayload.writeUInt16BE(400, 1);
  sofPayload.writeUInt16BE(400, 3);
  const sof = Buffer.alloc(4);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(sofPayload.length + 2, 2);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    exif,
    sof,
    sofPayload,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 0, 0, 0x3f, 0]),
    Buffer.from([0x11, 0x22, 0x33]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function pngOf(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from([0x78, 0x9c])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A WebP that is just its container and the extended-format header: 24-bit canvas width-1 and height-1. */
function webpExtended(width: number, height: number): Buffer {
  const header = Buffer.alloc(10);
  header.writeUIntLE(width - 1, 4, 3);
  header.writeUIntLE(height - 1, 7, 3);
  const chunk = Buffer.concat([Buffer.from('VP8X'), Buffer.from([10, 0, 0, 0]), header]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + chunk.length, 4);
  return Buffer.concat([riff, Buffer.from('WEBP'), chunk]);
}

/** Every file this account has on disk, whatever the database says. */
async function filesOnDisk(): Promise<string[]> {
  return readdir(path.join(MEDIA_ROOT, 'avatars', userId)).catch(() => []);
}

const storedKey = async (): Promise<string | null> =>
  (
    await db.query<{ avatar_storage_key: string | null }>(
      `SELECT avatar_storage_key FROM app_user WHERE id=$1`,
      [userId],
    )
  ).rows[0]!.avatar_storage_key;

async function upload(
  bytes: Buffer,
  opts: { filename?: string; type?: string; contentLength?: string } = {},
): Promise<Response> {
  const form = new FormData();
  form.append(
    'file',
    new File([new Uint8Array(bytes)], opts.filename ?? 'avatar.jpg', { type: opts.type ?? 'image/jpeg' }),
  );

  const request = new Request('http://localhost/api/uploads/avatar', { method: 'POST', body: form });
  if (opts.contentLength) {
    const headers = new Headers(request.headers);
    headers.set('content-length', opts.contentLength);
    return POST(new Request('http://localhost/api/uploads/avatar', { method: 'POST', body: form, headers }));
  }
  return POST(request);
}

/* ================================================================== */

describe('what reaches the disk and the database', () => {
  it('accepts a JPEG, stores it under a namespaced key, and records it on app_user', async () => {
    const response = await upload(jpegOf(400, 400));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { storageKey: string; url: string };
    expect(body.storageKey).toMatch(new RegExp(`^avatars/${userId}/[0-9a-f-]{36}\\.jpg$`));
    expect(body.url).toBe(`/media/${body.storageKey}`);

    const { rows } = await db.query<{ avatar_storage_key: string }>(
      `SELECT avatar_storage_key FROM app_user WHERE id=$1`,
      [userId],
    );
    expect(rows[0]!.avatar_storage_key).toBe(body.storageKey);

    // Also actually readable back through the same route the header and the
    // account page point at — the point of the storage-key convention.
    const stored = await readFile(path.join(MEDIA_ROOT, body.storageKey));
    expect(stored.length).toBeGreaterThan(0);
  });

  it('strips GPS metadata before writing the file, same as the listing route', async () => {
    const original = jpegWithGps();
    const response = await upload(original);
    const { storageKey } = (await response.json()) as { storageKey: string };

    const stored = await readFile(path.join(MEDIA_ROOT, storageKey));
    expect(stored.toString('latin1')).not.toContain('GPSLatitude');
    expect(stored.length).toBeLessThan(original.length);
  });

  it('replaces the previous avatar rather than accumulating, and deletes the old file', async () => {
    const first = await upload(jpegOf(200, 200));
    const { storageKey: firstKey } = (await first.json()) as { storageKey: string };
    const firstAbsolute = path.join(MEDIA_ROOT, firstKey);
    await expect(readFile(firstAbsolute)).resolves.toBeDefined();

    const second = await upload(pngOf(300, 300), { filename: 'two.png', type: 'image/png' });
    expect(second.status).toBe(200);
    const { storageKey: secondKey } = (await second.json()) as { storageKey: string };
    expect(secondKey).not.toBe(firstKey);

    const { rows } = await db.query<{ avatar_storage_key: string }>(
      `SELECT avatar_storage_key FROM app_user WHERE id=$1`,
      [userId],
    );
    expect(rows[0]!.avatar_storage_key).toBe(secondKey);

    // Best-effort cleanup of the file the new upload replaced.
    await expect(readFile(firstAbsolute)).rejects.toThrow();
  });

  it('does not fail the request when the previous file is already gone', async () => {
    const first = await upload(jpegOf(200, 200));
    const { storageKey: firstKey } = (await first.json()) as { storageKey: string };
    await rm(path.join(MEDIA_ROOT, firstKey));

    const second = await upload(jpegOf(200, 200));
    expect(second.status).toBe(200);
  });
});

describe('what is refused', () => {
  it('refuses a file over the 3 MB avatar cap even though it would pass the 10 MB listing cap', async () => {
    // Padded past 3 MB with an oversized (but still well under the listing
    // cap and under the pixel budget) comment segment so the declared size
    // check further down is what actually catches it.
    const padding = Buffer.alloc(4 * 1024 * 1024, 0x20);
    const withComment = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xfe, ((padding.length + 2) >> 8) & 0xff, (padding.length + 2) & 0xff]),
      padding,
      jpegOf(200, 200).subarray(2),
    ]);
    const response = await upload(withComment);
    expect(response.status).toBe(413);
  });

  it('refuses an oversized body before parsing it', async () => {
    const response = await upload(jpegOf(200, 200), { contentLength: String(20 * 1024 * 1024) });
    expect(response.status).toBe(413);
  });

  it('refuses a file that is not an image, whatever it claims to be', async () => {
    const response = await upload(Buffer.from('#!/bin/sh\necho hi', 'utf8'), {
      filename: 'innocent.jpg',
      type: 'image/jpeg',
    });
    expect(response.status).toBe(415);
  });

  it('refuses a decompression bomb by its declared dimensions', async () => {
    const response = await upload(pngOf(30_000, 30_000), { filename: 'bomb.png', type: 'image/png' });
    expect(response.status).toBe(413);
  });

  it('refuses an anonymous caller, and touches neither disk nor database', async () => {
    session.current = null;
    const response = await upload(jpegOf(200, 200));
    expect(response.status).toBe(401);

    const { rows } = await db.query<{ avatar_storage_key: string | null }>(
      `SELECT avatar_storage_key FROM app_user WHERE id=$1`,
      [userId],
    );
    expect(rows[0]!.avatar_storage_key).toBeNull();
  });

  it('returns 501 rather than claiming success when object storage is configured but unimplemented', async () => {
    process.env.MEDIA_BUCKET_URL = 'https://media.example.com';
    const response = await upload(jpegOf(200, 200));
    expect(response.status).toBe(501);

    const { rows } = await db.query<{ avatar_storage_key: string | null }>(
      `SELECT avatar_storage_key FROM app_user WHERE id=$1`,
      [userId],
    );
    expect(rows[0]!.avatar_storage_key).toBeNull();
  });
});

describe('a WebP is held to the same dimension budget as a JPEG or PNG', () => {
  it('accepts one within budget and reports its size', async () => {
    const response = await upload(webpExtended(800, 600), { filename: 'me.webp', type: 'image/webp' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ width: 800, height: 600, contentType: 'image/webp' });
    expect(await filesOnDisk()).toHaveLength(1);
  });

  it('refuses a decompression bomb by its declared canvas, and stores nothing', async () => {
    const response = await upload(webpExtended(30_000, 30_000), {
      filename: 'bomb.webp',
      type: 'image/webp',
    });
    expect(response.status).toBe(413);
    expect(await filesOnDisk()).toEqual([]);
    expect(await storedKey()).toBeNull();
  });

  it('refuses a WebP whose header is cut off before its size, and stores nothing', async () => {
    const response = await upload(webpExtended(800, 600).subarray(0, 24), {
      filename: 'cut.webp',
      type: 'image/webp',
    });
    expect(response.status).toBe(415);
    expect(await filesOnDisk()).toEqual([]);
    expect(await storedKey()).toBeNull();
  });
});

describe('one account cannot flood the disk or leave files nothing points to', () => {
  const bucket = () => `upload:avatar:user:${userId}`;
  const seedHits = (hits: number) =>
    db.query(`INSERT INTO rate_limit_counter (bucket, window_start, hits) VALUES ($1,$2,$3)`, [
      bucket(),
      new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString(),
      hits,
    ]);

  it('caps one account at 10 uploads an hour, refusing the 11th before it writes anything', async () => {
    await seedHits(9);
    const tenth = await upload(jpegOf(200, 200));
    expect(tenth.status).toBe(200);
    const { storageKey } = (await tenth.json()) as { storageKey: string };

    const eleventh = await upload(jpegOf(200, 200));
    expect(eleventh.status).toBe(429);
    expect(await storedKey()).toBe(storageKey);
    expect(await filesOnDisk()).toEqual([path.basename(storageKey)]);
  });

  it('counts each account on its own', async () => {
    await seedHits(10);
    expect((await upload(jpegOf(200, 200))).status).toBe(429);

    const other = uuidv7();
    await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,'Іншы карыстальнік')`, [
      other,
      `${other}@example.by`,
    ]);
    session.current = { userId: other, displayName: 'Іншы карыстальнік' };
    expect((await upload(jpegOf(200, 200))).status).toBe(200);
  });

  describe('when the database write fails', () => {
    beforeEach(async () => {
      await db.execScript(`
        CREATE FUNCTION refuse_avatar_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'avatar write refused'; END $$;
        CREATE TRIGGER refuse_avatar_write BEFORE UPDATE OF avatar_storage_key ON app_user
          FOR EACH ROW EXECUTE PROCEDURE refuse_avatar_write();
      `);
    });
    afterEach(async () => {
      await db.execScript(
        `DROP TRIGGER refuse_avatar_write ON app_user; DROP FUNCTION refuse_avatar_write();`,
      );
    });

    it('removes the file it just wrote', async () => {
      const response = await upload(jpegOf(200, 200));
      expect(response.status).toBe(500);
      expect(await filesOnDisk()).toEqual([]);
      expect(await storedKey()).toBeNull();
    });

    it('keeps the avatar the person already had', async () => {
      await db.execScript(`ALTER TABLE app_user DISABLE TRIGGER refuse_avatar_write`);
      const first = await upload(jpegOf(200, 200));
      const { storageKey } = (await first.json()) as { storageKey: string };
      await db.execScript(`ALTER TABLE app_user ENABLE TRIGGER refuse_avatar_write`);

      expect((await upload(jpegOf(300, 300))).status).toBe(500);
      expect(await storedKey()).toBe(storageKey);
      expect(await filesOnDisk()).toEqual([path.basename(storageKey)]);
    });
  });

  it('removes the file when the account was closed after the session was checked', async () => {
    await db.query(`UPDATE app_user SET status='DELETED', deleted_at=now() WHERE id=$1`, [userId]);
    const response = await upload(jpegOf(200, 200));
    expect(response.status).toBe(409);
    expect(await filesOnDisk()).toEqual([]);
    expect(await storedKey()).toBeNull();
  });

  it('removes the file when the account row is gone altogether', async () => {
    session.current = { userId: uuidv7(), displayName: 'Прывід' };
    const response = await upload(jpegOf(200, 200));
    expect(response.status).toBe(409);
    expect(await readdir(path.join(MEDIA_ROOT, 'avatars', session.current.userId)).catch(() => [])).toEqual(
      [],
    );
  });

  it('parallel replacements leave exactly one file, the one the account references', async () => {
    const N = 8;
    /* Line the requests up so every one has written its file before any of them
       touches the account row: the interleaving that used to orphan files, made
       certain instead of left to timing. Only the first statement each request
       sends about app_user waits, so a request that sends several is not stuck. */
    let arrived = 0;
    let open!: () => void;
    const released = new Promise<void>((resolve) => (open = resolve));
    const timer = setTimeout(open, 5_000);
    runtime.db = {
      ...db,
      query: async (text: string, params?: readonly unknown[]) => {
        if (arrived < N && text.includes('app_user')) {
          arrived += 1;
          if (arrived === N) open();
          await released;
        }
        return db.query(text, params);
      },
    };

    try {
      const responses = await Promise.all(
        Array.from({ length: N }, (_, i) => upload(jpegOf(100 + i, 100 + i))),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(N).fill(200));

      const keys = await Promise.all(
        responses.map(async (r) => ((await r.json()) as { storageKey: string }).storageKey),
      );
      expect(new Set(keys).size).toBe(N);

      const current = await storedKey();
      expect(keys).toContain(current);
      expect(await filesOnDisk()).toEqual([path.basename(current!)]);
    } finally {
      clearTimeout(timer);
      runtime.db = db;
    }
  });
});

describe('the media route serving an uploaded avatar', () => {
  it('serves the exact bytes that were written, with an image content type', async () => {
    const response = await upload(jpegOf(200, 200));
    const { storageKey } = (await response.json()) as { storageKey: string };

    const { GET } = await import('@/app/media/[...key]/route.ts');
    const served = await GET(new Request(`http://localhost/media/${storageKey}`), {
      params: Promise.resolve({ key: storageKey.split('/') }),
    });

    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await served.arrayBuffer());
    const onDisk = await readFile(path.join(MEDIA_ROOT, storageKey));
    expect(bytes.equals(onDisk)).toBe(true);
  });
});
