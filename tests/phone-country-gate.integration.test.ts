/**
 * A verified phone number outside Belarus (does not start with +375) is a
 * country-restriction signal now, per a direct product owner instruction
 * (DEC-076) rather than a default this codebase invented:
 *
 *   1. Publishing a listing is refused for a landlord whose own verified
 *      phone is not Belarusian — at listing creation and at submission for
 *      moderation, the two places `finance.assertNotRestricted` already
 *      gates `CANNOT_PUBLISH_NEW_LISTINGS`.
 *   2. A landlord contacted by — messaged, or booked by — a guest whose
 *      verified phone is not Belarusian sees a derived `phoneCountryMismatch`
 *      warning about it, never the raw phone number, and never the reverse
 *      (a tenant never sees this about their landlord).
 *
 * A caller with NO verified phone at all is unaffected by any of this: in
 * production the platform-wide phone gate (router.ts) already refuses every
 * `auth: 'required'` route before dispatch reaches these checks. That gate
 * is never armed in this test harness (`ApiTestClient` never passes
 * `phoneVerificationAvailable` to `dispatch`, matching every other suite
 * here), so the assertion below is simply that OUR new checks do not
 * themselves invent a restriction for the unverified case.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { BookingService } from '@/server/services/booking-service.ts';
import { MessagingService } from '@/server/services/messaging-service.ts';
import { uuidv7 } from '@/lib/id.ts';

let db: TestDb;
let api: ApiTestClient;
let bookings: BookingService;
let messaging: MessagingService;

beforeAll(async () => {
  db = await createTestDb();
  api = new ApiTestClient(db);
  bookings = new BookingService(db);
  messaging = new MessagingService(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await api.resetRateLimits();
});

/** Telegram is the only verification channel left (DEC-069) — mirrors the
 *  shape `completePhoneVerificationTelegramContact` actually writes. */
async function verifyPhone(userId: string, phone: string | null): Promise<void> {
  await db.query(
    `UPDATE app_user SET phone = $2, phone_verified_via = 'TELEGRAM', phone_verified_at = now() WHERE id = $1`,
    [userId, phone],
  );
}

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
        53.9045,27.5615,53.9048,27.5611,8000,'NIGHT',0,
        0,1,365,4,'INSTANT_AND_REQUEST','PUBLISHED',now())`,
    [id, ownerId],
  );
  return id;
}

async function fillOutAndAddPhoto(token: string, id: string): Promise<void> {
  const res = await api.patch(
    `/listings/${id}`,
    {
      title: 'Светлая двушка у метро Немига',
      city: 'Минск',
      latitude: 53.9045,
      longitude: 27.5615,
      basePriceMinor: '9000',
    },
    { token },
  );
  expect(res.status).toBe(200);
  await api.attachPhoto(id);
}

/* ================================================================== */

describe('publishing requires a Belarusian phone (DEC-076)', () => {
  it('refuses to create a draft for a landlord verified on a foreign phone', async () => {
    const landlord = await api.signUp();
    await verifyPhone(landlord.userId, '+79261234567'); // Russia

    const res = await api.post('/listings', { propertyType: 'APARTMENT' }, { token: landlord.token });
    expect(res.status).toBe(403);
    expect(res.errorCode).toBe('FORBIDDEN');
  });

  it('allows creating a draft for a landlord verified on a Belarusian phone', async () => {
    const landlord = await api.signUp();
    await verifyPhone(landlord.userId, '+375291234567');

    const res = await api.post('/listings', { propertyType: 'APARTMENT' }, { token: landlord.token });
    expect(res.status).toBe(201);
  });

  it('does not block a landlord with no verified phone at all', async () => {
    const landlord = await api.signUp();
    // phone_verified_at stays NULL — the platform-wide gate (router.ts)
    // is what refuses this caller in production, not this check.
    const res = await api.post('/listings', { propertyType: 'APARTMENT' }, { token: landlord.token });
    expect(res.status).toBe(201);
  });

  it('does not block a phone_verified_at set with no phone on file (residual pre-Telegram-only shape)', async () => {
    const landlord = await api.signUp();
    await verifyPhone(landlord.userId, null);

    const res = await api.post('/listings', { propertyType: 'APARTMENT' }, { token: landlord.token });
    expect(res.status).toBe(201);
  });

  it('refuses submission for moderation once the landlord verifies a foreign phone', async () => {
    const landlord = await api.signUp();
    const draft = await api.post('/listings', { propertyType: 'APARTMENT' }, { token: landlord.token });
    expect(draft.status).toBe(201);
    const id = draft.body.id as string;
    await fillOutAndAddPhoto(landlord.token, id);

    await verifyPhone(landlord.userId, '+380501234567'); // Ukraine

    const res = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
    expect(res.status).toBe(403);
    expect(res.errorCode).toBe('FORBIDDEN');
  });

  it('allows submission for moderation for a landlord verified on a Belarusian phone', async () => {
    const landlord = await api.signUp();
    const draft = await api.post('/listings', { propertyType: 'APARTMENT' }, { token: landlord.token });
    const id = draft.body.id as string;
    await fillOutAndAddPhoto(landlord.token, id);

    await verifyPhone(landlord.userId, '+375291234567');

    const res = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING_MODERATION');
  });
});

/* ================================================================== */

describe('chat counterparty carries a derived phoneCountryMismatch, never the raw phone (DEC-076)', () => {
  it('is true when a foreign-phone guest messages the landlord, and the raw phone never appears', async () => {
    const landlord = await user('Алесь Уладальнік');
    const guest = await user('Гость Іншаземны');
    await verifyPhone(guest, '+79261234567');
    const property = await publishedProperty(landlord);

    await messaging.startConversation(property, guest);
    const conversations = await messaging.listConversations(landlord);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.counterparty.phoneCountryMismatch).toBe(true);
    // The whole payload, not just the object shape: the raw digits must not
    // be reachable through this response by any route.
    expect(JSON.stringify(conversations)).not.toContain('79261234567');
  });

  it('is false for a Belarusian-verified guest', async () => {
    const landlord = await user('Алесь Уладальнік');
    const guest = await user('Гаспадар Мясцовы');
    await verifyPhone(guest, '+375291234567');
    const property = await publishedProperty(landlord);

    await messaging.startConversation(property, guest);
    const conversations = await messaging.listConversations(landlord);

    expect(conversations[0]!.counterparty.phoneCountryMismatch).toBe(false);
  });

  it('is false for a guest with no verified phone', async () => {
    const landlord = await user('Алесь Уладальнік');
    const guest = await user('Госць Без Тэлефона');
    const property = await publishedProperty(landlord);

    await messaging.startConversation(property, guest);
    const conversations = await messaging.listConversations(landlord);

    expect(conversations[0]!.counterparty.phoneCountryMismatch).toBe(false);
  });

  it('never reports the reverse: a tenant viewing a foreign-phone-verified landlord sees false', async () => {
    const landlord = await user('Замежны Гаспадар');
    await verifyPhone(landlord, '+79261234567');
    const guest = await user('Звычайны Госць');
    const property = await publishedProperty(landlord);

    await messaging.startConversation(property, guest);
    const conversations = await messaging.listConversations(guest);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.counterparty.phoneCountryMismatch).toBe(false);
  });

  it('is true when the signal comes from a booking request rather than a chat message', async () => {
    const landlord = await user('Алесь Уладальнік');
    const guest = await user('Госць Замежны');
    await verifyPhone(guest, '+380501234567');
    const property = await publishedProperty(landlord);

    await bookings.requestBooking({
      propertyId: property,
      tenantId: guest,
      from: '2026-10-01',
      to: '2026-10-05',
      guests: 2,
    });

    const conversations = await messaging.listConversations(landlord);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.counterparty.phoneCountryMismatch).toBe(true);
  });
});

/* ================================================================== */

describe('booking detail trust panel — same derived boolean, gated by viewer role (DEC-076)', () => {
  /**
   * `bookings/[id]/page.tsx` is a Next.js server component and cannot be
   * driven from this in-process harness, so this runs its counterparty
   * query verbatim (kept in sync with that file by hand) rather than a
   * paraphrase of the logic — the assertion is on the exact SQL that ships,
   * including that the SELECT list never names a phone column at all.
   */
  async function counterpartyRow(counterpartyId: string, viewerIsLandlord: boolean): Promise<Record<string, any>> {
    const { rows } = await db.query<Record<string, any>>(
      `SELECT u.id, u.display_name, u.account_kind, u.company_name, u.verification_level,
              u.created_at, u.completed_rentals_as_tenant, u.completed_rentals_as_landlord,
              (SELECT round(avg(r.overall)::numeric,2) FROM review r
                WHERE r.subject_id = u.id AND r.status = 'PUBLISHED') AS rating,
              ($2::boolean AND u.phone_verified_via IS NOT NULL AND u.phone_verified_at IS NOT NULL
                  AND u.phone IS NOT NULL AND u.phone NOT LIKE '+375%') AS phone_country_mismatch
         FROM app_user u WHERE u.id = $1`,
      [counterpartyId, viewerIsLandlord],
    );
    return rows[0]!;
  }

  it('is true for a landlord viewing a foreign-phone tenant, and never selects a phone column', async () => {
    const tenant = await user('Арандатар Замежны');
    await verifyPhone(tenant, '+79261234567');

    const row = await counterpartyRow(tenant, true);
    expect(row.phone_country_mismatch).toBe(true);
    expect(Object.keys(row)).not.toContain('phone');
    expect(JSON.stringify(row)).not.toContain('79261234567');
  });

  it('is false for a landlord viewing a Belarusian-verified tenant', async () => {
    const tenant = await user('Арандатар Мясцовы');
    await verifyPhone(tenant, '+375291234567');

    const row = await counterpartyRow(tenant, true);
    expect(row.phone_country_mismatch).toBe(false);
  });

  it('is false when the viewer is the tenant, even though the landlord has a foreign phone', async () => {
    const landlord = await user('Гаспадар Замежны');
    await verifyPhone(landlord, '+79261234567');

    const row = await counterpartyRow(landlord, false);
    expect(row.phone_country_mismatch).toBe(false);
  });

  it('is false for phone_verified_at set with phone NULL (residual pre-Telegram-only shape)', async () => {
    const tenant = await user('Стары Запіс');
    await verifyPhone(tenant, null);

    const row = await counterpartyRow(tenant, true);
    expect(row.phone_country_mismatch).toBe(false);
  });
});

/* ================================================================== */

describe('landlord booking inbox row — same derived boolean (DEC-076)', () => {
  /** Mirrors dashboard/(hub)/bookings/page.tsx's own query, which is
   *  landlord-only by construction (`WHERE b.landlord_id = $1`) so it needs
   *  no viewer-role gating the way the shared booking-detail query does. */
  async function inboxRow(tenantId: string): Promise<Record<string, any>> {
    const { rows } = await db.query<Record<string, any>>(
      `SELECT u.display_name AS counterparty_name,
              (u.phone_verified_via IS NOT NULL AND u.phone_verified_at IS NOT NULL
                  AND u.phone IS NOT NULL AND u.phone NOT LIKE '+375%') AS counterparty_phone_mismatch
         FROM app_user u WHERE u.id = $1`,
      [tenantId],
    );
    return rows[0]!;
  }

  it('flags a foreign-phone tenant and clears a Belarusian one', async () => {
    const foreignTenant = await user('Іншаземны Арандатар');
    await verifyPhone(foreignTenant, '+79261234567');
    const localTenant = await user('Мясцовы Арандатар');
    await verifyPhone(localTenant, '+375291234567');

    expect((await inboxRow(foreignTenant)).counterparty_phone_mismatch).toBe(true);
    expect((await inboxRow(localTenant)).counterparty_phone_mismatch).toBe(false);
  });
});
