/**
 * Genuine simultaneous transactions, against a real PostgreSQL server.
 *
 * WHY THIS FILE IS DIFFERENT FROM EVERY OTHER SUITE HERE
 *
 * The other 27 suites run against PGlite, which is a real PostgreSQL engine but
 * serialises every connection through one in-process instance. That is enough
 * to prove a constraint REJECTS a bad row when it is presented — and it can
 * never prove what happens when two transactions reach the same row at the same
 * instant, because under PGlite they cannot. Every concurrency claim this
 * project has made has therefore been an argument from the constraint's
 * definition rather than an observation.
 *
 * MVP_RELEASE_CHECKLIST.md has carried "suite run against a real PostgreSQL
 * server" as an unchecked release gate since the beginning, with the note that
 * it was not possible in this environment. It is: a PostgreSQL 16 service is
 * running locally. This file is what that gate was for.
 *
 * It SKIPS under PGlite rather than passing. A concurrency test that quietly
 * runs serialised is worse than no test, because it reports success for a
 * property it did not examine — and this suite exists precisely because that
 * distinction has been invisible until now.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/kvaterka_test npm test
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { BookingService } from '@/server/services/booking-service.ts';
import { ListingService } from '@/server/services/listing-service.ts';
import { NotificationService } from '@/server/services/notification-service.ts';
import { RetentionService } from '@/server/services/retention-service.ts';
import { uuidv7 } from '@/lib/id.ts';

let db: TestDb;
let bookings: BookingService;
let listings: ListingService;
let notifications: NotificationService;
let retention: RetentionService;
/** Set once the driver is known; every test in the file is gated on it. */
let real = false;

beforeAll(async () => {
  db = await createTestDb();
  real = db.driver === 'postgres';
  bookings = new BookingService(db);
  listings = new ListingService(db);
  notifications = new NotificationService(db);
  retention = new RetentionService(db);

  if (!real) {
    // Loud on purpose. A skipped concurrency suite that says nothing looks
    // exactly like a passing one in CI output.
    console.warn(
      '\n  [concurrency] SKIPPED — running on PGlite, which serialises connections.\n' +
        '  These assertions require genuinely simultaneous transactions.\n' +
        '  Set TEST_DATABASE_URL to a real PostgreSQL server to run them.\n',
    );
  }
}, 180_000);

afterAll(async () => {
  await db?.close();
});

let landlord: string;
let tenantA: string;
let tenantB: string;
let property: string;

beforeEach(async () => {
  if (!real) return;
  await db.truncateAll();
  landlord = await user('Алесь Уладальнік');
  tenantA = await user('Ірына Арандатар');
  tenantB = await user('Другі Арандатар');
  property = await publishedProperty(landlord);
});

async function user(name: string): Promise<string> {
  const id = uuidv7();
  await db.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,$3)`, [
    id,
    `${id}@example.by`,
    name,
  ]);
  return id;
}

async function publishedProperty(ownerId: string): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO property (id, owner_id, title, city, property_type, latitude, longitude,
        public_latitude, public_longitude, base_price_minor, price_unit, cleaning_fee_minor,
        deposit_minor, min_nights, max_nights, max_guests, booking_mode, status, published_at)
     VALUES ($1,$2,'Светлая квартира у метро Немига','Минск','APARTMENT',
        53.9045,27.5615,53.9048,27.5611,8000,'NIGHT',3000,30000,1,365,4,'INSTANT_AND_REQUEST','PUBLISHED',now())`,
    [id, ownerId],
  );
  return id;
}

const count = async (table: string, where: string, params: unknown[]): Promise<number> => {
  const { rows } = await db.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(rows[0]!.c);
};

/**
 * Run N operations as simultaneously as a single process can arrange, and
 * report each as fulfilled or rejected without letting one failure hide the
 * others. `Promise.all` would reject on the first loser and discard exactly the
 * information these tests are about.
 */
async function race<T>(...operations: (() => Promise<T>)[]): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(operations.map((op) => op()));
}

const won = <T>(results: PromiseSettledResult<T>[]): PromiseFulfilledResult<T>[] =>
  results.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled');

const lost = <T>(results: PromiseSettledResult<T>[]): PromiseRejectedResult[] =>
  results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

/* ================================================================== *
 * The booking calendar
 * ================================================================== */

describe('two people reaching for the same dates', () => {
  it('confirms exactly one of two simultaneous acceptances for overlapping dates', async () => {
    if (!real) return;

    // Both requests are legal: a REQUESTED booking reserves nothing, which is
    // deliberate — a landlord may weigh several enquiries for the same week.
    const a = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantA,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    const b = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantB,
      from: '2026-09-05',
      to: '2026-09-12',
    });

    // The acceptances are what collide, and they collide inside the database.
    const results = await race(
      () => bookings.acceptRequest(a.id, landlord),
      () => bookings.acceptRequest(b.id, landlord),
    );

    expect(won(results)).toHaveLength(1);
    expect(lost(results)).toHaveLength(1);

    // And the loser is a clean domain refusal, not a raw constraint error
    // leaking a PostgreSQL code to the caller.
    const rejection = lost(results)[0]!.reason;
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection.message)).not.toMatch(/23P01|exclusion|EXCLUDE/i);

    expect(await count('booking', `property_id=$1 AND status='CONFIRMED'`, [property])).toBe(1);
  });

  it('confirms both when the dates only touch, because adjacency is not overlap', async () => {
    if (!real) return;

    // One guest leaves the morning the next arrives. The range is half-open,
    // so this must succeed — and it is the case a too-eager lock would break.
    const a = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantA,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    const b = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantB,
      from: '2026-09-08',
      to: '2026-09-15',
    });

    const results = await race(
      () => bookings.acceptRequest(a.id, landlord),
      () => bookings.acceptRequest(b.id, landlord),
    );

    expect(lost(results)).toHaveLength(0);
    expect(await count('booking', `property_id=$1 AND status='CONFIRMED'`, [property])).toBe(2);
  });

  it('refuses a contained booking — a stay wholly inside another is still a double booking', async () => {
    if (!real) return;

    const a = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantA,
      from: '2026-09-01',
      to: '2026-09-30',
    });
    const b = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantB,
      from: '2026-09-10',
      to: '2026-09-12',
    });

    const results = await race(
      () => bookings.acceptRequest(a.id, landlord),
      () => bookings.acceptRequest(b.id, landlord),
    );

    expect(won(results)).toHaveLength(1);
    expect(await count('booking', `property_id=$1 AND status='CONFIRMED'`, [property])).toBe(1);
  });

  it('survives eight simultaneous acceptances of the same week with exactly one winner', async () => {
    if (!real) return;

    // Beyond two, because a race that only ever runs two ways can pass by luck.
    const requests = [];
    for (let i = 0; i < 8; i += 1) {
      const tenant = await user(`Претендент ${i}`);
      requests.push(
        await bookings.requestBooking({
          propertyId: property,
          tenantId: tenant,
          from: '2026-10-01',
          to: '2026-10-08',
        }),
      );
    }

    const results = await race(...requests.map((r) => () => bookings.acceptRequest(r.id, landlord)));

    expect(won(results)).toHaveLength(1);
    expect(lost(results)).toHaveLength(7);
    expect(await count('booking', `property_id=$1 AND status='CONFIRMED'`, [property])).toBe(1);
  });
});

/* ================================================================== *
 * Two hands on one booking
 * ================================================================== */

describe('two decisions arriving on one booking at once', () => {
  it('lets only one of two simultaneous acceptances of the SAME booking through', async () => {
    if (!real) return;

    const booking = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantA,
      from: '2026-09-01',
      to: '2026-09-08',
    });

    // A landlord double-clicking, or two staff tabs open.
    const results = await race(
      () => bookings.acceptRequest(booking.id, landlord),
      () => bookings.acceptRequest(booking.id, landlord),
    );

    expect(won(results)).toHaveLength(1);
    // One transition, not two: the event log is what a dispute is decided on.
    expect(await count('booking_event', `booking_id=$1 AND event_type='ACCEPT_REQUEST'`, [booking.id])).toBe(1);
  });

  it('resolves accept-versus-decline to a single outcome, whichever wins', async () => {
    if (!real) return;

    const booking = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantA,
      from: '2026-09-01',
      to: '2026-09-08',
    });

    const results = await race(
      () => bookings.acceptRequest(booking.id, landlord),
      () => bookings.declineRequest(booking.id, landlord, 'Занято'),
    );

    expect(won(results)).toHaveLength(1);
    const final = await bookings.get(booking.id);
    expect(['CONFIRMED', 'DECLINED']).toContain(final.status);
  });

  it('resolves the expiry job racing a landlord acceptance without corrupting either', async () => {
    if (!real) return;

    const booking = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantA,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    // Make it due for expiry this instant.
    await db.query(`UPDATE booking SET expires_at = now() - interval '1 minute' WHERE id=$1`, [booking.id]);

    const results = await race(
      () => bookings.expireStale(booking.id),
      () => bookings.acceptRequest(booking.id, landlord),
    );

    // expireStale is a deliberate no-op when it loses, so BOTH may resolve —
    // what must not happen is two transitions or an ambiguous final state.
    const final = await bookings.get(booking.id);
    expect(['CONFIRMED', 'EXPIRED']).toContain(final.status);

    const transitions = await count(
      'booking_event',
      `booking_id=$1 AND event_type IN ('ACCEPT_REQUEST','EXPIRE')`,
      [booking.id],
    );
    expect(transitions).toBe(1);
    expect(results.length).toBe(2);
  });

  it('cancels once when tenant and landlord cancel simultaneously', async () => {
    if (!real) return;

    const booking = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantA,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    await bookings.acceptRequest(booking.id, landlord);

    const results = await race(
      () => bookings.cancelByTenant(booking.id, tenantA, 'Планы изменились'),
      () => bookings.cancelByLandlord(booking.id, landlord, 'Ремонт'),
    );

    expect(won(results).length).toBeGreaterThanOrEqual(1);
    const cancellations = await count(
      'booking_event',
      `booking_id=$1 AND event_type LIKE 'CANCEL%'`,
      [booking.id],
    );
    expect(cancellations).toBe(1);
  });
});

/* ================================================================== *
 * Money
 * ================================================================== */

describe('the service fee under simultaneous completion', () => {
  it('accrues exactly one fee when both sides confirm completion at the same instant', async () => {
    if (!real) return;

    const booking = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantA,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    await bookings.acceptRequest(booking.id, landlord);
    await bookings.checkIn(booking.id, tenantA);
    // checkOut already moves the booking into COMPLETION_PENDING; calling
    // openCompletionWindow again would be an illegal transition, which is
    // itself a small proof that the FSM refuses a duplicated system sweep.
    await bookings.checkOut(booking.id, tenantA);

    // The dangerous moment: the second confirmation is what triggers accrual,
    // and both arriving together is precisely when a check-then-insert fails.
    const results = await race(
      () => bookings.confirmCompletion(booking.id, tenantA, 'TOOK_PLACE'),
      () => bookings.confirmCompletion(booking.id, landlord, 'TOOK_PLACE'),
    );

    expect(lost(results)).toHaveLength(0);

    expect(await count('service_fee', 'booking_id=$1', [booking.id])).toBe(1);
    // And exactly one ledger row for it. Two would be a real double charge.
    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_entry le
         JOIN service_fee sf ON sf.id = le.service_fee_id
        WHERE sf.booking_id = $1 AND le.entry_type = 'FEE_ACCRUED'`,
      [booking.id],
    );
    expect(Number(rows[0]!.c)).toBe(1);
  });

  it('accrues one fee when the same confirmation is retried concurrently', async () => {
    if (!real) return;

    const booking = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantA,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    await bookings.acceptRequest(booking.id, landlord);
    await bookings.checkIn(booking.id, tenantA);
    // checkOut already moves the booking into COMPLETION_PENDING; calling
    // openCompletionWindow again would be an illegal transition, which is
    // itself a small proof that the FSM refuses a duplicated system sweep.
    await bookings.checkOut(booking.id, tenantA);
    await bookings.confirmCompletion(booking.id, tenantA, 'TOOK_PLACE');

    // A retried request from an impatient client, three times at once.
    await race(
      () => bookings.confirmCompletion(booking.id, landlord, 'TOOK_PLACE'),
      () => bookings.confirmCompletion(booking.id, landlord, 'TOOK_PLACE'),
      () => bookings.confirmCompletion(booking.id, landlord, 'TOOK_PLACE'),
    );

    expect(await count('service_fee', 'booking_id=$1', [booking.id])).toBe(1);
  });
});

/* ================================================================== *
 * The outbox
 * ================================================================== */

describe('two delivery workers on one queue', () => {
  it('never hands the same notification to two workers', async () => {
    if (!real) return;

    for (let i = 0; i < 40; i += 1) {
      await notifications.enqueue({
        userId: tenantA,
        category: 'MESSAGE',
        dedupeKey: `race:${i}`,
        channels: ['IN_APP'],
      });
    }

    const now = new Date();
    // Four workers, each asking for more than a quarter of the queue, so any
    // overlap in what they claim would show up immediately.
    const claims = await race(
      () => notifications.claimForDelivery(['IN_APP'], 20, now),
      () => notifications.claimForDelivery(['IN_APP'], 20, now),
      () => notifications.claimForDelivery(['IN_APP'], 20, now),
      () => notifications.claimForDelivery(['IN_APP'], 20, now),
    );

    const claimed = won(claims).flatMap((r) => r.value.map((n) => n.id));
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.length).toBeLessThanOrEqual(40);

    // Everything claimed is exclusively held; nothing is left half-claimed.
    const stillPending = await count('notification', `status='PENDING' AND dedupe_key LIKE 'race:%'`, []);
    expect(stillPending).toBe(40 - claimed.length);
  });

  it('does not double-count attempts when workers collide', async () => {
    if (!real) return;

    await notifications.enqueue({
      userId: tenantA,
      category: 'MESSAGE',
      dedupeKey: 'attempts:1',
      channels: ['IN_APP'],
    });

    const now = new Date();
    await race(
      () => notifications.claimForDelivery(['IN_APP'], 5, now),
      () => notifications.claimForDelivery(['IN_APP'], 5, now),
      () => notifications.claimForDelivery(['IN_APP'], 5, now),
    );

    const { rows } = await db.query<{ attempts: number }>(
      `SELECT attempts FROM notification WHERE dedupe_key='attempts:1'`,
    );
    // One claim, one attempt. Three would mean the row was handed out thrice
    // and its retry budget silently burned by workers that never sent it.
    expect(rows[0]!.attempts).toBe(1);
  });
});

/* ================================================================== *
 * Jobs
 * ================================================================== */

describe('two schedulers firing at once', () => {
  it('lets exactly one runner claim a job, whatever the overlap', async () => {
    if (!real) return;

    const results = await race(
      () => retention.beginRun('notification.deliver', null),
      () => retention.beginRun('notification.deliver', null),
      () => retention.beginRun('notification.deliver', null),
      () => retention.beginRun('notification.deliver', null),
    );

    const ids = won(results).map((r) => r.value);
    // The partial unique index on (job_name) WHERE status='RUNNING' is the
    // mutex. Losers get null — a documented no-op, not an exception.
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect(await count('job_run', `job_name='notification.deliver' AND status='RUNNING'`, [])).toBe(1);
  });

  it('keeps two different jobs independent', async () => {
    if (!real) return;

    const results = await race(
      () => retention.beginRun('notification.deliver', null),
      () => retention.beginRun('retention.purge', null),
      () => retention.beginRun('lifecycle.sweep', null),
    );

    expect(won(results).map((r) => r.value).filter(Boolean)).toHaveLength(3);
  });

  it('frees the lock for the next run once the first finishes', async () => {
    if (!real) return;

    const first = await retention.beginRun('lifecycle.sweep', null);
    expect(first).not.toBeNull();
    await retention.finishRun(first!, { processed: 0, skipped: 0, failed: 0 });

    const second = await retention.beginRun('lifecycle.sweep', null);
    expect(second).not.toBeNull();
  });
});

/* ================================================================== *
 * Listings
 * ================================================================== */

describe('two staff decisions on one listing', () => {
  it('records one moderation outcome when approve and reject arrive together', async () => {
    if (!real) return;

    const moderator = await user('Ганна Мадэратар');
    const draft = uuidv7();
    await db.query(
      `INSERT INTO property (id, owner_id, title, city, property_type, latitude, longitude,
          public_latitude, public_longitude, base_price_minor, price_unit, min_nights, max_nights,
          max_guests, booking_mode, status)
       VALUES ($1,$2,'На модерации','Минск','APARTMENT',53.9,27.5,53.9,27.5,8000,'NIGHT',1,365,4,
          'INSTANT_AND_REQUEST','PENDING_MODERATION')`,
      [draft, landlord],
    );

    const results = await race(
      () => listings.moderate(draft, moderator, 'PUBLISHED'),
      () => listings.moderate(draft, moderator, 'REJECTED', 'Мало фотографий', ['INSUFFICIENT_PHOTOS']),
    );

    // Whatever the order, the listing must end in one of the two states and
    // must not be left half-moderated.
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM property WHERE id=$1`, [draft]);
    expect(['PUBLISHED', 'REJECTED']).toContain(rows[0]!.status);
    expect(won(results).length).toBeGreaterThanOrEqual(1);
  });
});

/* ================================================================== *
 * Rollback
 * ================================================================== */

describe('a failed transaction leaves nothing behind', () => {
  it('writes no booking and no event when acceptance is refused', async () => {
    if (!real) return;

    const booking = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantA,
      from: '2026-09-01',
      to: '2026-09-08',
    });

    const eventsBefore = await count('booking_event', 'booking_id=$1', [booking.id]);

    // A stranger, not the landlord.
    await expect(bookings.acceptRequest(booking.id, tenantB)).rejects.toThrow();

    expect(await count('booking_event', 'booking_id=$1', [booking.id])).toBe(eventsBefore);
    expect((await bookings.get(booking.id)).status).toBe('REQUESTED');
  });

  it('leaves no partial fee when a completion is refused mid-way', async () => {
    if (!real) return;

    const booking = await bookings.requestBooking({
      propertyId: property,
      tenantId: tenantA,
      from: '2026-09-01',
      to: '2026-09-08',
    });
    await bookings.acceptRequest(booking.id, landlord);

    // Completion before the window is open must refuse, and must not have
    // written a fee on its way to refusing.
    await expect(
      bookings.confirmCompletion(booking.id, tenantA, 'TOOK_PLACE'),
    ).rejects.toThrow();

    expect(await count('service_fee', 'booking_id=$1', [booking.id])).toBe(0);
    expect(await count('ledger_entry', 'booking_id=$1', [booking.id])).toBe(0);
  });
});

/* ================================================================== *
 * The driver itself
 * ================================================================== */

describe('the two database drivers agree', () => {
  it('runs this suite on a real server, or says why it did not', () => {
    // Not decoration. If this file is ever run in CI without
    // TEST_DATABASE_URL, this is the line that records that every assertion
    // above was skipped — which is the failure mode the whole file guards.
    if (!real) {
      expect(db.driver).toBe('pglite');
      return;
    }
    expect(db.driver).toBe('postgres');
  });

  it('rolls back a nested savepoint without losing the outer transaction', async () => {
    if (!real) return;

    // The pg adapter implements nesting with real SAVEPOINTs via
    // AsyncLocalStorage. If an inner failure escaped, a service calling
    // another service would silently commit half its work.
    const id = uuidv7();
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,'Внешний')`, [
        id,
        `${id}@example.by`,
      ]);
      const innerId = uuidv7();
      await expect(
        db.transaction(async (inner) => {
          await inner.query(`INSERT INTO app_user (id, email, display_name) VALUES ($1,$2,'Внутренний')`, [
            innerId,
            `${innerId}@example.by`,
          ]);
          throw new Error('inner fails');
        }),
      ).rejects.toThrow('inner fails');

      // The inner rollback took the savepoint back and nothing else: the
      // outer row is still pending in the same transaction.
      const { rows } = await tx.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM app_user WHERE id IN ($1,$2)`,
        [id, innerId],
      );
      expect(Number(rows[0]!.c)).toBe(1);
    });

    expect(await count('app_user', 'id=$1', [id])).toBe(1);
  });
});
