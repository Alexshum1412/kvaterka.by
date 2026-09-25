/**
 * The watchdog and the error tracker (DEC-086): each alert fires on the state
 * it names, clears when the lifecycle sweep fixes it, and reaches an
 * administrator once a day, not once a tick.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { checkOperations } from '@/server/services/watchdog.ts';
import { recordError } from '@/server/services/error-log.ts';
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
  await api.post(`/admin/moderation/listings/${listingId}`, { decision: 'PUBLISHED' }, { token: moderator.token });
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
    await recordError(db, { source: 'API', message: 'POST: boom on 01a0d5c2-b467-7492-9bbb-c2c36d0d6bd6', path: '/bookings/11/accept' });
    await recordError(db, { source: 'API', message: 'POST: boom on 01a0d5c2-b467-7492-9bbb-000000000000', path: '/bookings/42/accept' });
    const { rows } = await db.query<{ count: number }>(`SELECT count FROM error_event`);
    expect(rows).toEqual([{ count: 2 }]);
    expect(await kinds()).toContain('NEW_ERRORS');
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
