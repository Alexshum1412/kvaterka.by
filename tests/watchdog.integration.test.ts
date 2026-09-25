/**
 * The watchdog and the error tracker (DEC-086): each alert fires on the state
 * it names, clears when the lifecycle sweep fixes it, and reaches an
 * administrator once a day, not once a tick.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { checkOperations, notifyAdministrators } from '@/server/services/watchdog.ts';
import { listRecentErrors, MAX_NEW_CLIENT_ERRORS_PER_DAY, recordError } from '@/server/services/error-log.ts';
import { NotificationService } from '@/server/services/notification-service.ts';
import { DELIVERY_JOB } from '@/server/services/delivery-service.ts';
import { uuidv7 } from '@/lib/id.ts';

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
  await db.execScript(`
    INSERT INTO amenity (code, category, name_ru, name_be, name_en) VALUES
      ('WIFI','ESSENTIALS','Wi-Fi','Wi-Fi','Wi-Fi') ON CONFLICT DO NOTHING;
  `);
});

async function confirmedBooking() {
  const landlord = await api.signUp();
  const created = await api.post(
    '/listings',
    {
      title: 'Светлая двушка у метро Немига',
      propertyType: 'APARTMENT',
      city: 'Минск',
      latitude: 53.9045,
      longitude: 27.5615,
      rooms: 2,
      beds: 3,
      maxGuests: 4,
      basePriceMinor: '10000',
      cleaningFeeMinor: '0',
      depositMinor: '0',
      minNights: 2,
      maxNights: 90,
      bookingMode: 'REQUEST',
      amenities: ['WIFI'],
    },
    { token: landlord.token },
  );
  const listingId = created.body.id as string;
  await api.attachPhoto(listingId);
  await api.post(`/listings/${listingId}/submit`, {}, { token: landlord.token });
  const moderator = await api.signUp();
  await api.grantRole(moderator.userId, 'MODERATOR');
  await api.post(
    `/admin/moderation/listings/${listingId}`,
    { decision: 'PUBLISHED' },
    { token: moderator.token },
  );
  const tenant = await api.signUp();
  const booked = await api.post(
    '/bookings',
    { propertyId: listingId, from: '2027-09-15', to: '2027-09-20', guests: 2 },
    { token: tenant.token },
  );
  const bookingId = booked.body.id as string;
  await api.post(`/bookings/${bookingId}/accept`, {}, { token: landlord.token });
  return bookingId;
}

const kinds = async () => (await checkOperations(db)).map((a) => a.kind);

describe('checks', () => {
  it('is quiet on a healthy database', async () => {
    expect(await checkOperations(db)).toEqual([]);
  });

  it('flags a stay that ended with no completion window, and clears once the sweep opens it', async () => {
    const bookingId = await confirmedBooking();
    await db.query(
      `UPDATE booking SET stay_period = daterange(CURRENT_DATE - 8, CURRENT_DATE - 3, '[)') WHERE id=$1`,
      [bookingId],
    );
    expect(await kinds()).toContain('STAY_NOT_CLOSED');

    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');
    const run = await api.post('/admin/lifecycle/run', {}, { token: admin.token });
    expect(run.status).toBe(200);
    expect(await kinds()).not.toContain('STAY_NOT_CLOSED');
  });

  it('flags a completion stuck a day past its deadline', async () => {
    const bookingId = await confirmedBooking();
    await db.query(
      `UPDATE booking SET status='COMPLETION_PENDING', completion_deadline_at = now() - interval '2 days' WHERE id=$1`,
      [bookingId],
    );
    expect(await kinds()).toContain('COMPLETION_STUCK');
  });

  it('flags a completed booking that has no fee', async () => {
    const bookingId = await confirmedBooking();
    await db.query(
      `UPDATE booking SET status='COMPLETED', completed_at = now() - interval '1 hour' WHERE id=$1`,
      [bookingId],
    );
    expect(await kinds()).toContain('FEE_MISSING');
  });

  it('flags notifications that have waited over an hour', async () => {
    const user = await api.signUp();
    await db.query(
      `INSERT INTO notification (id, user_id, category, channel, dedupe_key, payload, status, created_at)
       VALUES ($1,$2,'MESSAGE','EMAIL','stale-1','{}','PENDING', now() - interval '2 hours')`,
      [uuidv7(), user.userId],
    );
    expect(await kinds()).toContain('NOTIFICATION_BACKLOG');
  });
});

describe('the error tracker', () => {
  it('folds repeats of one failure into one row, ids and numbers masked', async () => {
    await recordError(db, {
      source: 'API',
      message: 'POST: boom on 01a0d5c2-b467-7492-9bbb-c2c36d0d6bd6',
      path: '/bookings/11/accept',
    });
    await recordError(db, {
      source: 'API',
      message: 'POST: boom on 01a0d5c2-b467-7492-9bbb-000000000000',
      path: '/bookings/42/accept',
    });
    const { rows } = await db.query<{ count: number }>(`SELECT count FROM error_event`);
    expect(rows).toEqual([{ count: 2 }]);
    expect(await kinds()).toContain('NEW_ERRORS');
  });

  /* The message is normalised (digits masked), so distinct failures need
     distinct letters, not distinct numbers. */
  const word = (i: number) => [...String(i)].map((d) => 'abcdefghij'[Number(d)]).join('');

  it('stops a flood of distinct browser errors from growing the table, without losing an API error', async () => {
    for (let i = 0; i < MAX_NEW_CLIENT_ERRORS_PER_DAY + 5; i++) {
      await recordError(db, { source: 'CLIENT', message: `boom ${word(i)}` });
    }
    const client = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM error_event WHERE source='CLIENT'`,
    );
    expect(client.rows[0]!.c).toBe(MAX_NEW_CLIENT_ERRORS_PER_DAY);

    // A failure the tracker already knows keeps counting, past the ceiling.
    await recordError(db, { source: 'CLIENT', message: `boom ${word(0)}` });
    const known = await db.query<{ count: number }>(`SELECT count FROM error_event WHERE message = $1`, [
      `boom ${word(0)}`,
    ]);
    expect(known.rows).toEqual([{ count: 2 }]);

    await recordError(db, { source: 'API', message: 'POST: the database is on fire', path: '/bookings' });
    const api = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM error_event WHERE source='API'`,
    );
    expect(api.rows[0]!.c).toBe(1);
  });

  it('lists server errors and the crashes that recur, however many one-off browser reports arrive after them', async () => {
    const insert = (fingerprint: string, source: string, message: string, count: number, hoursAgo: number) =>
      db.query(
        `INSERT INTO error_event (fingerprint, source, message, count, first_seen, last_seen)
         VALUES ($1,$2,$3,$4, now() - make_interval(hours => $5::int), now() - make_interval(hours => $5::int))`,
        [fingerprint, source, message, count, hoursAgo],
      );
    await insert('api-old', 'API', 'POST: old server error', 3, 200);
    await insert('api-new', 'API', 'POST: newer server error', 1, 50);
    await insert('client-popular', 'CLIENT', 'TypeError: recurring crash', 40, 30);
    for (let i = 0; i < 14; i++) await insert(`client-junk-${i}`, 'CLIENT', `junk ${word(i)}`, 1, 0);

    const listed = await listRecentErrors(db);
    const fingerprints = listed.map((e) => e.fingerprint);
    expect(fingerprints.slice(0, 2)).toEqual(['api-new', 'api-old']);
    expect(fingerprints).toContain('client-popular');
    expect(listed.filter((e) => e.source === 'CLIENT')).toHaveLength(10);
  });
});

describe('the job check', () => {
  async function jobRun(jobName: string, status: string, minutesAgo: number, failed = 0) {
    await db.query(
      `INSERT INTO job_run (id, job_name, status, started_at, finished_at, failed)
       VALUES ($1,$2,$3, now() - make_interval(mins => $4::int),
               CASE WHEN $3::text = 'RUNNING' THEN NULL ELSE now() - make_interval(mins => $4::int) + interval '1 minute' END, $5)`,
      [uuidv7(), jobName, status, minutesAgo, failed],
    );
  }

  async function admin() {
    const user = await api.signUp();
    await api.grantRole(user.userId, 'ADMIN');
    return user;
  }

  it('reports the previous failed run when the check runs inside the sweep that just started', async () => {
    await jobRun('lifecycle.sweep', 'FAILED', 120, 1);
    const user = await admin();
    const run = await api.post('/admin/lifecycle/run', {}, { token: user.token });
    expect(run.status).toBe(200);
    expect(run.body.alerts).toContainEqual({ kind: 'JOB_FAILED', count: 1 });
    // That sweep succeeded, so the next look finds nothing wrong.
    expect(await kinds()).not.toContain('JOB_FAILED');
  });

  it('reports a sweep that died mid-run, which the next sweep reclaims before it checks', async () => {
    await jobRun('lifecycle.sweep', 'RUNNING', 120);
    const user = await admin();
    const run = await api.post('/admin/lifecycle/run', {}, { token: user.token });
    expect(run.status).toBe(200);
    expect(run.body.alerts).toContainEqual({ kind: 'JOB_FAILED', count: 1 });
  });

  it('judges the latest finished run: a fresh RUNNING row hides nothing, a later success clears', async () => {
    await jobRun('retention.purge', 'FAILED', 300, 1);
    await jobRun('retention.purge', 'RUNNING', 1);
    expect(await kinds()).toContain('JOB_FAILED');

    await db.query(`DELETE FROM job_run`);
    await jobRun('retention.purge', 'FAILED', 300, 1);
    await jobRun('retention.purge', 'SUCCEEDED', 200);
    expect(await kinds()).not.toContain('JOB_FAILED');
  });

  it('still catches a run left RUNNING for over an hour, and leaves a recent one alone', async () => {
    await jobRun('retention.purge', 'RUNNING', 10);
    expect(await kinds()).not.toContain('JOB_FAILED');
    await db.query(`DELETE FROM job_run`);
    await jobRun('retention.purge', 'RUNNING', 120);
    expect(await kinds()).toContain('JOB_FAILED');
  });

  it('does not call a delivery run a failed job because one recipient bounced', async () => {
    await jobRun(DELIVERY_JOB, 'FAILED', 5, 1);
    expect(await kinds()).not.toContain('JOB_FAILED');
    await jobRun('retention.purge', 'FAILED', 5, 1);
    expect(await kinds()).toContain('JOB_FAILED');
  });
});

describe('alerting', () => {
  it('tells every administrator once a day per alert, however often the sweep runs', async () => {
    await recordError(db, { source: 'CLIENT', message: 'TypeError: x is undefined', path: '/search' });
    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');
    for (let i = 0; i < 3; i++) {
      const run = await api.post('/admin/lifecycle/run', {}, { token: admin.token });
      expect(run.status).toBe(200);
      expect(run.body.alerts).toEqual([{ kind: 'NEW_ERRORS', count: 1 }]);
    }
    const { rows } = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM notification WHERE user_id=$1 AND category='OPERATIONS' AND channel='IN_APP'`,
      [admin.userId],
    );
    expect(rows[0]!.c).toBe(1);
  });
});

describe('alert dedupe follows the window each alert counts over', () => {
  const inApp = async (userId: string) =>
    (
      await db.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM notification WHERE user_id=$1 AND category='OPERATIONS' AND channel='IN_APP'`,
        [userId],
      )
    ).rows[0]!.c;

  const evening = new Date('2027-01-01T23:00:00Z');
  const nextMorning = new Date('2027-01-02T01:00:00Z');

  it('announces one new error once, not again after midnight while it is still inside the 24 hours', async () => {
    const user = await api.signUp();
    await api.grantRole(user.userId, 'ADMIN');
    await recordError(db, { source: 'CLIENT', message: 'TypeError: x is undefined', path: '/search' });
    await db.query(`UPDATE error_event SET first_seen = now() - interval '2 hours'`);

    const notifications = new NotificationService(db);
    const alerts = await checkOperations(db);
    expect(alerts).toEqual([{ kind: 'NEW_ERRORS', count: 1 }]);
    await notifyAdministrators(db, notifications, alerts, evening);
    await notifyAdministrators(db, notifications, alerts, nextMorning);
    expect(await inApp(user.userId)).toBe(1);
  });

  it('does the same for a burst of failed deliveries', async () => {
    const user = await api.signUp();
    await api.grantRole(user.userId, 'ADMIN');
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO notification (id, user_id, category, channel, dedupe_key, payload, status, created_at)
         VALUES ($1,$2,'MESSAGE','EMAIL',$3,'{}','FAILED', now() - interval '2 hours')`,
        [uuidv7(), user.userId, `failed-${i}`],
      );
    }
    const notifications = new NotificationService(db);
    const alerts = await checkOperations(db);
    expect(alerts).toEqual([{ kind: 'NOTIFICATION_FAILURES', count: 5 }]);
    await notifyAdministrators(db, notifications, alerts, evening);
    await notifyAdministrators(db, notifications, alerts, nextMorning);
    expect(await inApp(user.userId)).toBe(1);
  });

  it('still tells about a standing fault once per calendar day', async () => {
    const user = await api.signUp();
    await api.grantRole(user.userId, 'ADMIN');
    const notifications = new NotificationService(db);
    const alerts = [{ kind: 'FEE_MISSING' as const, count: 1 }];
    await notifyAdministrators(db, notifications, alerts, evening);
    await notifyAdministrators(db, notifications, alerts, new Date('2027-01-01T23:30:00Z'));
    expect(await inApp(user.userId)).toBe(1);
    await notifyAdministrators(db, notifications, alerts, nextMorning);
    expect(await inApp(user.userId)).toBe(2);
  });
});
