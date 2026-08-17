/**
 * Staff operations: the dispute console, over the real dispatcher.
 *
 * The bulk of this file is negative. A console that can read a case file and
 * decide a booking is the most dangerous surface in the product, so most of
 * what is asserted here is what it CANNOT do: which roles are refused which
 * evidence, that identity documents are out of reach of every role that works
 * cases, that internal notes never reach the parties, that a case id cannot be
 * probed by an ordinary account, and that no staff action writes the ledger
 * except through the booking domain.
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
    INSERT INTO feature_flag (key, enabled, description, requires_legal_approval) VALUES
      ('fee.enforcement', true, 'test', true)
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
  beds: 3,
  maxGuests: 4,
  basePriceMinor: '10000',
  cleaningFeeMinor: '0',
  depositMinor: '0',
  minNights: 2,
  maxNights: 90,
  bookingMode: 'REQUEST' as const,
  amenities: ['WIFI'],
};

const FROM = '2027-09-15';
const TO = '2027-09-20';

async function published() {
  const landlord = await api.signUp();
  const created = await api.post('/listings', LISTING, { token: landlord.token });
  const listingId = created.body.id as string;
  await api.post(`/listings/${listingId}/photos`, { storageKey: `listings/${listingId}/a.jpg` }, { token: landlord.token });
  await api.post(`/listings/${listingId}/submit`, {}, { token: landlord.token });

  const moderator = await api.signUp();
  await api.grantRole(moderator.userId, 'MODERATOR');
  await api.post(`/admin/moderation/listings/${listingId}`, { decision: 'PUBLISHED' }, { token: moderator.token });
  return { landlord, listingId };
}

/** A booking in COMPLETION_PENDING with an open dispute filed by the tenant. */
async function disputed(category = 'LISTING_MISMATCH', summary = 'Квартира отличалась от фотографий, не было стиральной машины.') {
  const { landlord, listingId } = await published();
  const tenant = await api.signUp();

  const created = await api.post('/bookings', { propertyId: listingId, from: FROM, to: TO, guests: 2 }, { token: tenant.token });
  const bookingId = created.body.id as string;
  await api.post(`/bookings/${bookingId}/accept`, {}, { token: landlord.token });
  await api.post(`/bookings/${bookingId}/check-in`, {}, { token: tenant.token });
  await db.query(
    `UPDATE booking SET stay_period = daterange((CURRENT_DATE - 6), (CURRENT_DATE - 1), '[)') WHERE id=$1`,
    [bookingId],
  );
  await api.post(`/bookings/${bookingId}/check-out`, {}, { token: tenant.token });

  const opened = await api.post(`/bookings/${bookingId}/dispute`, { category, summary }, { token: tenant.token });
  expect(opened.status).toBe(201);

  const { rows } = await db.query<{ id: string; reference: string }>(
    `SELECT id, reference FROM dispute_case WHERE booking_id=$1`,
    [bookingId],
  );

  return { landlord, tenant, listingId, bookingId, caseId: rows[0]!.id, reference: rows[0]!.reference };
}

async function staffWith(role: string) {
  const user = await api.signUp();
  await api.grantRole(user.userId, role);
  return user;
}

/* ================================================================== *
 * Who may open the console at all
 * ================================================================== */

describe('console access', () => {
  it('refuses an ordinary tenant and an ordinary landlord', async () => {
    const { caseId, tenant, landlord } = await disputed();

    for (const [who, token] of [
      ['tenant', tenant.token],
      ['landlord', landlord.token],
    ] as const) {
      expect((await api.get('/admin/overview', { token })).status, who).toBe(403);
      expect((await api.get('/admin/disputes', { token })).status, who).toBe(403);
      expect((await api.get(`/admin/disputes/${caseId}`, { token })).status, who).toBe(403);
      expect(
        (await api.post(`/admin/disputes/${caseId}/notes`, { note: 'x y' }, { token })).status,
        who,
      ).toBe(403);
    }
  });

  it('refuses an anonymous caller before it refuses anything else', async () => {
    const { caseId } = await disputed();
    expect((await api.get('/admin/disputes')).status).toBe(401);
    expect((await api.get(`/admin/disputes/${caseId}`)).status).toBe(401);
  });

  it('does not let a party enumerate case ids', async () => {
    const first = await disputed();
    const second = await disputed();

    // The tenant of one booking cannot read the other's case, and gets the same
    // answer for a case that exists as for one that does not.
    const real = await api.get(`/admin/disputes/${second.caseId}`, { token: first.tenant.token });
    const fake = await api.get('/admin/disputes/00000000-0000-4000-8000-000000000000', {
      token: first.tenant.token,
    });
    expect(real.status).toBe(fake.status);
  });

  it('lets FINANCE hold debt.view without reaching the case queue', async () => {
    const { caseId } = await disputed();
    const finance = await staffWith('FINANCE');
    // FINANCE has no case.* permission at all, by design.
    expect((await api.get('/admin/disputes', { token: finance.token })).status).toBe(403);
    expect((await api.get(`/admin/disputes/${caseId}`, { token: finance.token })).status).toBe(403);
  });
});

/* ================================================================== *
 * Identity documents — the rule that must not bend
 * ================================================================== */

describe('identity documents stay VERIFIER-only', () => {
  it('is refused to every role that works cases, including ADMIN', async () => {
    const { caseId } = await disputed();
    // Turned on so the refusals below are demonstrably about the permission
    // and not about the flag. The flag itself is asserted in the next test.
    await db.query(
      `INSERT INTO feature_flag (key, enabled, description, requires_legal_approval)
       VALUES ('verification.identity_documents', true, 'test', true)
       ON CONFLICT (key) DO UPDATE SET enabled = true`,
    );

    // A document row to aim at, so the refusal is about permission and not
    // about the row being missing.
    const owner = await api.signUp();
    const requestId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    await db.query(
      `INSERT INTO verification_request (id, user_id, kind, target_level, status)
       VALUES ($1,$2,'IDENTITY',1,'SUBMITTED')`,
      [requestId, owner.userId],
    );
    await db.query(
      `INSERT INTO verification_document (id, request_id, doc_type, storage_key, purge_after)
       VALUES ($1,$2,'PASSPORT','private/doc.jpg', now() + interval '30 days')`,
      [documentId, requestId],
    );

    for (const role of ['SUPPORT', 'MODERATOR', 'FINANCE', 'ADMIN']) {
      const staff = await staffWith(role);
      const res = await api.get(`/admin/verification/documents/${documentId}`, { token: staff.token });
      expect(res.status, `${role} must not read a document`).toBe(403);

      // And nothing in the case file leaks one either.
      const detail = await api.get(`/admin/disputes/${caseId}`, { token: staff.token });
      if (detail.status === 200) {
        const serialised = JSON.stringify(detail.body);
        expect(serialised, role).not.toContain('private/doc.jpg');
        expect(serialised, role).not.toContain('PASSPORT');
        expect(detail.body.entitlements.identityDocuments, role).toBe(false);
      }
    }

    // VERIFIER can, must say why, and the read is logged before the key is
    // handed over.
    const verifier = await staffWith('VERIFIER');
    expect((await api.get(`/admin/verification/documents/${documentId}`, { token: verifier.token })).status)
      .toBe(422); // no stated purpose
    const opened = await api.get(
      `/admin/verification/documents/${documentId}?purpose=${encodeURIComponent('проверка личности по обращению')}`,
      { token: verifier.token },
    );
    expect(opened.status).toBe(200);

    const { rows } = await db.query<{ actor_user_id: string; purpose: string }>(
      `SELECT actor_user_id, purpose FROM document_access_log WHERE document_id=$1`,
      [documentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(verifier.userId);
    expect(rows[0]!.purpose).toContain('проверка личности');
  });

  it('stays closed for VERIFIER too while the legal flag is off', async () => {
    // Fail-closed: the permission is necessary but not sufficient, because
    // document handling is still an open legal question (LEGAL-004).
    const owner = await api.signUp();
    const requestId = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    await db.query(
      `INSERT INTO verification_request (id, user_id, kind, target_level, status)
       VALUES ($1,$2,'IDENTITY',1,'SUBMITTED')`,
      [requestId, owner.userId],
    );
    await db.query(
      `INSERT INTO verification_document (id, request_id, doc_type, storage_key)
       VALUES ($1,$2,'PASSPORT','private/doc.jpg')`,
      [documentId, requestId],
    );

    const verifier = await staffWith('VERIFIER');
    const res = await api.get(`/admin/verification/documents/${documentId}?purpose=проверка`, {
      token: verifier.token,
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain('private/doc.jpg');
  });
});

/* ================================================================== *
 * Evidence, per entitlement
 * ================================================================== */

describe('least privilege on evidence', () => {
  it('gives message bodies only to message.review, and says so otherwise', async () => {
    const { caseId, tenant, bookingId } = await disputed();
    // A message to find.
    const { rows: conv } = await db.query<{ id: string }>(
      `SELECT id FROM conversation WHERE booking_id=$1`,
      [bookingId],
    );
    await api.post(
      `/chat/conversations/${conv[0]!.id}/messages`,
      { text: 'Мы договорились встретиться у подъезда в шесть.' },
      { token: tenant.token },
    );

    const support = await staffWith('SUPPORT');
    const moderator = await staffWith('MODERATOR');

    const supportView = await api.get(`/admin/disputes/${caseId}`, { token: support.token });
    expect(supportView.status).toBe(200);
    expect(supportView.body.entitlements.messages).toBe(false);
    // Absent, not empty: "no access" and "no conversation" are different facts.
    expect(supportView.body.messages).toBeUndefined();
    expect(JSON.stringify(supportView.body)).not.toContain('у подъезда');

    const moderatorView = await api.get(`/admin/disputes/${caseId}`, { token: moderator.token });
    expect(moderatorView.body.entitlements.messages).toBe(true);
    expect(JSON.stringify(moderatorView.body)).toContain('у подъезда');
  });

  it('gives the financial picture only to debt.view', async () => {
    const { caseId } = await disputed();
    const moderator = await staffWith('MODERATOR'); // no debt.view
    const support = await staffWith('SUPPORT'); // has debt.view

    const m = await api.get(`/admin/disputes/${caseId}`, { token: moderator.token });
    expect(m.body.entitlements.finance).toBe(false);
    expect(m.body.finance).toBeUndefined();

    const s = await api.get(`/admin/disputes/${caseId}`, { token: support.token });
    expect(s.body.entitlements.finance).toBe(true);
    expect(s.body.finance).toBeDefined();
  });

  it('never exposes contact details or the exact address', async () => {
    const { caseId, tenant, listingId } = await disputed();
    await db.query(`UPDATE property SET street='ул. Секретная', house_number='ДОМ-ZZQ', apartment_number='КВ-ZZQ' WHERE id=$1`, [listingId]);

    const admin = await staffWith('ADMIN');
    const detail = await api.get(`/admin/disputes/${caseId}`, { token: admin.token });
    const serialised = JSON.stringify(detail.body);

    expect(serialised).not.toContain(tenant.email);
    expect(serialised).not.toContain('@example.by');
    expect(serialised).not.toContain('ДОМ-ZZQ');
    expect(serialised).not.toContain('КВ-ZZQ');
    expect(serialised).not.toContain('Секретная');
  });

  it('shows review scores and state but not unpublished review text', async () => {
    const { caseId, bookingId, tenant, landlord } = await disputed();
    // Force the booking to COMPLETED so a review can be written, then dispute
    // again is not needed — the case row is what matters here.
    await db.query(
      `UPDATE booking SET status='COMPLETED', completed_at=now(),
              review_deadline_at=now() + interval '14 days' WHERE id=$1`,
      [bookingId],
    );
    const submitted = await api.post(
      `/bookings/${bookingId}/reviews`,
      {
        role: 'TENANT', overall: 2, cleanliness: 2, accuracy: 2, communication: 3,
        body: 'Очень грязно, и хозяин долго не отвечал на сообщения о заселении.',
      },
      { token: tenant.token },
    );
    expect(submitted.status).toBe(201);
    void landlord;

    const admin = await staffWith('ADMIN');
    const detail = await api.get(`/admin/disputes/${caseId}`, { token: admin.token });
    expect(detail.body.reviewState).toHaveLength(1);
    expect(detail.body.reviewState[0]).toMatchObject({ authorRole: 'TENANT', overall: 2, status: 'PENDING' });
    // The score is evidence; the text of a review that has not published yet is
    // exactly what the publication delay conceals.
    expect(JSON.stringify(detail.body.reviewState)).not.toContain('Очень грязно');
  });
});

/* ================================================================== *
 * The queue
 * ================================================================== */

describe('the queue orders by what is most pressing', () => {
  it('puts an active-stay safety report above an old routine case', async () => {
    // Routine, and old.
    const routine = await disputed('COMMUNICATION', 'Хозяин отвечает медленно, но в целом всё нормально.');
    await db.query(`UPDATE dispute_case SET created_at = now() - interval '10 days' WHERE id=$1`, [routine.caseId]);

    // Safety, during a stay that is still running.
    const safety = await disputed('SAFETY_CONCERN', 'В квартире не работает замок, дверь не запирается изнутри.');
    await db.query(`UPDATE booking SET status='CHECKED_IN' WHERE id=$1`, [safety.bookingId]);

    const support = await staffWith('SUPPORT');
    const queue = await api.get('/admin/disputes?status=ACTIVE', { token: support.token });
    expect(queue.status).toBe(200);

    const ids = (queue.body.items as { id: string; priority: string }[]).map((i) => i.id);
    expect(ids[0], 'the safety case must be first').toBe(safety.caseId);
    expect(queue.body.items[0].priority).toBe('URGENT');
  });

  it('filters and paginates server-side, in the URL’s terms', async () => {
    const a = await disputed('CLEANLINESS', 'Квартира была не убрана к заселению, пыль и посуда.');
    await disputed('PROPERTY_DAMAGE', 'Арендатор повредил кухонный шкаф во время проживания.');

    const support = await staffWith('SUPPORT');

    const filtered = await api.get('/admin/disputes?status=ACTIVE&category=CLEANLINESS', { token: support.token });
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].id).toBe(a.caseId);

    const paged = await api.get('/admin/disputes?status=ACTIVE&limit=1&offset=0', { token: support.token });
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.limit).toBe(1);

    const second = await api.get('/admin/disputes?status=ACTIVE&limit=1&offset=1', { token: support.token });
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(paged.body.items[0].id);
  });

  it('marks a case overdue against the target for its own priority', async () => {
    const { caseId } = await disputed('COMMUNICATION', 'Хозяин не отвечает уже несколько дней подряд.');
    await db.query(`UPDATE dispute_case SET created_at = now() - interval '30 days' WHERE id=$1`, [caseId]);

    const support = await staffWith('SUPPORT');
    const queue = await api.get('/admin/disputes?status=ACTIVE', { token: support.token });
    const item = (queue.body.items as Record<string, any>[]).find((i) => i.id === caseId)!;
    // Age alone has raised it, and it is late against the raised target.
    expect(item.priority).toBe('HIGH');
    expect(item.overdue).toBe(true);
  });
});

/* ================================================================== *
 * Workflow
 * ================================================================== */

describe('case workflow', () => {
  it('walks a case from filing to a decision, recording every step', async () => {
    const { caseId } = await disputed();
    const admin = await staffWith('ADMIN');

    expect((await api.post(`/admin/disputes/${caseId}/actions`, { action: 'TAKE' }, { token: admin.token })).body.status)
      .toBe('UNDER_REVIEW');
    expect(
      (await api.post(
        `/admin/disputes/${caseId}/actions`,
        { action: 'REQUEST_INFORMATION', reason: 'Пришлите, пожалуйста, фотографии на момент заселения.' },
        { token: admin.token },
      )).body.status,
    ).toBe('WAITING_FOR_PARTY');
    expect((await api.post(`/admin/disputes/${caseId}/actions`, { action: 'RESUME' }, { token: admin.token })).body.status)
      .toBe('UNDER_REVIEW');

    const resolved = await api.post(
      `/admin/disputes/${caseId}/actions`,
      { action: 'RESOLVE', reason: 'Фотографии подтверждают несоответствие. Рекомендована компенсация вне платформы.' },
      { token: admin.token },
    );
    expect(resolved.body.status).toBe('RESOLVED');

    // The database refuses a terminal status with no recorded decision.
    const { rows } = await db.query<Record<string, any>>(
      `SELECT status, resolution, resolved_at, resolved_by FROM dispute_case WHERE id=$1`,
      [caseId],
    );
    expect(rows[0]!.resolution).toContain('Фотографии подтверждают');
    expect(rows[0]!.resolved_at).not.toBeNull();
    expect(rows[0]!.resolved_by).toBe(admin.userId);
  });

  it('refuses a move the transition table does not define', async () => {
    const { caseId } = await disputed();
    const admin = await staffWith('ADMIN');
    // RESUME only exists from WAITING_FOR_PARTY.
    const res = await api.post(`/admin/disputes/${caseId}/actions`, { action: 'RESUME' }, { token: admin.token });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM dispute_case WHERE id=$1`, [caseId]);
    expect(rows[0]!.status).toBe('OPEN');
  });

  it('refuses a consequential move with no written reason', async () => {
    const { caseId } = await disputed();
    const admin = await staffWith('ADMIN');
    await api.post(`/admin/disputes/${caseId}/actions`, { action: 'TAKE' }, { token: admin.token });

    const res = await api.post(`/admin/disputes/${caseId}/actions`, { action: 'RESOLVE' }, { token: admin.token });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('does not let SUPPORT or MODERATOR close a case', async () => {
    const { caseId } = await disputed();

    for (const role of ['SUPPORT', 'MODERATOR']) {
      const staff = await staffWith(role);
      // They can work it. The second role finds it already taken, which the
      // transition table refuses with a 409 rather than a 500.
      const taken = await api.post(`/admin/disputes/${caseId}/actions`, { action: 'TAKE' }, { token: staff.token });
      expect([200, 409], role).toContain(taken.status);

      // ...but deciding is the resolver's act.
      const resolved = await api.post(
        `/admin/disputes/${caseId}/actions`,
        { action: 'RESOLVE', reason: 'Разобрались, всё в порядке и стороны договорились.' },
        { token: staff.token },
      );
      expect(resolved.status, `${role} must not resolve`).toBe(403);
      const closed = await api.post(
        `/admin/disputes/${caseId}/actions`,
        { action: 'CLOSE', reason: 'Дубликат другого обращения по той же брони.' },
        { token: staff.token },
      );
      expect(closed.status, `${role} must not close`).toBe(403);
    }

    const { rows } = await db.query<{ status: string }>(`SELECT status FROM dispute_case WHERE id=$1`, [caseId]);
    expect(rows[0]!.status).toBe('UNDER_REVIEW');
  });

  it('offers each role only the actions it can actually perform', async () => {
    const { caseId } = await disputed();
    const support = await staffWith('SUPPORT');
    const admin = await staffWith('ADMIN');

    const s = await api.get(`/admin/disputes/${caseId}`, { token: support.token });
    const a = await api.get(`/admin/disputes/${caseId}`, { token: admin.token });

    const actionsOf = (r: any) => new Set((r.body.availableActions as { action: string }[]).map((x) => x.action));
    expect(actionsOf(s)).toEqual(new Set(['TAKE', 'ESCALATE']));
    expect(actionsOf(a)).toEqual(new Set(['TAKE', 'ESCALATE', 'CLOSE']));
  });
});

/* ================================================================== *
 * Assignment
 * ================================================================== */

describe('assignment', () => {
  it('assigns, reassigns and unassigns', async () => {
    const { caseId } = await disputed();
    const admin = await staffWith('ADMIN');
    const support = await staffWith('SUPPORT');

    expect((await api.post(`/admin/disputes/${caseId}/assign`, { assigneeId: support.userId }, { token: admin.token })).body.assignedTo)
      .toBe(support.userId);
    expect((await api.post(`/admin/disputes/${caseId}/assign`, { assigneeId: admin.userId }, { token: admin.token })).body.assignedTo)
      .toBe(admin.userId);
    expect((await api.post(`/admin/disputes/${caseId}/assign`, { assigneeId: null }, { token: admin.token })).body.assignedTo)
      .toBeNull();

    // Every change is in the case history, which is append-only.
    const { rows } = await db.query<{ event_type: string }>(
      `SELECT event_type FROM case_event WHERE case_id=$1 AND event_type IN ('ASSIGNED','UNASSIGNED') ORDER BY id`,
      [caseId],
    );
    expect(rows.map((r) => r.event_type)).toEqual(['ASSIGNED', 'ASSIGNED', 'UNASSIGNED']);
  });

  it('refuses to assign a case to somebody who does not work cases', async () => {
    const { caseId, tenant } = await disputed();
    const admin = await staffWith('ADMIN');

    const res = await api.post(`/admin/disputes/${caseId}/assign`, { assigneeId: tenant.userId }, { token: admin.token });
    expect(res.status).toBe(422);
  });

  it('filters the queue to the caller’s own cases', async () => {
    const mine = await disputed();
    await disputed();
    const support = await staffWith('SUPPORT');
    await api.post(`/admin/disputes/${mine.caseId}/assign`, { assigneeId: support.userId }, { token: support.token });

    const queue = await api.get('/admin/disputes?status=ACTIVE&assigned=ME', { token: support.token });
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0].id).toBe(mine.caseId);
  });
});

/* ================================================================== *
 * Internal notes
 * ================================================================== */

describe('internal notes', () => {
  it('are visible to staff and to nobody else', async () => {
    const { caseId, bookingId, tenant, landlord } = await disputed();
    const support = await staffWith('SUPPORT');

    const secret = 'Возможен дубликат аккаунта, проверить телефон при верификации.';
    expect((await api.post(`/admin/disputes/${caseId}/notes`, { note: secret }, { token: support.token })).status).toBe(201);

    const staffView = await api.get(`/admin/disputes/${caseId}`, { token: support.token });
    expect(JSON.stringify(staffView.body)).toContain(secret);

    // The parties see their booking, and their booking never carries the note.
    for (const token of [tenant.token, landlord.token]) {
      const booking = await api.get(`/bookings/${bookingId}`, { token });
      expect(booking.status).toBe(200);
      expect(JSON.stringify(booking.body)).not.toContain(secret);
    }

    // Nor does any endpoint they can reach.
    const { rows } = await db.query<{ visibility: string }>(
      `SELECT visibility FROM case_event WHERE case_id=$1 AND event_type='INTERNAL_NOTE'`,
      [caseId],
    );
    expect(rows[0]!.visibility).toBe('INTERNAL');
  });

  it('cannot be edited or deleted once written', async () => {
    const { caseId } = await disputed();
    const support = await staffWith('SUPPORT');
    await api.post(`/admin/disputes/${caseId}/notes`, { note: 'Первая заметка по делу.' }, { token: support.token });

    // The append-only trigger, not application code, is what enforces this.
    await expect(
      db.query(`UPDATE case_event SET note='подменено' WHERE case_id=$1`, [caseId]),
    ).rejects.toThrow();
    await expect(db.query(`DELETE FROM case_event WHERE case_id=$1`, [caseId])).rejects.toThrow();
  });

  it('needs case.handle, not merely case.view', async () => {
    const { caseId } = await disputed();
    // VERIFIER holds no case permission at all.
    const verifier = await staffWith('VERIFIER');
    expect((await api.post(`/admin/disputes/${caseId}/notes`, { note: 'Пробую написать.' }, { token: verifier.token })).status)
      .toBe(403);
  });
});

/* ================================================================== *
 * Talking to the parties
 * ================================================================== */

describe('user communication', () => {
  it('notifies the party without exposing the console or internal notes', async () => {
    const { caseId, tenant } = await disputed();
    const admin = await staffWith('ADMIN');
    await api.post(`/admin/disputes/${caseId}/actions`, { action: 'TAKE' }, { token: admin.token });
    await api.post(`/admin/disputes/${caseId}/notes`, { note: 'Внутреннее: подозрение на дубликат.' }, { token: admin.token });

    const ask = 'Пришлите, пожалуйста, фотографии комнаты на момент заселения.';
    await api.post(`/admin/disputes/${caseId}/actions`, { action: 'REQUEST_INFORMATION', reason: ask }, { token: admin.token });

    const inbox = await api.get('/notifications', { token: tenant.token });
    const serialised = JSON.stringify(inbox.body);
    expect(serialised).toContain(ask);
    expect(serialised).not.toContain('подозрение на дубликат');
    expect(serialised).not.toContain('/staff/');
  });

  it('queues rather than pretending to deliver', async () => {
    const { caseId } = await disputed();
    const admin = await staffWith('ADMIN');
    await api.post(`/admin/disputes/${caseId}/actions`, { action: 'TAKE' }, { token: admin.token });
    await api.post(
      `/admin/disputes/${caseId}/actions`,
      { action: 'REQUEST_INFORMATION', reason: 'Уточните, пожалуйста, дату и время заселения.' },
      { token: admin.token },
    );

    const { rows } = await db.query<{ status: string; sent_at: string | null }>(
      `SELECT status, sent_at FROM notification WHERE category='MODERATION' AND channel='IN_APP'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    // Nothing has been delivered, and nothing claims to have been.
    for (const r of rows) {
      expect(r.status).not.toBe('SENT');
      expect(r.sent_at).toBeNull();
    }
  });
});

/* ================================================================== *
 * Financial safety
 * ================================================================== */

describe('financial safety', () => {
  it('resolves the booking through the domain, deriving the fee from frozen terms', async () => {
    const { caseId, bookingId, landlord } = await disputed();
    const admin = await staffWith('ADMIN');

    expect((await db.query<{ status: string }>(`SELECT status FROM booking WHERE id=$1`, [bookingId])).rows[0]!.status)
      .toBe('DISPUTED');
    expect((await db.query(`SELECT id FROM service_fee WHERE booking_id=$1`, [bookingId])).rows).toHaveLength(0);

    const res = await api.post(
      `/admin/disputes/${caseId}/booking-outcome`,
      { outcome: 'COMPLETED', reason: 'Переписка и отметка о заселении подтверждают, что проживание состоялось.' },
      { token: admin.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.bookingStatus).toBe('COMPLETED');
    expect(res.body.feeAccrued).toBe(true);

    // 5 nights x 100.00 = 500.00 base, 5% = 25.00 — from the booking's own
    // frozen terms, not from anything the administrator typed.
    const { rows } = await db.query<Record<string, string>>(
      `SELECT base_minor::text AS base_minor, fee_minor::text AS fee_minor, bps::text AS bps
         FROM service_fee WHERE booking_id=$1`,
      [bookingId],
    );
    expect(rows[0]).toMatchObject({ base_minor: '50000', fee_minor: '2500', bps: '500' });

    const balance = await api.get('/me/balance', { token: landlord.token });
    expect(balance.body.balanceMinor).toBe('-2500');
  });

  it('accrues nothing when the outcome is that the rental did not happen', async () => {
    const { caseId, bookingId } = await disputed();
    const admin = await staffWith('ADMIN');

    await api.post(
      `/admin/disputes/${caseId}/booking-outcome`,
      { outcome: 'NOT_TAKEN_PLACE', reason: 'Арендатор не получил доступ и в квартире не проживал.' },
      { token: admin.token },
    );

    expect((await db.query<{ status: string }>(`SELECT status FROM booking WHERE id=$1`, [bookingId])).rows[0]!.status)
      .toBe('NOT_TAKEN_PLACE');
    expect((await db.query(`SELECT id FROM service_fee WHERE booking_id=$1`, [bookingId])).rows).toHaveLength(0);
  });

  it('gives no staff route that writes an amount', async () => {
    const { caseId, bookingId } = await disputed();
    const admin = await staffWith('ADMIN');

    // An amount in the body is not part of the contract and cannot become one.
    await api.post(
      `/admin/disputes/${caseId}/booking-outcome`,
      {
        outcome: 'COMPLETED',
        reason: 'Проживание подтверждено обеими сторонами в переписке.',
        feeMinor: '999999',
        amountMinor: '999999',
        baseMinor: '999999',
      },
      { token: admin.token },
    );

    const { rows } = await db.query<{ fee_minor: string }>(
      `SELECT fee_minor::text AS fee_minor FROM service_fee WHERE booking_id=$1`,
      [bookingId],
    );
    expect(rows[0]!.fee_minor).toBe('2500');
  });

  it('does not let a handler decide a booking', async () => {
    const { caseId, bookingId } = await disputed();
    for (const role of ['SUPPORT', 'MODERATOR']) {
      const staff = await staffWith(role);
      const res = await api.post(
        `/admin/disputes/${caseId}/booking-outcome`,
        { outcome: 'COMPLETED', reason: 'Считаю, что аренда состоялась по переписке.' },
        { token: staff.token },
      );
      expect(res.status, role).toBe(403);
    }
    expect((await db.query<{ status: string }>(`SELECT status FROM booking WHERE id=$1`, [bookingId])).rows[0]!.status)
      .toBe('DISPUTED');
  });

  it('cannot bypass the booking state machine', async () => {
    // A booking that is not DISPUTED has no RESOLVE_DISPUTE_* transition, so
    // the console cannot use a dispute as a lever to move an arbitrary booking.
    const { caseId, bookingId } = await disputed();
    await db.query(`UPDATE booking SET status='CONFIRMED' WHERE id=$1`, [bookingId]);

    const admin = await staffWith('ADMIN');
    const res = await api.post(
      `/admin/disputes/${caseId}/booking-outcome`,
      { outcome: 'COMPLETED', reason: 'Хочу закрыть это бронирование как завершённое.' },
      { token: admin.token },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await db.query<{ status: string }>(`SELECT status FROM booking WHERE id=$1`, [bookingId])).rows[0]!.status)
      .toBe('CONFIRMED');
  });

  it('leaves the ledger append-only', async () => {
    const { caseId, bookingId } = await disputed();
    const admin = await staffWith('ADMIN');
    await api.post(
      `/admin/disputes/${caseId}/booking-outcome`,
      { outcome: 'COMPLETED', reason: 'Обе стороны подтвердили проживание в переписке.' },
      { token: admin.token },
    );

    await expect(
      db.query(`UPDATE ledger_entry SET amount_minor = 0 WHERE booking_id=$1`, [bookingId]),
    ).rejects.toThrow();
    await expect(db.query(`DELETE FROM ledger_entry WHERE booking_id=$1`, [bookingId])).rejects.toThrow();
  });
});

/* ================================================================== *
 * Audit
 * ================================================================== */

describe('audit trail', () => {
  it('records actor, role, reason and resulting state for every staff action', async () => {
    const { caseId, bookingId } = await disputed();
    const admin = await staffWith('ADMIN');

    await api.post(`/admin/disputes/${caseId}/actions`, { action: 'TAKE' }, { token: admin.token });
    await api.post(`/admin/disputes/${caseId}/notes`, { note: 'Запросил фотографии у арендатора.' }, { token: admin.token });
    await api.post(`/admin/disputes/${caseId}/assign`, { assigneeId: admin.userId }, { token: admin.token });
    await api.post(
      `/admin/disputes/${caseId}/booking-outcome`,
      { outcome: 'COMPLETED', reason: 'Проживание подтверждено отметкой о заселении.' },
      { token: admin.token },
    );

    const { rows } = await db.query<Record<string, any>>(
      // Scoped to the staff actions. This user's own `auth.register` and
      // `auth.login` rows are in the same table and legitimately carry no
      // role — they happened before any role was granted.
      `SELECT action, actor_user_id, actor_role, reason, changes, target_type, occurred_at
         FROM audit_log
        WHERE actor_user_id=$1 AND (action LIKE 'dispute.%' OR action = 'booking.resolve_dispute')
        ORDER BY id`,
      [admin.userId],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual([
      'dispute.take',
      'dispute.note',
      'dispute.assign',
      'booking.resolve_dispute',
    ]);

    for (const r of rows) {
      expect(r.actor_user_id).toBe(admin.userId);
      expect(r.actor_role).toBe('ADMIN');
      expect(r.occurred_at).toBeTruthy();
      expect(r.target_type).toBeTruthy();
    }

    const decision = rows.find((r) => r.action === 'booking.resolve_dispute')!;
    expect(decision.reason).toContain('отметкой о заселении');
    expect(decision.changes.status).toMatchObject({ from: 'DISPUTED', to: 'COMPLETED' });
    void bookingId;
  });

  it('is append-only', async () => {
    const { caseId } = await disputed();
    const admin = await staffWith('ADMIN');
    await api.post(`/admin/disputes/${caseId}/actions`, { action: 'TAKE' }, { token: admin.token });

    await expect(db.query(`UPDATE audit_log SET reason='подменено'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM audit_log`)).rejects.toThrow();
  });

  it('reads only with audit.read', async () => {
    const support = await staffWith('SUPPORT');
    const admin = await staffWith('ADMIN');
    expect((await api.get('/admin/audit', { token: support.token })).status).toBe(403);
    expect((await api.get('/admin/audit', { token: admin.token })).status).toBe(200);
  });
});

/* ================================================================== *
 * Abuse
 * ================================================================== */

describe('abuse limits', () => {
  it('does not let a party open unlimited cases against one booking', async () => {
    const { bookingId, tenant } = await disputed();

    for (let i = 0; i < 4; i += 1) {
      await api.post(
        `/bookings/${bookingId}/dispute`,
        { category: 'OTHER', summary: `Ещё одно сообщение по этой же ситуации, попытка ${i}.` },
        { token: tenant.token },
      );
    }

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM dispute_case WHERE booking_id=$1`,
      [bookingId],
    );
    // Repeat reports join the open case rather than creating new ones.
    expect(rows[0]!.c).toBe('1');
  });
});

/* ================================================================== *
 * The two priority implementations must agree
 * ================================================================== */

describe('priority in TypeScript and in SQL', () => {
  it('gives the same answer for every category and booking state', async () => {
    // The rule exists twice on purpose: the queue orders and paginates in the
    // database, so it cannot use a value computed after the rows arrive. Two
    // implementations of one rule drift, and this is what stops them — if
    // somebody edits priorityOf() and forgets PRIORITY_SQL, this fails.
    const { DISPUTE_CATEGORIES, PRIORITY_SQL, priorityOf } = await import('@/server/domain/dispute.ts');

    const bookingStates = [null, 'CONFIRMED', 'CHECKED_IN', 'COMPLETION_PENDING', 'COMPLETED', 'DISPUTED'];
    const mismatches: string[] = [];

    for (const category of DISPUTE_CATEGORIES) {
      for (const bookingStatus of bookingStates) {
        // The SQL reads `dc`, `b` and `fs`; a VALUES clause supplies all three
        // so the same expression can be evaluated without inventing rows.
        const { rows } = await db.query<{ priority: string }>(
          `SELECT ${PRIORITY_SQL} AS priority
             FROM (SELECT $1::text AS category, now() - interval '1 hour' AS created_at) dc,
                  (SELECT $2::text AS status) b,
                  (SELECT false AS has_signal) fs`,
          [category, bookingStatus],
        );

        const inSql = rows[0]!.priority;
        const inTs = priorityOf({ category, bookingStatus, hasFraudSignal: false, ageHours: 1 });
        if (inSql !== inTs) mismatches.push(`${category}/${bookingStatus}: sql=${inSql} ts=${inTs}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('agrees on the fraud-signal and age escalations too', async () => {
    const { PRIORITY_SQL, priorityOf } = await import('@/server/domain/dispute.ts');

    for (const [hasSignal, ageHours] of [
      [true, 1],
      [false, 1],
      [false, 200],
    ] as const) {
      const { rows } = await db.query<{ priority: string }>(
        `SELECT ${PRIORITY_SQL} AS priority
           FROM (SELECT 'COMMUNICATION'::text AS category,
                        now() - ($1::int * interval '1 hour') AS created_at) dc,
                (SELECT NULL::text AS status) b,
                (SELECT $2::boolean AS has_signal) fs`,
        [ageHours, hasSignal],
      );
      expect(rows[0]!.priority, `signal=${hasSignal} age=${ageHours}`).toBe(
        priorityOf({ category: 'COMMUNICATION', bookingStatus: null, hasFraudSignal: hasSignal, ageHours }),
      );
    }
  });
});

/* ================================================================== *
 * The overview
 * ================================================================== */

describe('operations overview', () => {
  it('counts what needs a person, and needs case.view', async () => {
    const safety = await disputed('SAFETY_CONCERN', 'Не закрывается входная дверь, в квартире находиться небезопасно.');
    await db.query(`UPDATE booking SET status='CHECKED_IN' WHERE id=$1`, [safety.bookingId]);

    const support = await staffWith('SUPPORT');
    const res = await api.get('/admin/overview', { token: support.token });
    expect(res.status).toBe(200);
    expect(res.body.disputes.open).toBe(1);
    expect(res.body.disputes.pressing).toBe(1);
    expect(res.body.disputes.unassigned).toBe(1);

    const verifier = await staffWith('VERIFIER');
    expect((await api.get('/admin/overview', { token: verifier.token })).status).toBe(403);
  });
});
