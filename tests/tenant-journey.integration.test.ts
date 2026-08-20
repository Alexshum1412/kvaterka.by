/**
 * The tenant journey, end to end.
 *
 * Search → quote → request → landlord decision → chat → confirmed.
 *
 * The FSM, the exclusion constraint and the contact filter already have
 * their own unit and integration coverage. What is tested here is the
 * journey as a caller experiences it over HTTP: that the pieces are wired
 * to each other, that one tenant cannot see another's booking, and that
 * the things which must not be possible are refused rather than merely
 * hidden from the UI.
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
  district: 'Центральный',
  latitude: 53.9045,
  longitude: 27.5615,
  rooms: 2,
  beds: 3,
  maxGuests: 4,
  basePriceMinor: '9000',
  cleaningFeeMinor: '3000',
  depositMinor: '20000',
  minNights: 2,
  maxNights: 90,
  bookingMode: 'REQUEST' as const,
  amenities: ['WIFI'],
};

/** A published listing, through the real lifecycle including moderation. */
async function published(overrides: Record<string, unknown> = {}) {
  const landlord = await api.signUp();
  const created = await api.post('/listings', { ...LISTING, ...overrides }, { token: landlord.token });
  expect(created.status).toBe(201);
  const listingId = created.body.id as string;

  await api.attachPhoto(listingId);
  await api.post(`/listings/${listingId}/submit`, {}, { token: landlord.token });

  const moderator = await api.signUp();
  await api.grantRole(moderator.userId, 'MODERATOR');
  await api.post(`/admin/moderation/listings/${listingId}`, { decision: 'PUBLISHED' }, {
    token: moderator.token,
  });

  return { landlord, listingId };
}

/** Dates far enough out that they never collide with "today". */
const FROM = '2027-09-15';
const TO = '2027-09-20';

async function request(
  token: string,
  listingId: string,
  body: Record<string, unknown> = {},
  opts: Record<string, unknown> = {},
) {
  return api.post('/bookings', { propertyId: listingId, from: FROM, to: TO, guests: 2, ...body }, {
    token,
    ...opts,
  });
}

/* ================================================================== */

describe('search feeds the journey', () => {
  it('finds the listing by every filter the UI exposes', async () => {
    const { listingId } = await published();

    const queries = [
      'city=Минск',
      'rooms=2',
      'guests=2',
      'beds=3',
      'types=APARTMENT',
      'amenities=WIFI',
      'priceMax=1000000',
      'durationMode=SHORT',
      `from=${FROM}&to=${TO}`,
    ];
    for (const q of queries) {
      const res = await api.get(`/search?${q}`);
      expect(res.status, q).toBe(200);
      expect(res.body.items.map((i: any) => i.id), q).toContain(listingId);
    }
  });

  it('excludes it when a filter genuinely does not match', async () => {
    await published();
    for (const q of ['city=Брест', 'rooms=4', 'beds=6', 'types=HOUSE', 'amenities=WASHING_MACHINE']) {
      const res = await api.get(`/search?${q}`);
      expect(res.body.items, q).toHaveLength(0);
    }
  });

  it('quotes the stay with the real total, in minor units', async () => {
    const { listingId } = await published();
    const res = await api.get(`/listings/${listingId}/quote?from=${FROM}&to=${TO}`);

    expect(res.status).toBe(200);
    expect(res.body.nights).toBe(5);
    // 5 × 90.00 + 30.00 cleaning = 480.00 BYN, as an integer string.
    expect(res.body.totalExpectedMinor).toBe('48000');
    expect(res.body.depositMinor).toBe('20000');
    expect(typeof res.body.totalExpectedMinor).toBe('string');
  });
});

describe('booking request', () => {
  it('creates a REQUESTED booking that does not hold the calendar', async () => {
    const { listingId } = await published();
    const tenant = await api.signUp();

    const res = await request(tenant.token, listingId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('REQUESTED');
    expect(res.body.role).toBe('TENANT');
    // The FSM decides what the tenant may do next, not the UI.
    expect(res.body.availableActions).toContain('WITHDRAW');

    // Dates are still bookable by somebody else until one is confirmed.
    const calendar = await api.get(`/listings/${listingId}/availability?from=2027-09-01&to=2027-09-30`);
    expect(calendar.body.days.find((d: any) => d.date === '2027-09-16').status).toBe('AVAILABLE');
  });

  it('refuses an anonymous caller', async () => {
    const { listingId } = await published();
    const res = await api.post('/bookings', { propertyId: listingId, from: FROM, to: TO });
    expect(res.status).toBe(401);
  });

  it('refuses a stay shorter than the listing allows', async () => {
    const { listingId } = await published();
    const tenant = await api.signUp();
    const res = await request(tenant.token, listingId, { from: FROM, to: '2027-09-16' });
    expect(res.status).toBe(422);
  });

  it('refuses a booking on a listing that is not published', async () => {
    const landlord = await api.signUp();
    const created = await api.post('/listings', LISTING, { token: landlord.token });
    const draftId = created.body.id as string;
    const tenant = await api.signUp();

    const res = await request(tenant.token, draftId);
    expect([404, 409, 422]).toContain(res.status);
  });

  it('refuses the landlord booking their own listing', async () => {
    const { landlord, listingId } = await published();
    const res = await request(landlord.token, listingId);
    expect(res.status).toBe(422);
  });

  it('is idempotent under a repeated Idempotency-Key', async () => {
    const { listingId } = await published();
    const tenant = await api.signUp();
    const key = randomUUID();

    const first = await request(tenant.token, listingId, {}, { idempotencyKey: key });
    const second = await request(tenant.token, listingId, {}, { idempotencyKey: key });

    expect(first.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);

    const mine = await api.get('/bookings?role=TENANT', { token: tenant.token });
    expect(mine.body).toHaveLength(1);
  });

  it('is idempotent even with no key at all, because the domain guards it too', async () => {
    const { listingId } = await published();
    const tenant = await api.signUp();

    await request(tenant.token, listingId);
    await request(tenant.token, listingId);

    const mine = await api.get('/bookings?role=TENANT', { token: tenant.token });
    expect(mine.body).toHaveLength(1);
  });

  it('turns the tenant’s note into a real first message, filtered by the server', async () => {
    const { landlord, listingId } = await published();
    const tenant = await api.signUp();

    await request(tenant.token, listingId, {
      message: 'Здравствуйте! Планирую приехать на несколько дней, звоните +375 29 123-45-67',
    });

    // The message exists — it used to be accepted and silently dropped.
    const threads = await api.get('/chat/conversations', { token: tenant.token });
    expect(threads.body).toHaveLength(1);

    const messages = await api.get(`/chat/conversations/${threads.body[0].id}/messages`, {
      token: tenant.token,
    });
    expect(messages.body.length).toBeGreaterThan(0);
    const stored = messages.body.map((m: any) => m.body).join(' ');
    // And the phone number did not survive it.
    expect(stored).not.toContain('123-45-67');
    expect(stored).not.toContain('+375 29');

    // The landlord sees the same thread.
    const theirs = await api.get('/chat/conversations', { token: landlord.token });
    expect(theirs.body).toHaveLength(1);
  });
});

describe('landlord decision', () => {
  it('accepts a request, which confirms it and holds the calendar', async () => {
    const { landlord, listingId } = await published();
    const tenant = await api.signUp();
    const booking = await request(tenant.token, listingId);

    const accepted = await api.post(`/bookings/${booking.body.id}/accept`, {}, { token: landlord.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('CONFIRMED');

    const calendar = await api.get(`/listings/${listingId}/availability?from=2027-09-01&to=2027-09-30`);
    expect(calendar.body.days.find((d: any) => d.date === '2027-09-16').status).toBe('BOOKED');
  });

  it('declines a request without confirming anything', async () => {
    const { landlord, listingId } = await published();
    const tenant = await api.signUp();
    const booking = await request(tenant.token, listingId);

    const declined = await api.post(
      `/bookings/${booking.body.id}/decline`,
      { reason: 'Эти даты уже заняты у меня вне платформы' },
      { token: landlord.token },
    );
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe('DECLINED');

    const calendar = await api.get(`/listings/${listingId}/availability?from=2027-09-01&to=2027-09-30`);
    expect(calendar.body.days.find((d: any) => d.date === '2027-09-16').status).toBe('AVAILABLE');
  });

  it('does NOT let the tenant accept their own request', async () => {
    const { listingId } = await published();
    const tenant = await api.signUp();
    const booking = await request(tenant.token, listingId);

    const res = await api.post(`/bookings/${booking.body.id}/accept`, {}, { token: tenant.token });
    expect([403, 404, 409]).toContain(res.status);

    const after = await api.get(`/bookings/${booking.body.id}`, { token: tenant.token });
    expect(after.body.status).toBe('REQUESTED');
  });

  it('does NOT let an unrelated landlord act on the booking', async () => {
    const { listingId } = await published();
    const tenant = await api.signUp();
    const other = await api.signUp();
    const booking = await request(tenant.token, listingId);

    const res = await api.post(`/bookings/${booking.body.id}/accept`, {}, { token: other.token });
    expect([403, 404]).toContain(res.status);
  });

  it('lets the tenant withdraw before a decision', async () => {
    const { listingId } = await published();
    const tenant = await api.signUp();
    const booking = await request(tenant.token, listingId);

    const res = await api.post(`/bookings/${booking.body.id}/withdraw`, {}, { token: tenant.token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('WITHDRAWN');
  });

  it('refuses an illegal transition rather than performing it', async () => {
    const { landlord, listingId } = await published();
    const tenant = await api.signUp();
    const booking = await request(tenant.token, listingId);
    await api.post(`/bookings/${booking.body.id}/accept`, {}, { token: landlord.token });

    // CONFIRMED → accept again is not in the FSM.
    const again = await api.post(`/bookings/${booking.body.id}/accept`, {}, { token: landlord.token });
    expect(again.status).toBe(409);
  });
});

describe('overlap and competition', () => {
  it('lets two tenants request the same dates, but only one be confirmed', async () => {
    const { landlord, listingId } = await published();
    const alice = await api.signUp();
    const bob = await api.signUp();

    const first = await request(alice.token, listingId);
    const second = await request(bob.token, listingId);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const accepted = await api.post(`/bookings/${first.body.id}/accept`, {}, { token: landlord.token });
    expect(accepted.body.status).toBe('CONFIRMED');

    // The exclusion constraint refuses the second confirmation.
    const clash = await api.post(`/bookings/${second.body.id}/accept`, {}, { token: landlord.token });
    expect(clash.status).toBe(409);
  });

  it('allows adjacent stays that touch but do not overlap', async () => {
    const { landlord, listingId } = await published();
    const alice = await api.signUp();
    const bob = await api.signUp();

    const first = await request(alice.token, listingId, { from: '2027-09-15', to: '2027-09-20' });
    await api.post(`/bookings/${first.body.id}/accept`, {}, { token: landlord.token });

    // Checkout day is the next guest's check-in day.
    const second = await request(bob.token, listingId, { from: '2027-09-20', to: '2027-09-25' });
    const accepted = await api.post(`/bookings/${second.body.id}/accept`, {}, { token: landlord.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('CONFIRMED');
  });

  it('frees the dates again after a confirmed booking is cancelled', async () => {
    const { landlord, listingId } = await published();
    const alice = await api.signUp();
    const bob = await api.signUp();

    const first = await request(alice.token, listingId);
    await api.post(`/bookings/${first.body.id}/accept`, {}, { token: landlord.token });
    await api.post(`/bookings/${first.body.id}/cancel`, { reason: 'Планы изменились' }, {
      token: alice.token,
    });

    const second = await request(bob.token, listingId);
    const accepted = await api.post(`/bookings/${second.body.id}/accept`, {}, { token: landlord.token });
    expect(accepted.status).toBe(200);
  });
});

describe('booking privacy', () => {
  it('shows a booking to its two participants and to nobody else', async () => {
    const { landlord, listingId } = await published();
    const tenant = await api.signUp();
    const stranger = await api.signUp();
    const booking = await request(tenant.token, listingId);

    expect((await api.get(`/bookings/${booking.body.id}`, { token: tenant.token })).status).toBe(200);
    expect((await api.get(`/bookings/${booking.body.id}`, { token: landlord.token })).status).toBe(200);
    // 404, not 403: whether a booking exists is itself information.
    expect((await api.get(`/bookings/${booking.body.id}`, { token: stranger.token })).status).toBe(404);
    expect((await api.get(`/bookings/${booking.body.id}`)).status).toBe(401);
  });

  it('never lists one tenant’s bookings to another', async () => {
    const { listingId } = await published();
    const alice = await api.signUp();
    const bob = await api.signUp();
    await request(alice.token, listingId);

    const bobsList = await api.get('/bookings?role=TENANT', { token: bob.token });
    expect(bobsList.body).toHaveLength(0);
  });

  it('gives the landlord the tenant’s public trust facts and nothing private', async () => {
    const { landlord, listingId } = await published();
    const tenant = await api.signUp();
    const booking = await request(tenant.token, listingId);

    const res = await api.get(`/bookings/${booking.body.id}`, { token: landlord.token });
    expect(res.body.counterparty.displayName).toBeTruthy();
    expect(res.body.counterparty.verificationLevel).toBeDefined();
    expect(res.body.counterparty.completedRentals).toBe(0);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(tenant.email);
    expect(serialised).not.toContain('password');
    expect(serialised).not.toContain('phone');
  });

  it('answers 404 for a malformed booking id', async () => {
    const tenant = await api.signUp();
    const res = await api.get('/bookings/not-a-uuid', { token: tenant.token });
    expect(res.status).toBe(404);
  });
});

describe('chat isolation', () => {
  it('keeps a conversation between its two participants', async () => {
    const { landlord, listingId } = await published();
    const tenant = await api.signUp();
    const stranger = await api.signUp();

    const opened = await api.post('/chat/conversations', { propertyId: listingId }, { token: tenant.token });
    expect(opened.status).toBe(201);
    const conversationId = opened.body.id as string;

    await api.post(`/chat/conversations/${conversationId}/messages`, { text: 'Здравствуйте! Даты свободны?' }, {
      token: tenant.token,
    });

    expect((await api.get(`/chat/conversations/${conversationId}/messages`, { token: landlord.token })).status).toBe(200);
    const outsider = await api.get(`/chat/conversations/${conversationId}/messages`, {
      token: stranger.token,
    });
    expect([403, 404]).toContain(outsider.status);

    const strangerSend = await api.post(
      `/chat/conversations/${conversationId}/messages`,
      { text: 'Впустите меня' },
      { token: stranger.token },
    );
    expect([403, 404]).toContain(strangerSend.status);
  });

  it('lists only the caller’s own conversations', async () => {
    const { listingId } = await published();
    const tenant = await api.signUp();
    const stranger = await api.signUp();
    await api.post('/chat/conversations', { propertyId: listingId }, { token: tenant.token });

    expect((await api.get('/chat/conversations', { token: stranger.token })).body).toHaveLength(0);
  });

  it('strips contact details from a message on the server', async () => {
    const { listingId } = await published();
    const tenant = await api.signUp();
    const opened = await api.post('/chat/conversations', { propertyId: listingId }, { token: tenant.token });

    await api.post(
      `/chat/conversations/${opened.body.id}/messages`,
      { text: 'Мой телеграм @vasil_minsk, пишите' },
      { token: tenant.token },
    );

    const messages = await api.get(`/chat/conversations/${opened.body.id}/messages`, {
      token: tenant.token,
    });
    // Assert the message is really there first: an empty thread would make
    // the "does not contain" check pass without proving anything.
    expect(messages.body.length).toBeGreaterThan(0);
    const stored = messages.body.map((m: any) => m.body).join(' ');
    expect(stored).not.toContain('@vasil_minsk');
  });

  it('does not break ordinary Russian text that merely looks like contact data', async () => {
    const { listingId } = await published();
    const tenant = await api.signUp();
    const opened = await api.post('/chat/conversations', { propertyId: listingId }, { token: tenant.token });

    const legitimate = 'Квартира 42, 5 этаж, заезд в 12:00, площадь 50 м²';
    await api.post(`/chat/conversations/${opened.body.id}/messages`, { text: legitimate }, {
      token: tenant.token,
    });

    const messages = await api.get(`/chat/conversations/${opened.body.id}/messages`, {
      token: tenant.token,
    });
    expect(messages.body.some((m: any) => m.body === legitimate)).toBe(true);
  });
});

describe('public profile', () => {
  it('exposes trust facts without contact details or internal scoring inputs', async () => {
    const { landlord } = await published();

    const res = await api.get(`/profiles/${landlord.userId}`);
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBeTruthy();
    expect(res.body.activeListings).toBe(1);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(landlord.email);
    expect(serialised).not.toContain('fraud');
    expect(serialised).not.toContain('password_hash');
  });

  it('answers 404 for somebody who does not exist', async () => {
    expect((await api.get(`/profiles/${randomUUID()}`)).status).toBe(404);
  });
});
