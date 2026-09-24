/**
 * `GET /me/profile`.
 *
 * The route has always queried and returned email, phone, verification
 * state, verification level, status, member-since and (since 0022) an
 * avatar key — but until the account page grew a read-only info section
 * nothing checked that any of it actually reached the response. This is
 * the assertion that keeps that shape honest: it is what
 * `src/ui/profile-settings.tsx` now reads field-by-field to render.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
      ('WIFI','ESSENTIALS','Wi-Fi','Wi-Fi','Wi-Fi')
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
  maxGuests: 4,
  basePriceMinor: '9000',
  bookingMode: 'INSTANT_AND_REQUEST' as const,
  amenities: ['WIFI'],
};

/** A listing that has been through moderation and is publicly visible. */
async function publishedListing(): Promise<string> {
  const landlord = await api.signUp();
  const created = await api.post('/listings', LISTING, { token: landlord.token });
  expect(created.status).toBe(201);
  const listingId = created.body.id as string;

  await api.attachPhoto(listingId);
  await api.post(`/listings/${listingId}/submit`, {}, { token: landlord.token });

  const moderator = await api.signUp();
  await api.grantRole(moderator.userId, 'MODERATOR');
  await api.post(`/admin/moderation/listings/${listingId}`, { decision: 'PUBLISHED' }, {
    token: moderator.token,
  });
  return listingId;
}

/** A listing that exists but has never been published. */
async function draftListing(): Promise<string> {
  const landlord = await api.signUp();
  const created = await api.post('/listings', LISTING, { token: landlord.token });
  return created.body.id as string;
}

describe('GET /me/profile', () => {
  it('surfaces email, phone, verification state, level, member-since and avatar key', async () => {
    const user = await api.signUp();

    const res = await api.get('/me/profile', { token: user.token });
    expect(res.status).toBe(200);

    expect(res.body.email).toBe(user.email);
    expect(res.body.phone).toBeNull();
    // Confirming the registration code IS proving control of the inbox — see
    // `confirmRegistration`'s INSERT, which sets email_verified_at at the
    // same moment the account is created. Phone was never supplied here, so
    // it stays unset and therefore unverified.
    expect(res.body.emailVerified).toBe(true);
    expect(res.body.phoneVerified).toBe(false);
    expect(res.body.verificationLevel).toBe(0);
    expect(res.body.avatarStorageKey).toBeNull();
    // A real HTTP round trip serialises this to an ISO string (which is what
    // `profile-settings.tsx` feeds straight into `new Date(...)`); the
    // in-process test client skips that JSON pass and hands back whatever
    // the driver returned, so this only pins "present and a real instant",
    // not the wire representation.
    expect(res.body.memberSince).toBeTruthy();
    expect(Number.isNaN(new Date(res.body.memberSince).getTime())).toBe(false);
    // Unchanged by this task, but still part of the same response the
    // profile screen reads — a regression here would silently blank the
    // trust section rather than fail loudly.
    expect(res.body.trust).toBeDefined();
  });

  it('reports a linked avatar once one is uploaded', async () => {
    const user = await api.signUp();
    await db.query(`UPDATE app_user SET avatar_storage_key=$1 WHERE id=$2`, [
      `avatars/${user.userId}/pic.jpg`,
      user.userId,
    ]);

    const res = await api.get('/me/profile', { token: user.token });
    expect(res.body.avatarStorageKey).toBe(`avatars/${user.userId}/pic.jpg`);
  });

  it('refuses an anonymous caller', async () => {
    const res = await api.get('/me/profile');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /me/profile', () => {
  it('updates every supplied field', async () => {
    const user = await api.signUp();

    const res = await api.patch(
      '/me/profile',
      { displayName: 'Новое Имя', locale: 'en', companyName: 'ООО Ромашка' },
      { token: user.token },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const profile = await api.get('/me/profile', { token: user.token });
    expect(profile.body.displayName).toBe('Новое Имя');
    expect(profile.body.locale).toBe('en');
    expect(profile.body.companyName).toBe('ООО Ромашка');
  });

  it('updates one field and leaves the others exactly as they were', async () => {
    const user = await api.signUp();
    const before = await api.get('/me/profile', { token: user.token });

    const res = await api.patch('/me/profile', { locale: 'be' }, { token: user.token });
    expect(res.status).toBe(200);

    const after = await api.get('/me/profile', { token: user.token });
    expect(after.body.locale).toBe('be');
    expect(after.body.displayName).toBe(before.body.displayName);
    expect(after.body.companyName).toBe(before.body.companyName);
  });

  it('is a harmless no-op when the body is empty', async () => {
    const user = await api.signUp();
    const before = await api.get('/me/profile', { token: user.token });

    const res = await api.patch('/me/profile', {}, { token: user.token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const after = await api.get('/me/profile', { token: user.token });
    expect(after.body.displayName).toBe(before.body.displayName);
    expect(after.body.locale).toBe(before.body.locale);
    expect(after.body.companyName).toBe(before.body.companyName);
  });

  it('rejects a display name below the minimum length', async () => {
    const user = await api.signUp();
    const res = await api.patch('/me/profile', { displayName: 'A' }, { token: user.token });
    expect(res.status).toBe(422);

    // Refused, not silently truncated or ignored — the old value is intact.
    const profile = await api.get('/me/profile', { token: user.token });
    expect(profile.body.displayName).not.toBe('A');
  });

  it('rejects a locale outside ru/be/en', async () => {
    const user = await api.signUp();
    const res = await api.patch('/me/profile', { locale: 'de' }, { token: user.token });
    expect(res.status).toBe(422);
  });

  it('never touches another account’s profile', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const bobBefore = await api.get('/me/profile', { token: bob.token });

    const res = await api.patch('/me/profile', { displayName: 'Имя Алисы' }, { token: alice.token });
    expect(res.status).toBe(200);

    const bobAfter = await api.get('/me/profile', { token: bob.token });
    expect(bobAfter.body.displayName).toBe(bobBefore.body.displayName);

    const alicesProfile = await api.get('/me/profile', { token: alice.token });
    expect(alicesProfile.body.displayName).toBe('Имя Алисы');
  });

  it('refuses an anonymous caller', async () => {
    const res = await api.patch('/me/profile', { displayName: 'Кто-то' });
    expect(res.status).toBe(401);
  });
});

/**
 * `GET/PUT/DELETE /me/favorites` — the social.ts favourites surface.
 *
 * Not to be confused with `/favorites` (favorites.ts, covered in
 * favorites.integration.test.ts): a separate handler, on the same
 * `favorite` table, reached from the account/profile area rather than the
 * listing heart button. It has none of that route's existence checks — it
 * saves and lists whatever the caller points it at, scoped only by
 * `caller.userId` — so what is worth pinning here is that scoping, and that
 * the shape it returns is what a saved-listings screen would actually need.
 */
describe('/me/favorites (profile surface)', () => {
  it('saves a listing and lists it back with the fields a saved-listings screen needs', async () => {
    const listingId = await publishedListing();
    const tenant = await api.signUp();

    const saved = await api.put(`/me/favorites/${listingId}`, undefined, { token: tenant.token });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ saved: true });

    const list = await api.get('/me/favorites', { token: tenant.token });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].property_id).toBe(listingId);
    expect(list.body[0].title).toBe(LISTING.title);
    expect(list.body[0].city).toBe(LISTING.city);
    expect(list.body[0].status).toBe('PUBLISHED');
    expect(list.body[0].cover_photo).toBeTruthy();
  });

  it('is idempotent when saving the same listing twice', async () => {
    const listingId = await publishedListing();
    const tenant = await api.signUp();

    await api.put(`/me/favorites/${listingId}`, undefined, { token: tenant.token });
    const again = await api.put(`/me/favorites/${listingId}`, undefined, { token: tenant.token });
    expect(again.status).toBe(200);

    const list = await api.get('/me/favorites', { token: tenant.token });
    expect(list.body).toHaveLength(1);
  });

  it('removes a saved listing, idempotently', async () => {
    const listingId = await publishedListing();
    const tenant = await api.signUp();
    await api.put(`/me/favorites/${listingId}`, undefined, { token: tenant.token });

    const first = await api.delete(`/me/favorites/${listingId}`, { token: tenant.token });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ saved: false });

    const second = await api.delete(`/me/favorites/${listingId}`, { token: tenant.token });
    expect(second.status).toBe(200);

    const list = await api.get('/me/favorites', { token: tenant.token });
    expect(list.body).toEqual([]);
  });

  it('keeps one account’s shortlist invisible to, and untouched by, another', async () => {
    const listingId = await publishedListing();
    const alice = await api.signUp();
    const bob = await api.signUp();

    await api.put(`/me/favorites/${listingId}`, undefined, { token: alice.token });

    const bobsList = await api.get('/me/favorites', { token: bob.token });
    expect(bobsList.body).toEqual([]);

    // Bob removing "his" copy of a listing he never saved must not touch Alice's.
    await api.delete(`/me/favorites/${listingId}`, { token: bob.token });
    const alicesList = await api.get('/me/favorites', { token: alice.token });
    expect(alicesList.body).toHaveLength(1);
  });

  it('requires a session for every operation', async () => {
    const listingId = await publishedListing();

    expect((await api.get('/me/favorites')).status).toBe(401);
    expect((await api.put(`/me/favorites/${listingId}`)).status).toBe(401);
    expect((await api.delete(`/me/favorites/${listingId}`)).status).toBe(401);
  });

  it('answers with an empty list rather than an error for an id nobody saved', async () => {
    const tenant = await api.signUp();
    const list = await api.get('/me/favorites', { token: tenant.token });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  it('drops the shortlist entry when the listing is deleted', async () => {
    const listingId = await publishedListing();
    const tenant = await api.signUp();
    await api.put(`/me/favorites/${listingId}`, undefined, { token: tenant.token });

    await db.query('DELETE FROM property WHERE id = $1', [listingId]);

    const list = await api.get('/me/favorites', { token: tenant.token });
    expect(list.body).toEqual([]);
  });

  /**
   * Bug found while writing this coverage: the handler used to INSERT
   * straight into `favorite` with no existence/visibility check — unlike
   * `FavoriteService.add` (the same table, reached from `/favorites`),
   * whose own docstring explains that the check exists specifically so
   * this endpoint cannot be used to probe which unpublished listings are
   * real. A property id that does not exist at all tripped the table's
   * foreign key and surfaced as a raw 500; a draft or paused listing's id
   * (which does exist) succeeded with 200 — two different outcomes an
   * outsider could use to tell "no such id anywhere" apart from "a real,
   * unpublished listing", which is exactly the oracle `FavoriteService`
   * was written to close off. Fixed by routing through that same service;
   * these assert the corrected, uniform behaviour.
   */
  it('refuses to save an unpublished listing, and says only "not found"', async () => {
    const draftId = await draftListing();
    const tenant = await api.signUp();

    const res = await api.put(`/me/favorites/${draftId}`, undefined, { token: tenant.token });
    expect(res.status).toBe(404);
    expect(res.errorCode).toBe('NOT_FOUND');
  });

  it('answers identically for a draft and for a property id that does not exist at all', async () => {
    const draftId = await draftListing();
    const tenant = await api.signUp();

    const draft = await api.put(`/me/favorites/${draftId}`, undefined, { token: tenant.token });
    const nowhere = await api.put(`/me/favorites/00000000-0000-0000-0000-000000000000`, undefined, {
      token: tenant.token,
    });

    expect(draft.status).toBe(nowhere.status);
    expect(draft.status).toBe(404);
    expect(draft.errorCode).toBe(nowhere.errorCode);
    expect(draft.body?.error?.message).toBe(nowhere.body?.error?.message);
  });
});
