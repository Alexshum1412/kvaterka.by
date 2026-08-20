/**
 * Authorization matrix and product-flow tests.
 *
 * The matrix section is the important one: it walks EVERY route in the table
 * that declares a permission and asserts an ordinary user is refused. That way
 * a newly added privileged endpoint cannot quietly ship without a guard —
 * the test discovers routes rather than listing them by hand.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { allRoutes } from '@/server/api/routes/index.ts';
import { can, permissionsFor, ROLES, type Role } from '@/server/auth/rbac.ts';

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
    INSERT INTO amenity (code, category, name_ru, name_be, name_en)
    VALUES ('WIFI','ESSENTIALS','Wi-Fi','Wi-Fi','Wi-Fi') ON CONFLICT DO NOTHING;
    INSERT INTO feature_flag (key, enabled, description, requires_legal_approval) VALUES
      ('fee.enforcement', true, 'test', true),
      ('rewards.lottery', false, 'test', true),
      ('verification.identity_documents', false, 'test', true)
    ON CONFLICT DO NOTHING;
  `);
});

const LISTING = {
  title: 'Уютная квартира рядом с парком',
  propertyType: 'APARTMENT' as const,
  city: 'Минск',
  latitude: 53.9045,
  longitude: 27.5615,
  maxGuests: 4,
  basePriceMinor: '8000',
  cleaningFeeMinor: '3000',
  bookingMode: 'INSTANT_AND_REQUEST' as const,
};

async function publishedListing() {
  const landlord = await api.signUp();
  const id = (await api.post('/listings', LISTING, { token: landlord.token })).body.id as string;
  await api.attachPhoto(id);
  await api.post(`/listings/${id}/submit`, {}, { token: landlord.token });

  const moderator = await api.signUp();
  await api.grantRole(moderator.userId, 'MODERATOR');
  await api.post(`/admin/moderation/listings/${id}`, { decision: 'PUBLISHED' }, { token: moderator.token });
  return { landlord, listingId: id };
}

/* ================================================================== *
 * The matrix
 * ================================================================== */

describe('every privileged route is guarded', () => {
  const privileged = allRoutes.filter((r) => r.permission);

  it('there are privileged routes to check', () => {
    expect(privileged.length).toBeGreaterThan(10);
  });

  it.each(privileged.map((r) => [`${r.method} ${r.path}`, r] as const))(
    'refuses an ordinary user: %s',
    async (_label, route) => {
      const user = await api.signUp();
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '00000000-0000-0000-0000-000000000000');

      const res = await api.request(route.method, path, sampleBodyFor(route.path), { token: user.token });

      // 403 is the expected answer. A validation error is also acceptable only
      // if it happened AFTER the permission check — which the dispatcher
      // guarantees by ordering authorize before validate, so anything other
      // than 403 here is a missing guard.
      expect(res.status, `${route.method} ${route.path} returned ${res.status}`).toBe(403);
      expect(res.errorCode).toBe('FORBIDDEN');
    },
  );

  it.each(privileged.map((r) => [`${r.method} ${r.path}`, r] as const))(
    'refuses an anonymous caller: %s',
    async (_label, route) => {
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '00000000-0000-0000-0000-000000000000');
      const res = await api.request(route.method, path, sampleBodyFor(route.path));
      expect(res.status).toBe(401);
    },
  );

  it('gives an identical refusal regardless of which permission was missing', async () => {
    // The message must not tell a prober which role would have worked.
    const user = await api.signUp();
    const a = await api.get('/admin/audit', { token: user.token });
    const b = await api.get('/admin/moderation/listings', { token: user.token });
    expect(a.body.error.message).toBe(b.body.error.message);
  });
});

/* ================================================================== *
 * Identity documents — the narrowest permission in the system
 * ================================================================== */

describe('identity documents', () => {
  const docPath = '/admin/verification/documents/00000000-0000-0000-0000-000000000000?purpose=review';

  it.each(['SUPPORT', 'MODERATOR', 'FINANCE', 'ADMIN'] as const)(
    'refuses %s — including ADMIN',
    async (role) => {
      const staff = await api.signUp();
      await api.grantRole(staff.userId, role);
      const res = await api.get(docPath, { token: staff.token });
      expect(res.status).toBe(403);
    },
  );

  it('allows VERIFIER past the permission check', async () => {
    const verifier = await api.signUp();
    await api.grantRole(verifier.userId, 'VERIFIER');
    const res = await api.get(docPath, { token: verifier.token });
    // Not 403: the guard let them through. It fails later because the feature
    // flag is off pending LEGAL-004, which is the intended state today.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/юридического заключения/);
  });

  it('logs every document read', async () => {
    const verifier = await api.signUp();
    await api.grantRole(verifier.userId, 'VERIFIER');
    const owner = await api.signUp();

    await db.query(
      `INSERT INTO feature_flag (key, enabled, description, requires_legal_approval)
       VALUES ('verification.identity_documents', true, 'test', true)
       ON CONFLICT (key) DO UPDATE SET enabled = true`,
    );
    const requestId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    await db.query(
      `INSERT INTO verification_request (id, user_id, kind, target_level) VALUES ($1,$2,'IDENTITY',1)`,
      [requestId, owner.userId],
    );
    await db.query(
      `INSERT INTO verification_document (id, request_id, doc_type, storage_key)
       VALUES ($1,$2,'PASSPORT','private/docs/1.jpg')`,
      [documentId, requestId],
    );

    const res = await api.get(
      `/admin/verification/documents/${documentId}?purpose=Проверка личности по заявке`,
      { token: verifier.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.accessLogged).toBe(true);

    const { rows } = await db.query<{ actor_user_id: string; purpose: string }>(
      `SELECT actor_user_id, purpose FROM document_access_log WHERE document_id=$1`,
      [documentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(verifier.userId);
    expect(rows[0]!.purpose).toMatch(/Проверка личности/);
  });

  it('never exposes document keys through the verification queue', async () => {
    const verifier = await api.signUp();
    await api.grantRole(verifier.userId, 'VERIFIER');
    const owner = await api.signUp();
    const requestId = crypto.randomUUID();
    await db.query(
      `INSERT INTO verification_request (id, user_id, kind, target_level) VALUES ($1,$2,'IDENTITY',1)`,
      [requestId, owner.userId],
    );
    await db.query(
      `INSERT INTO verification_document (id, request_id, doc_type, storage_key)
       VALUES ($1,$2,'PASSPORT','private/docs/secret.jpg')`,
      [crypto.randomUUID(), requestId],
    );

    const res = await api.get('/admin/verification/queue', { token: verifier.token });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('secret.jpg');
    expect(res.body[0].document_count).toBe(1);
  });
});

/* ================================================================== *
 * RBAC unit-level invariants
 * ================================================================== */

describe('role definitions', () => {
  it('grants no staff permission to tenants or landlords', () => {
    expect(permissionsFor(['TENANT', 'LANDLORD']).size).toBe(0);
  });

  it('lets exactly one role read identity documents', () => {
    const holders = ROLES.filter((r: Role) => can([r], 'document.read'));
    expect(holders).toEqual(['VERIFIER']);
  });

  it('keeps money operations away from support and moderation', () => {
    for (const role of ['SUPPORT', 'MODERATOR', 'VERIFIER'] as const) {
      expect(can([role], 'ledger.adjust')).toBe(false);
      expect(can([role], 'fee.waive')).toBe(false);
    }
  });
});

/* ================================================================== *
 * Feature flags gating legal questions
 * ================================================================== */

describe('legally gated feature flags', () => {
  it('refuses to enable the rewards lottery without a legal approval reference', async () => {
    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');

    const res = await api.put(
      '/admin/feature-flags/rewards.lottery',
      { enabled: true, reason: 'Хотим запустить розыгрыш' },
      { token: admin.token },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/юридического заключения/);

    const { rows } = await db.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flag WHERE key='rewards.lottery'`,
    );
    expect(rows[0]!.enabled).toBe(false);
  });

  it('records the legal reference in the audit log when it is supplied', async () => {
    const admin = await api.signUp();
    await api.grantRole(admin.userId, 'ADMIN');

    const res = await api.put(
      '/admin/feature-flags/rewards.lottery',
      { enabled: true, reason: 'Одобрено', legalApprovalReference: 'Заключение от 2026-08-01, юрист И.И.' },
      { token: admin.token },
    );
    expect(res.status).toBe(200);

    const { rows } = await db.query<{ reason: string }>(
      `SELECT reason FROM audit_log WHERE action='feature_flag.update' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.reason).toContain('legal: Заключение');
  });
});

/* ================================================================== *
 * Chat
 * ================================================================== */

describe('chat', () => {
  it('filters contact details server-side before confirmation', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();

    const conversation = await api.post('/chat/conversations', { propertyId: listingId }, { token: tenant.token });
    expect(conversation.status).toBe(201);

    const sent = await api.post(
      `/chat/conversations/${conversation.body.id}/messages`,
      { text: 'Добрый день! Звоните мне на +375 29 123-45-67' },
      { token: tenant.token },
    );
    expect(sent.status).toBe(201);
    expect(sent.body.body).not.toMatch(/\d{7,}/);
    expect(sent.body.body).toContain('[контакт скрыт]');
    expect(sent.body.moderationState).toBe('REDACTED');
    expect(sent.body.filterNotice).toMatch(/подтверждения/);
  });

  it('leaves ordinary rental chat untouched', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    const conversation = await api.post('/chat/conversations', { propertyId: listingId }, { token: tenant.token });

    const text = 'Здравствуйте! Квартира 42, 5 этаж — заезд в 14:00 подойдёт?';
    const sent = await api.post(
      `/chat/conversations/${conversation.body.id}/messages`,
      { text },
      { token: tenant.token },
    );
    expect(sent.body.body).toBe(text);
    expect(sent.body.moderationState).toBe('CLEAN');
  });

  it('keeps the original text for moderation when it redacts', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    const conversation = await api.post('/chat/conversations', { propertyId: listingId }, { token: tenant.token });
    await api.post(
      `/chat/conversations/${conversation.body.id}/messages`,
      { text: 'пишите в телеграм @minsk_flats_2026' },
      { token: tenant.token },
    );

    const { rows } = await db.query<{ body_original: string; moderation_state: string }>(
      `SELECT body_original, moderation_state FROM message WHERE moderation_state <> 'CLEAN'`,
    );
    expect(rows[0]!.body_original).toContain('@minsk_flats_2026');
    const events = await db.query<{ detectors: string[] }>(`SELECT detectors FROM message_moderation_event`);
    expect(events.rows[0]!.detectors).toContain('HANDLE');
  });

  it('stops filtering once the booking is confirmed', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );

    const conversations = await api.get('/chat/conversations', { token: tenant.token });
    const conversationId = conversations.body[0].id;
    expect(conversations.body[0].contactReleased).toBe(true);

    const text = 'Мой номер +375 29 123-45-67, звоните перед заездом';
    const sent = await api.post(
      `/chat/conversations/${conversationId}/messages`,
      { text },
      { token: tenant.token },
    );
    expect(sent.body.body).toBe(text);
    expect(sent.body.moderationState).toBe('CLEAN');
  });

  it('does not let an outsider read a conversation', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    const conversation = await api.post('/chat/conversations', { propertyId: listingId }, { token: tenant.token });

    const stranger = await api.signUp();
    const res = await api.get(`/chat/conversations/${conversation.body.id}/messages`, { token: stranger.token });
    expect(res.status).toBe(403);
  });

  it('does not let an outsider post into a conversation', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    const conversation = await api.post('/chat/conversations', { propertyId: listingId }, { token: tenant.token });

    const stranger = await api.signUp();
    const res = await api.post(
      `/chat/conversations/${conversation.body.id}/messages`,
      { text: 'Влезаю в чужую переписку' },
      { token: stranger.token },
    );
    expect(res.status).toBe(403);
  });
});

/* ================================================================== *
 * Reviews
 * ================================================================== */

describe('reviews', () => {
  async function completedBooking() {
    const { landlord, listingId } = await publishedListing();
    const tenant = await api.signUp();

    const booking = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );
    const bookingId = booking.body.id as string;

    await api.post(`/bookings/${bookingId}/check-in`, {}, { token: tenant.token });
    await db.query(
      `UPDATE booking SET status='COMPLETION_PENDING', completion_deadline_at = now() + interval '7 days'
        WHERE id=$1`,
      [bookingId],
    );
    await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: tenant.token });
    await api.post(`/bookings/${bookingId}/completion`, { answer: 'TOOK_PLACE' }, { token: landlord.token });

    await db.query(`UPDATE booking SET review_deadline_at = now() + interval '14 days' WHERE id=$1`, [
      bookingId,
    ]);
    return { landlord, tenant, bookingId, listingId };
  }

  const TENANT_REVIEW = {
    role: 'TENANT' as const,
    overall: 5,
    cleanliness: 5,
    accuracy: 4,
    communication: 5,
    body: 'Всё соответствовало описанию, хозяин на связи.',
    confirmedFacts: { WIFI: true },
  };

  const LANDLORD_REVIEW = {
    role: 'LANDLORD' as const,
    overall: 5,
    communication: 5,
    ruleCompliance: 5,
    propertyCondition: 5,
    body: 'Аккуратные жильцы, всё в порядке.',
  };

  it('refuses a review before the rental is completed', async () => {
    const { listingId } = await publishedListing();
    const tenant = await api.signUp();
    const booking = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );

    const eligibility = await api.get(`/bookings/${booking.body.id}/review-eligibility`, {
      token: tenant.token,
    });
    expect(eligibility.body.canReview).toBe(false);
    expect(eligibility.body.reason).toBe('RENTAL_NOT_COMPLETED');

    const res = await api.post(`/bookings/${booking.body.id}/reviews`, TENANT_REVIEW, { token: tenant.token });
    expect(res.status).toBe(409);
  });

  it('holds the first review back until the second arrives', async () => {
    const { landlord, tenant, bookingId, listingId } = await completedBooking();

    const first = await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    expect(first.status).toBe(201);
    expect(first.body.published).toBe(false);

    // Nothing is visible yet — this is what prevents retaliatory scoring.
    expect((await api.get(`/listings/${listingId}/reviews`)).body.reviews).toHaveLength(0);

    const second = await api.post(`/bookings/${bookingId}/reviews`, LANDLORD_REVIEW, { token: landlord.token });
    expect(second.body.published).toBe(true);

    const published = await api.get(`/listings/${listingId}/reviews`);
    expect(published.body.reviews).toHaveLength(1);
    expect(published.body.reviews[0].ratings.overall).toBe(5);
  });

  it('rejects a second review from the same side', async () => {
    const { tenant, bookingId } = await completedBooking();
    expect((await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token })).status).toBe(
      201,
    );
    const duplicate = await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    expect(duplicate.status).toBe(409);
  });

  it('rejects a review from somebody who was not part of the rental', async () => {
    const { bookingId } = await completedBooking();
    const stranger = await api.signUp();
    const res = await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: stranger.token });
    expect(res.status).toBe(403);
  });

  it('refuses a harsh rating with no explanation', async () => {
    const { tenant, bookingId } = await completedBooking();
    const res = await api.post(
      `/bookings/${bookingId}/reviews`,
      { ...TENANT_REVIEW, overall: 1, body: '', whatWasGood: '', whatToImprove: '' },
      { token: tenant.token },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/опишите/);
  });

  it('publishes a one-sided review once the window closes', async () => {
    const { tenant, bookingId, listingId } = await completedBooking();
    await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    expect((await api.get(`/listings/${listingId}/reviews`)).body.reviews).toHaveLength(0);

    // Otherwise a party could suppress criticism forever by never replying.
    await db.query(`UPDATE booking SET review_deadline_at = now() - interval '1 day' WHERE id=$1`, [bookingId]);
    const { ReviewService } = await import('@/server/services/review-service.ts');
    expect(await new ReviewService(db).publishExpiredWindows()).toBe(1);

    expect((await api.get(`/listings/${listingId}/reviews`)).body.reviews).toHaveLength(1);
  });

  it('aggregates guest-confirmed facts separately from landlord claims', async () => {
    const { landlord, tenant, bookingId, listingId } = await completedBooking();
    await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    await api.post(`/bookings/${bookingId}/reviews`, LANDLORD_REVIEW, { token: landlord.token });

    const res = await api.get(`/listings/${listingId}/reviews`);
    expect(res.body.confirmedFacts.WIFI).toEqual({ confirmed: 1, total: 1 });
  });

  it('reports the stay duration without exposing exact dates', async () => {
    const { landlord, tenant, bookingId, listingId } = await completedBooking();
    await api.post(`/bookings/${bookingId}/reviews`, TENANT_REVIEW, { token: tenant.token });
    await api.post(`/bookings/${bookingId}/reviews`, LANDLORD_REVIEW, { token: landlord.token });

    const res = await api.get(`/listings/${listingId}/reviews`);
    const review = res.body.reviews[0];
    expect(review.stayLength).toMatch(/7 ночей/);
    expect(JSON.stringify(review)).not.toContain('2026-09-01');
  });
});

/* ================================================================== *
 * Trust profile
 * ================================================================== */

describe('trust profile', () => {
  it('explains the score rather than just asserting it', async () => {
    const user = await api.signUp();
    const res = await api.get(`/profiles/${user.userId}`);
    expect(res.status).toBe(200);
    expect(res.body.trustBand).toBe('NEW');
    expect(res.body.components.length).toBeGreaterThanOrEqual(5);
    for (const component of res.body.components) {
      expect(component.detail.length).toBeGreaterThan(3);
      expect(component.maxPoints).toBeGreaterThan(0);
    }
  });

  it('never exposes fraud signals or internal risk data', async () => {
    const user = await api.signUp();
    await db.query(
      `INSERT INTO fraud_signal (user_id, kind, severity) VALUES ($1,'UNILATERAL_LANDLORD_DENIAL',3)`,
      [user.userId],
    );
    const res = await api.get(`/profiles/${user.userId}`);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('UNILATERAL_LANDLORD_DENIAL');
    expect(serialised).not.toContain('fraud');
  });

  it('does not expose contact details on a public profile', async () => {
    const user = await api.signUp();
    const res = await api.get(`/profiles/${user.userId}`);
    expect(JSON.stringify(res.body)).not.toContain('@example.by');
  });
});

/* ================================================================== *
 * Debt restrictions
 * ================================================================== */

describe('debt restrictions', () => {
  it('does not restrict a landlord with no debt', async () => {
    const { landlord } = await publishedListing();
    const res = await api.get('/me/balance', { token: landlord.token });
    expect(res.body.hasDebt).toBe(false);
    expect(res.body.restrictions).toEqual([]);
  });

  it('blocks new listings once a fee is overdue, without touching active bookings', async () => {
    const { landlord, listingId } = await publishedListing();
    const tenant = await api.signUp();

    const booking = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );

    // An overdue fee on a month-long rental: 1900.00 BYN x 5% = 95.00 BYN,
    // which is above the 50.00 restriction threshold. A smaller debt is
    // deliberately not enough to disable an account.
    const feeId = crypto.randomUUID();
    await db.query(
      `INSERT INTO service_fee (id, booking_id, landlord_id, base_minor, bps, fee_minor, due_at)
       VALUES ($1,$2,$3, 190000, 500, 9500, now() - interval '1 day')`,
      [feeId, booking.body.id, landlord.userId],
    );
    await db.query(
      `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, service_fee_id, booking_id)
       VALUES ($1,'FEE_ACCRUED', -9500, $2, $3)`,
      [landlord.userId, feeId, booking.body.id],
    );

    const balance = await api.get('/me/balance', { token: landlord.token });
    expect(balance.body.hasDebt).toBe(true);
    expect(balance.body.restrictions).toContain('CANNOT_PUBLISH_NEW_LISTINGS');

    const blocked = await api.post('/listings', LISTING, { token: landlord.token });
    expect(blocked.status).toBe(403);

    // The existing booking is untouched: punishing the landlord mid-stay would
    // punish their tenant, who did nothing wrong.
    const existing = await api.get(`/bookings/${booking.body.id}`, { token: tenant.token });
    expect(existing.status).toBe(200);
    expect(existing.body.status).toBe('CONFIRMED');
  });

  it('shows the arithmetic behind every fee', async () => {
    const { landlord, listingId } = await publishedListing();
    const tenant = await api.signUp();
    const booking = await api.post(
      '/bookings',
      { propertyId: listingId, from: '2026-09-01', to: '2026-09-08', instant: true },
      { token: tenant.token },
    );
    await db.query(
      `INSERT INTO service_fee (id, booking_id, landlord_id, base_minor, bps, fee_minor)
       VALUES ($1,$2,$3, 59000, 500, 2950)`,
      [crypto.randomUUID(), booking.body.id, landlord.userId],
    );

    const fees = await api.get('/me/fees', { token: landlord.token });
    expect(fees.body[0].arithmeticVerified).toBe(true);
    expect(fees.body[0].explanation).toBe('590.00 × 5% = 29.50 BYN');
  });
});

/* ================================================================== */

/** Minimal valid-shaped body so a route fails on permission, not on parsing. */
function sampleBodyFor(path: string): Record<string, unknown> | undefined {
  if (path.includes('feature-flags')) return { enabled: false, reason: 'проверка доступа' };
  if (path.includes('restrict')) return { status: 'RESTRICTED', reason: 'проверка доступа' };
  if (path.includes('decide')) return { decision: 'APPROVED', note: 'проверка доступа' };
  if (path.includes('moderation/listings')) return { decision: 'PUBLISHED' };
  if (path.includes('payments')) return { amountMinor: '1000', reference: 'проверка доступа' };
  if (path.includes('adjustments')) return { amountMinor: '1000', reason: 'проверка доступа' };
  if (path.includes('waive')) return { reason: 'проверка доступа' };
  return undefined;
}
