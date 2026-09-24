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
import { ListingService } from '@/server/services/listing-service.ts';
import { BookingService } from '@/server/services/booking-service.ts';

let db: TestDb;
let api: ApiTestClient;
let listings: ListingService;
let bookings: BookingService;

beforeAll(async () => {
  db = await createTestDb();
  api = new ApiTestClient(db);
  listings = new ListingService(db);
  bookings = new BookingService(db);
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

/* ================================================================== */

describe('draft creation', () => {
  it('creates a listing from a property type alone', async () => {
    const landlord = await api.signUp();
    await startDraft(landlord.token);

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

  it('never lists a second landlord’s listings under /listings/mine', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const aliceListing = await startDraft(alice.token);
    await startDraft(bob.token);
    await startDraft(bob.token);

    const mine = await api.get('/listings/mine', { token: bob.token });
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(2);
    expect(mine.body.every((l: any) => l.id !== aliceListing)).toBe(true);
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
    await api.attachPhoto(id);

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
    await api.attachPhoto(id);

    const res = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('цену');
  });

  it('accepts a complete draft and moves it to PENDING_MODERATION', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await fillOut(landlord.token, id);
    await api.attachPhoto(id);

    const res = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
    expect(res.status).toBe(200);

    const mine = await api.get('/listings/mine', { token: landlord.token });
    expect(mine.body[0].status).toBe('PENDING_MODERATION');
  });

  it('does not publish on submission — a moderator still has to act', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await fillOut(landlord.token, id);
    await api.attachPhoto(id);
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

    const res = await api.patch(
      `/listings/${id}`,
      { minNights: 30, maxNights: 7 },
      { token: landlord.token },
    );
    expect(res.status).toBe(422);
  });

  it('accepts a long-stay range', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);

    const res = await api.patch(
      `/listings/${id}`,
      { minNights: 180, maxNights: 1095 },
      { token: landlord.token },
    );
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
    const first = await api.attachPhoto(id);
    await api.attachPhoto(id, 'b.jpg');

    const res = await api.get(`/listings/${id}/edit`, { token: landlord.token });
    expect(res.body.photos).toHaveLength(2);
    expect(res.body.photos.find((p: any) => p.id === first).isCover).toBe(true);
  });

  it('moves the cover when asked', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await api.attachPhoto(id);
    const second = await api.attachPhoto(id, 'b.jpg');

    await api.post(`/listings/${id}/photos/${second}/cover`, {}, { token: landlord.token });

    const res = await api.get(`/listings/${id}/edit`, { token: landlord.token });
    expect(res.body.photos.find((p: any) => p.id === second).isCover).toBe(true);
  });
});

/** A landlord's listing that has cleared moderation and gone live. */
async function publishedListing() {
  const landlord = await api.signUp();
  const id = await startDraft(landlord.token);
  await fillOut(landlord.token, id);
  await api.attachPhoto(id);
  const submitted = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
  expect(submitted.status).toBe(200);

  const moderator = await api.signUp();
  await api.grantRole(moderator.userId, 'MODERATOR');
  const decision = await api.post(
    `/admin/moderation/listings/${id}`,
    { decision: 'PUBLISHED' },
    { token: moderator.token },
  );
  expect(decision.status).toBe(200);

  return { landlord, id, moderator };
}

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

    // Ownership is checked in the service, so the refusal holds no matter
    // which door a future caller comes through.
    await expect(
      listings.addPhoto(id, bob.userId, { storageKey: `listings/${id}/evil.jpg` }),
    ).rejects.toThrow();

    const check = await api.get(`/listings/${id}/edit`, { token: alice.token });
    expect(check.body.photos).toEqual([]);
  });

  it('cannot point a photo at another listing’s namespace', async () => {
    const alice = await api.signUp();
    const id = await startDraft(alice.token);
    const other = await startDraft(alice.token);

    // Alice owns both, so ownership is not what refuses this: the key must
    // live under the listing it is attached to, or a row could publish another
    // listing's object once a real bucket exists.
    await expect(
      listings.addPhoto(id, alice.userId, { storageKey: `listings/${other}/a.jpg` }),
    ).rejects.toThrow();

    await expect(
      listings.addPhoto(id, alice.userId, { storageKey: `private/documents/passport.jpg` }),
    ).rejects.toThrow();
  });

  it('cannot delete a stranger’s photo', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);
    const photoId = await api.attachPhoto(id);

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
    await api.attachPhoto(id);

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

  it('cannot remove a block from a stranger’s calendar', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);
    await fillOut(alice.token, id);

    const blocked = await api.post(
      `/listings/${id}/availability/block`,
      { from: '2027-04-01', to: '2027-04-05' },
      { token: alice.token },
    );
    expect(blocked.status).toBe(201);

    const res = await api.delete(`/availability/blocks/${blocked.body.id}`, { token: bob.token });
    expect([403, 404]).toContain(res.status);

    // Untouched: the block still holds those dates.
    const calendar = await api.get(`/listings/${id}/availability?from=2027-04-01&to=2027-04-10`, {
      token: alice.token,
    });
    expect(calendar.body.days.find((d: any) => d.date === '2027-04-02').status).toBe('BLOCKED');
  });

  it('cannot confirm a stranger’s calendar is up to date', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);

    await db.query(`UPDATE property SET calendar_updated_at = now() - interval '30 days' WHERE id=$1`, [id]);

    const res = await api.post(`/listings/${id}/availability/confirm`, {}, { token: bob.token });
    expect([403, 404]).toContain(res.status);

    // Untouched: alice's calendar is still stale, not refreshed by a stranger.
    const row = await db.query<{ calendar_updated_at: string }>(
      `SELECT calendar_updated_at FROM property WHERE id=$1`,
      [id],
    );
    const ageDays = (Date.now() - Date.parse(row.rows[0]!.calendar_updated_at)) / 86_400_000;
    expect(ageDays).toBeGreaterThan(29);
  });

  it('cannot set the cover photo on a stranger’s listing', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);
    const first = await api.attachPhoto(id);
    const second = await api.attachPhoto(id, 'b.jpg');

    const res = await api.post(`/listings/${id}/photos/${second}/cover`, {}, { token: bob.token });
    expect([403, 404]).toContain(res.status);

    // Untouched: the first photo attached is still the cover.
    const check = await api.get(`/listings/${id}/edit`, { token: alice.token });
    expect(check.body.photos.find((p: any) => p.id === first).isCover).toBe(true);
    expect(check.body.photos.find((p: any) => p.id === second).isCover).toBe(false);
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

    const calendar = await api.get(`/listings/${id}/availability?from=2027-03-01&to=2027-03-31`, {
      token: landlord.token,
    });
    const march12 = calendar.body.days.find((d: any) => d.date === '2027-03-12');
    expect(march12.status).toBe('BLOCKED');

    await api.delete(`/availability/blocks/${blocked.body.id}`, { token: landlord.token });

    const after = await api.get(`/listings/${id}/availability?from=2027-03-01&to=2027-03-31`, {
      token: landlord.token,
    });
    expect(after.body.days.find((d: any) => d.date === '2027-03-12').status).toBe('AVAILABLE');
  });

  it('lets the owner confirm their calendar is up to date, refreshing its freshness', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await fillOut(landlord.token, id);

    await db.query(`UPDATE property SET calendar_updated_at = now() - interval '30 days' WHERE id=$1`, [id]);

    const res = await api.post(`/listings/${id}/availability/confirm`, {}, { token: landlord.token });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await db.query<{ calendar_updated_at: string }>(
      `SELECT calendar_updated_at FROM property WHERE id=$1`,
      [id],
    );
    const ageDays = (Date.now() - Date.parse(row.rows[0]!.calendar_updated_at)) / 86_400_000;
    expect(ageDays).toBeLessThan(1);
  });
});

describe('calendar visibility', () => {
  it('hides an unpublished listing’s calendar from a non-owner (404, not "forbidden")', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);

    const res = await api.get(`/listings/${id}/availability?from=2027-05-01&to=2027-05-05`, {
      token: bob.token,
    });
    expect(res.status).toBe(404);
  });

  it('hides an unpublished listing’s calendar from an unauthenticated caller too', async () => {
    const alice = await api.signUp();
    const id = await startDraft(alice.token);

    const res = await api.get(`/listings/${id}/availability?from=2027-05-01&to=2027-05-05`);
    expect(res.status).toBe(404);
  });

  it('still lets the owner see their own unpublished listing’s calendar', async () => {
    const alice = await api.signUp();
    const id = await startDraft(alice.token);

    const res = await api.get(`/listings/${id}/availability?from=2027-05-01&to=2027-05-05`, {
      token: alice.token,
    });
    expect(res.status).toBe(200);
  });

  it('silently ignores includePending from a non-owner but honours it for the owner', async () => {
    const { landlord, id } = await publishedListing();
    const bob = await api.signUp();
    const tenant = await api.signUp();

    const booking = await bookings.requestBooking({
      propertyId: id,
      tenantId: tenant.userId,
      from: '2027-06-10',
      to: '2027-06-12',
      guests: 1,
    });
    expect(booking.status).toBe('REQUESTED');

    // A stranger asking for includePending=true gets the ordinary public
    // calendar back — the pending request is not honoured, and the request
    // is not refused either; it is simply not theirs to see.
    const asStranger = await api.get(
      `/listings/${id}/availability?from=2027-06-01&to=2027-06-20&includePending=true`,
      { token: bob.token },
    );
    expect(asStranger.status).toBe(200);
    expect(asStranger.body.days.find((d: any) => d.date === '2027-06-10').status).toBe('AVAILABLE');

    // The owner, asking the same question, sees the pending request.
    const asOwner = await api.get(
      `/listings/${id}/availability?from=2027-06-01&to=2027-06-20&includePending=true`,
      { token: landlord.token },
    );
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.days.find((d: any) => d.date === '2027-06-10').status).toBe('PENDING');

    // And without includePending, even the owner sees an ordinary calendar.
    const ownerWithoutFlag = await api.get(
      `/listings/${id}/availability?from=2027-06-01&to=2027-06-20`,
      { token: landlord.token },
    );
    expect(ownerWithoutFlag.body.days.find((d: any) => d.date === '2027-06-10').status).toBe('AVAILABLE');
  });
});

describe('changing a listing’s status', () => {
  it('lets the owner pause and resume their own published listing', async () => {
    const { landlord, id } = await publishedListing();

    const paused = await api.post(`/listings/${id}/status`, { status: 'PAUSED' }, { token: landlord.token });
    expect(paused.status).toBe(200);
    expect((await api.get('/listings/mine', { token: landlord.token })).body[0].status).toBe('PAUSED');

    // Pausing was the owner's own decision, so resuming needs no review.
    const resumed = await api.post(
      `/listings/${id}/status`,
      { status: 'PUBLISHED' },
      { token: landlord.token },
    );
    expect(resumed.status).toBe(200);
    expect((await api.get('/listings/mine', { token: landlord.token })).body[0].status).toBe('PUBLISHED');
  });

  it('refuses a stranger changing another landlord’s listing status', async () => {
    const { id } = await publishedListing();
    const bob = await api.signUp();

    const res = await api.post(`/listings/${id}/status`, { status: 'PAUSED' }, { token: bob.token });
    expect([403, 404]).toContain(res.status);

    // Untouched: still live, exactly as alice left it.
    expect((await api.get(`/listings/${id}`)).status).toBe(200);
  });

  it('requires a session', async () => {
    const { id } = await publishedListing();
    const res = await api.post(`/listings/${id}/status`, { status: 'PAUSED' });
    expect(res.status).toBe(401);
  });

  it('refuses a landlord publishing a draft straight through this route, bypassing moderation', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);

    const res = await api.post(`/listings/${id}/status`, { status: 'PUBLISHED' }, { token: landlord.token });
    expect(res.status).toBe(409);
    expect((await api.get(`/listings/${id}/edit`, { token: landlord.token })).body.status).toBe('DRAFT');
  });

  it('refuses a landlord publishing a pending submission straight through this route, bypassing moderation', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);
    await fillOut(landlord.token, id);
    await api.attachPhoto(id);
    const submitted = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
    expect(submitted.status).toBe(200);

    const res = await api.post(`/listings/${id}/status`, { status: 'PUBLISHED' }, { token: landlord.token });
    expect(res.status).toBe(409);
    expect((await api.get(`/listings/${id}/edit`, { token: landlord.token })).body.status).toBe(
      'PENDING_MODERATION',
    );
  });

  /**
   * PAUSED is shared by two very different causes: a landlord hiding their
   * own listing, and a moderator pausing a live one over a problem. Both land
   * on the same status column, so this is the case that actually matters —
   * without a check that tells the two apart, a landlord could use their own
   * status route to silently republish right back over a moderator's call.
   */
  it('refuses a landlord self-publishing straight back over a moderator’s pause', async () => {
    const { landlord, id, moderator } = await publishedListing();

    const pausedByModerator = await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'PAUSED', reasonCodes: ['SUSPICIOUS_INFORMATION'] },
      { token: moderator.token },
    );
    expect(pausedByModerator.status).toBe(200);

    const res = await api.post(`/listings/${id}/status`, { status: 'PUBLISHED' }, { token: landlord.token });
    expect(res.status).toBe(409);

    // Still hidden — the moderator's pause held.
    expect((await api.get(`/listings/${id}`)).status).toBe(404);
    expect((await api.get(`/listings/${id}/edit`, { token: landlord.token })).body.status).toBe('PAUSED');
  });
});

describe('pricing rules', () => {
  const rule = {
    kind: 'LENGTH_OF_STAY' as const,
    minNights: 7,
    maxNights: 29,
    priceMinor: '8000',
    priceUnit: 'NIGHT' as const,
  };

  it('lets the owner set and then fully replace their pricing rules', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);

    const res = await api.put(
      `/listings/${id}/pricing-rules`,
      {
        rules: [
          rule,
          {
            kind: 'SEASONAL',
            seasonFrom: '2027-06-01',
            seasonTo: '2027-09-01',
            priceMinor: '12000',
            priceUnit: 'NIGHT',
          },
        ],
      },
      { token: landlord.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);

    const stored = await db.query(`SELECT kind FROM pricing_rule WHERE property_id=$1`, [id]);
    expect(stored.rows).toHaveLength(2);

    // A second call replaces the set outright rather than appending to it.
    const replaced = await api.put(
      `/listings/${id}/pricing-rules`,
      { rules: [rule] },
      { token: landlord.token },
    );
    expect(replaced.status).toBe(200);
    expect(replaced.body.count).toBe(1);

    const after = await db.query(`SELECT kind FROM pricing_rule WHERE property_id=$1`, [id]);
    expect(after.rows).toHaveLength(1);
  });

  it('refuses a stranger replacing another landlord’s pricing rules', async () => {
    const alice = await api.signUp();
    const bob = await api.signUp();
    const id = await startDraft(alice.token);

    const res = await api.put(`/listings/${id}/pricing-rules`, { rules: [rule] }, { token: bob.token });
    expect([403, 404]).toContain(res.status);

    const stored = await db.query(`SELECT count(*)::int AS c FROM pricing_rule WHERE property_id=$1`, [id]);
    expect(stored.rows[0]!.c).toBe(0);
  });

  it('requires a session', async () => {
    const landlord = await api.signUp();
    const id = await startDraft(landlord.token);

    const res = await api.put(`/listings/${id}/pricing-rules`, { rules: [rule] });
    expect(res.status).toBe(401);
  });
});
