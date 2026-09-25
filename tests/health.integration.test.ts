/**
 * GET /api/health — each part of the report degrades on its own (DEC-086).
 */

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { uuidv7 } from '@/lib/id.ts';

/* The real database behind a wrapper that can be told to fail the queries whose
   text matches, which is how "the jobs query broke but the site is up" is staged. */
const runtime = vi.hoisted(() => ({ db: null as unknown as TestDb, failing: null as RegExp | null }));
vi.mock('@/server/runtime.ts', () => {
  const connection = {
    query: (text: string, params?: unknown[]) =>
      runtime.failing?.test(text) ? Promise.reject(new Error('down')) : runtime.db.query(text, params),
  };
  return {
    ready: async () => connection,
    db: () => connection,
    env: () => ({ DATABASE_URL: 'postgres://health.test/db' }),
    PGLITE_URL: 'pglite',
  };
});

const { GET } = await import('@/app/api/health/route.ts');

beforeAll(async () => {
  runtime.db = await createTestDb();
}, 120_000);
afterAll(async () => {
  await runtime.db?.close();
});
beforeEach(async () => {
  runtime.failing = null;
  await runtime.db.truncateAll();
  await runtime.db.query(
    `INSERT INTO job_run (id, job_name, status, finished_at) VALUES ($1,'lifecycle.sweep','SUCCEEDED', now())`,
    [uuidv7()],
  );
});

const health = async () => {
  const res = await GET();
  return { status: res.status, body: (await res.json()) as { status: string; checks: Record<string, any> } };
};

it('reports the database, the jobs, the backlog and the alerts when all of them can be read', async () => {
  const { status, body } = await health();
  expect(status).toBe(200);
  expect(body.checks['jobs']).toEqual([
    expect.objectContaining({ job: 'lifecycle.sweep', status: 'SUCCEEDED' }),
  ]);
  expect(body.checks['notificationBacklog']).toEqual({});
  expect(body.checks['alerts']).toEqual([]);
});

it('keeps the jobs and the backlog when only the watchdog query fails', async () => {
  runtime.failing = /service_fee/;
  const { status, body } = await health();
  expect(status).toBe(200);
  expect(body.checks['jobs']).toHaveLength(1);
  expect(body.checks['notificationBacklog']).toEqual({});
  expect(body.checks['alerts']).toBeNull();
});

it('keeps the jobs and the alerts when only the backlog query fails', async () => {
  runtime.failing = /GROUP BY channel/;
  const { status, body } = await health();
  expect(status).toBe(200);
  expect(body.checks['jobs']).toHaveLength(1);
  expect(body.checks['notificationBacklog']).toBeNull();
  expect(body.checks['alerts']).toEqual([]);
});

it('keeps the backlog and the alerts when only the jobs query fails', async () => {
  runtime.failing = /job_name, status, started_at, finished_at/;
  const { status, body } = await health();
  expect(status).toBe(200);
  expect(body.checks['jobs']).toBeNull();
  expect(body.checks['notificationBacklog']).toEqual({});
  expect(body.checks['alerts']).toEqual([]);
});

it('is degraded, and says only the error class, when the database itself does not answer', async () => {
  runtime.failing = /^SELECT 1$/;
  const { status, body } = await health();
  expect(status).toBe(503);
  expect(body.status).toBe('degraded');
  expect(body.checks['database']).toEqual({ ok: false, error: 'Error' });
});
