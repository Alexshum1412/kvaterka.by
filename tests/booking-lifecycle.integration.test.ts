/**
 * End-to-end booking lifecycle against a real PostgreSQL engine.
 *
 * This is the test that proves the core loop is actually connected:
 *   listing → request → acceptance → check-in → completion → fee → ledger → audit.
 * Nothing is mocked; every assertion reads back what the database really holds.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { BookingService } from '@/server/services/booking-service.ts';
import { DomainError } from '@/server/services/errors.ts';
import { toDecimalString, fromStorage } from '@/server/domain/money.ts';
import { verifyStoredFee } from '@/server/domain/pricing.ts';
import { uuidv7 } from '@/lib/id.ts';

let db: TestDb;
let service: BookingService;

beforeAll(async () => {
  db = await createTestDb();
  service = new BookingService(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

let landlord: string;
let tenant: string;
let otherTenant: string;
let property: string;

beforeEach(async () => {
  await db.truncateAll();
  landlord = await user('Алесь Уладальнік');
  tenant = await user('Ірына Арандатар');
  otherTenant = await user('Другі Арандатар');
  property = await publishedProperty(landlord);
});

async function user(name: string): Promise<string> {
  const id = uuidv7();
  // The full id, not a prefix: UUIDv7 is time-ordered, so ids minted in the
  // same millisecond share their leading hex digits.
  await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,$3)`, [
    id,
    `${id}@example.by`,
    name,
  ]);
  return id;
}

async function publishedProperty(ownerId: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO property (id, owner_id, title, city, property_type, latitude, longitude,
        public_latitude, public_longitude, base_price_minor, price_unit, cleaning_fee_minor,
        deposit_minor, min_nights, max_nights, max_guests, booking_mode, status, published_at)
     VALUES ($1,$2,'Светлая квартира у метро Немига','Минск','APARTMENT',
        53.9045,27.5615,53.9048,27.5611,$3,$4,$5,$6,$7,$8,$9,$10,'PUBLISHED',now())`,
    [
      id,
      ownerId,
      over.basePrice ?? 8000, // 80.00 BYN / night
      over.priceUnit ?? 'NIGHT',
      over.cleaning ?? 3000, // 30.00 BYN
      over.deposit ?? 30000, // 300.00 BYN, refundable
      over.minNights ?? 1,
      over.maxNights ?? 365,
      over.maxGuests ?? 4,
      over.bookingMode ?? 'INSTANT_AND_REQUEST',
    ],
  );
  return id;
}

const ledgerBalance = async (userId: string): Promise<bigint> => {
  const { rows } = await db.query<{ balance: string }>(
    `SELECT COALESCE(SUM(amount_minor),0)::text AS balance FROM ledger_entry WHERE landlord_id = $1`,
    [userId],
  );
  return BigInt(rows[0]!.balance);
};

const countRows = async (table: string, where: string, params: unknown[]): Promise<number> => {
  const { rows } = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM ${table} WHERE ${where}`, params);
  return Number(rows[0]!.c);
};

/* ================================================================== */

describe('the full happy path', () => {
  it('carries a rental from request to fee and leaves a complete trail', async () => {
    // 1. Tenant requests 7 nights.
    const booking = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
      guests: 2,
    });
    expect(booking.status).toBe('REQUESTED');

    // Quote: 7 x 80.00 rent + 30.00 cleaning = 590.00 expected; deposit excluded.
    expect(toDecimalString(fromStorage(booking.total_expected_minor))).toBe('590.00');
    expect(toDecimalString(fromStorage(booking.fee_base_minor))).toBe('590.00');

    // A request must not hold the calendar yet.
    expect(await countRows('booking', "status='REQUESTED' AND id=$1", [booking.id])).toBe(1);

    // 2. Landlord accepts.
    const accepted = await service.acceptRequest(booking.id, landlord);
    expect(accepted.status).toBe('CONFIRMED');

    // Contact details unlock exactly at confirmation, and it is recorded.
    const conv = await db.query<{ contact_release_state: string; contact_released_at: string | null }>(
      `SELECT contact_release_state, contact_released_at FROM conversation WHERE booking_id=$1`,
      [booking.id],
    );
    expect(conv.rows[0]!.contact_release_state).toBe('RELEASED');
    expect(conv.rows[0]!.contact_released_at).not.toBeNull();

    // 3. Tenant checks in.
    expect((await service.checkIn(booking.id, tenant)).status).toBe('CHECKED_IN');

    // 4. Stay ends.
    expect((await service.openCompletionWindow(booking.id)).status).toBe('COMPLETION_PENDING');

    // 5. Both sides confirm the rental happened.
    const first = await service.confirmCompletion(booking.id, tenant, 'TOOK_PLACE');
    expect(first.booking.status).toBe('COMPLETION_PENDING'); // still waiting for the landlord
    expect(first.feeAccrued).toBe(false);

    const second = await service.confirmCompletion(booking.id, landlord, 'TOOK_PLACE');
    expect(second.booking.status).toBe('COMPLETED');
    expect(second.feeAccrued).toBe(true);

    // 6. The fee is exactly 5% of the frozen base and is reproducible.
    const fee = await db.query<{ base_minor: string; bps: number; fee_minor: string; status: string }>(
      `SELECT base_minor::text, bps, fee_minor::text, status FROM service_fee WHERE booking_id=$1`,
      [booking.id],
    );
    expect(fee.rows).toHaveLength(1);
    expect(toDecimalString(fromStorage(fee.rows[0]!.fee_minor))).toBe('29.50');
    expect(verifyStoredFee(BigInt(fee.rows[0]!.base_minor), fee.rows[0]!.bps, BigInt(fee.rows[0]!.fee_minor))).toBe(
      true,
    );

    // 7. The landlord's balance is now a debt of exactly that fee.
    expect(await ledgerBalance(landlord)).toBe(-2950n);

    // 8. Completed-rental counters moved on both sides.
    const counts = await db.query<{ t: number; l: number }>(
      `SELECT (SELECT completed_rentals_as_tenant FROM app_user WHERE id=$1) AS t,
              (SELECT completed_rentals_as_landlord FROM app_user WHERE id=$2) AS l`,
      [tenant, landlord],
    );
    expect(Number(counts.rows[0]!.t)).toBe(1);
    expect(Number(counts.rows[0]!.l)).toBe(1);

    // 9. Every transition left an immutable event, and the money left an audit row.
    const events = await db.query<{ event_type: string; to_status: string }>(
      `SELECT event_type, to_status FROM booking_event WHERE booking_id=$1 ORDER BY id`,
      [booking.id],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual([
      'REQUEST',
      'ACCEPT_REQUEST',
      'CHECK_IN',
      'REACH_STAY_END',
      'CONFIRM_COMPLETION',
      'CONFIRM_COMPLETION',
      'RESOLVE_COMPLETION',
    ]);
    expect(await countRows('audit_log', `action='fee.accrue'`, [])).toBe(1);
  });

  it('completes an instant booking without landlord action', async () => {
    const booking = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-10-01',
      to: '2026-10-05',
      instant: true,
    });
    expect(booking.status).toBe('CONFIRMED');
    const conv = await db.query<{ contact_release_state: string }>(
      `SELECT contact_release_state FROM conversation WHERE booking_id=$1`,
      [booking.id],
    );
    expect(conv.rows[0]!.contact_release_state).toBe('RELEASED');
  });
});

/* ================================================================== */

describe('the service fee can never be charged twice', () => {
  async function bookingReadyForCompletion(): Promise<string> {
    const b = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    await service.acceptRequest(b.id, landlord);
    await service.checkIn(b.id, tenant);
    await service.openCompletionWindow(b.id);
    return b.id;
  }

  it('ignores a repeated confirmation from the same party', async () => {
    const id = await bookingReadyForCompletion();
    await service.confirmCompletion(id, tenant, 'TOOK_PLACE');
    await service.confirmCompletion(id, tenant, 'TOOK_PLACE');
    await service.confirmCompletion(id, tenant, 'TOOK_PLACE');

    expect(await countRows('service_fee', 'booking_id=$1', [id])).toBe(0); // landlord has not answered
    const events = await countRows('booking_event', `booking_id=$1 AND event_type='CONFIRM_COMPLETION'`, [id]);
    expect(events).toBe(1); // the repeats were no-ops
  });

  it('creates exactly one fee no matter how often completion is resolved', async () => {
    const id = await bookingReadyForCompletion();
    await service.confirmCompletion(id, tenant, 'TOOK_PLACE');
    const r1 = await service.confirmCompletion(id, landlord, 'TOOK_PLACE');
    expect(r1.feeAccrued).toBe(true);

    // Retries after completion must not charge again.
    await expect(service.confirmCompletion(id, landlord, 'TOOK_PLACE')).rejects.toThrow(DomainError);
    await service.resolveExpiredCompletion(id);
    await service.resolveExpiredCompletion(id);

    expect(await countRows('service_fee', 'booking_id=$1', [id])).toBe(1);
    expect(await countRows('ledger_entry', `booking_id=$1 AND entry_type='FEE_ACCRUED'`, [id])).toBe(1);
    expect(await ledgerBalance(landlord)).toBe(-2950n);
  });

  it('refuses to change an answer once given', async () => {
    const id = await bookingReadyForCompletion();
    await service.confirmCompletion(id, landlord, 'DID_NOT_TAKE_PLACE');
    await expect(service.confirmCompletion(id, landlord, 'TOOK_PLACE')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('rejects completion confirmation before the stay has ended', async () => {
    const b = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    await service.acceptRequest(b.id, landlord);
    await expect(service.confirmCompletion(b.id, tenant, 'TOOK_PLACE')).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
  });
});

/* ================================================================== */

describe('fee-evasion resistance', () => {
  async function pending(deadlineInPast: boolean): Promise<string> {
    const b = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    await service.acceptRequest(b.id, landlord);
    await service.openCompletionWindow(b.id);
    if (deadlineInPast) {
      await db.query(`UPDATE booking SET completion_deadline_at = now() - interval '1 day' WHERE id=$1`, [b.id]);
    }
    return b.id;
  }

  it('charges the fee when the tenant confirms and the landlord goes quiet', async () => {
    const id = await pending(true);
    await service.confirmCompletion(id, tenant, 'TOOK_PLACE');
    const { rows } = await db.query<{ status: string }>('SELECT status FROM booking WHERE id=$1', [id]);
    expect(rows[0]!.status).toBe('COMPLETED');
    expect(await ledgerBalance(landlord)).toBe(-2950n);
  });

  it('charges the fee immediately when the landlord admits the rental happened', async () => {
    const id = await pending(false); // deadline still in the future
    const r = await service.confirmCompletion(id, landlord, 'TOOK_PLACE');
    expect(r.booking.status).toBe('COMPLETED');
    expect(r.feeAccrued).toBe(true);
  });

  it('charges nothing but records a fraud signal on a lone landlord denial', async () => {
    const id = await pending(true);
    await service.confirmCompletion(id, landlord, 'DID_NOT_TAKE_PLACE');
    const { rows } = await db.query<{ status: string }>('SELECT status FROM booking WHERE id=$1', [id]);
    expect(rows[0]!.status).toBe('NOT_TAKEN_PLACE');
    expect(await ledgerBalance(landlord)).toBe(0n);
    expect(await countRows('fraud_signal', `booking_id=$1 AND kind='UNILATERAL_LANDLORD_DENIAL'`, [id])).toBe(1);
  });

  it('escalates a contradiction to a dispute and charges nobody', async () => {
    const id = await pending(false);
    await service.confirmCompletion(id, tenant, 'TOOK_PLACE');
    const r = await service.confirmCompletion(id, landlord, 'DID_NOT_TAKE_PLACE');
    expect(r.booking.status).toBe('DISPUTED');
    expect(await ledgerBalance(landlord)).toBe(0n);
    expect(await countRows('service_fee', 'booking_id=$1', [id])).toBe(0);
  });

  it('charges on total silence when a check-in was recorded', async () => {
    const b = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    await service.acceptRequest(b.id, landlord);
    await service.checkIn(b.id, tenant);
    await service.openCompletionWindow(b.id);
    await db.query(`UPDATE booking SET completion_deadline_at = now() - interval '1 day' WHERE id=$1`, [b.id]);

    await service.resolveExpiredCompletion(b.id);
    const { rows } = await db.query<{ status: string }>('SELECT status FROM booking WHERE id=$1', [b.id]);
    expect(rows[0]!.status).toBe('COMPLETED');
    expect(await ledgerBalance(landlord)).toBe(-2950n);
  });

  it('charges nothing on total silence with no evidence at all', async () => {
    const id = await pending(true);
    await service.resolveExpiredCompletion(id);
    const { rows } = await db.query<{ status: string }>('SELECT status FROM booking WHERE id=$1', [id]);
    expect(rows[0]!.status).toBe('NOT_TAKEN_PLACE');
    expect(await ledgerBalance(landlord)).toBe(0n);
    expect(await countRows('fraud_signal', `booking_id=$1`, [id])).toBe(1);
  });
});

/* ================================================================== */

describe('competing bookings', () => {
  it('lets several tenants request the same dates', async () => {
    await service.requestBooking({ propertyId: property, tenantId: tenant, from: '2026-09-01', to: '2026-09-08' });
    const second = await service.requestBooking({
      propertyId: property,
      tenantId: otherTenant,
      from: '2026-09-03',
      to: '2026-09-10',
    });
    expect(second.status).toBe('REQUESTED');
  });

  it('auto-declines the losers when one request is accepted', async () => {
    const a = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    const b = await service.requestBooking({
      propertyId: property,
      tenantId: otherTenant,
      from: '2026-09-03',
      to: '2026-09-10',
    });

    await service.acceptRequest(a.id, landlord);

    const loser = await service.get(b.id);
    expect(loser.status).toBe('DECLINED');
    // The declined tenant gets an explanation, not silence.
    const ev = await db.query<{ payload: { reason: string } }>(
      `SELECT payload FROM booking_event WHERE booking_id=$1 AND event_type='DECLINE_REQUEST'`,
      [b.id],
    );
    expect(ev.rows[0]!.payload.reason).toBe('DATES_TAKEN_BY_ANOTHER_BOOKING');
  });

  it('refuses an instant booking over already-confirmed dates', async () => {
    const a = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    await service.acceptRequest(a.id, landlord);

    await expect(
      service.requestBooking({
        propertyId: property,
        tenantId: otherTenant,
        from: '2026-09-05',
        to: '2026-09-12',
        instant: true,
      }),
    ).rejects.toMatchObject({ code: 'DATES_UNAVAILABLE' });
  });

  it('allows a back-to-back stay starting on the checkout day', async () => {
    const a = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    await service.acceptRequest(a.id, landlord);

    const b = await service.requestBooking({
      propertyId: property,
      tenantId: otherTenant,
      from: '2026-09-08',
      to: '2026-09-12',
      instant: true,
    });
    expect(b.status).toBe('CONFIRMED');
  });

  it('frees the dates again after a cancellation', async () => {
    const a = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
      instant: true,
    });
    await service.cancelByTenant(a.id, tenant, 'Планы изменились');

    const b = await service.requestBooking({
      propertyId: property,
      tenantId: otherTenant,
      from: '2026-09-01',
      to: '2026-09-08',
      instant: true,
    });
    expect(b.status).toBe('CONFIRMED');
  });
});

/* ================================================================== */

describe('idempotency', () => {
  it('returns the original booking when a request is retried with the same key', async () => {
    const key = 'retry-key-1';
    const first = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
      idempotencyKey: key,
    });
    const second = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
      idempotencyKey: key,
    });

    expect(second.id).toBe(first.id);
    expect(await countRows('booking', 'tenant_id=$1', [tenant])).toBe(1);
  });

  it('does not let one tenant reuse another tenant’s key', async () => {
    const key = 'shared-key';
    await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
      idempotencyKey: key,
    });
    const other = await service.requestBooking({
      propertyId: property,
      tenantId: otherTenant,
      from: '2026-09-20',
      to: '2026-09-25',
      idempotencyKey: key,
    });
    expect(await countRows('booking', 'id=$1', [other.id])).toBe(1);
  });
});

/* ================================================================== */

describe('authorization', () => {
  let bookingId: string;

  beforeEach(async () => {
    const b = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    bookingId = b.id;
  });

  it('does not let a stranger accept a request', async () => {
    await expect(service.acceptRequest(bookingId, otherTenant)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not let the tenant accept their own request', async () => {
    await expect(service.acceptRequest(bookingId, tenant)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not let the landlord withdraw the tenant’s request', async () => {
    await expect(service.withdraw(bookingId, landlord)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not let a stranger confirm completion', async () => {
    await service.acceptRequest(bookingId, landlord);
    await service.openCompletionWindow(bookingId);
    await expect(service.confirmCompletion(bookingId, otherTenant, 'TOOK_PLACE')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('does not let a tenant book their own property', async () => {
    const own = await publishedProperty(tenant);
    await expect(
      service.requestBooking({ propertyId: own, tenantId: tenant, from: '2026-09-01', to: '2026-09-05' }),
    ).rejects.toMatchObject({ code: 'SELF_BOOKING' });
  });

  it('leaves no partial write behind when authorization fails', async () => {
    const before = await countRows('booking_event', 'booking_id=$1', [bookingId]);
    await expect(service.acceptRequest(bookingId, otherTenant)).rejects.toThrow();
    expect(await countRows('booking_event', 'booking_id=$1', [bookingId])).toBe(before);
    expect((await service.get(bookingId)).status).toBe('REQUESTED');
  });
});

/* ================================================================== */

describe('listing rules are enforced at booking time', () => {
  it('rejects a stay shorter than the landlord’s minimum', async () => {
    const strict = await publishedProperty(landlord, { minNights: 14, maxNights: 180 });
    await expect(
      service.requestBooking({ propertyId: strict, tenantId: tenant, from: '2026-09-01', to: '2026-09-05' }),
    ).rejects.toMatchObject({ code: 'DURATION_OUT_OF_RANGE' });
  });

  it('rejects a stay longer than the landlord’s maximum', async () => {
    const strict = await publishedProperty(landlord, { minNights: 1, maxNights: 10 });
    await expect(
      service.requestBooking({ propertyId: strict, tenantId: tenant, from: '2026-09-01', to: '2026-10-01' }),
    ).rejects.toMatchObject({ code: 'DURATION_OUT_OF_RANGE' });
  });

  it('rejects more guests than the property allows', async () => {
    await expect(
      service.requestBooking({
        propertyId: property,
        tenantId: tenant,
        from: '2026-09-01',
        to: '2026-09-05',
        guests: 9,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects instant booking on a request-only listing', async () => {
    const requestOnly = await publishedProperty(landlord, { bookingMode: 'REQUEST' });
    await expect(
      service.requestBooking({
        propertyId: requestOnly,
        tenantId: tenant,
        from: '2026-09-01',
        to: '2026-09-05',
        instant: true,
      }),
    ).rejects.toMatchObject({ code: 'LISTING_NOT_BOOKABLE' });
  });

  it('rejects booking an unpublished listing', async () => {
    const draft = await publishedProperty(landlord);
    await db.query(`UPDATE property SET status='PAUSED' WHERE id=$1`, [draft]);
    await expect(
      service.requestBooking({ propertyId: draft, tenantId: tenant, from: '2026-09-01', to: '2026-09-05' }),
    ).rejects.toMatchObject({ code: 'LISTING_NOT_BOOKABLE' });
  });

  it('freezes the terms so a later price change cannot rewrite them', async () => {
    const b = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    await service.acceptRequest(b.id, landlord);

    // Landlord doubles the price after confirmation.
    await db.query(`UPDATE property SET base_price_minor = 16000 WHERE id=$1`, [property]);

    const after = await service.get(b.id);
    expect(toDecimalString(fromStorage(after.total_expected_minor))).toBe('590.00');
    expect(toDecimalString(fromStorage(after.fee_base_minor))).toBe('590.00');
  });

  it('keeps an immutable snapshot of what the offer said', async () => {
    const b = await service.requestBooking({
      propertyId: property,
      tenantId: tenant,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    const snap = await db.query<{ content: { base_price_minor: string } }>(
      `SELECT ls.content FROM listing_snapshot ls JOIN booking b ON b.snapshot_id = ls.id WHERE b.id=$1`,
      [b.id],
    );
    expect(snap.rows[0]!.content.base_price_minor).toBe('8000');
    await expect(db.query(`UPDATE listing_snapshot SET content='{}'::jsonb`)).rejects.toThrow(/append-only/i);
  });
});
