/**
 * POST /api/client-errors — where a browser reports a crash (DEC-086).
 */

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
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

const report = (body: string, ip = '203.0.113.9') =>
  POST(new Request('http://localhost/api/client-errors', { method: 'POST', body, headers: { 'x-real-ip': ip } }));

it('records a crash with its page, query string dropped', async () => {
  const res = await report(JSON.stringify({ message: 'TypeError: a is undefined', path: '/search?city=Минск' }));
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
