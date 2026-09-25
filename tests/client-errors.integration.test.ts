/**
 * POST /api/client-errors — where a browser reports a crash (DEC-086).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';

const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/server/runtime.ts', () => ({ ready: async () => runtime.db }));

const { POST } = await import('@/app/api/client-errors/route.ts');

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  runtime.db = db;
}, 120_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.truncateAll();
});
afterEach(() => {
  vi.useRealTimers();
});

const report = (body: string, ip = '203.0.113.9') =>
  POST(
    new Request('http://localhost/api/client-errors', { method: 'POST', body, headers: { 'x-real-ip': ip } }),
  );

it('records a crash with its page, query string dropped', async () => {
  const res = await report(
    JSON.stringify({ message: 'TypeError: a is undefined', path: '/search?city=Минск' }),
  );
  expect(res.status).toBe(204);
  const { rows } = await db.query<{ source: string; path: string }>(`SELECT source, path FROM error_event`);
  expect(rows).toEqual([{ source: 'CLIENT', path: '/search' }]);
});

it('refuses a body that is not the expected shape', async () => {
  expect((await report('not json')).status).toBe(400);
});

it('stops one address from flooding the table', async () => {
  for (let i = 0; i < 30; i++) await report(JSON.stringify({ message: `e${i}` }));
  expect((await report(JSON.stringify({ message: 'one more' }))).status).toBe(429);
});

it('caps all callers together, so a rotating X-Real-IP does not lift the limit', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-03-01T12:00:30Z'));
  for (let i = 0; i < 60; i++) {
    expect((await report(JSON.stringify({ message: 'boom' }), `198.51.100.${i}`)).status).toBe(204);
  }
  expect((await report(JSON.stringify({ message: 'boom' }), '198.51.100.200')).status).toBe(429);
  vi.setSystemTime(new Date('2027-03-01T12:01:30Z'));
  expect((await report(JSON.stringify({ message: 'boom' }), '198.51.100.201')).status).toBe(204);
});

it('keeps a long message, clipped to what the tracker stores, instead of dropping the report', async () => {
  const res = await report(JSON.stringify({ message: `TypeError: ${'x'.repeat(3000)}` }));
  expect(res.status).toBe(204);
  const { rows } = await db.query<{ len: number }>(`SELECT length(message) AS len FROM error_event`);
  expect(rows).toEqual([{ len: 500 }]);
});

/**
 * A body that counts what was pulled from it, so a test can tell "read" from
 * "refused unread". highWaterMark 0: nothing is pulled until somebody reads.
 */
function countingBody(chunks: number) {
  const seen = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(1024).fill(97);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.pulled >= chunks) return controller.close();
        seen.pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { seen, stream };
}

const streamed = (stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://localhost/api/client-errors', {
      method: 'POST',
      body: stream,
      headers: { 'x-real-ip': '203.0.113.9', ...headers },
      duplex: 'half',
    } as RequestInit),
  );

describe('body limits', () => {
  it('refuses a declared oversize body without reading any of it', async () => {
    const { seen, stream } = countingBody(4);
    const res = await streamed(stream, { 'content-length': '1000000' });
    expect(res.status).toBe(413);
    expect(seen.pulled).toBe(0);
  });

  it('stops reading a body with no Content-Length once it passes the cap', async () => {
    const { seen, stream } = countingBody(100_000);
    const res = await streamed(stream);
    expect(res.status).toBe(413);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThan(64);
  });

  it('stops reading a body that understates its own Content-Length', async () => {
    const { seen, stream } = countingBody(100_000);
    const res = await streamed(stream, { 'content-length': '10' });
    expect(res.status).toBe(413);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThan(64);
  });

  it('answers 400, not an exception, when the body cannot be read', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const res = await streamed(broken);
    expect(res.status).toBe(400);
  });
});
