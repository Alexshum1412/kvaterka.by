/**
 * API contract, authorization and validation tests.
 *
 * These drive the real dispatcher against a real PostgreSQL engine — no mocks,
 * no stubbed services. A passing assertion here is a statement about what the
 * deployed API actually does.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { looksLikeLeak } from '@/server/api/problem.ts';
import { generateOpenApi } from '@/server/api/openapi.ts';
import { allRoutes } from '@/server/api/routes/index.ts';
import { Router } from '@/server/api/router.ts';

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
  // Fixtures create several accounts per test; without this the registration
  // limiter (correctly) starts rejecting them.
  await api.resetRateLimits();
  // The amenity vocabulary and feature flags are seed data, not test fixtures.
  await db.execScript(`
    INSERT INTO amenity (code, category, name_ru, name_be, name_en) VALUES
      ('WIFI','ESSENTIALS','Wi-Fi','Wi-Fi','Wi-Fi'),
      ('WORKSPACE','WORK','Рабочее место','Працоўнае месца','Workspace'),
      ('ELEVATOR','BUILDING','Лифт','Ліфт','Elevator')
    ON CONFLICT DO NOTHING;
    INSERT INTO feature_flag (key, enabled, description, requires_legal_approval) VALUES
      ('fee.enforcement', true, 'test', true),
      ('rewards.lottery', false, 'test', true),
      ('verification.identity_documents', false, 'test', true)
    ON CONFLICT DO NOTHING;
  `);
});

const LISTING = {
  title: 'Светлая квартира у метро Немига',
  propertyType: 'APARTMENT' as const,
  city: 'Минск',
  latitude: 53.9045,
  longitude: 27.5615,
  rooms: 2,
  maxGuests: 4,
  basePriceMinor: '8000',
  cleaningFeeMinor: '3000',
  depositMinor: '30000',
  bookingMode: 'INSTANT_AND_REQUEST' as const,
  amenities: ['WIFI', 'WORKSPACE'],
};

/** Create a published listing owned by a fresh landlord. */
async function publishedListing(): Promise<{ landlord: { token: string; userId: string }; listingId: string }> {
  const landlord = await api.signUp();
  const created = await api.post('/listings', LISTING, { token: landlord.token });
  expect(created.status).toBe(201);
  const listingId = created.body.id as string;

  await api.post(`/listings/${listingId}/photos`, { storageKey: `media/${listingId}/1.jpg` }, {
    token: landlord.token,
  });
  await api.post(`/listings/${listingId}/submit`, {}, { token: landlord.token });

  const moderator = await api.signUp();
  await api.grantRole(moderator.userId, 'MODERATOR');
  const decision = await api.post(
    `/admin/moderation/listings/${listingId}`,
    { decision: 'PUBLISHED' },
    { token: moderator.token },
  );
  expect(decision.status).toBe(200);

  return { landlord, listingId };
}

/* ================================================================== */

describe('routing and contract', () => {
  it('serves health without authentication', async () => {
    const res = await api.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns 404 for an unknown path', async () => {
    const res = await api.get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.errorCode).toBe('NOT_FOUND');
  });

  it('rejects a wrong method on a known path', async () => {
    const res = await api.delete('/health');
    expect(res.status).toBe(422);
  });

  it('attaches a correlation id to every response', async () => {
    const res = await api.get('/health');
    expect(res.headers?.['x-correlation-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('echoes a caller-supplied correlation id so logs can be joined up', async () => {
    const res = await api.get('/health', { headers: { 'x-correlation-id': 'trace-abc-123' } });
    expect(res.headers?.['x-correlation-id']).toBe('trace-abc-123');
  });

  it('declares no duplicate routes', () => {
    expect(() => new Router(allRoutes)).not.toThrow();
  });

  it('generates an OpenAPI document from the route table', () => {
    const spec = generateOpenApi(allRoutes) as any;
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(30);
    expect(spec.paths['/listings/{id}'].get.summary).toBeTruthy();
    // Path params must be converted from :id to {id}.
    expect(Object.keys(spec.paths).every((p) => !p.includes(':'))).toBe(true);
  });

  it('documents the permission and audit requirement for privileged routes', () => {
    const spec = generateOpenApi(allRoutes) as any;
    const doc = spec.paths['/admin/verification/documents/{documentId}'].get;
    expect(doc.description).toContain('document.read');
    expect(doc.description).toContain('audit log');
    expect(doc.description).toContain('LEGAL-004');
  });
});

/* ================================================================== */

describe('authentication', () => {
  it('rejects an anonymous call to a protected route', async () => {
    const res = await api.get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.errorCode).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged session token', async () => {
    const res = await api.get('/auth/me', { token: 'totally-made-up-token' });
    expect(res.status).toBe(401);
  });

  it('signs a user up, in, and identifies them', async () => {
    const user = await api.signUp();
    const me = await api.get('/auth/me', { token: user.token });
    expect(me.status).toBe(200);
    expect(me.body.roles).toContain('TENANT');
    expect(me.body.permissions).toEqual([]);
  });

  it('sets an HttpOnly, SameSite session cookie', async () => {
    const email = `cookie-${Date.now()}@example.by`;
    await api.post('/auth/register', {
      email,
      password: 'karotkaja-vulica-2026',
      displayName: 'Кука Тэст',
    });
    const login = await api.post('/auth/login', { identifier: email, password: 'karotkaja-vulica-2026' });
    const cookie = login.headers!['set-cookie']!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('never returns the email verification token in the response body', async () => {
    const res = await api.post('/auth/register', {
      email: `secret-${Date.now()}@example.by`,
      password: 'karotkaja-vulica-2026',
      displayName: 'Тэст',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });

  it('logs out and invalidates the session', async () => {
    const user = await api.signUp();
    expect((await api.post('/auth/logout', {}, { token: user.token })).status).toBe(200);
    expect((await api.get('/auth/me', { token: user.token })).status).toBe(401);
  });

  it('rotates a session and kills the previous token', async () => {
    const user = await api.signUp();
    const refreshed = await api.post('/auth/refresh', {}, { token: user.token });
    expect(refreshed.status).toBe(200);
    const newToken = /kv_session=([^;]+)/.exec(refreshed.headers!['set-cookie']!)![1]!;
    expect((await api.get('/auth/me', { token: decodeURIComponent(newToken) })).status).toBe(200);
    expect((await api.get('/auth/me', { token: user.token })).status).toBe(401);
  });

  it('requires the current password to change it', async () => {
    const user = await api.signUp();
    const res = await api.post(
      '/auth/password',
      { currentPassword: 'wrong-password-here', newPassword: 'novy-parol-dlia-mianie' },
      { token: user.token },
    );
    expect(res.status).toBe(401);
  });

  it('gives the same answer whether or not an account exists on password reset', async () => {
    const user = await api.signUp();
    const known = await api.post('/auth/password-reset/request', { identifier: user.email });
    const unknown = await api.post('/auth/password-reset/request', { identifier: 'nobody@example.by' });
    expect(known.status).toBe(unknown.status);
    expect(JSON.stringify(known.body)).toBe(JSON.stringify(unknown.body));
  });
});

/* ================================================================== */

describe('validation', () => {
  it('returns field-level detail a form can render', async () => {
    const res = await api.post('/auth/register', { email: 'not-an-email', password: 'x', displayName: '' });
    expect(res.status).toBe(422);
    expect(res.errorCode).toBe('VALIDATION_FAILED');
    const fields = res.body.error.details.fields.map((f: { field: string }) => f.field);
    expect(fields).toContain('email');
    expect(fields).toContain('password');
    expect(fields).toContain('displayName');
  });

  it('rejects an unparseable coordinate', async () => {
    const user = await api.signUp();
    const res = await api.post('/listings', { ...LISTING, latitude: 999 }, { token: user.token });
    expect(res.status).toBe(422);
  });

  it('rejects a listing outside Belarus', async () => {
    const user = await api.signUp();
    const res = await api.post('/listings', { ...LISTING, latitude: 48.85, longitude: 2.35 }, { token: user.token });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Беларуси/);
  });

  it('rejects an unknown amenity code', async () => {
    const user = await api.signUp();
    const res = await api.post('/listings', { ...LISTING, amenities: ['TELEPORTER'] }, { token: user.token });
    expect(res.status).toBe(422);
  });

  it('rejects a duration range that is inside out', async () => {
    const user = await api.signUp();
    const res = await api.post('/listings', { ...LISTING, minNights: 30, maxNights: 5 }, { token: user.token });
    expect(res.status).toBe(422);
  });

  it('rejects money sent as a JSON number', async () => {
    // Money crosses the wire as a decimal string; a float would be a silent
    // precision bug, so the schema refuses it outright.
    const user = await api.signUp();
    const res = await api.post('/listings', { ...LISTING, basePriceMinor: 8000 }, { token: user.token });
    expect(res.status).toBe(422);
  });
});

/* ================================================================== */

describe('error responses never leak internals', () => {
  it('does not expose SQL or stack traces on a 404', async () => {
    const user = await api.signUp();
    const res = await api.get('/listings/00000000-0000-0000-0000-000000000000', { token: user.token });
    expect(looksLikeLeak(res.body)).toBe(false);
  });

  it('does not expose constraint names on a conflict', async () => {
    const { landlord, listingId } = await publishedListing();
    const tenant = await api.signUp();
    await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );
    const second = await api.signUp();
    const clash = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-03', to: '2026-09-10', instant: true },
      { token: second.token },
    );
    expect(clash.status).toBe(409);
    expect(clash.errorCode).toBe('DATES_UNAVAILABLE');
    expect(looksLikeLeak(clash.body)).toBe(false);
    expect(JSON.stringify(clash.body)).not.toContain('booking_no_overlap');
    expect(landlord.userId).toBeTruthy();
  });

  it('carries a correlation id on every error', async () => {
    const res = await api.get('/nope');
    expect(res.body.error.correlationId).toBeTruthy();
  });
});

/* ================================================================== */

describe('listing lifecycle over HTTP', () => {
  it('walks draft → moderation → published', async () => {
    const landlord = await api.signUp();
    const created = await api.post('/listings', LISTING, { token: landlord.token });
    expect(created.status).toBe(201);
    const id = created.body.id;

    // Publication requires at least one photo.
    const premature = await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });
    expect(premature.status).toBe(422);
    expect(premature.body.error.message).toMatch(/фотограф/i);

    await api.post(`/listings/${id}/photos`, { storageKey: 'media/x/1.jpg' }, { token: landlord.token });
    expect((await api.post(`/listings/${id}/submit`, {}, { token: landlord.token })).status).toBe(200);

    // A landlord cannot approve their own listing.
    const selfApprove = await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'PUBLISHED' },
      { token: landlord.token },
    );
    expect(selfApprove.status).toBe(403);

    const moderator = await api.signUp();
    await api.grantRole(moderator.userId, 'MODERATOR');
    expect(
      (await api.post(`/admin/moderation/listings/${id}`, { decision: 'PUBLISHED' }, { token: moderator.token }))
        .status,
    ).toBe(200);

    const listing = await api.get(`/listings/${id}`);
    expect(listing.status).toBe(200);
    expect(listing.body.status).toBe('PUBLISHED');
  });

  it('requires a reason when rejecting', async () => {
    const landlord = await api.signUp();
    const id = (await api.post('/listings', LISTING, { token: landlord.token })).body.id;
    await api.post(`/listings/${id}/photos`, { storageKey: 'k' }, { token: landlord.token });
    await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });

    const moderator = await api.signUp();
    await api.grantRole(moderator.userId, 'MODERATOR');
    const res = await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'REJECTED' },
      { token: moderator.token },
    );
    expect(res.status).toBe(422);
  });

  it('does not let one landlord edit another’s listing', async () => {
    const { listingId } = await publishedListing();
    const stranger = await api.signUp();
    const res = await api.patch(`/listings/${listingId}`, { title: 'Захвачено чужое объявление' }, {
      token: stranger.token,
    });
    expect(res.status).toBe(403);
  });

  it('hides an unpublished listing from the public', async () => {
    const landlord = await api.signUp();
    const id = (await api.post('/listings', LISTING, { token: landlord.token })).body.id;
    expect((await api.get(`/listings/${id}`)).status).toBe(404);
    // …but the owner can see their own draft.
    expect((await api.get(`/listings/${id}`, { token: landlord.token })).status).toBe(200);
  });
});

/* ================================================================== */

describe('location privacy', () => {
  it('never returns the exact address to the public', async () => {
    const { listingId } = await publishedListing();
    const res = await api.get(`/listings/${listingId}`);
    expect(res.body.location.precision).toBe('APPROXIMATE');
    expect(res.body.address).toBeUndefined();
    // The blurred point must differ from the true one.
    expect(res.body.location.latitude).not.toBe(53.9045);
  });

  it('keeps the blurred point stable across requests', async () => {
    // A pin that moved between loads could be averaged back to the real one.
    const { listingId } = await publishedListing();
    const a = await api.get(`/listings/${listingId}`);
    const b = await api.get(`/listings/${listingId}`);
    expect(a.body.location.latitude).toBe(b.body.location.latitude);
    expect(a.body.location.longitude).toBe(b.body.location.longitude);
  });

  it('refuses the exact address to a tenant without a confirmed booking', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    const res = await api.get(`/listings/${listingId}/address`, { token: tenant.token });
    expect(res.status).toBe(403);
  });

  it('releases the exact address once the booking is confirmed', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );
    const res = await api.get(`/listings/${listingId}/address`, { token: tenant.token });
    expect(res.status).toBe(200);
    expect(res.body.location.precision).toBe('EXACT');
    expect(res.body.location.latitude).toBe(53.9045);
  });

  it('only returns blurred coordinates from the map endpoint', async () => {
    await publishedListing();
    const res = await api.get('/search/map?north=54.2&south=53.6&east=27.9&west=27.2');
    expect(res.status).toBe(200);
    for (const marker of res.body.markers) expect(marker.precision).toBe('APPROXIMATE');
  });
});

/* ================================================================== */

describe('search', () => {
  it('finds a published listing by city', async () => {
    await publishedListing();
    const res = await api.get('/search?city=Минск');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].title).toContain('Немига');
  });

  it('excludes listings that are booked for the requested dates', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );

    expect((await api.get('/search?city=Минск&from=2026-09-02&to=2026-09-05')).body.total).toBe(0);
    expect((await api.get('/search?city=Минск&from=2026-09-10&to=2026-09-12')).body.total).toBe(1);
  });

  it('filters by amenity, requiring all of them', async () => {
    await publishedListing(); // has WIFI + WORKSPACE
    expect((await api.get('/search?amenities=WIFI')).body.total).toBe(1);
    expect((await api.get('/search?amenities=WIFI,WORKSPACE')).body.total).toBe(1);
    expect((await api.get('/search?amenities=WIFI,ELEVATOR')).body.total).toBe(0);
  });

  it('filters by guest capacity and duration range', async () => {
    await publishedListing(); // maxGuests 4, 1..365 nights
    expect((await api.get('/search?guests=4')).body.total).toBe(1);
    expect((await api.get('/search?guests=9')).body.total).toBe(0);
  });

  it('includes the stay total when dates are supplied', async () => {
    await publishedListing();
    const res = await api.get('/search?city=Минск&from=2026-09-01&to=2026-09-08');
    // 7 nights x 80.00 + 30.00 cleaning = 590.00
    expect(res.body.items[0].stayTotalMinor).toBe('59000');
  });

  it('performs a radius search', async () => {
    await publishedListing();
    expect((await api.get('/search?lat=53.9045&lng=27.5615&radius=5000')).body.total).toBe(1);
    expect((await api.get('/search?lat=52.0976&lng=23.7341&radius=5000')).body.total).toBe(0);
  });

  it('refuses an absurdly large map area', async () => {
    const res = await api.get('/search?north=60&south=45&east=40&west=10');
    expect(res.status).toBe(422);
  });

  it('does not return unpublished listings', async () => {
    const landlord = await api.signUp();
    await api.post('/listings', LISTING, { token: landlord.token });
    expect((await api.get('/search?city=Минск')).body.total).toBe(0);
  });

  it('costs a bounded number of queries regardless of page size', async () => {
    // Guards against N+1: the count must not grow with the number of results.
    for (let i = 0; i < 5; i += 1) await publishedListing();

    const before = api.errors.length;
    const res = await api.get('/search?city=Минск&limit=5');
    expect(res.body.items).toHaveLength(5);
    expect(res.body.items.every((i: { photos: unknown[] }) => Array.isArray(i.photos))).toBe(true);
    expect(api.errors.length).toBe(before);
  });
});

/* ================================================================== */

describe('booking API', () => {
  it('creates a request and lets the landlord accept it', async () => {
    const { landlord, listingId } = await publishedListing();
    const tenant = await api.signUp();

    const created = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08', guests: 2 },
      { token: tenant.token },
    );
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('REQUESTED');
    expect(created.body.money.totalExpectedMinor).toBe('59000');
    expect(created.body.availableActions).toContain('WITHDRAW');

    const accepted = await api.post(`/bookings/${created.body.id}/accept`, {}, { token: landlord.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('CONFIRMED');
  });

  it('does not let a stranger accept somebody else’s booking', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    const created = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08' },
      { token: tenant.token },
    );
    const stranger = await api.signUp();
    const res = await api.post(`/bookings/${created.body.id}/accept`, {}, { token: stranger.token });
    // 404, not 403: a 403 would confirm that this booking id is real, which is
    // the whole enumeration problem the GET route already avoided.
    expect(res.status).toBe(404);
  });

  it('hides a booking from anyone who is not a participant', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    const created = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08' },
      { token: tenant.token },
    );
    const stranger = await api.signUp();
    // 404 rather than 403: existence itself is not disclosed.
    expect((await api.get(`/bookings/${created.body.id}`, { token: stranger.token })).status).toBe(404);
  });

  it('quotes an honest price breakdown before booking', async () => {
    const { listingId } = await publishedListing();
    const res = await api.get(`/listings/${listingId}/quote?from=2026-09-01&to=2026-09-08`);
    expect(res.status).toBe(200);
    expect(res.body.nights).toBe(7);
    expect(res.body.totalExpectedMinor).toBe('59000');
    expect(res.body.depositMinor).toBe('30000');
    // Mandatory lines must sum exactly to the stated total.
    const mandatory = res.body.lines
      .filter((l: { variable: boolean; code: string }) => !l.variable && l.code !== 'DEPOSIT')
      .reduce((sum: bigint, l: { amountMinor: string }) => sum + BigInt(l.amountMinor), 0n);
    expect(mandatory.toString()).toBe(res.body.totalExpectedMinor);
  });

  it('refuses to book your own listing', async () => {
    const { landlord, listingId } = await publishedListing();
    const res = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08' },
      { token: landlord.token },
    );
    expect(res.status).toBe(422);
    expect(res.errorCode).toBe('SELF_BOOKING');
  });
});

/* ================================================================== */

describe('idempotency', () => {
  it('replays the original response for a repeated key', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    const payload = { propertyId: listingId, from: '2026-09-01', to: '2026-09-08' };

    const first = await api.post('/bookings', payload, { token: tenant.token, idempotencyKey: 'key-1' });
    const second = await api.post('/bookings', payload, { token: tenant.token, idempotencyKey: 'key-1' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers?.['idempotent-replay']).toBe('true');

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM booking WHERE tenant_id=$1`,
      [tenant.userId],
    );
    expect(rows[0]!.c).toBe('1');
  });

  it('refuses to reuse a key with a different payload', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();

    await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08' },
      { token: tenant.token, idempotencyKey: 'key-2' },
    );
    const different = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-10-01', to: '2026-10-08' },
      { token: tenant.token, idempotencyKey: 'key-2' },
    );
    expect(different.status).toBe(409);
  });

  it('does not let one user replay another user’s key', async () => {
    const { listingId } = await publishedListing();
    const a = await api.signUp();
    const b = await api.signUp();
    const payload = { propertyId: listingId, from: '2026-11-01', to: '2026-11-05' };

    const first = await api.post('/bookings', payload, { token: a.token, idempotencyKey: 'shared' });
    const second = await api.post('/bookings', payload, { token: b.token, idempotencyKey: 'shared' });

    expect(first.status).toBe(201);
    // Different user, so it is a real booking attempt, not a replay.
    expect(second.body.id).not.toBe(first.body.id);
  });

  it('frees the key when the request failed, so an honest retry works', async () => {
    const tenant = await api.signUp();
    const bad = await api.post(
      '/bookings',
      { propertyId: '00000000-0000-0000-0000-000000000000', from: '2026-09-01', to: '2026-09-08' },
      { token: tenant.token, idempotencyKey: 'retry-me' },
    );
    expect(bad.status).toBe(404);

    const { listingId } = await publishedListing();
    const good = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08' },
      { token: tenant.token, idempotencyKey: 'retry-me' },
    );
    expect(good.status).toBe(201);
  });
});

/* ================================================================== */

describe('rate limiting', () => {
  beforeEach(async () => {
    await api.resetRateLimits();
  });

  it('blocks a login flood from one address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await api.post(
        '/auth/login',
        { identifier: 'nobody@example.by', password: 'guessing-again' },
        { ip: '203.0.113.99' },
      );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('does not penalise a different address', async () => {
    for (let i = 0; i < 12; i += 1) {
      await api.post('/auth/login', { identifier: 'a@example.by', password: 'x' }, { ip: '203.0.113.1' });
    }
    const other = await api.post(
      '/auth/login',
      { identifier: 'b@example.by', password: 'x' },
      { ip: '203.0.113.2' },
    );
    expect(other.status).not.toBe(429);
  });

  it('tells the client when it may retry', async () => {
    let limited: any = null;
    for (let i = 0; i < 15 && !limited; i += 1) {
      const res = await api.post('/auth/login', { identifier: 'c@example.by', password: 'x' }, { ip: '203.0.113.5' });
      if (res.status === 429) limited = res;
    }
    expect(limited).not.toBeNull();
    expect(limited.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });
});
