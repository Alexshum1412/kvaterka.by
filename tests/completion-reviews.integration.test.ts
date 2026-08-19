/**
 * Completion, fees and reviews, end to end over the real API.
 *
 * The pure completion rules already have unit coverage in
 * src/server/domain/booking/completion.test.ts. What is tested here is the part
 * that had none: that the HTTP surface, the scheduled sweep, the ledger and the
 * review window are actually wired to those rules — and that the things which
 * must not be possible are refused rather than merely absent from the UI.
 *
 * Time is simulated by moving `stay_period` and the deadline columns into the
 * past with SQL. That is deliberate: the alternative is faking a clock, and
 * these paths are meant to be driven by real timestamps in production.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';

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
      ('WIFI','ESSENTIALS','Wi-Fi','Wi-Fi','Wi-Fi'),
      ('WASHING_MACHINE','BATHROOM','Стиральная машина','Пральная машына','Washing machine')
    ON CONFLICT DO NOTHING;
    INSERT INTO feature_flag (key, enabled, description, requires_legal_approval) VALUES
      ('fee.enforcement', true, 'test', true)
    ON CONFLICT DO NOTHING;
  `);
});

const LISTING = {
  title: 'Светлая двушка у метро Немига',
  propertyType: 'APARTMENT' as const,
  city: 'Минск',
  latitude: 53.9045,
  longitude: 27.5615,
  rooms: 2,
  beds: 3,
  maxGuests: 4,
  // 500.00 BYN for five nights → 5% is exactly 25.00, the worked example in
  // the product brief.
  basePriceMinor: '10000',
  cleaningFeeMinor: '0',
  depositMinor: '0',
  minNights: 2,
  maxNights: 90,
  bookingMode: 'REQUEST' as const,
  amenities: ['WIFI'],
};

const FROM = '2027-09-15';
const TO = '2027-09-20'; // five nights

/** A published listing through the real lifecycle, including moderation. */
async function published(overrides: Record<string, unknown> = {}) {
  const landlord = await api.signUp();
  const created = await api.post('/listings', { ...LISTING, ...overrides }, { token: landlord.token });
  expect(created.status).toBe(201);
  const listingId = created.body.id as string;

  await api.post(
    `/listings/${listingId}/photos`,
    { storageKey: `listings/${listingId}/a.jpg` },
    { token: landlord.token },
  );
  await api.post(`/listings/${listingId}/submit`, {}, { token: landlord.token });

  const moderator = await api.signUp();
  await api.grantRole(moderator.userId, 'MODERATOR');
  const decided = await api.post(
    `/admin/moderation/listings/${listingId}`,
    { decision: 'PUBLISHED' },
    { token: moderator.token },
  );
  expect(decided.status).toBe(200);

  return { landlord, listingId };
}

/** A confirmed booking with the landlord and tenant tokens that own it. */
async function confirmed(overrides: Record<string, unknown> = {}) {
  const { landlord, listingId } = await published(overrides);
  const tenant = await api.signUp();

  const created = await api.post(
    '/bookings',
    { propertyId: listingId, from: FROM, to: TO, guests: 2 },
    { token: tenant.token },
  );
  expect(created.status).toBe(201);
  const bookingId = created.body.id as string;

  const accepted = await api.post(`/bookings/${bookingId}/accept`, {}, { token: landlord.token });
  expect(accepted.status).toBe(200);
  expect(accepted.body.status).toBe('CONFIRMED');

  return { landlord, tenant, listingId, bookingId };
}

/** Pretend the stay is over: the last night was yesterday. */
async function stayHasEnded(bookingId: string): Promise<void> {
  await db.query(
    `UPDATE booking
        SET stay_period = daterange((CURRENT_DATE - 6), (CURRENT_DATE - 1), '[)')
      WHERE id = $1`,
    [bookingId],
  );
}

/** Pretend the confirmation window has run out. */
async function windowHasClosed(bookingId: string): Promise<void> {
  await db.query(
    `UPDATE booking SET completion_deadline_at = now() - interval '1 hour' WHERE id = $1`,
    [bookingId],
  );
}

async function admin() {
  const staff = await api.signUp();
  await api.grantRole(staff.userId, 'ADMIN');
  return staff;
}

/** Run the scheduled lifecycle sweep the way a cron would. */
async function runSweep(token: string) {
  const res = await api.post('/admin/lifecycle/run', {}, { token });
  expect(res.status).toBe(200);
  return res.body;
}

async function statusOf(bookingId: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(`SELECT status FROM booking WHERE id=$1`, [bookingId]);
  return rows[0]!.status;
}

async function feesFor(bookingId: string) {
  const { rows } = await db.query<Record<string, string>>(
    `SELECT fee_minor::text AS fee_minor, base_minor::text AS base_minor, bps::text AS bps, status
       FROM service_fee WHERE booking_id=$1`,
    [bookingId],
  );
  return rows;
}

/* ================================================================== *
 * Reaching the completion window
 * ================================================================== */

describe('confirmed → active → completion pending', () => {
  it('lets the tenant check in and records the evidence', async () => {
    const { tenant, bookingId } = await confirmed();

    const res = await api.post(`/bookings/${bookingId}/check-in`, {}, { token: tenant.token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CHECKED_IN');
    expect(res.body.availableActions).toContain('CHECK_OUT');

    const { rows } = await db.query<Record<string, string>>(
      `SELECT kind, reported_by FROM stay_event WHERE booking_id=$1`,
      [bookingId],
    );
    expect(rows).toEqual([{ kind: 'CHECK_IN', reported_by: 'TENANT' }]);
  });

  it('lets the tenant check out, which opens the confirmation window', async () => {
    const { tenant, bookingId } = await confirmed();
    await api.post(`/bookings/${bookingId}/check-in`, {}, { token: tenant.token });

    const res = await api.post(`/bookings/${bookingId}/check-out`, {}, { token: tenant.token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETION_PENDING');
    // Opening the window is not completing the booking, and must not create
    // a fee on its own.
    expect(await feesFor(bookingId)).toHaveLength(0);
    expect(res.body.completion.deadlineAt).not.toBeNull();
  });

  it('refuses check-out from the landlord — it is the tenant’s statement', async () => {
    const { landlord, tenant, bookingId } = await confirmed();
    await api.post(`/bookings/${bookingId}/check-in`, {}, { token: tenant.token });

    const res = await api.post(`/bookings/${bookingId}/check-out`, {}, { token: landlord.token });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await statusOf(bookingId)).toBe('CHECKED_IN');
  });

  it('refuses check-out before check-in', async () => {
    const { tenant, bookingId } = await confirmed();
    const res = await api.post(`/bookings/${bookingId}/check-out`, {}, { token: tenant.token });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await statusOf(bookingId)).toBe('CONFIRMED');
  });

  it('opens the window from the sweep when nobody pressed anything', async () => {
    const { bookingId } = await confirmed();
    await stayHasEnded(bookingId);

    const result = await runSweep((await admin()).token);
    expect(result.staysEnded).toContain(bookingId);
    expect(await statusOf(bookingId)).toBe('COMPLETION_PENDING');
    // The sweep decides nothing about whether the rental happened.
    expect(await feesFor(bookingId)).toHaveLength(0);
  });

  it('does not touch a stay that has not ended yet', async () => {
    const { bookingId } = await confirmed();
    const result = await runSweep((await admin()).token);
    expect(result.staysEnded).not.toContain(bookingId);
    expect(await statusOf(bookingId)).toBe('CONFIRMED');
  });
});

/* ================================================================== *
 * Two-sided completion: the evidence rules over HTTP
 * ================================================================== */

/** A booking sitting in COMPLETION_PENDING, optionally with a check-in record. */
async function pending(opts: { checkIn?: boolean } = {}) {
  const ctx = await confirmed();
  if (opts.checkIn) {
    await api.post(`/bookings/${ctx.bookingId}/check-in`, {}, { token: ctx.tenant.token });
  }
  await stayHasEnded(ctx.bookingId);
  await runSweep((await admin()).token);
  expect(await statusOf(ctx.bookingId)).toBe('COMPLETION_PENDING');
  return ctx;
}

describe('two-sided completion', () => {
  it('completes on the landlord’s unopposed confirmation — admission against interest', async () => {
    const { landlord, bookingId } = await pending();

    const res = await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'TOOK_PLACE' },
      { token: landlord.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.feeAccrued).toBe(true);
  });

  it('waits for the second party when only the tenant has confirmed', async () => {
    const { tenant, bookingId } = await pending({ checkIn: true });

    const res = await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'TOOK_PLACE' },
      { token: tenant.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETION_PENDING');
    expect(res.body.feeAccrued).toBe(false);
    expect(await feesFor(bookingId)).toHaveLength(0);
  });

  it('completes on both confirmations', async () => {
    const { landlord, tenant, bookingId } = await pending({ checkIn: true });

    await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: tenant.token });
    const res = await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'TOOK_PLACE' },
      { token: landlord.token },
    );
    expect(res.body.status).toBe('COMPLETED');
    expect(await feesFor(bookingId)).toHaveLength(1);
  });

  it('does not let landlord silence avoid the fee once the window closes', async () => {
    const { tenant, bookingId } = await pending({ checkIn: true });
    await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: tenant.token });
    await windowHasClosed(bookingId);

    const result = await runSweep((await admin()).token);
    expect(result.completionsResolved).toEqual([
      { id: bookingId, status: 'COMPLETED', feeAccrued: true },
    ]);
  });

  it('charges nothing when the tenant says the rental did not happen', async () => {
    const { tenant, bookingId } = await pending();
    await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'DID_NOT_TAKE_PLACE' },
      { token: tenant.token },
    );
    await windowHasClosed(bookingId);
    await runSweep((await admin()).token);

    expect(await statusOf(bookingId)).toBe('NOT_TAKEN_PLACE');
    expect(await feesFor(bookingId)).toHaveLength(0);
  });

  it('honours a lone landlord denial but records it as a fraud signal', async () => {
    const { landlord, bookingId } = await pending();
    await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'DID_NOT_TAKE_PLACE' },
      { token: landlord.token },
    );
    await windowHasClosed(bookingId);
    await runSweep((await admin()).token);

    expect(await statusOf(bookingId)).toBe('NOT_TAKEN_PLACE');
    expect(await feesFor(bookingId)).toHaveLength(0);

    const { rows } = await db.query<{ kind: string; user_id: string }>(
      `SELECT kind, user_id FROM fraud_signal WHERE booking_id=$1`,
      [bookingId],
    );
    expect(rows.map((r) => r.kind)).toEqual(['UNILATERAL_LANDLORD_DENIAL']);
    expect(rows[0]!.user_id).toBe(landlord.userId);
  });

  it('escalates a contradiction instead of charging anybody', async () => {
    const { landlord, tenant, bookingId } = await pending({ checkIn: true });

    await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: tenant.token });
    const res = await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'DID_NOT_TAKE_PLACE' },
      { token: landlord.token },
    );

    expect(res.body.status).toBe('DISPUTED');
    expect(await feesFor(bookingId)).toHaveLength(0);
  });

  it('charges on total silence only when the platform holds a check-in record', async () => {
    const withRecord = await pending({ checkIn: true });
    const withoutRecord = await pending();
    await windowHasClosed(withRecord.bookingId);
    await windowHasClosed(withoutRecord.bookingId);

    await runSweep((await admin()).token);

    expect(await statusOf(withRecord.bookingId)).toBe('COMPLETED');
    expect(await feesFor(withRecord.bookingId)).toHaveLength(1);

    // No answers and no evidence: the platform is claiming money from a
    // person, so the burden is ours.
    expect(await statusOf(withoutRecord.bookingId)).toBe('NOT_TAKEN_PLACE');
    expect(await feesFor(withoutRecord.bookingId)).toHaveLength(0);
    const { rows } = await db.query<{ kind: string }>(
      `SELECT kind FROM fraud_signal WHERE booking_id=$1`,
      [withoutRecord.bookingId],
    );
    expect(rows.map((r) => r.kind)).toEqual(['SILENT_COMPLETION_NO_EVIDENCE']);
  });

  it('opens the review window when — and only when — the rental completed', async () => {
    const done = await pending();
    await api.post(
      `/bookings/${done.bookingId}/completion`,
      { answer: 'TOOK_PLACE' },
      { token: done.landlord.token },
    );

    const notDone = await pending();
    await api.post(
      `/bookings/${notDone.bookingId}/completion`,
      { answer: 'DID_NOT_TAKE_PLACE' },
      { token: notDone.tenant.token },
    );
    await windowHasClosed(notDone.bookingId);
    await runSweep((await admin()).token);

    const { rows } = await db.query<{ id: string; review_deadline_at: string | null }>(
      `SELECT id, review_deadline_at FROM booking WHERE id = ANY($1::uuid[])`,
      [[done.bookingId, notDone.bookingId]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.review_deadline_at]));
    // Without this the landlord's review prompt never appears and a one-sided
    // review can never publish.
    expect(byId.get(done.bookingId)).not.toBeNull();
    expect(byId.get(notDone.bookingId)).toBeNull();
  });
});

/* ================================================================== *
 * Completion: what must be refused
 * ================================================================== */

describe('completion authorization and idempotency', () => {
  it('refuses a stranger, with 404 rather than 403', async () => {
    const { bookingId } = await pending();
    const stranger = await api.signUp();

    const res = await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'TOOK_PLACE' },
      { token: stranger.token },
    );
    expect(res.status).toBe(404);
    expect(await statusOf(bookingId)).toBe('COMPLETION_PENDING');
  });

  it('refuses another landlord’s booking', async () => {
    const { bookingId } = await pending();
    const otherLandlord = await published();

    const res = await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'TOOK_PLACE' },
      { token: otherLandlord.landlord.token },
    );
    expect(res.status).toBe(404);
  });

  it('refuses completion before the stay has ended', async () => {
    const { tenant, bookingId } = await confirmed();
    const res = await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'TOOK_PLACE' },
      { token: tenant.token },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.errorCode).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses an unauthenticated caller', async () => {
    const { bookingId } = await pending();
    const res = await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' });
    expect(res.status).toBe(401);
  });

  it('treats a repeated identical answer as a no-op and never charges twice', async () => {
    const { landlord, bookingId } = await pending();

    for (let i = 0; i < 3; i += 1) {
      await api.post(
        `/bookings/${bookingId}/completion`,
        { answer: 'TOOK_PLACE' },
        { token: landlord.token },
      );
    }
    expect(await feesFor(bookingId)).toHaveLength(1);
    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_entry WHERE booking_id=$1 AND entry_type='FEE_ACCRUED'`,
      [bookingId],
    );
    expect(rows[0]!.c).toBe('1');
  });

  it('refuses a changed answer', async () => {
    const { tenant, bookingId } = await pending({ checkIn: true });
    await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: tenant.token });

    const res = await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'DID_NOT_TAKE_PLACE' },
      { token: tenant.token },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.errorCode).toBe('CONFLICT');
  });

  it('cannot be driven past the FSM by a second resolution', async () => {
    const { landlord, tenant, bookingId } = await pending();
    await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: landlord.token });
    expect(await statusOf(bookingId)).toBe('COMPLETED');

    // COMPLETED is terminal: no further completion answer is accepted from
    // either side, and the sweep leaves it alone.
    const res = await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'DID_NOT_TAKE_PLACE' },
      { token: tenant.token },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    await runSweep((await admin()).token);
    expect(await statusOf(bookingId)).toBe('COMPLETED');
    expect(await feesFor(bookingId)).toHaveLength(1);
  });

  it('needs the lifecycle.run permission to sweep', async () => {
    const nobody = await api.signUp();
    expect((await api.post('/admin/lifecycle/run', {}, { token: nobody.token })).status).toBe(403);

    const support = await api.signUp();
    await api.grantRole(support.userId, 'SUPPORT');
    expect((await api.post('/admin/lifecycle/run', {}, { token: support.token })).status).toBe(403);
  });
});

/* ================================================================== *
 * Problems
 * ================================================================== */

describe('reporting a problem', () => {
  it('opens a case, freezes the fee, and does not decide anything', async () => {
    const { tenant, bookingId } = await pending({ checkIn: true });

    const res = await api.post(
      `/bookings/${bookingId}/dispute`,
      { category: 'LISTING_MISMATCH', summary: 'Квартира оказалась другой, фотографии не совпадают.' },
      { token: tenant.token },
    );
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DISPUTED');
    expect(res.body.case.reference).toMatch(/^SP-/);
    expect(await feesFor(bookingId)).toHaveLength(0);

    const { rows } = await db.query<{ status: string; resolution: string | null }>(
      `SELECT status, resolution FROM dispute_case WHERE booking_id=$1`,
      [bookingId],
    );
    // No automated resolution. A human decides.
    expect(rows[0]!.status).toBe('OPEN');
    expect(rows[0]!.resolution).toBeNull();
  });

  it('joins the existing case instead of opening a second one', async () => {
    const { landlord, tenant, bookingId } = await pending({ checkIn: true });
    const body = { category: 'CLEANLINESS' as const, summary: 'Квартира была не убрана при заселении.' };

    await api.post(`/bookings/${bookingId}/dispute`, body, { token: tenant.token });
    await api.post(
      `/bookings/${bookingId}/dispute`,
      { category: 'OTHER', summary: 'Со своей стороны добавляю подробности по этой ситуации.' },
      { token: landlord.token },
    );

    const cases = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM dispute_case WHERE booking_id=$1`,
      [bookingId],
    );
    const events = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM case_event WHERE case_id IN (SELECT id FROM dispute_case WHERE booking_id=$1)`,
      [bookingId],
    );
    expect(cases.rows[0]!.c).toBe('1');
    expect(events.rows[0]!.c).toBe('2');
  });

  it('refuses a stranger', async () => {
    const { bookingId } = await pending();
    const stranger = await api.signUp();
    const res = await api.post(
      `/bookings/${bookingId}/dispute`,
      { category: 'OTHER', summary: 'Хочу пожаловаться на это бронирование.' },
      { token: stranger.token },
    );
    expect(res.status).toBe(404);
    expect(await statusOf(bookingId)).toBe('COMPLETION_PENDING');
  });

  it('requires an actual description', async () => {
    const { tenant, bookingId } = await pending();
    const res = await api.post(
      `/bookings/${bookingId}/dispute`,
      { category: 'OTHER', summary: 'плохо' },
      { token: tenant.token },
    );
    expect(res.status).toBe(422);
  });
});

/* ================================================================== *
 * The fee
 * ================================================================== */

describe('the service fee', () => {
  it('is exactly 5% of the rent, in minor units', async () => {
    const { landlord, bookingId } = await pending();
    await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: landlord.token });

    const [fee] = await feesFor(bookingId);
    // 5 nights × 100.00 = 500.00 BYN base; 5% = 25.00 BYN.
    expect(fee!.base_minor).toBe('50000');
    expect(fee!.bps).toBe('500');
    expect(fee!.fee_minor).toBe('2500');
    expect(fee!.status).toBe('PAYABLE');
  });

  it('rounds half-up on an amount that does not divide evenly', async () => {
    // 3 nights × 33.33 = 99.99 → 5% = 4.9995 → 5.00, in integer kopecks.
    const { landlord, listingId } = await published({ basePriceMinor: '3333', minNights: 1 });
    const guest = await api.signUp();
    const booking = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2027-11-01', to: '2027-11-04' },
      { token: guest.token },
    );
    const bookingId = booking.body.id as string;
    await api.post(`/bookings/${bookingId}/accept`, {}, { token: landlord.token });
    await stayHasEnded(bookingId);
    await runSweep((await admin()).token);
    await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: landlord.token });

    const [fee] = await feesFor(bookingId);
    expect(fee!.base_minor).toBe('9999');
    expect(fee!.fee_minor).toBe('500');
  });

  it('appears on the landlord ledger and nowhere on the tenant’s', async () => {
    const { landlord, tenant, bookingId } = await pending();
    await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: landlord.token });

    const landlordBalance = await api.get('/me/balance', { token: landlord.token });
    expect(landlordBalance.status).toBe(200);
    expect(landlordBalance.body.balanceMinor).toBe('-2500');
    expect(landlordBalance.body.hasDebt).toBe(true);
    expect(landlordBalance.body.outstandingFees).toBe(1);

    const tenantBalance = await api.get('/me/balance', { token: tenant.token });
    expect(tenantBalance.body.balanceMinor).toBe('0');
    expect(tenantBalance.body.entries).toHaveLength(0);

    const fees = await api.get('/me/fees', { token: landlord.token });
    expect(fees.body).toHaveLength(1);
    // The arithmetic is recomputed from the stored inputs and shown, so the
    // person being charged can check it.
    expect(fees.body[0].arithmeticVerified).toBe(true);
    expect(fees.body[0].explanation).toContain('5%');

    const tenantFees = await api.get('/me/fees', { token: tenant.token });
    expect(tenantFees.body).toHaveLength(0);
  });

  it('cannot be fabricated or altered from client input', async () => {
    const { landlord, tenant, bookingId } = await pending();

    // No route exists for a landlord to write their own ledger or fee, and the
    // staff ones refuse a caller without the permission.
    expect(
      (await api.post(`/admin/finance/${landlord.userId}/adjustments`, { amountMinor: '100000', reason: 'x' }, { token: landlord.token })).status,
    ).toBe(403);
    expect(
      (await api.post(`/admin/finance/${landlord.userId}/payments`, { amountMinor: '100000', reference: 'x' }, { token: tenant.token })).status,
    ).toBe(403);

    // A tenant cannot make somebody else's fee appear by claiming completion
    // with a forged body: the answer is the only field, and the amount comes
    // from the frozen booking terms.
    const res = await api.post(
      `/bookings/${bookingId}/completion`,
      { answer: 'TOOK_PLACE', feeMinor: '999999', baseMinor: '999999' },
      { token: tenant.token },
    );
    expect(res.status).toBe(200);
    expect(await feesFor(bookingId)).toHaveLength(0); // still waiting on the landlord
  });

  it('does not disrupt an active rental when the landlord is in debt', async () => {
    // First rental completes and leaves a debt over the restriction threshold.
    const first = await pending();
    await api.post(
      `/bookings/${first.bookingId}/completion`,
      { answer: 'TOOK_PLACE' },
      { token: first.landlord.token },
    );
    await db.query(
      `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, reason, created_by)
       VALUES ($1,'ADJUSTMENT','-500000','долг для теста',$1)`,
      [first.landlord.userId],
    );
    await db.query(`UPDATE service_fee SET due_at = now() - interval '1 day' WHERE landlord_id=$1`, [
      first.landlord.userId,
    ]);

    const restrictions = await api.get('/me/balance', { token: first.landlord.token });
    expect(restrictions.body.restrictions).toContain('CANNOT_ACCEPT_NEW_BOOKINGS');

    // A NEW booking cannot be accepted...
    const newTenant = await api.signUp();
    const fresh = await api.post(
      '/bookings',
      { propertyId: first.listingId, from: '2027-12-01', to: '2027-12-05' },
      { token: newTenant.token },
    );
    expect(
      (await api.post(`/bookings/${fresh.body.id}/accept`, {}, { token: first.landlord.token })).status,
    ).toBe(403);

    // ...but an ALREADY ACTIVE rental keeps working end to end: DEC-022. The
    // tenant did nothing wrong and must not lose their stay over the
    // landlord's balance.
    const second = await confirmed();
    await db.query(
      `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, reason, created_by)
       VALUES ($1,'ADJUSTMENT','-500000','долг для теста',$1)`,
      [second.landlord.userId],
    );
    await db.query(
      `INSERT INTO service_fee (id, booking_id, landlord_id, base_minor, bps, fee_minor, due_at)
       SELECT $1, id, landlord_id, 50000, 500, 2500, now() - interval '1 day'
         FROM booking WHERE id=$2`,
      [randomUUID(), second.bookingId],
    );

    expect(
      (await api.post(`/bookings/${second.bookingId}/check-in`, {}, { token: second.tenant.token })).status,
    ).toBe(200);
    await stayHasEnded(second.bookingId);
    expect(
      (await api.post(`/bookings/${second.bookingId}/check-out`, {}, { token: second.tenant.token })).status,
    ).toBe(200);
    expect(
      (await api.post(`/bookings/${second.bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: second.landlord.token })).status,
    ).toBe(200);
    expect(await statusOf(second.bookingId)).toBe('COMPLETED');
  });
});

/* ================================================================== *
 * Reviews
 * ================================================================== */

/** A completed booking, ready to be reviewed by either side. */
async function completed() {
  const ctx = await pending({ checkIn: true });
  await api.post(
    `/bookings/${ctx.bookingId}/completion`,
    { answer: 'TOOK_PLACE' },
    { token: ctx.landlord.token },
  );
  expect(await statusOf(ctx.bookingId)).toBe('COMPLETED');
  return ctx;
}

const TENANT_REVIEW = {
  role: 'TENANT' as const,
  overall: 5,
  cleanliness: 5,
  accuracy: 4,
  communication: 5,
  checkIn: 5,
  location: 4,
  body: 'Всё совпало с описанием, заселение прошло быстро.',
  wouldRentAgain: true,
  confirmedFacts: { WIFI: true },
};

const LANDLORD_REVIEW = {
  role: 'LANDLORD' as const,
  overall: 5,
  communication: 5,
  ruleCompliance: 5,
  propertyCondition: 4,
  timeliness: 5,
  body: 'Аккуратные гости, всё оставили в порядке.',
};

describe('review eligibility', () => {
  it('refuses before the rental is completed', async () => {
    const { tenant, bookingId } = await pending();

    const eligibility = await api.get(`/bookings/${bookingId}/review-eligibility`, { token: tenant.token });
    expect(eligibility.body).toMatchObject({ canReview: false, reason: 'RENTAL_NOT_COMPLETED' });

    const submitted = await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    expect(submitted.status).toBeGreaterThanOrEqual(400);
    const { rows } = await db.query(`SELECT id FROM review WHERE booking_id=$1`, [bookingId]);
    expect(rows).toHaveLength(0);
  });

  it('refuses after a cancellation', async () => {
    const { tenant, bookingId } = await confirmed();
    expect((await api.post(`/bookings/${bookingId}/cancel`, {}, { token: tenant.token })).status).toBe(200);

    const eligibility = await api.get(`/bookings/${bookingId}/review-eligibility`, { token: tenant.token });
    expect(eligibility.body.canReview).toBe(false);
    expect((await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token })).status)
      .toBeGreaterThanOrEqual(400);
  });

  it('refuses a stranger with 404 rather than 403', async () => {
    const { bookingId } = await completed();
    const stranger = await api.signUp();

    expect((await api.get(`/bookings/${bookingId}/review-eligibility`, { token: stranger.token })).body)
      .toMatchObject({ canReview: false, role: null });
    expect((await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: stranger.token })).status)
      .toBeGreaterThanOrEqual(400);
  });

  it('closes after the window expires', async () => {
    const { tenant, bookingId } = await completed();
    await db.query(`UPDATE booking SET review_deadline_at = now() - interval '1 day' WHERE id=$1`, [bookingId]);

    const eligibility = await api.get(`/bookings/${bookingId}/review-eligibility`, { token: tenant.token });
    expect(eligibility.body).toMatchObject({ canReview: false, reason: 'WINDOW_CLOSED' });
    expect((await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token })).status)
      .toBeGreaterThanOrEqual(400);
  });

  it('makes each side independently eligible', async () => {
    const { landlord, tenant, bookingId } = await completed();

    for (const [token, role] of [
      [tenant.token, 'TENANT'],
      [landlord.token, 'LANDLORD'],
    ] as const) {
      const res = await api.get(`/bookings/${bookingId}/review-eligibility`, { token });
      expect(res.body).toMatchObject({ canReview: true, role });
    }
  });
});

describe('two-sided reviews', () => {
  it('holds the first review back and publishes both at once', async () => {
    const { landlord, tenant, bookingId } = await completed();

    const first = await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    expect(first.status).toBe(201);
    // Not published: publishing now would let the landlord read the tenant's
    // rating before writing their own, which is the retaliation the delay
    // exists to prevent.
    expect(first.body.published).toBe(false);

    const listing = await api.get(`/listings/${(await db.query<{ property_id: string }>(
      `SELECT property_id FROM booking WHERE id=$1`,
      [bookingId],
    )).rows[0]!.property_id}/reviews`);
    expect(listing.body.reviews).toHaveLength(0);

    const second = await api.post(`/bookings/${bookingId}/reviews`, LANDLORD_REVIEW, { token: landlord.token });
    expect(second.body.published).toBe(true);

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM review WHERE booking_id=$1`,
      [bookingId],
    );
    expect(rows.map((r) => r.status).sort()).toEqual(['PUBLISHED', 'PUBLISHED']);
  });

  it('publishes a lone review once the window closes, so silence cannot suppress it', async () => {
    const { tenant, bookingId } = await completed();
    await api.post(`/bookings/${bookingId}/reviews`, { ...TENANT_REVIEW, overall: 2, body: 'Квартира сильно отличалась от фотографий, было холодно.' }, { token: tenant.token });

    await db.query(`UPDATE booking SET review_deadline_at = now() - interval '1 day' WHERE id=$1`, [bookingId]);
    const result = await runSweep((await admin()).token);
    expect(result.reviewsPublished).toBe(1);

    const { rows } = await db.query<{ status: string }>(`SELECT status FROM review WHERE booking_id=$1`, [
      bookingId,
    ]);
    expect(rows.map((r) => r.status)).toEqual(['PUBLISHED']);
  });

  it('rejects a duplicate from the same side', async () => {
    const { tenant, bookingId } = await completed();
    expect((await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token })).status).toBe(201);

    const again = await api.post(
      `/bookings/${bookingId}/reviews`,
      { ...TENANT_REVIEW, overall: 1, body: 'Передумал(а), всё было плохо и очень грязно.' },
      { token: tenant.token },
    );
    expect(again.status).toBeGreaterThanOrEqual(400);
    const { rows } = await db.query<{ overall: number }>(
      `SELECT overall FROM review WHERE booking_id=$1 AND author_role='TENANT'`,
      [bookingId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.overall).toBe(5);
  });

  it('never lets a review point at the author', async () => {
    const { landlord, tenant, bookingId } = await completed();
    await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    await api.post(`/bookings/${bookingId}/reviews`, LANDLORD_REVIEW, { token: landlord.token });

    const { rows } = await db.query<{ author_id: string; subject_id: string }>(
      `SELECT author_id, subject_id FROM review WHERE booking_id=$1`,
      [bookingId],
    );
    for (const r of rows) expect(r.author_id).not.toBe(r.subject_id);
    expect(new Set(rows.map((r) => r.subject_id))).toEqual(new Set([landlord.userId, tenant.userId]));
  });
});

describe('review content', () => {
  it('requires the dimensions that side is responsible for', async () => {
    const { tenant, bookingId } = await completed();
    const { role, cleanliness, ...withoutCleanliness } = TENANT_REVIEW;
    void role;
    void cleanliness;

    const res = await api.post(
      `/bookings/${bookingId}/reviews`,
      { role: 'TENANT', ...withoutCleanliness },
      { token: tenant.token },
    );
    expect(res.status).toBe(422);
  });

  it('drops the other side’s dimensions rather than storing them', async () => {
    const { tenant, bookingId } = await completed();
    const res = await api.post(
      `/bookings/${bookingId}/reviews`,
      { ...TENANT_REVIEW, ruleCompliance: 5, propertyCondition: 1 },
      { token: tenant.token },
    );
    // The schema strips unknown keys rather than rejecting them, which is fine
    // here as long as nothing reaches the row: the table's CHECK constraint
    // requires each role to fill its own dimension set and nothing from the
    // other's, so a stored value would be a hard failure rather than a mix-up.
    expect(res.status).toBe(201);
    const { rows } = await db.query<Record<string, number | null>>(
      `SELECT rule_compliance, property_condition, cleanliness FROM review WHERE booking_id=$1`,
      [bookingId],
    );
    expect(rows[0]).toMatchObject({ rule_compliance: null, property_condition: null, cleanliness: 5 });
  });

  it('refuses an out-of-range rating', async () => {
    const { tenant, bookingId } = await completed();
    for (const overall of [0, 6, 4.5]) {
      const res = await api.post(
        `/bookings/${bookingId}/reviews`,
        { ...TENANT_REVIEW, overall },
        { token: tenant.token },
      );
      expect(res.status, String(overall)).toBe(422);
    }
  });

  it('refuses a harsh rating with no explanation', async () => {
    const { tenant, bookingId } = await completed();
    const res = await api.post(
      `/bookings/${bookingId}/reviews`,
      { ...TENANT_REVIEW, overall: 1, body: '' },
      { token: tenant.token },
    );
    expect(res.status).toBe(422);
  });

  it('strips contact details from review text', async () => {
    const { tenant, bookingId } = await completed();
    await api.post(
      `/bookings/${bookingId}/reviews`,
      {
        ...TENANT_REVIEW,
        body: 'Хорошая квартира, пишите мне напрямую +375 29 765-43-21 или на my.mail@example.com',
      },
      { token: tenant.token },
    );

    const { rows } = await db.query<{ body: string; moderation_note: string | null }>(
      `SELECT body, moderation_note FROM review WHERE booking_id=$1`,
      [bookingId],
    );
    expect(rows[0]!.body).not.toContain('765-43-21');
    expect(rows[0]!.body).not.toContain('my.mail@example.com');
    expect(rows[0]!.body).toContain('Хорошая квартира');
    // The redaction is recorded so a moderator can see a pattern of it.
    expect(rows[0]!.moderation_note).toContain('удалены автоматически');
  });

  it('derives the stay length from the booking and never publishes exact dates', async () => {
    const { landlord, tenant, bookingId } = await completed();
    await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    await api.post(`/bookings/${bookingId}/reviews`, LANDLORD_REVIEW, { token: landlord.token });

    const { rows } = await db.query<{ property_id: string; stay_from: string; stay_to: string }>(
      `SELECT property_id,
              lower(stay_period)::text AS stay_from,
              upper(stay_period)::text AS stay_to
         FROM booking WHERE id=$1`,
      [bookingId],
    );
    const res = await api.get(`/listings/${rows[0]!.property_id}/reviews`);
    const [review] = res.body.reviews;

    // Derived, not asked for: the form never collects a duration.
    expect(review.stayLength).toMatch(/ноч/);
    expect(review.stayLength).toContain('5');

    /* Publishing exactly when a home stood empty is a security problem, not a
       feature. The publication date is fine — it says nothing about the
       property — and it is stripped before the search rather than merely
       excluded in a comment.

       It has to be. `publishedAt` is the moment the review went live, and the
       fixture's stay ends today, so on any day where those coincide a bare
       substring search finds "today" inside `publishedAt` and reports a leak
       that is not there. The assertion said one thing and tested another; this
       makes it test what it says, on every day of the year. */
    const withoutPublicationDates = JSON.stringify(res.body).replaceAll(
      /"publishedAt":"[^"]*"/g,
      '"publishedAt":"<redacted>"',
    );
    expect(withoutPublicationDates).not.toContain(rows[0]!.stay_from);
    expect(withoutPublicationDates).not.toContain(rows[0]!.stay_to);
  });

  it('summarises dimensions across every published review, not one page of them', async () => {
    const { landlord, tenant, bookingId } = await completed();
    await api.post(`/bookings/${bookingId}/reviews`, { ...TENANT_REVIEW, cleanliness: 3 }, { token: tenant.token });
    await api.post(`/bookings/${bookingId}/reviews`, LANDLORD_REVIEW, { token: landlord.token });

    const { rows } = await db.query<{ property_id: string }>(
      `SELECT property_id FROM booking WHERE id=$1`,
      [bookingId],
    );
    const res = await api.get(`/listings/${rows[0]!.property_id}/reviews`);
    expect(res.body.summary.count).toBe(1);
    expect(res.body.summary.dimensions.cleanliness).toMatchObject({ average: 3, count: 1 });
    // The landlord's review of the tenant is not part of the listing's rating.
    expect(res.body.reviews).toHaveLength(1);
  });

  it('aggregates the facts guests confirmed', async () => {
    const { landlord, tenant, bookingId } = await completed();
    await api.post(
      `/bookings/${bookingId}/reviews`,
      { ...TENANT_REVIEW, confirmedFacts: { WIFI: true, WASHING_MACHINE: false } },
      { token: tenant.token },
    );
    await api.post(`/bookings/${bookingId}/reviews`, LANDLORD_REVIEW, { token: landlord.token });

    const { rows } = await db.query<{ property_id: string }>(
      `SELECT property_id FROM booking WHERE id=$1`,
      [bookingId],
    );
    const res = await api.get(`/listings/${rows[0]!.property_id}/reviews`);
    expect(res.body.confirmedFacts).toMatchObject({
      WIFI: { confirmed: 1, total: 1 },
      WASHING_MACHINE: { confirmed: 0, total: 1 },
    });
  });
});

describe('reporting a review', () => {
  it('files a report without hiding the review', async () => {
    const { landlord, tenant, bookingId } = await completed();
    await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    await api.post(`/bookings/${bookingId}/reviews`, LANDLORD_REVIEW, { token: landlord.token });

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM review WHERE booking_id=$1 AND author_role='TENANT'`,
      [bookingId],
    );
    const reviewId = rows[0]!.id;

    const res = await api.post(
      `/reviews/${reviewId}/report`,
      { category: 'FALSE_INFORMATION', detail: 'Описанного не происходило.' },
      { token: landlord.token },
    );
    expect(res.status).toBe(201);

    // Reporting must not be a way to suppress a rating you dislike.
    const after = await db.query<{ status: string }>(`SELECT status FROM review WHERE id=$1`, [reviewId]);
    expect(after.rows[0]!.status).toBe('PUBLISHED');

    const report = await db.query<{ target_type: string; status: string }>(
      `SELECT target_type, status FROM report WHERE target_id=$1`,
      [reviewId],
    );
    expect(report.rows[0]).toMatchObject({ target_type: 'REVIEW', status: 'OPEN' });
  });

  it('refuses reporting your own review, and an unpublished one', async () => {
    const { tenant, bookingId } = await completed();
    await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM review WHERE booking_id=$1`, [bookingId]);
    const reviewId = rows[0]!.id;

    // Still PENDING — whether an unpublished review exists is exactly what the
    // publication delay hides, so this is 404, not 403.
    const other = await api.signUp();
    expect((await api.post(`/reviews/${reviewId}/report`, { category: 'SPAM' }, { token: other.token })).status).toBe(404);

    await db.query(`UPDATE review SET status='PUBLISHED', published_at=now() WHERE id=$1`, [reviewId]);
    expect((await api.post(`/reviews/${reviewId}/report`, { category: 'SPAM' }, { token: tenant.token })).status).toBe(422);
  });
});

/* ================================================================== *
 * Trust and dashboards
 * ================================================================== */

describe('trust profile after a completed rental', () => {
  it('counts the rental for both sides and publishes the rating', async () => {
    const { landlord, tenant, bookingId } = await completed();

    const before = await api.get(`/profiles/${landlord.userId}`);
    expect(before.body.completedRentalsAsLandlord).toBe(1);
    expect(before.body.rating).toBeNull();

    await api.post(`/bookings/${bookingId}/reviews`, { ...TENANT_REVIEW, overall: 4 }, { token: tenant.token });
    await api.post(`/bookings/${bookingId}/reviews`, LANDLORD_REVIEW, { token: landlord.token });

    const landlordProfile = await api.get(`/profiles/${landlord.userId}`);
    expect(landlordProfile.body.rating).toBe(4);
    expect(landlordProfile.body.reviewCount).toBe(1);
    expect(landlordProfile.body.completedRentalsAsLandlord).toBe(1);

    const tenantProfile = await api.get(`/profiles/${tenant.userId}`);
    expect(tenantProfile.body.rating).toBe(5);
    expect(tenantProfile.body.completedRentalsAsTenant).toBe(1);
  });

  it('exposes no private data on a public profile', async () => {
    const { landlord, tenant, bookingId } = await completed();
    await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });

    const res = await api.get(`/profiles/${tenant.userId}`);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(tenant.email);
    expect(serialised).not.toContain('@example.by');
    // The score is returned; the counterparties and bookings are not.
    expect(serialised).not.toContain(bookingId);
    expect(serialised).not.toContain(landlord.userId);
  });
});

describe('dashboards prompt for what is outstanding', () => {
  it('shows the landlord a completion prompt, then a review prompt, then the debt', async () => {
    const { landlord, bookingId } = await pending({ checkIn: true });

    const waiting = await api.get('/dashboard/summary', { token: landlord.token });
    const kinds = (waiting.body.attention as { kind: string; href: string }[]).map((a) => a.kind);
    expect(kinds).toContain('CONFIRM_COMPLETION');

    await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: landlord.token });

    const after = await api.get('/dashboard/summary', { token: landlord.token });
    const items = after.body.attention as { kind: string; href: string }[];
    // This is the one the missing review window silently disabled: the count
    // requires a live `review_deadline_at`.
    expect(items.map((a) => a.kind)).toContain('REVIEW_PENDING');
    expect(items.map((a) => a.kind)).toContain('OUTSTANDING_DEBT');
    // Every attention href must point at a real tab on /dashboard/bookings.
    for (const item of items) {
      const match = /\/dashboard\/bookings\?status=(\w+)/.exec(item.href);
      if (match) expect(['REQUESTED', 'CONFIRMED', 'ACTIVE', 'COMPLETION', 'HISTORY']).toContain(match[1]);
    }
  });

  it('lists pending reviews per user and never leaks another user’s', async () => {
    const { landlord, tenant } = await completed();

    const tenantPending = await api.get('/me/reviews/pending', { token: tenant.token });
    expect(tenantPending.body).toHaveLength(1);
    expect(tenantPending.body[0].role).toBe('TENANT');

    const landlordPending = await api.get('/me/reviews/pending', { token: landlord.token });
    expect(landlordPending.body).toHaveLength(1);
    expect(landlordPending.body[0].role).toBe('LANDLORD');

    const stranger = await api.signUp();
    expect((await api.get('/me/reviews/pending', { token: stranger.token })).body).toHaveLength(0);
  });

  it('drops the prompt once that side has written', async () => {
    const { tenant, bookingId } = await completed();
    await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    expect((await api.get('/me/reviews/pending', { token: tenant.token })).body).toHaveLength(0);
  });
});
