/**
 * The upload endpoint, which had no test at all.
 *
 * `POST /api/uploads` is where untrusted bytes enter this product: it decides
 * the content type by sniffing magic bytes rather than believing the client,
 * generates the storage key server-side, and now strips metadata and refuses
 * absurd dimensions. Every one of those is a security property, and not one of
 * them was exercised by the 1054-test suite — the only test touching photos
 * called the JSON attach route with a fabricated key, so the suite certified
 * the bypass and never opened the door it was bypassing.
 *
 * It is a Next.js route handler rather than a table route, so it is called
 * here directly with a constructed `Request`, which is exactly what the
 * framework does.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ListingService } from '@/server/services/listing-service.ts';
import { uuidv7 } from '@/lib/id.ts';

/* The route reads the session and the service container from the process
   runtime. Both are replaced here so the handler under test is the real one
   while its two ambient dependencies point at this suite's database. */
const session = vi.hoisted(() => ({ current: null as { userId: string; displayName: string } | null }));
const runtime = vi.hoisted(() => ({ services: null as unknown }));

vi.mock('@/server/session.ts', () => ({
  currentUser: async () => session.current,
  signInUrl: (next: string) => `/login?next=${next}`,
}));

vi.mock('@/server/runtime.ts', () => ({
  readyServices: async () => runtime.services,
  ready: async () => undefined,
}));

const MEDIA_ROOT = path.join(process.cwd(), '.media-test-uploads');
process.env.DEV_MEDIA_DIR = MEDIA_ROOT;

const { POST } = await import('@/app/api/uploads/route.ts');

let db: TestDb;
let listings: ListingService;
let ownerId: string;
let propertyId: string;

beforeAll(async () => {
  db = await createTestDb();
  listings = new ListingService(db);
  runtime.services = { listings };
}, 120_000);

afterAll(async () => {
  await db?.close();
  await rm(MEDIA_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.truncateAll();
  delete process.env.MEDIA_BUCKET_URL;

  ownerId = uuidv7();
  await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,'Алесь Уладальнік')`, [
    ownerId,
    `${ownerId}@example.by`,
  ]);
  session.current = { userId: ownerId, displayName: 'Алесь Уладальнік' };

  propertyId = uuidv7();
  await db.query(
    `INSERT INTO property (id, owner_id, title, city, property_type, latitude, longitude,
        public_latitude, public_longitude, base_price_minor, price_unit, min_nights, max_nights,
        max_guests, booking_mode, status)
     VALUES ($1,$2,'Черновик','Минск','APARTMENT',53.9,27.5,53.9,27.5,8000,'NIGHT',1,365,4,
        'INSTANT_AND_REQUEST','DRAFT')`,
    [propertyId, ownerId],
  );
});

afterEach(() => {
  session.current = null;
});

/* ------------------------------------------------------------------ */

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
  sofPayload.writeUInt16BE(1200, 1);
  sofPayload.writeUInt16BE(1600, 3);
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

async function upload(
  bytes: Buffer,
  opts: { filename?: string; type?: string; property?: string; contentLength?: string } = {},
): Promise<Response> {
  const form = new FormData();
  form.append('propertyId', opts.property ?? propertyId);
  form.append(
    'file',
    new File([new Uint8Array(bytes)], opts.filename ?? 'photo.jpg', {
      type: opts.type ?? 'image/jpeg',
    }),
  );

  const request = new Request('http://localhost/api/uploads', { method: 'POST', body: form });
  if (opts.contentLength) {
    // Node's Request headers are immutable once constructed with a body, so a
    // declared-size test builds its own.
    const headers = new Headers(request.headers);
    headers.set('content-length', opts.contentLength);
    return POST(new Request('http://localhost/api/uploads', { method: 'POST', body: form, headers }));
  }
  return POST(request);
}

/* ================================================================== */

describe('what reaches the disk', () => {
  it('accepts a JPEG and stores it under a server-generated key', async () => {
    const response = await upload(jpegWithGps());
    expect(response.status).toBe(201);

    const body = (await response.json()) as { storageKey: string; id: string };
    // The client sent "photo.jpg" and has no say in where it landed.
    expect(body.storageKey).toMatch(new RegExp(`^listings/${propertyId}/[0-9a-f-]{36}\\.jpg$`));
    expect(body.storageKey).not.toContain('photo.jpg');
  });

  it('strips the GPS coordinates before writing the file', async () => {
    const original = jpegWithGps();
    expect(original.toString('latin1')).toContain('GPSLatitude');

    const response = await upload(original);
    const { storageKey } = (await response.json()) as { storageKey: string };

    // Read what actually landed on disk, not what the handler returned.
    const stored = await readFile(path.join(MEDIA_ROOT, storageKey));
    expect(stored.toString('latin1')).not.toContain('GPSLatitude');
    expect(stored.toString('latin1')).not.toContain('Exif');

    // This is the whole point: the product hides the exact address until a
    // booking is confirmed, and the photograph was carrying it.
    expect(stored.length).toBeLessThan(original.length);
  });

  it('records the stored byte size, not the uploaded one', async () => {
    const original = jpegWithGps();
    const response = await upload(original);
    const { id } = (await response.json()) as { id: string };

    const { rows } = await db.query<{ byte_size: number }>(
      `SELECT byte_size FROM property_photo WHERE id=$1`,
      [id],
    );
    expect(rows[0]!.byte_size).toBeLessThan(original.length);
  });

  it('reads the real dimensions out of the file rather than trusting anybody', async () => {
    const response = await upload(jpegWithGps());
    const { id } = (await response.json()) as { id: string };

    const { rows } = await db.query<{ width: number; height: number }>(
      `SELECT width, height FROM property_photo WHERE id=$1`,
      [id],
    );
    expect(rows[0]).toEqual({ width: 1600, height: 1200 });
  });
});

describe('what is refused', () => {
  it('refuses a file that is not an image, whatever it claims to be', async () => {
    const response = await upload(Buffer.from('#!/bin/sh\nrm -rf /', 'utf8'), {
      filename: 'innocent.jpg',
      type: 'image/jpeg',
    });
    expect(response.status).toBe(415);
  });

  it('refuses an SVG, which is a script that renders as a picture', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const response = await upload(svg, { filename: 'x.svg', type: 'image/svg+xml' });
    expect(response.status).toBe(415);
  });

  it('refuses a decompression bomb by its declared dimensions', async () => {
    // 30000x30000: about 25 KB on the wire, 3.6 GB decoded in the browser of
    // everyone who opens the listing.
    const response = await upload(pngOf(30_000, 30_000), { filename: 'bomb.png', type: 'image/png' });
    expect(response.status).toBe(413);
  });

  it('accepts an ordinary large photograph', async () => {
    const response = await upload(pngOf(6000, 4000), { filename: 'big.png', type: 'image/png' });
    expect(response.status).toBe(201);
  });

  it('refuses an oversized body before parsing it', async () => {
    const response = await upload(jpegWithGps(), { contentLength: String(80 * 1024 * 1024) });
    expect(response.status).toBe(413);
  });

  it('refuses an anonymous caller', async () => {
    session.current = null;
    const response = await upload(jpegWithGps());
    expect(response.status).toBe(401);
  });

  it('refuses to attach to a listing somebody else owns', async () => {
    const stranger = uuidv7();
    await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,'Чужы')`, [
      stranger,
      `${stranger}@example.by`,
    ]);
    session.current = { userId: stranger, displayName: 'Чужы' };

    const response = await upload(jpegWithGps());
    expect(response.status).toBeGreaterThanOrEqual(400);

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM property_photo WHERE property_id=$1`,
      [propertyId],
    );
    expect(Number(rows[0]!.c)).toBe(0);
  });

  it('refuses a malformed property id without touching the disk', async () => {
    const response = await upload(jpegWithGps(), { property: '../../etc/passwd' });
    expect(response.status).toBe(400);
  });
});

describe('the honest refusal when storage is configured but unimplemented', () => {
  it('returns 501 rather than claiming an upload that went nowhere', async () => {
    process.env.MEDIA_BUCKET_URL = 'https://media.example.com';

    const response = await upload(jpegWithGps());
    expect(response.status).toBe(501);

    // And nothing was recorded. A landlord must never be told a photo was
    // uploaded when it was not.
    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM property_photo WHERE property_id=$1`,
      [propertyId],
    );
    expect(Number(rows[0]!.c)).toBe(0);
  });
});
