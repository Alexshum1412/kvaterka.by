/**
 * The landlord's path from "Добавить объявление" to "На проверке".
 *
 * The wizard's whole premise is that a listing can exist while it is
 * still nonsense — no title, no price, no location — and that the
 * database will nonetheless refuse to let anything incomplete escape
 * DRAFT. Both halves of that are asserted here, along with the
 * cross-tenant cases, which are the ones that actually matter if they
 * ever regress.
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
      ('WIFI','ESSENTIALS','Wi-Fi','Wi-Fi','Wi-Fi'),
      ('WASHING_MACHINE','BATHROOM','Стиральная машина','Пральная машына','Washing machine')
    ON CONFLICT DO NOTHING;
    INSERT INTO feature_flag (key, enabled, description, requires_legal_approval) VALUES
      ('fee.enforcement', true, 'test', true)
    ON CONFLICT DO NOTHING;
  `);
});

/** The wizard's first screen: a type and nothing else. */
async function startDraft(token: string) {
  const res = await api.post('/listings', { propertyType: 'APARTMENT' }, { token });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** Everything `submitForModeration` insists on, minus the photograph. */
async function fillOut(token: string, id: string) {
  const res = await api.patch(
    `/listings/${id}`,
    {
      title: 'Светлая двушка у метро Немига',
      city: 'Минск',
      district: 'Центральный',
      latitude: 53.9045,
      longitude: 27.5615,
      rooms: 2,
      maxGuests: 4,
      basePriceMinor: '9000',
      minNights: 2,
      maxNights: 90,
      amenities: ['WIFI'],
    },
    { token },
  );
  expect(res.status).toBe(200);
}

async function attachPhoto(token: string, id: string) {
  const res = await api.post(`/listings/${id}/photos`, { storageKey: `listings/${id}/a.jpg` }, { token });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/* ================================================================== */

describe('draft creation', () => {
  it('creates a listing from a property type alone', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);

    const mine = await api.get('/listings/mine', { token: landlord.token });
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].status).toBe('DRAFT');
    // Nothing has been filled in yet, and that is a legal state.
    expect(mine.body[0].title).toBeNull();
  });

  it('shows the draft in the owner’s own view with everything still empty', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);

    const res = await api.get(`/listings/${id}/edit`, { token: landlord.token });
    expect(res.status).toBe(200);
    expect(res.body.propertyType).toBe('APARTMENT');
    expect(res.body.title).toBeNull();
    expect(res.body.city).toBeNull();
    expect(res.body.basePriceMinor).toBeNull();
    expect(res.body.photos).toEqual([]);
  });

  it('keeps every answer across separate saves, which is what resume relies on', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);

    await api.patch(`/listings/${id}`, { city: 'Гродно' }, { token: landlord.token });
    await api.patch(`/listings/${id}`, { rooms: 3 }, { token: landlord.token });
    await api.patch(`/listings/${id}`, { title: 'Квартира в старом городе' }, { token: landlord.token });

    const res = await api.get(`/listings/${id}/edit`, { token: landlord.token });
    expect(res.body.city).toBe('Гродно');
    expect(res.body.rooms).toBe(3);
    expect(res.body.title).toBe('Квартира в старом городе');
  });

  it('refuses half a coordinate', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);

    const res = await api.patch(`/listings/${id}`, { latitude: 53.9 }, { token: landlord.token });
    expect(res.status).toBe(422);
  });
});

describe('submission requirements', () => {
  it('refuses a draft with no photograph, and says which one is missing', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await fillOut(landlord.token, id);

    const res = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('фотографию');
  });

  it('refuses a draft with no title', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await api.patch(
      `/listings/${id}`,
      { city: 'Минск', latitude: 53.9, longitude: 27.56, basePriceMinor: '9000' },
      { token: landlord.token },
    );
    await attachPhoto(landlord.token, id);

    const res = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('название');
  });

  it('refuses a draft with no price', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await api.patch(
      `/listings/${id}`,
      { title: 'Светлая двушка у метро', city: 'Минск', latitude: 53.9, longitude: 27.56 },
      { token: landlord.token },
    );
    await attachPhoto(landlord.token, id);

    const res = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('цену');
  });

  it('accepts a complete draft and moves it to PENDING_MODERATION', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await fillOut(landlord.token, id);
    await attachPhoto(landlord.token, id);

    const res = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
    expect(res.status).toBe(200);

    const mine = await api.get('/listings/mine', { token: landlord.token });
    expect(mine.body[0].status).toBe('PENDING_MODERATION');
  });

  it('does not publish on submission — a moderator still has to act', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await fillOut(landlord.token, id);
    await attachPhoto(landlord.token, id);
    await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });

    // Still invisible to the public.
    const publicView = await api.get(`/listings/${id}`);
    expect(publicView.status).toBe(404);
  });
});

describe('the database is the backstop, not the form', () => {
  it('refuses to leave DRAFT without a price even if the service is bypassed', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);

    // Straight SQL, as a rogue script or a future bug would do it.
    await expect(
      db.query(`UPDATE property SET status='PENDING_MODERATION' WHERE id=$1`, [id]),
    ).rejects.toThrow();
  });

  it('still allows a complete listing to leave DRAFT', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await fillOut(landlord.token, id);

    await expect(
      db.query(`UPDATE property SET status='PENDING_MODERATION' WHERE id=$1`, [id]),
    ).resolves.toBeDefined();
  });
});

describe('duration', () => {
  it('rejects a maximum shorter than the minimum', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);

    const res = await api.patch(`/listings/${id}`, { minNights: 30, maxNights: 7 }, { token: landlord.token });
    expect(res.status).toBe(422);
  });

  it('accepts a long-stay range', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);

    const res = await api.patch(`/listings/${id}`, { minNights: 180, maxNights: 1095 }, { token: landlord.token });
    expect(res.status).toBe(200);
    const check = await api.get(`/listings/${id}/edit`, { token: landlord.token });
    expect(check.body.minNights).toBe(180);
    expect(check.body.maxNights).toBe(1095);
  });
});

describe('photos', () => {
  it('makes the first photo the cover automatically', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    const first = await attachPhoto(landlord.token, id);
    await api.post(`/listings/${id}/photos`, { storageKey: `listings/${id}/b.jpg` }, { token: landlord.token });

    const res = await api.get(`/listings/${id}/edit`, { token: landlord.token });
    expect(res.body.photos).toHaveLength(2);
    expect(res.body.photos.find((p: any) => p.id === first).isCover).toBe(true);
  });

  it('moves the cover when asked', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await attachPhoto(landlord.token, id);
    const second = await api.post(
      `/listings/${id}/photos`,
      { storageKey: `listings/${id}/b.jpg` },
      { token: landlord.token },
    );

    await api.post(`/listings/${id}/photos/${second.body.id}/cover`, {}, { token: landlord.token });

    const res = await api.get(`/listings/${id}/edit`, { token: landlord.token });
    expect(res.body.photos.find((p: any) => p.id === second.body.id).isCover).toBe(true);
  });
});

/* ================================================================== *
 * The cases that matter if they regress
 * ================================================================== */

describe('one landlord cannot touch another’s listing', () => {
  it('cannot read a stranger’s draft', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);

    const res = await api.get(`/listings/${id}/edit`, { token: bob.token });
    // "Not found", not "forbidden": otherwise the endpoint confirms that
    // a draft with that id exists.
    expect(res.status).toBe(404);
  });

  it('cannot edit a stranger’s draft', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);

    const res = await api.patch(`/listings/${id}`, { title: 'Захвачено' }, { token: bob.token });
    expect([403, 404]).toContain(res.status);

    const check = await api.get(`/listings/${id}/edit`, { token: alice.token });
    expect(check.body.title).toBeNull();
  });

  it('cannot attach a photo to a stranger’s listing', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);

    const res = await api.post(`/listings/${id}/photos`, { storageKey: 'listings/x/evil.jpg' }, { token: bob.token });
    expect([403, 404]).toContain(res.status);

    const check = await api.get(`/listings/${id}/edit`, { token: alice.token });
    expect(check.body.photos).toEqual([]);
  });

  it('cannot delete a stranger’s photo', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);
    const photoId = await attachPhoto(alice.token, id);

    const res = await api.delete(`/listings/${id}/photos/${photoId}`, { token: bob.token });
    expect([403, 404]).toContain(res.status);

    const check = await api.get(`/listings/${id}/edit`, { token: alice.token });
    expect(check.body.photos).toHaveLength(1);
  });

  it('cannot submit a stranger’s listing for moderation', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);
    await fillOut(alice.token, id);
    await attachPhoto(alice.token, id);

    const res = await api.post(`/listings/${id}/submit`, {}, { token: bob.token });
    expect([403, 404]).toContain(res.status);

    const check = await api.get(`/listings/${id}/edit`, { token: alice.token });
    expect(check.body.status).toBe('DRAFT');
  });

  it('cannot block dates on a stranger’s calendar', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);

    const res = await api.post(
      `/listings/${id}/availability/block`,
      { from: '2027-03-01', to: '2027-03-05' },
      { token: bob.token },
    );
    expect([403, 404]).toContain(res.status);
  });

  it('requires a session at all', async () => {
    const alice = await api.signUp();
    const id = await startDraft(alice.token);

    expect((await api.get(`/listings/${id}/edit`)).status).toBe(401);
    expect((await api.patch(`/listings/${id}`, { title: 'x' })).status).toBe(401);
    expect((await api.post(`/listings/${id}/submit`, {})).status).toBe(401);
  });
});

describe('availability', () => {
  it('blocks and reopens a range', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await fillOut(landlord.token, id);

    const blocked = await api.post(
      `/listings/${id}/availability/block`,
      { from: '2027-03-10', to: '2027-03-14' },
      { token: landlord.token },
    );
    expect(blocked.status).toBe(201);

    const calendar = await api.get(
      `/listings/${id}/availability?from=2027-03-01&to=2027-03-31`,
      { token: landlord.token },
    );
    const march12 = calendar.body.days.find((d: any) => d.date === '2027-03-12');
    expect(march12.status).toBe('BLOCKED');

    await api.delete(`/availability/blocks/${blocked.body.id}`, { token: landlord.token });

    const after = await api.get(
      `/listings/${id}/availability?from=2027-03-01&to=2027-03-31`,
      { token: landlord.token },
    );
    expect(after.body.days.find((d: any) => d.date === '2027-03-12').status).toBe('AVAILABLE');
  });
});
