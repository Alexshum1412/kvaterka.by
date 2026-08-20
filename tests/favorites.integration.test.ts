/**
 * Favourites.
 *
 * The interesting properties are not "can I save a flat" but the three
 * things that make the endpoint safe to expose to a heart button on a
 * phone: it is idempotent in both directions, it is scoped to the caller,
 * and it cannot be used to discover listings the caller may not see.
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

/* ================================================================== */

describe('favourites', () => {
  it('requires a session', async () => {
    const listingId = await publishedListing();
    const res = await api.put(`/favorites/${listingId}`);
    expect(res.status).toBe(401);
  });

  it('saves and lists a published listing', async () => {
    const listingId = await publishedListing();
    const tenant = await api.signUp();

    const saved = await api.put(`/favorites/${listingId}`, undefined, { token: tenant.token });
    expect(saved.status).toBe(204);

    const list = await api.get('/favorites', { token: tenant.token });
    expect(list.status).toBe(200);
    expect(list.body.propertyIds).toEqual([listingId]);
  });

  it('is idempotent when saving twice', async () => {
    const listingId = await publishedListing();
    const tenant = await api.signUp();

    // A double tap on a phone, or a retry after a dropped connection.
    await api.put(`/favorites/${listingId}`, undefined, { token: tenant.token });
    const again = await api.put(`/favorites/${listingId}`, undefined, { token: tenant.token });
    expect(again.status).toBe(204);

    const list = await api.get('/favorites', { token: tenant.token });
    expect(list.body.propertyIds).toEqual([listingId]);
  });

  it('is idempotent when removing something already gone', async () => {
    const listingId = await publishedListing();
    const tenant = await api.signUp();

    const first = await api.delete(`/favorites/${listingId}`, { token: tenant.token });
    expect(first.status).toBe(204);
    const second = await api.delete(`/favorites/${listingId}`, { token: tenant.token });
    expect(second.status).toBe(204);

    const list = await api.get('/favorites', { token: tenant.token });
    expect(list.body.propertyIds).toEqual([]);
  });

  it('removes a saved listing', async () => {
    const listingId = await publishedListing();
    const tenant = await api.signUp();

    await api.put(`/favorites/${listingId}`, undefined, { token: tenant.token });
    await api.delete(`/favorites/${listingId}`, { token: tenant.token });

    const list = await api.get('/favorites', { token: tenant.token });
    expect(list.body.propertyIds).toEqual([]);
  });

  it('keeps one account’s shortlist invisible to another', async () => {
    const listingId = await publishedListing();
    const alice = await api.signUp();
    const bob = await api.signUp();

    await api.put(`/favorites/${listingId}`, undefined, { token: alice.token });

    const bobsList = await api.get('/favorites', { token: bob.token });
    expect(bobsList.body.propertyIds).toEqual([]);
  });

  it('refuses to save an unpublished listing, and says only "not found"', async () => {
    const draftId = await draftListing();
    const tenant = await api.signUp();

    const res = await api.put(`/favorites/${draftId}`, undefined, { token: tenant.token });
    expect(res.status).toBe(404);
    expect(res.errorCode).toBe('NOT_FOUND');
  });

  it('answers identically for a draft and for an id that does not exist', async () => {
    // Otherwise the endpoint is an oracle: probe an id, and the difference
    // between 404 and 403 tells you whether a private draft exists.
    const draftId = await draftListing();
    const tenant = await api.signUp();

    const draft = await api.put(`/favorites/${draftId}`, undefined, { token: tenant.token });
    const nowhere = await api.put(`/favorites/${randomUUID()}`, undefined, { token: tenant.token });

    expect(draft.status).toBe(nowhere.status);
    expect(draft.errorCode).toBe(nowhere.errorCode);
    expect(draft.body?.error?.message).toBe(nowhere.body?.error?.message);
  });

  it('drops the shortlist entry when the listing is deleted', async () => {
    const listingId = await publishedListing();
    const tenant = await api.signUp();
    await api.put(`/favorites/${listingId}`, undefined, { token: tenant.token });

    await db.query('DELETE FROM property WHERE id = $1', [listingId]);

    const list = await api.get('/favorites', { token: tenant.token });
    expect(list.body.propertyIds).toEqual([]);
  });
});
