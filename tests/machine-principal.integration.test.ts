/**
 * The scheduler credential.
 *
 * These tests exist because of a specific regression. `lifecycle.run`,
 * `retention.run` and `notifications.run` were always described in `rbac.ts`
 * as machine credentials — "a cron calls it" — but were granted to ADMIN,
 * because a human admin was the only principal the product had. DEC-054 then
 * made ADMIN a role that is WITHHELD until a second factor is satisfied, and a
 * cron cannot type a six-digit code. Every background job in the platform
 * became unreachable by automation, silently, while all 1001 tests still
 * passed — because every one of them logs in as a person.
 *
 * So the assertions below come in two halves of equal weight: a scheduler CAN
 * now run the three jobs, and it can do nothing else whatsoever.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { MACHINE_PERMISSIONS, MIN_JOB_TOKEN_LENGTH } from '@/server/api/machine.ts';
import { STEP_UP_PERMISSIONS } from '@/server/domain/two-factor.ts';

const TOKEN = 'z'.repeat(48);
const JOB_ROUTES = ['/admin/lifecycle/run', '/admin/retention/run', '/admin/notifications/run'] as const;

/** What a scheduler sends: the secret in the header, and no session at all. */
const asScheduler = (token = TOKEN) => ({ jobToken: TOKEN, headers: { 'x-job-token': token } });

let db: TestDb;
let api: ApiTestClient;

beforeAll(async () => {
  db = await createTestDb();
  api = new ApiTestClient(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await api.resetRateLimits();
});

describe('a scheduler runs the jobs it was always meant to run', () => {
  it.each(JOB_ROUTES)('runs %s with the job token and no session', async (path) => {
    const response = await api.post(path, {}, asScheduler());

    expect(response.status).toBe(200);
    // Not merely "not 401": the job reported a result, so it actually ran.
    expect(response.body).toBeTruthy();
  });

  it('records the run as machine-triggered rather than attributing it to a person', async () => {
    await api.post('/admin/notifications/run', {}, asScheduler());

    const { rows } = await db.query<{ job_name: string; triggered_by: string | null }>(
      `SELECT job_name, triggered_by FROM job_run ORDER BY started_at DESC LIMIT 1`,
    );
    expect(rows[0]!.job_name).toBe('notification.deliver');
    // `triggered_by` references app_user, so NULL is the only honest value for
    // a machine — and a human always has an id, which makes NULL unambiguous
    // rather than merely absent.
    expect(rows[0]!.triggered_by).toBeNull();
  });
});

describe('the credential is not a skeleton key', () => {
  it('refuses a document read, the thing a leaked scheduler token must never reach', async () => {
    const response = await api.get(
      '/admin/verification/documents/00000000-0000-0000-0000-000000000000',
      asScheduler(),
    );

    expect(response.status).toBe(403);
    expect(response.errorCode).toBe('FORBIDDEN');
  });

  it.each(['/admin/users', '/admin/retention/runs', '/admin/notifications/backlog'])(
    'refuses %s, which reads rather than runs',
    async (path) => {
      const response = await api.get(path, asScheduler());
      expect(response.status).toBe(403);
    },
  );

  it('holds exactly the three job permissions', () => {
    expect([...MACHINE_PERMISSIONS].sort()).toEqual(
      ['lifecycle.run', 'notifications.run', 'retention.run'].sort(),
    );
  });

  it('never holds a permission that also demands step-up, which no machine could satisfy', () => {
    // Keeping these two sets disjoint is a design constraint, not a
    // coincidence: a permission needing both a machine runner and proof of a
    // second factor in the last fifteen minutes is unsatisfiable by anyone.
    expect(MACHINE_PERMISSIONS.filter((p) => STEP_UP_PERMISSIONS.includes(p))).toEqual([]);
  });
});

describe('the credential fails closed', () => {
  it('rejects a job route when the deployment configured no job token', async () => {
    // The same request that succeeds above, minus the deployment secret.
    const response = await api.post('/admin/notifications/run', {}, { headers: { 'x-job-token': TOKEN } });

    expect(response.status).toBe(401);
    expect(response.errorCode).toBe('UNAUTHENTICATED');
  });

  it('rejects a wrong token without hinting that it was nearly right', async () => {
    const response = await api.post('/admin/notifications/run', {}, asScheduler('z'.repeat(47) + 'y'));

    // Identical to presenting nothing at all.
    expect(response.status).toBe(401);
    expect(response.errorCode).toBe('UNAUTHENTICATED');
  });

  it.each([1, 10, 47, 49, 200])('rejects a token of length %i without throwing', async (length) => {
    // `timingSafeEqual` throws when buffers differ in length, and the naive
    // repair — comparing lengths first — leaks the real token's length through
    // timing. This asserts the padded comparison neither throws nor accepts.
    const response = await api.post('/admin/notifications/run', {}, asScheduler('z'.repeat(length)));

    expect(response.status).toBe(401);
    expect(api.errors).toEqual([]);
  });

  it('refuses a token below the minimum length even when it matches exactly', async () => {
    // A deployment that sets a short secret gets no machine principal rather
    // than a weak one. `runtime.ts` refuses it at startup; this is the second
    // line of the same defence, for the case where it is injected directly.
    const weak = 'z'.repeat(MIN_JOB_TOKEN_LENGTH - 1);
    const response = await api.post(
      '/admin/notifications/run',
      {},
      { jobToken: weak, headers: { 'x-job-token': weak } },
    );

    expect(response.status).toBe(401);
  });

  it('lets a session win, so presenting both does not escalate a tenant', async () => {
    const tenant = await api.signUp();

    const response = await api.post(
      '/admin/notifications/run',
      {},
      { token: tenant.token, ...asScheduler() },
    );

    expect(response.status).toBe(403);
  });
});

describe('the regression this closes, from both sides', () => {
  it('confirms an admin without a second factor still cannot run a job', async () => {
    // The state migration 0014 left every existing staff session in. This is
    // not a bug to fix — it is the intended behaviour for people, and it is
    // precisely why a separate machine principal had to exist.
    const admin = await api.signUp();
    await api.grantRoleWithoutTwoFactor(admin.userId, 'ADMIN');

    const response = await api.post('/admin/notifications/run', {}, { token: admin.token });
    expect(response.status).toBe(403);
  });

  it('confirms an admin with a second factor can still run it by hand', async () => {
    // The machine principal adds a caller; it must not remove one. An operator
    // debugging a stuck queue still needs to be able to press the button.
    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');

    const response = await api.post('/admin/notifications/run', {}, { token: admin.token });
    expect(response.status).toBe(200);
  });
});
