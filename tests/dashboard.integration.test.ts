/**
 * Landlord dashboard: authorization, scoping and the "needs attention" logic.
 *
 * The scoping tests matter most. A dashboard is the easiest place to leak
 * another user's data, because the query is "everything about me" and one
 * missing WHERE clause turns it into "everything about everyone".
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { DashboardService } from '@/server/services/dashboard-service.ts';

let db: TestDb;
let api: ApiTestClient;
let dashboard: DashboardService;

beforeAll(async () => {
  db = await createTestDb();
  api = new ApiTestClient(db);
  dashboard = new DashboardService(db);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await api.resetRateLimits();
  await db.execScript(`
    INSERT INTO amenity (code, category, name_ru, name_be, name_en)
    VALUES ('WIFI','ESSENTIALS','Wi-Fi','Wi-Fi','Wi-Fi') ON CONFLICT DO NOTHING;
    INSERT INTO feature_flag (key, enabled, description, requires_legal_approval)
    VALUES ('fee.enforcement', true, 'test', true) ON CONFLICT DO NOTHING;
  `);
});

const LISTING = {
  title: 'Двухкомнатная квартира у парка',
  propertyType: 'APARTMENT' as const,
  city: 'Минск',
  latitude: 53.9045,
  longitude: 27.5615,
  maxGuests: 4,
  basePriceMinor: '9000',
  cleaningFeeMinor: '3000',
  bookingMode: 'INSTANT_AND_REQUEST' as const,
};

async function publishedListing(landlordToken: string): Promise<string> {
  const id = (await api.post('/listings', LISTING, { token: landlordToken })).body.id as string;
  await api.attachPhoto(id);
  await api.post(`/listings/${id}/submit`, {}, { token: landlordToken });

  const moderator = await api.signUp();
  await api.grantRole(moderator.userId, 'MODERATOR');
  await api.post(`/admin/moderation/listings/${id}`, { decision: 'PUBLISHED' }, { token: moderator.token });
  return id;
}

/* ================================================================== */

describe('authorization', () => {
  it('refuses an anonymous caller', async () => {
    const res = await api.get('/dashboard/summary');
    expect(res.status).toBe(401);
  });

  it('serves any authenticated user their own (possibly empty) dashboard', async () => {
    const user = await api.signUp();
    const res = await api.get('/dashboard/summary', { token: user.token });
    expect(res.status).toBe(200);
    expect(res.body.listings).toEqual([]);
    expect(res.body.stats.publishedListings).toBe(0);
  });

  it('never shows one landlord another landlord’s listings', async () => {
    const a = await api.signUp();
    const b = await api.signUp();
    await publishedListing(a.token);

    const seenByB = await api.get('/dashboard/summary', { token: b.token });
    expect(seenByB.body.listings).toEqual([]);
    expect(seenByB.body.stats.publishedListings).toBe(0);

    const seenByA = await api.get('/dashboard/summary', { token: a.token });
    expect(seenByA.body.listings).toHaveLength(1);
  });

  it('never shows one landlord another landlord’s bookings or balance', async () => {
    const a = await api.signUp();
    const b = await api.signUp();
    const listing = await publishedListing(a.token);

    const tenant = await api.signUp();
    await api.post(
      '/bookings',
      { propertyId: listing, from: '2026-09-01', to: '2026-09-08' },
      { token: tenant.token },
    );
    await db.query(
      `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor) VALUES ($1,'FEE_ACCRUED',-9500)`,
      [a.userId],
    );

    const seenByB = await api.get('/dashboard/summary', { token: b.token });
    expect(seenByB.body.stats.pendingRequests).toBe(0);
    expect(seenByB.body.stats.balanceMinor).toBe('0');
    expect(seenByB.body.upcoming).toEqual([]);
  });
});

/* ================================================================== */

describe('stats reflect real data', () => {
  it('counts published listings and pending requests', async () => {
    const landlord = await api.signUp();
    const listing = await publishedListing(landlord.token);
    const tenant = await api.signUp();

    await api.post(
      '/bookings',
      { propertyId: listing, from: '2026-09-01', to: '2026-09-08' },
      { token: tenant.token },
    );

    const res = await api.get('/dashboard/summary', { token: landlord.token });
    expect(res.body.stats.publishedListings).toBe(1);
    expect(res.body.stats.pendingRequests).toBe(1);
    expect(res.body.listings[0].pendingRequests).toBe(1);
  });

  it('lists confirmed stays as upcoming, with the tenant name', async () => {
    const landlord = await api.signUp();
    const listing = await publishedListing(landlord.token);
    const tenant = await api.signUp();

    await api.post(
      '/bookings',
      { propertyId: listing, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );

    const res = await api.get('/dashboard/summary', { token: landlord.token });
    expect(res.body.upcoming).toHaveLength(1);
    expect(res.body.upcoming[0].nights).toBe(7);
    expect(res.body.upcoming[0].tenantName).toBeTruthy();
    // 7 x 90.00 + 30.00 cleaning
    expect(res.body.upcoming[0].totalExpectedMinor).toBe('66000');
  });

  it('reports the balance from the ledger, not a cached column', async () => {
    const landlord = await api.signUp();
    await db.query(
      `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor) VALUES
         ($1,'FEE_ACCRUED',-9500), ($1,'PAYMENT_RECEIVED',4000)`,
      [landlord.userId],
    );
    const res = await api.get('/dashboard/summary', { token: landlord.token });
    expect(res.body.stats.balanceMinor).toBe('-5500');
  });
});

/* ================================================================== */

describe('«Требует внимания»', () => {
  it('is empty for a landlord with nothing to do', async () => {
    const landlord = await api.signUp();
    await publishedListing(landlord.token);
    const res = await api.get('/dashboard/summary', { token: landlord.token });
    expect(res.body.attention).toEqual([]);
  });

  it('puts a pending booking request first and marks it urgent', async () => {
    const landlord = await api.signUp();
    const listing = await publishedListing(landlord.token);
    const tenant = await api.signUp();
    await api.post(
      '/bookings',
      { propertyId: listing, from: '2026-09-01', to: '2026-09-08' },
      { token: tenant.token },
    );

    const res = await api.get('/dashboard/summary', { token: landlord.token });
    expect(res.body.attention[0].kind).toBe('BOOKING_REQUEST');
    expect(res.body.attention[0].severity).toBe('URGENT');
    expect(res.body.attention[0].href).toContain('REQUESTED');
  });

  it('surfaces a rejected listing together with the moderator’s reason', async () => {
    const landlord = await api.signUp();
    const id = (await api.post('/listings', LISTING, { token: landlord.token })).body.id;
    await api.attachPhoto(id);
    await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });

    const moderator = await api.signUp();
    await api.grantRole(moderator.userId, 'MODERATOR');
    await api.post(
      `/admin/moderation/listings/${id}`,
      { decision: 'REJECTED', reason: 'Фотографии не соответствуют описанию' },
      { token: moderator.token },
    );

    const res = await api.get('/dashboard/summary', { token: landlord.token });
    const item = res.body.attention.find((a: { kind: string }) => a.kind === 'LISTING_REJECTED');
    expect(item).toBeTruthy();
    expect(item.detail).toContain('Фотографии');
  });

  it('asks the landlord to confirm completion when the window is open', async () => {
    const landlord = await api.signUp();
    const listing = await publishedListing(landlord.token);
    const tenant = await api.signUp();
    const booking = await api.post(
      '/bookings',
      { propertyId: listing, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );
    await db.query(
      `UPDATE booking SET status='COMPLETION_PENDING', completion_deadline_at=now() + interval '7 days'
        WHERE id=$1`,
      [booking.body.id],
    );

    const res = await api.get('/dashboard/summary', { token: landlord.token });
    const item = res.body.attention.find((a: { kind: string }) => a.kind === 'CONFIRM_COMPLETION');
    expect(item).toBeTruthy();
    expect(item.severity).toBe('ACTION');
  });

  it('escalates debt only once a fee is actually overdue', async () => {
    const landlord = await api.signUp();
    const listing = await publishedListing(landlord.token);
    const tenant = await api.signUp();
    const booking = await api.post(
      '/bookings',
      { propertyId: listing, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );

    const feeId = crypto.randomUUID();
    await db.query(
      `INSERT INTO service_fee (id, booking_id, landlord_id, base_minor, bps, fee_minor, due_at)
       VALUES ($1,$2,$3, 190000, 500, 9500, now() + interval '10 days')`,
      [feeId, booking.body.id, landlord.userId],
    );
    await db.query(
      `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, service_fee_id)
       VALUES ($1,'FEE_ACCRUED',-9500,$2)`,
      [landlord.userId, feeId],
    );

    const beforeDue = await api.get('/dashboard/summary', { token: landlord.token });
    const infoItem = beforeDue.body.attention.find((a: { kind: string }) => a.kind === 'OUTSTANDING_DEBT');
    expect(infoItem.severity).toBe('INFO');

    await db.query(`UPDATE service_fee SET due_at = now() - interval '1 day' WHERE id=$1`, [feeId]);
    const afterDue = await api.get('/dashboard/summary', { token: landlord.token });
    const urgentItem = afterDue.body.attention.find((a: { kind: string }) => a.kind === 'OUTSTANDING_DEBT');
    expect(urgentItem.severity).toBe('URGENT');
  });

  it('flags a stale calendar on a published listing', async () => {
    const landlord = await api.signUp();
    const id = await publishedListing(landlord.token);
    await db.query(`UPDATE property SET calendar_updated_at = now() - interval '40 days' WHERE id=$1`, [id]);

    const res = await api.get('/dashboard/summary', { token: landlord.token });
    expect(res.body.listings[0].calendarStale).toBe(true);
    expect(res.body.attention.some((a: { kind: string }) => a.kind === 'STALE_CALENDAR')).toBe(true);
  });

  it('does not flag a stale calendar on an unpublished listing', async () => {
    // Nobody can book a draft, so nagging about its calendar is noise.
    const landlord = await api.signUp();
    const id = (await api.post('/listings', LISTING, { token: landlord.token })).body.id;
    await db.query(`UPDATE property SET calendar_updated_at = now() - interval '40 days' WHERE id=$1`, [id]);

    const res = await api.get('/dashboard/summary', { token: landlord.token });
    expect(res.body.listings[0].calendarStale).toBe(false);
    expect(res.body.attention.some((a: { kind: string }) => a.kind === 'STALE_CALENDAR')).toBe(false);
  });

  it('orders urgent items above informational ones', async () => {
    const landlord = await api.signUp();
    const listing = await publishedListing(landlord.token);
    await api.post('/listings', LISTING, { token: landlord.token }); // a draft
    const tenant = await api.signUp();
    await api.post(
      '/bookings',
      { propertyId: listing, from: '2026-09-01', to: '2026-09-08' },
      { token: tenant.token },
    );

    const res = await api.get('/dashboard/summary', { token: landlord.token });
    const severities = res.body.attention.map((a: { severity: string }) => a.severity);
    const rank = { URGENT: 0, ACTION: 1, INFO: 2 } as Record<string, number>;
    expect(severities.map((s: string) => rank[s])).toEqual([...severities.map((s: string) => rank[s])].sort());
  });
});

/* ================================================================== */

describe('privacy of the dashboard payload', () => {
  it('does not include tenant contact details', async () => {
    const landlord = await api.signUp();
    const listing = await publishedListing(landlord.token);
    const tenant = await api.signUp();
    await api.post(
      '/bookings',
      { propertyId: listing, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );

    const res = await api.get('/dashboard/summary', { token: landlord.token });
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('@example.by');
    expect(serialised).not.toContain(tenant.email);
  });

  it('does not include exact addresses', async () => {
    const landlord = await api.signUp();
    await api.post(
      '/listings',
      // Unmistakable fixture values. '42' as a needle passed or failed
      // depending on the millisecond in `calendarUpdatedAt` — a two-character
      // number occurs in timestamps and uuids by accident, so the assertion
      // was testing luck rather than privacy.
      { ...LISTING, street: 'ул. Секретная', houseNumber: 'ДОМ-ZZQ', apartmentNumber: 'КВ-ZZQ' },
      { token: landlord.token },
    );
    const res = await api.get('/dashboard/summary', { token: landlord.token });
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('Секретная');
    expect(serialised).not.toContain('ДОМ-ZZQ');
    expect(serialised).not.toContain('КВ-ZZQ');
  });

  it('scopes the service to one user even when called directly', async () => {
    // Belt and braces: the service must be safe even if a future route forgets.
    const a = await api.signUp();
    const b = await api.signUp();
    await publishedListing(a.token);

    const summary = await dashboard.landlordSummary(b.userId);
    expect(summary.listings).toEqual([]);
  });
});
