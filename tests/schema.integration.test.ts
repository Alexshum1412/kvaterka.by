/**
 * Schema-level integration tests.
 *
 * These run against a real PostgreSQL engine and assert that the *database*
 * refuses illegal states — not that the application remembers to check. Every
 * assertion here is a guarantee that still holds if a future service method
 * forgets its validation, if an admin runs manual SQL, or if two requests race.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { PG_ERROR, hasErrorCode } from '@/server/db/sql.ts';
import { humanReference, uuidv7 } from '@/lib/id.ts';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
});

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

async function makeUser(name: string, kind: 'PRIVATE' | 'COMPANY' = 'PRIVATE'): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO app_user (id, email, display_name, account_kind, company_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, `${name}-${id.slice(0, 8)}@example.by`, name, kind, kind === 'COMPANY' ? `${name} LLC` : null],
  );
  return id;
}

async function makeProperty(ownerId: string, over: Partial<Record<string, unknown>> = {}): Promise<string> {
  const id = uuidv7();
  const values = {
    title: 'Светлая квартира у метро Немига',
    city: 'Минск',
    property_type: 'APARTMENT',
    latitude: 53.9045,
    longitude: 27.5615,
    public_latitude: 53.9048,
    public_longitude: 27.5611,
    base_price_minor: 9000, // 90.00 BYN
    status: 'PUBLISHED',
    ...over,
  };
  await db.query(
    `INSERT INTO property (id, owner_id, title, city, property_type,
        latitude, longitude, public_latitude, public_longitude,
        base_price_minor, status, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $11 = 'PUBLISHED' THEN now() END)`,
    [
      id,
      ownerId,
      values.title,
      values.city,
      values.property_type,
      values.latitude,
      values.longitude,
      values.public_latitude,
      values.public_longitude,
      values.base_price_minor,
      values.status,
    ],
  );
  return id;
}

interface BookingOpts {
  status?: string;
  from?: string;
  to?: string;
  rent?: number;
  feeBase?: number;
}

async function makeBooking(
  propertyId: string,
  tenantId: string,
  landlordId: string,
  opts: BookingOpts = {},
): Promise<string> {
  const id = uuidv7();
  const { status = 'CONFIRMED', from = '2026-09-01', to = '2026-09-08', rent = 63000, feeBase = rent } = opts;
  await db.query(
    `INSERT INTO booking (id, reference, property_id, tenant_id, landlord_id, status,
        stay_period, booking_mode, rent_minor, total_expected_minor, fee_base_minor,
        terms_frozen_at, confirmed_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6, daterange($7::date,$8::date,'[)'), 'REQUEST',
        $9,$9,$10,
        CASE WHEN $6 IN ('CONFIRMED','CHECKED_IN','COMPLETION_PENDING','COMPLETED','DISPUTED') THEN now() END,
        CASE WHEN $6 IN ('CONFIRMED','CHECKED_IN','COMPLETION_PENDING','COMPLETED','DISPUTED') THEN now() END,
        CASE WHEN $6 = 'COMPLETED' THEN now() END)`,
    [id, humanReference('KV'), propertyId, tenantId, landlordId, status, from, to, rent, feeBase],
  );
  return id;
}

/* ------------------------------------------------------------------ */

describe('migrations', () => {
  it('build the whole schema from a clean database', async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );
    const tables = rows.map((r) => r.tablename);
    for (const expected of [
      'app_user',
      'audit_log',
      'booking',
      'booking_event',
      'booking_offer',
      'calendar_block',
      'conversation',
      'dispute_case',
      'ledger_entry',
      'message',
      'property',
      'review',
      'service_fee',
      'verification_document',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('record themselves so they are applied exactly once', async () => {
    const { rows } = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM schema_migration');
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(5);
  });

  it('install every extension the schema depends on', async () => {
    const { rows } = await db.query<{ extname: string }>('SELECT extname FROM pg_extension');
    const names = rows.map((r) => r.extname);
    expect(names).toEqual(expect.arrayContaining(['btree_gist', 'pg_trgm', 'citext', 'cube', 'earthdistance']));
  });
});

describe('double booking is impossible', () => {
  let landlord: string, tenantA: string, tenantB: string, property: string;

  beforeEach(async () => {
    landlord = await makeUser('landlord');
    tenantA = await makeUser('tenant-a');
    tenantB = await makeUser('tenant-b');
    property = await makeProperty(landlord);
  });

  it('rejects a second confirmed booking overlapping the first', async () => {
    await makeBooking(property, tenantA, landlord, { from: '2026-09-01', to: '2026-09-10' });
    await expect(
      makeBooking(property, tenantB, landlord, { from: '2026-09-09', to: '2026-09-15' }),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION));
  });

  it('rejects an identical duplicate booking', async () => {
    await makeBooking(property, tenantA, landlord);
    await expect(makeBooking(property, tenantB, landlord)).rejects.toSatisfy((e: unknown) =>
      hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION),
    );
  });

  it('rejects a booking fully contained inside another', async () => {
    await makeBooking(property, tenantA, landlord, { from: '2026-09-01', to: '2026-09-30' });
    await expect(
      makeBooking(property, tenantB, landlord, { from: '2026-09-10', to: '2026-09-12' }),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION));
  });

  it('allows a back-to-back booking starting on the previous checkout day', async () => {
    // '[)' bounds: the checkout day belongs to the next tenant. Getting this
    // wrong would cost the landlord one bookable night on every single stay.
    await makeBooking(property, tenantA, landlord, { from: '2026-09-01', to: '2026-09-10' });
    await expect(
      makeBooking(property, tenantB, landlord, { from: '2026-09-10', to: '2026-09-14' }),
    ).resolves.toBeTruthy();
  });

  it('allows the same dates on a different property', async () => {
    const other = await makeProperty(landlord);
    await makeBooking(property, tenantA, landlord);
    await expect(makeBooking(other, tenantB, landlord)).resolves.toBeTruthy();
  });

  it('does not let competing REQUESTED bookings block each other', async () => {
    // Several tenants may ask for the same dates; the landlord chooses.
    await makeBooking(property, tenantA, landlord, { status: 'REQUESTED' });
    await expect(makeBooking(property, tenantB, landlord, { status: 'REQUESTED' })).resolves.toBeTruthy();
  });

  it('lets the first acceptance win and blocks the second', async () => {
    const a = await makeBooking(property, tenantA, landlord, { status: 'REQUESTED' });
    const b = await makeBooking(property, tenantB, landlord, { status: 'REQUESTED' });

    await db.query(`UPDATE booking SET status='CONFIRMED', terms_frozen_at=now(), confirmed_at=now() WHERE id=$1`, [a]);
    await expect(
      db.query(`UPDATE booking SET status='CONFIRMED', terms_frozen_at=now(), confirmed_at=now() WHERE id=$1`, [b]),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION));
  });

  it('frees the dates again after a cancellation', async () => {
    const a = await makeBooking(property, tenantA, landlord);
    await db.query(`UPDATE booking SET status='CANCELLED_BY_TENANT', cancelled_at=now() WHERE id=$1`, [a]);
    await expect(makeBooking(property, tenantB, landlord)).resolves.toBeTruthy();
  });

  it('still protects historical completed stays from retroactive overlap', async () => {
    await makeBooking(property, tenantA, landlord, { status: 'COMPLETED' });
    await expect(makeBooking(property, tenantB, landlord, { status: 'CONFIRMED' })).rejects.toSatisfy(
      (e: unknown) => hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION),
    );
  });

  it('rolls the whole transaction back when the overlap fires mid-transaction', async () => {
    await makeBooking(property, tenantA, landlord);
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`INSERT INTO audit_log (action, target_type, target_id) VALUES ('x','booking','y')`);
        await tx.query(
          `INSERT INTO booking (id, reference, property_id, tenant_id, landlord_id, status, stay_period,
             booking_mode, rent_minor, total_expected_minor, fee_base_minor, terms_frozen_at, confirmed_at)
           VALUES ($1,$2,$3,$4,$5,'CONFIRMED', daterange('2026-09-02','2026-09-05','[)'),
             'REQUEST', 1000, 1000, 1000, now(), now())`,
          [uuidv7(), humanReference('KV'), property, tenantB, landlord],
        );
      }),
    ).rejects.toThrow();

    const { rows } = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM audit_log`);
    expect(rows[0]!.count).toBe('0');
  });
});

describe('calendar blocks', () => {
  it('cannot overlap each other', async () => {
    const landlord = await makeUser('landlord');
    const property = await makeProperty(landlord);
    await db.query(
      `INSERT INTO calendar_block (id, property_id, period) VALUES ($1,$2, daterange('2026-10-01','2026-10-10','[)'))`,
      [uuidv7(), property],
    );
    await expect(
      db.query(
        `INSERT INTO calendar_block (id, property_id, period) VALUES ($1,$2, daterange('2026-10-05','2026-10-12','[)'))`,
        [uuidv7(), property],
      ),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION));
  });

  it('prevent a confirmed booking landing on blocked dates', async () => {
    const landlord = await makeUser('landlord');
    const tenant = await makeUser('tenant');
    const property = await makeProperty(landlord);
    await db.query(
      `INSERT INTO calendar_block (id, property_id, period, reason)
       VALUES ($1,$2, daterange('2026-11-01','2026-11-10','[)'), 'MAINTENANCE')`,
      [uuidv7(), property],
    );
    await expect(
      makeBooking(property, tenant, landlord, { from: '2026-11-05', to: '2026-11-07' }),
    ).rejects.toThrow(/calendar block/i);
  });

  it('allow a booking outside the blocked dates', async () => {
    const landlord = await makeUser('landlord');
    const tenant = await makeUser('tenant');
    const property = await makeProperty(landlord);
    await db.query(
      `INSERT INTO calendar_block (id, property_id, period) VALUES ($1,$2, daterange('2026-11-01','2026-11-10','[)'))`,
      [uuidv7(), property],
    );
    await expect(
      makeBooking(property, tenant, landlord, { from: '2026-11-10', to: '2026-11-14' }),
    ).resolves.toBeTruthy();
  });
});

describe('service fee can only ever be charged once', () => {
  let landlord: string, tenant: string, property: string, booking: string;

  beforeEach(async () => {
    landlord = await makeUser('landlord');
    tenant = await makeUser('tenant');
    property = await makeProperty(landlord);
    booking = await makeBooking(property, tenant, landlord, { status: 'COMPLETED' });
  });

  const insertFee = (bookingId: string) =>
    db.query(
      `INSERT INTO service_fee (id, booking_id, landlord_id, base_minor, bps, fee_minor)
       VALUES ($1,$2,$3, 100000, 500, 5000)`,
      [uuidv7(), bookingId, landlord],
    );

  it('accepts the first accrual', async () => {
    await expect(insertFee(booking)).resolves.toBeTruthy();
  });

  it('rejects a second accrual for the same booking', async () => {
    await insertFee(booking);
    await expect(insertFee(booking)).rejects.toSatisfy((e: unknown) =>
      hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION),
    );
  });

  it('rejects a second FEE_ACCRUED ledger entry for the same fee', async () => {
    await insertFee(booking);
    const { rows } = await db.query<{ id: string }>('SELECT id FROM service_fee WHERE booking_id=$1', [booking]);
    const feeId = rows[0]!.id;

    const accrue = () =>
      db.query(
        `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, service_fee_id, booking_id)
         VALUES ($1,'FEE_ACCRUED', -5000, $2, $3)`,
        [landlord, feeId, booking],
      );

    await expect(accrue()).resolves.toBeTruthy();
    await expect(accrue()).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION));
  });

  it('refuses a positive fee accrual (debt must reduce the balance)', async () => {
    await expect(
      db.query(
        `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor) VALUES ($1,'FEE_ACCRUED', 5000)`,
        [landlord],
      ),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));
  });

  it('refuses an unexplained manual adjustment', async () => {
    await expect(
      db.query(
        `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor) VALUES ($1,'ADJUSTMENT', 5000)`,
        [landlord],
      ),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));
  });
});

describe('financial records are immutable', () => {
  it('refuses to update a ledger entry', async () => {
    const landlord = await makeUser('landlord');
    await db.query(
      `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor) VALUES ($1,'FEE_ACCRUED', -5000)`,
      [landlord],
    );
    await expect(db.query(`UPDATE ledger_entry SET amount_minor = 0`)).rejects.toThrow(/append-only/i);
  });

  it('refuses to delete a ledger entry', async () => {
    const landlord = await makeUser('landlord');
    await db.query(
      `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor) VALUES ($1,'FEE_ACCRUED', -5000)`,
      [landlord],
    );
    await expect(db.query(`DELETE FROM ledger_entry`)).rejects.toThrow(/append-only/i);
  });

  it('refuses to rewrite an audit log row', async () => {
    await db.query(`INSERT INTO audit_log (action, target_type, target_id) VALUES ('login','user','u1')`);
    await expect(db.query(`UPDATE audit_log SET action='nothing happened'`)).rejects.toThrow(/append-only/i);
    await expect(db.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/i);
  });

  it('refuses to alter a booking event after the fact', async () => {
    const landlord = await makeUser('landlord');
    const tenant = await makeUser('tenant');
    const property = await makeProperty(landlord);
    const booking = await makeBooking(property, tenant, landlord);
    await db.query(
      `INSERT INTO booking_event (booking_id, event_type, actor, to_status) VALUES ($1,'ACCEPT_REQUEST','LANDLORD','CONFIRMED')`,
      [booking],
    );
    await expect(db.query(`UPDATE booking_event SET to_status='DECLINED'`)).rejects.toThrow(/append-only/i);
  });
});

describe('reviews', () => {
  let landlord: string, tenant: string, property: string, booking: string;

  beforeEach(async () => {
    landlord = await makeUser('landlord');
    tenant = await makeUser('tenant');
    property = await makeProperty(landlord);
    booking = await makeBooking(property, tenant, landlord, { status: 'COMPLETED' });
  });

  const tenantReview = () =>
    db.query(
      `INSERT INTO review (id, booking_id, author_id, subject_id, property_id, author_role,
          overall, cleanliness, accuracy, communication, body)
       VALUES ($1,$2,$3,$4,$5,'TENANT', 5,5,4,5,'Всё отлично')`,
      [uuidv7(), booking, tenant, landlord, property],
    );

  it('accepts one review per side', async () => {
    await expect(tenantReview()).resolves.toBeTruthy();
    await expect(
      db.query(
        `INSERT INTO review (id, booking_id, author_id, subject_id, author_role,
            overall, rule_compliance, property_condition, communication, body)
         VALUES ($1,$2,$3,$4,'LANDLORD', 5,5,5,5,'Хороший арендатор')`,
        [uuidv7(), booking, landlord, tenant],
      ),
    ).resolves.toBeTruthy();
  });

  it('rejects a duplicate review from the same side', async () => {
    await tenantReview();
    await expect(tenantReview()).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION));
  });

  it('rejects a tenant review that fills in landlord-only dimensions', async () => {
    await expect(
      db.query(
        `INSERT INTO review (id, booking_id, author_id, subject_id, author_role,
            overall, cleanliness, accuracy, communication, rule_compliance, body)
         VALUES ($1,$2,$3,$4,'TENANT', 5,5,5,5,5,'mixed')`,
        [uuidv7(), booking, tenant, landlord],
      ),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));
  });

  it('rejects a review of oneself', async () => {
    await expect(
      db.query(
        `INSERT INTO review (id, booking_id, author_id, subject_id, author_role,
            overall, cleanliness, accuracy, communication, body)
         VALUES ($1,$2,$3,$3,'TENANT', 5,5,5,5,'self')`,
        [uuidv7(), booking, tenant],
      ),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));
  });

  it('rejects an out-of-range rating', async () => {
    await expect(
      db.query(
        `INSERT INTO review (id, booking_id, author_id, subject_id, author_role,
            overall, cleanliness, accuracy, communication, body)
         VALUES ($1,$2,$3,$4,'TENANT', 6,5,5,5,'too good')`,
        [uuidv7(), booking, tenant, landlord],
      ),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));
  });
});

describe('assorted business invariants', () => {
  it('refuses a booking where the tenant is also the landlord', async () => {
    const user = await makeUser('both');
    const property = await makeProperty(user);
    await expect(makeBooking(property, user, user)).rejects.toSatisfy((e: unknown) =>
      hasErrorCode(e, PG_ERROR.CHECK_VIOLATION),
    );
  });

  it('refuses a confirmed booking whose financial terms were never frozen', async () => {
    const landlord = await makeUser('landlord');
    const tenant = await makeUser('tenant');
    const property = await makeProperty(landlord);
    await expect(
      db.query(
        `INSERT INTO booking (id, reference, property_id, tenant_id, landlord_id, status, stay_period,
           booking_mode, rent_minor, total_expected_minor, fee_base_minor, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,'CONFIRMED', daterange('2026-09-01','2026-09-05','[)'),
           'REQUEST', 1000, 1000, 1000, now())`,
        [uuidv7(), humanReference('KV'), property, tenant, landlord],
      ),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));
  });

  it('computes the number of nights instead of trusting the caller', async () => {
    const landlord = await makeUser('landlord');
    const tenant = await makeUser('tenant');
    const property = await makeProperty(landlord);
    const booking = await makeBooking(property, tenant, landlord, { from: '2026-09-01', to: '2026-09-08' });
    const { rows } = await db.query<{ nights: number }>('SELECT nights FROM booking WHERE id=$1', [booking]);
    expect(Number(rows[0]!.nights)).toBe(7);
  });

  it('refuses an empty stay period', async () => {
    const landlord = await makeUser('landlord');
    const tenant = await makeUser('tenant');
    const property = await makeProperty(landlord);
    await expect(makeBooking(property, tenant, landlord, { from: '2026-09-01', to: '2026-09-01' })).rejects.toThrow();
  });

  it('refuses a company account with no company name', async () => {
    await expect(
      db.query(
        `INSERT INTO app_user (id, email, display_name, account_kind) VALUES ($1,$2,'Agency','COMPANY')`,
        [uuidv7(), `agency-${Date.now()}@example.by`],
      ),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));
  });

  it('refuses an account with neither email nor phone', async () => {
    await expect(
      db.query(`INSERT INTO app_user (id, display_name) VALUES ($1,'Ghost')`, [uuidv7()]),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));
  });

  it('treats email as case-insensitive so one address cannot be registered twice', async () => {
    const email = `Duplicate-${Date.now()}@Example.BY`;
    await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,'One')`, [uuidv7(), email]);
    await expect(
      db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,'Two')`, [
        uuidv7(),
        email.toLowerCase(),
      ]),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION));
  });

  it('allows only one cover photo per property', async () => {
    const landlord = await makeUser('landlord');
    const property = await makeProperty(landlord);
    const photo = (cover: boolean) =>
      db.query(`INSERT INTO property_photo (id, property_id, storage_key, is_cover) VALUES ($1,$2,$3,$4)`, [
        uuidv7(),
        property,
        `k/${uuidv7()}`,
        cover,
      ]);
    await expect(photo(true)).resolves.toBeTruthy();
    await expect(photo(true)).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION));
    await expect(photo(false)).resolves.toBeTruthy();
  });

  it('allows only one pending offer per booking', async () => {
    const landlord = await makeUser('landlord');
    const tenant = await makeUser('tenant');
    const property = await makeProperty(landlord);
    const booking = await makeBooking(property, tenant, landlord, { status: 'OFFER_PENDING' });
    const offer = (seq: number) =>
      db.query(
        `INSERT INTO booking_offer (id, booking_id, sequence, proposed_by, proposed_by_user_id,
            rent_minor, total_expected_minor, stay_period)
         VALUES ($1,$2,$3,'TENANT',$4, 50000, 50000, daterange('2026-09-01','2026-09-08','[)'))`,
        [uuidv7(), booking, seq, tenant],
      );
    await expect(offer(1)).resolves.toBeTruthy();
    await expect(offer(2)).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION));
  });

  it('enforces a duration range that makes sense', async () => {
    const landlord = await makeUser('landlord');
    await expect(
      makeProperty(landlord).then(() =>
        db.query(`UPDATE property SET min_nights = 30, max_nights = 7 WHERE owner_id = $1`, [landlord]),
      ),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));
  });

  it('rejects a property whose floor is above the top of its building', async () => {
    const landlord = await makeUser('landlord');
    const property = await makeProperty(landlord);
    await expect(
      db.query(`UPDATE property SET floor = 12, total_floors = 9 WHERE id = $1`, [property]),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));
  });
});

describe('geo search', () => {
  it('finds properties inside a radius and excludes those outside it', async () => {
    const landlord = await makeUser('landlord');
    // Minsk centre, ~1.7 km away, and Brest (~300 km away).
    await makeProperty(landlord, { public_latitude: 53.9045, public_longitude: 27.5615 });
    await makeProperty(landlord, { public_latitude: 53.9145, public_longitude: 27.5815 });
    await makeProperty(landlord, { public_latitude: 52.0976, public_longitude: 23.7341 });

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM property
       WHERE status='PUBLISHED'
         AND earth_box(ll_to_earth($1,$2), $3) @> ll_to_earth(public_latitude, public_longitude)
         AND earth_distance(ll_to_earth($1,$2), ll_to_earth(public_latitude, public_longitude)) <= $3`,
      [53.9045, 27.5615, 5000],
    );
    expect(rows[0]!.count).toBe('2');
  });
});

describe('Russian full-text search', () => {
  it('matches a different grammatical form of the same word', async () => {
    const { rows } = await db.query<{ m: boolean }>(
      `SELECT to_tsvector('russian', $1) @@ plainto_tsquery('russian', $2) AS m`,
      ['Уютная двухкомнатная квартира рядом с метро', 'квартиры'],
    );
    expect(rows[0]!.m).toBe(true);
  });

  it('tolerates a typo through trigram similarity', async () => {
    const { rows } = await db.query<{ s: number }>(`SELECT similarity($1,$2) AS s`, ['Минск', 'Минкс']);
    expect(Number(rows[0]!.s)).toBeGreaterThan(0.3);
  });
});
