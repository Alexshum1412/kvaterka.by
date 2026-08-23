/**
 * PostgreSQL 10.23 compatibility — the half that needs a real engine.
 *
 * The static scan of the migration files lives in pg10-migrations.static.test.ts
 * and deliberately has no database, so that a migration which cannot be applied
 * still produces a legible failure rather than a file of skipped tests.
 *
 * What is asserted here is what a file scan cannot see: that the database really
 * has no extensions, that it can lower-case Cyrillic, that the replacement
 * indexes are reachable by the queries written for them, and that the occupancy
 * table holds the calendar through confirmation, cancellation, date changes,
 * adjacency and deletion.
 *
 * Point it at a real PostgreSQL 10.23 with TEST_DATABASE_URL and it is proof;
 * run it on PGlite and it is still a useful check of the same invariants on a
 * different engine.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { PG_ERROR, hasErrorCode, isOverlapViolation } from '@/server/db/sql.ts';
import { humanReference, uuidv7 } from '@/lib/id.ts';

/* ================================================================== *
 * Runtime — real engine required, and meaningful only on 10.23
 * ================================================================== */

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

async function makeUser(name: string): Promise<string> {
  const id = uuidv7();
  await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,$3)`, [
    id,
    `${name}-${id.slice(0, 8)}@example.by`,
    name,
  ]);
  return id;
}

async function makeProperty(ownerId: string): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO property (id, owner_id, title, city, property_type,
        latitude, longitude, public_latitude, public_longitude,
        base_price_minor, status, published_at)
     VALUES ($1,$2,'Светлая квартира у метро Немига','Минск','APARTMENT',
        53.9045,27.5615,53.9048,27.5611, 9000,'PUBLISHED', now())`,
    [id, ownerId],
  );
  return id;
}

async function confirmBooking(
  propertyId: string,
  tenantId: string,
  landlordId: string,
  from: string,
  to: string,
  status = 'CONFIRMED',
): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO booking (id, reference, property_id, tenant_id, landlord_id, status,
        stay_period, booking_mode, rent_minor, total_expected_minor, fee_base_minor,
        terms_frozen_at, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6, daterange($7::date,$8::date,'[)'), 'REQUEST',
        63000,63000,63000, now(), now())`,
    [id, humanReference('KV'), propertyId, tenantId, landlordId, status, from, to],
  );
  return id;
}

const occupiedNights = async (propertyId: string): Promise<number> => {
  const { rows } = await db.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM property_occupancy WHERE property_id=$1`,
    [propertyId],
  );
  return Number(rows[0]!.c);
};

describe('the database this suite is actually running against', () => {
  it('has no extensions installed', async () => {
    const { rows } = await db.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname <> 'plpgsql'`,
    );
    expect(rows.map((r) => r.extname)).toEqual([]);
  });

  /* The defect this guards against is silent. Under LC_CTYPE=C every query still
     succeeds and every test that uses ASCII still passes; only Russian search
     stops working, for everyone, with no error anywhere. Migration 0001 refuses
     to run on such a database — this asserts the same property from the other
     side, so a harness that somehow got past the guard still fails loudly. */
  it('can lower-case Cyrillic, or Russian search is quietly broken', async () => {
    const { rows } = await db.query<{ folded: string; matched: boolean }>(
      `SELECT lower('МИНСК') AS folded,
              (to_tsvector('russian','Квартира в центре Минска')
                 @@ plainto_tsquery('russian','минск')) AS matched`,
    );
    expect(rows[0]!.folded).toBe('минск');
    expect(rows[0]!.matched).toBe(true);
  });
});

describe('nights, derived by trigger instead of by a generated column', () => {
  it('computes the value the generated column used to compute', async () => {
    const landlord = await makeUser('landlord');
    const tenant = await makeUser('tenant');
    const property = await makeProperty(landlord);
    const booking = await confirmBooking(property, tenant, landlord, '2026-09-01', '2026-09-08');

    const { rows } = await db.query<{ nights: number }>(`SELECT nights FROM booking WHERE id=$1`, [
      booking,
    ]);
    expect(rows[0]!.nights).toBe(7);
  });

  /* The point of a generated column is that the application cannot lie about the
     value. A trigger has to earn that the hard way, so this writes a wrong
     number deliberately and expects the database to ignore it. */
  it('overwrites a value the application supplies, exactly as GENERATED ALWAYS did', async () => {
    const landlord = await makeUser('landlord');
    const tenant = await makeUser('tenant');
    const property = await makeProperty(landlord);

    const id = uuidv7();
    await db.query(
      `INSERT INTO booking (id, reference, property_id, tenant_id, landlord_id, status,
          stay_period, nights, booking_mode, rent_minor, total_expected_minor, fee_base_minor,
          terms_frozen_at, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,'CONFIRMED', daterange('2026-09-01','2026-09-08','[)'),
          999, 'REQUEST', 63000,63000,63000, now(), now())`,
      [id, humanReference('KV'), property, tenant, landlord],
    );

    const { rows } = await db.query<{ nights: number }>(`SELECT nights FROM booking WHERE id=$1`, [id]);
    expect(rows[0]!.nights).toBe(7);
  });

  it('recomputes when the dates move', async () => {
    const landlord = await makeUser('landlord');
    const tenant = await makeUser('tenant');
    const property = await makeProperty(landlord);
    const booking = await confirmBooking(property, tenant, landlord, '2026-09-01', '2026-09-08');

    await db.query(
      `UPDATE booking SET stay_period = daterange('2026-09-01','2026-09-04','[)') WHERE id=$1`,
      [booking],
    );
    const { rows } = await db.query<{ nights: number }>(`SELECT nights FROM booking WHERE id=$1`, [
      booking,
    ]);
    expect(rows[0]!.nights).toBe(3);
  });
});

describe('property_occupancy holds the calendar', () => {
  let landlord: string, tenantA: string, tenantB: string, property: string;

  beforeEach(async () => {
    landlord = await makeUser('landlord');
    tenantA = await makeUser('tenant-a');
    tenantB = await makeUser('tenant-b');
    property = await makeProperty(landlord);
  });

  it('claims one row per night when a booking is confirmed', async () => {
    await confirmBooking(property, tenantA, landlord, '2026-09-01', '2026-09-08');
    expect(await occupiedNights(property)).toBe(7);
  });

  it('claims nothing for a REQUESTED booking, so competing requests survive', async () => {
    await confirmBooking(property, tenantA, landlord, '2026-09-01', '2026-09-08', 'REQUESTED');
    await confirmBooking(property, tenantB, landlord, '2026-09-01', '2026-09-08', 'REQUESTED');
    expect(await occupiedNights(property)).toBe(0);
  });

  it('refuses the second confirmation and names the constraint the application catches', async () => {
    const a = await confirmBooking(property, tenantA, landlord, '2026-09-01', '2026-09-08', 'REQUESTED');
    const b = await confirmBooking(property, tenantB, landlord, '2026-09-01', '2026-09-08', 'REQUESTED');

    await db.query(`UPDATE booking SET status='CONFIRMED' WHERE id=$1`, [a]);
    await expect(
      db.query(`UPDATE booking SET status='CONFIRMED' WHERE id=$1`, [b]),
    ).rejects.toSatisfy(
      (e: unknown) => hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION) && isOverlapViolation(e),
    );

    // And the winner still holds exactly its own nights, not a mixture.
    expect(await occupiedNights(property)).toBe(7);
  });

  it('releases the nights when a booking is cancelled', async () => {
    const a = await confirmBooking(property, tenantA, landlord, '2026-09-01', '2026-09-08');
    expect(await occupiedNights(property)).toBe(7);

    await db.query(`UPDATE booking SET status='CANCELLED_BY_TENANT', cancelled_at=now() WHERE id=$1`, [a]);
    expect(await occupiedNights(property)).toBe(0);

    await expect(
      confirmBooking(property, tenantB, landlord, '2026-09-01', '2026-09-08'),
    ).resolves.toBeTruthy();
  });

  it('moves the footprint when the dates move, without colliding with itself', async () => {
    const a = await confirmBooking(property, tenantA, landlord, '2026-09-01', '2026-09-08');
    await db.query(
      `UPDATE booking SET stay_period = daterange('2026-09-03','2026-09-06','[)') WHERE id=$1`,
      [a],
    );

    expect(await occupiedNights(property)).toBe(3);
    const { rows } = await db.query<{ night: string }>(
      `SELECT night::text AS night FROM property_occupancy WHERE property_id=$1 ORDER BY night`,
      [property],
    );
    expect(rows.map((r) => r.night)).toEqual(['2026-09-03', '2026-09-04', '2026-09-05']);
  });

  it('leaves the checkout night free for the next tenant', async () => {
    await confirmBooking(property, tenantA, landlord, '2026-09-01', '2026-09-10');
    await expect(
      confirmBooking(property, tenantB, landlord, '2026-09-10', '2026-09-14'),
    ).resolves.toBeTruthy();
    expect(await occupiedNights(property)).toBe(13);
  });

  it('lets a block and a booking compete for the same night, and only one wins', async () => {
    await confirmBooking(property, tenantA, landlord, '2026-09-01', '2026-09-08');
    await expect(
      db.query(
        `INSERT INTO calendar_block (id, property_id, period) VALUES ($1,$2, daterange('2026-09-04','2026-09-06','[)'))`,
        [uuidv7(), property],
      ),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION));
  });

  it('frees a block’s nights when the block is deleted', async () => {
    const blockId = uuidv7();
    await db.query(
      `INSERT INTO calendar_block (id, property_id, period) VALUES ($1,$2, daterange('2026-09-01','2026-09-05','[)'))`,
      [blockId, property],
    );
    expect(await occupiedNights(property)).toBe(4);

    await db.query(`DELETE FROM calendar_block WHERE id=$1`, [blockId]);
    expect(await occupiedNights(property)).toBe(0);
  });

  /* Every row must be traceable to something that can release it. A row owned by
     neither a booking nor a block would hold a night for ever, and nothing in the
     system would know why the flat had stopped being bookable. */
  it('refuses a row that no booking and no block owns', async () => {
    await expect(
      db.query(`INSERT INTO property_occupancy (property_id, night) VALUES ($1, '2026-09-01')`, [
        property,
      ]),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));

    const booking = await confirmBooking(property, tenantA, landlord, '2026-10-01', '2026-10-02');
    const blockId = uuidv7();
    await db.query(
      `INSERT INTO calendar_block (id, property_id, period) VALUES ($1,$2, daterange('2026-11-01','2026-11-02','[)'))`,
      [blockId, property],
    );
    await expect(
      db.query(
        `INSERT INTO property_occupancy (property_id, night, booking_id, block_id)
         VALUES ($1, '2026-12-01', $2, $3)`,
        [property, booking, blockId],
      ),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.CHECK_VIOLATION));
  });
});

describe('the replacement indexes are usable by the queries written for them', () => {
  /* An expression index is only used when the query's expression matches it
     character for character. Nothing warns you when it stops matching — the
     query keeps returning correct results and quietly starts scanning the whole
     table, and you find out when the table is large enough to hurt.

     THE ROWS BELOW ARE THE TEST. An earlier version of this asserted against a
     three-row table with enable_seqscan turned off, and it failed for a reason
     worth keeping: with three rows and no statistics the planner picked
     whichever partial index it happened to reach first and filtered the rest,
     so the assertion was about tie-breaking rather than about the index. Real
     rows plus ANALYZE make the planner answer the question actually being
     asked — given a realistic table, does it reach for this index? */
  const SEED = 500;

  beforeEach(async () => {
    const owner = await makeUser('index-owner');

    await db.query(
      `INSERT INTO app_user (id, email, display_name)
       SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
              'person' || g || '@example.by', 'person ' || g
         FROM generate_series(1, $1) g`,
      [SEED],
    );

    /* Spread across Belarus rather than stacked on one point: an index on
       coordinates that all share a value tells the planner nothing. */
    await db.query(
      `INSERT INTO property (id, owner_id, title, description, city, property_type,
          latitude, longitude, public_latitude, public_longitude,
          base_price_minor, status, published_at)
       SELECT ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid,
              $1,
              'Уютная квартира номер ' || g,
              'Просторное жильё рядом с центром, вариант ' || g,
              (ARRAY['Минск','Брест','Гомель','Витебск','Гродно'])[1 + g % 5],
              'APARTMENT',
              51.3 + (g % 480) / 100.0, 23.2 + (g % 950) / 100.0,
              51.3 + (g % 480) / 100.0, 23.2 + (g % 950) / 100.0,
              9000 + g, 'PUBLISHED', now()
         FROM generate_series(1, $2) g`,
      [owner, SEED],
    );

    // Without statistics the planner is guessing, and a guess is not a plan.
    await db.query('ANALYZE app_user');
    await db.query('ANALYZE property');
  }, 60_000);

  /** The planner's own choice, with nothing forced. */
  const planFor = async (sql: string, params: readonly unknown[] = []): Promise<string> => {
    const { rows } = await db.query<Record<string, string>>(`EXPLAIN ${sql}`, params);
    return rows.map((r) => Object.values(r)[0]).join('\n');
  };

  it('uses property_fts_idx for the search service’s full-text expression', async () => {
    const plan = await planFor(
      `SELECT p.id FROM property p
        WHERE p.status = 'PUBLISHED'
          AND to_tsvector('russian', p.title || ' ' || p.description || ' ' || p.city)
              @@ plainto_tsquery('russian', $1)`,
      ['квартира'],
    );
    expect(plan, plan).toContain('property_fts_idx');
  });

  it('uses property_geo_idx for the bounding box', async () => {
    const plan = await planFor(
      `SELECT p.id FROM property p
        WHERE p.status = 'PUBLISHED'
          AND p.public_latitude BETWEEN $1 AND $2
          AND p.public_longitude BETWEEN $3 AND $4`,
      [53.8, 54.0, 27.4, 27.7],
    );
    expect(plan, plan).toContain('property_geo_idx');
  });

  it('uses app_user_email_lower_idx for a case-insensitive login lookup', async () => {
    const plan = await planFor(
      `SELECT id FROM app_user WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
      ['Someone@Example.by'],
    );
    expect(plan, plan).toContain('app_user_email_lower_idx');
  });

  /* The only one of these four that forces the planner's hand, because it is the
     only one asking a different question. The other three are expression indexes
     whose usability depends on the query text matching the index text — a thing
     that can silently stop being true, which is why they are tested against
     realistic data with the planner left free to choose.

     This is a plain two-column primary key, and what is being checked is that
     the predicate fits its shape: equality on the leading column, a range on the
     second. Occupancy rows can only be written by the triggers, so seeding a
     table large enough to make an index scan the cheaper plan would mean
     inserting hundreds of bookings to assert something that does not depend on
     size. Disabling the sequential scan asks exactly the question that matters:
     given no alternative, can this index serve this query at all? */
  it('uses the occupancy primary key to answer "is this property free"', async () => {
    const landlord = await makeUser('occ-landlord');
    const tenant = await makeUser('occ-tenant');
    const property = await makeProperty(landlord);
    await confirmBooking(property, tenant, landlord, '2026-09-01', '2026-09-20');

    await db.query('SET enable_seqscan = off');
    try {
      const plan = await planFor(
        `SELECT 1 FROM property_occupancy po
          WHERE po.property_id = $1 AND po.night >= $2::date AND po.night < $3::date`,
        [property, '2026-09-01', '2026-09-08'],
      );
      expect(plan, plan).toContain('property_occupancy_pkey');
    } finally {
      await db.query('SET enable_seqscan = on');
    }
  });
});

describe('case-insensitive email without citext', () => {
  it('refuses two accounts differing only in capitalisation', async () => {
    await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,$3)`, [
      uuidv7(),
      'Test@Email.by',
      'first',
    ]);
    await expect(
      db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,$3)`, [
        uuidv7(),
        'test@email.by',
        'second',
      ]),
    ).rejects.toSatisfy((e: unknown) => hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION));
  });

  it('still allows several accounts with no email at all', async () => {
    // The unique index is partial for this reason: reachable by phone is a
    // valid account, and NULLs must not compete with each other.
    await db.query(`INSERT INTO app_user (id, phone, display_name) VALUES ($1,$2,$3)`, [
      uuidv7(),
      '+375291110001',
      'phone-only-a',
    ]);
    await expect(
      db.query(`INSERT INTO app_user (id, phone, display_name) VALUES ($1,$2,$3)`, [
        uuidv7(),
        '+375291110002',
        'phone-only-b',
      ]),
    ).resolves.toBeTruthy();
  });

  it('finds the account whichever way the address is capitalised', async () => {
    const id = uuidv7();
    await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,$3)`, [
      id,
      'mixed.case@example.by',
      'someone',
    ]);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE lower(email) = lower($1)`,
      ['MIXED.CASE@EXAMPLE.BY'],
    );
    expect(rows[0]?.id).toBe(id);
  });
});
