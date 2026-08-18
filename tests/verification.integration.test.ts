/**
 * Verification, end to end over the real dispatcher.
 *
 * The slice's central invariant is that a trust badge is never granted on
 * nothing, so most of this file is about approvals that must NOT happen — and
 * about the one rule that has to hold whatever else changes: identity documents
 * are reachable by VERIFIER and by nobody else, including ADMIN.
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
      ('verification.identity_documents', false,
       'Identity document collection. Requires LEGAL-004.', true)
    ON CONFLICT (key) DO UPDATE SET enabled = false;
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

async function staffWith(role: string) {
  const user = await api.signUp();
  await api.grantRole(user.userId, role);
  return user;
}

/** Turn document collection on, as answering LEGAL-004 would. */
async function enableCollection() {
  await db.query(`UPDATE feature_flag SET enabled = true WHERE key='verification.identity_documents'`);
}

/** Attach evidence directly: the upload path is closed by design (see below). */
async function attachEvidence(requestId: string, types: string[]) {
  for (const docType of types) {
    await db.query(
      `INSERT INTO verification_document (id, request_id, doc_type, storage_key)
       VALUES ($1,$2,$3,$4)`,
      [crypto.randomUUID(), requestId, docType, `private/verification/${requestId}/${crypto.randomUUID()}`],
    );
  }
}

async function submitIdentity(token: string) {
  const res = await api.post('/me/verification', { targetLevel: 1 }, { token });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function publishedListingFor(token: string) {
  const created = await api.post('/listings', LISTING, { token });
  const listingId = created.body.id as string;
  await api.post(`/listings/${listingId}/photos`, { storageKey: `listings/${listingId}/a.jpg` }, { token });
  await api.post(`/listings/${listingId}/submit`, {}, { token });
  const moderator = await staffWith('MODERATOR');
  await api.post(`/admin/moderation/listings/${listingId}`, { decision: 'PUBLISHED' }, { token: moderator.token });
  return listingId;
}

/* ================================================================== *
 * Submission — the half that did not exist
 * ================================================================== */

describe('submission', () => {
  it('creates a request a verifier can actually see', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);

    const verifier = await staffWith('VERIFIER');
    const queue = await api.get('/admin/verification/requests?status=ACTIVE', { token: verifier.token });
    expect(queue.status).toBe(200);
    expect((queue.body.items as { id: string }[]).map((i) => i.id)).toContain(id);
  });

  it('refuses a second live request for the same thing', async () => {
    const applicant = await api.signUp();
    const first = await submitIdentity(applicant.token);

    // A double-tapped button returns the request that already exists rather
    // than making a second one for a verifier to duplicate work on.
    const again = await api.post('/me/verification', { targetLevel: 1 }, { token: applicant.token });
    expect(again.body.id).toBe(first);

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM verification_request WHERE user_id=$1`,
      [applicant.userId],
    );
    expect(rows[0]!.c).toBe('1');
  });

  it('refuses level 2 before level 1', async () => {
    const applicant = await api.signUp();
    const listingId = await publishedListingFor(applicant.token);

    const res = await api.post(
      '/me/verification',
      { targetLevel: 2, propertyId: listingId, ownershipBasis: 'SOLE_OWNER' },
      { token: applicant.token },
    );
    expect(res.status).toBe(409);
    // Checking a right to let a flat is meaningless without knowing who claims it.
    expect(JSON.stringify(res.body)).toContain('личность');
  });

  it('refuses a level 2 request about somebody else’s listing, with 404', async () => {
    const owner = await api.signUp();
    const listingId = await publishedListingFor(owner.token);

    const other = await api.signUp();
    await db.query(`UPDATE app_user SET verification_level=1 WHERE id=$1`, [other.userId]);

    const res = await api.post(
      '/me/verification',
      { targetLevel: 2, propertyId: listingId, ownershipBasis: 'SOLE_OWNER' },
      { token: other.token },
    );
    expect(res.status).toBe(404);
  });

  it('refuses an identity request from somebody already verified', async () => {
    const applicant = await api.signUp();
    await db.query(`UPDATE app_user SET verification_level=1 WHERE id=$1`, [applicant.userId]);
    const res = await api.post('/me/verification', { targetLevel: 1 }, { token: applicant.token });
    expect(res.status).toBe(409);
  });

  it('refuses an anonymous caller', async () => {
    expect((await api.post('/me/verification', { targetLevel: 1 })).status).toBe(401);
    expect((await api.get('/me/verification')).status).toBe(401);
  });
});

/* ================================================================== *
 * Document collection fails closed, twice over
 * ================================================================== */

describe('document collection', () => {
  it('is refused while the legal flag is off', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);

    const res = await api.post(`/me/verification/${id}/documents`, { docType: 'PASSPORT' }, {
      token: applicant.token,
    });
    expect(res.status).toBe(409);
    expect(res.errorCode).toBe('FEATURE_DISABLED');

    const { rows } = await db.query(`SELECT id FROM verification_document WHERE request_id=$1`, [id]);
    expect(rows).toHaveLength(0);
  });

  it('is still refused with the flag on but no private storage configured', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);

    // The two dependencies fail closed independently: answering LEGAL-004 does
    // not by itself start collecting documents onto a disk that does not exist.
    const res = await api.post(`/me/verification/${id}/documents`, { docType: 'PASSPORT' }, {
      token: applicant.token,
    });
    expect(res.status).toBe(501);
    expect(res.errorCode).toBe('NOT_IMPLEMENTED');
  });

  it('refuses attaching to somebody else’s request', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    const stranger = await api.signUp();

    const res = await api.post(`/me/verification/${id}/documents`, { docType: 'PASSPORT' }, {
      token: stranger.token,
    });
    expect(res.status).toBe(404);
  });

  it('keeps every document row inside the private namespace', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);

    // The database refuses a key the public media route would serve, so a
    // document cannot exist outside the namespace that route declines.
    await expect(
      db.query(
        `INSERT INTO verification_document (id, request_id, doc_type, storage_key)
         VALUES ($1,$2,'PASSPORT','listings/oops.jpg')`,
        [crypto.randomUUID(), id],
      ),
    ).rejects.toThrow();
  });
});

/* ================================================================== *
 * A badge is never granted on nothing
 * ================================================================== */

describe('approval requires evidence', () => {
  it('refuses approval while document collection is disabled', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    const verifier = await staffWith('VERIFIER');

    await api.post(`/admin/verification/requests/${id}/actions`, { action: 'TAKE' }, { token: verifier.token });
    const res = await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'APPROVE' },
      { token: verifier.token },
    );
    expect(res.status).toBe(409);
    expect(res.errorCode).toBe('CONFLICT');

    // And the level is untouched: this is the whole point of the slice.
    const { rows } = await db.query<{ verification_level: number }>(
      `SELECT verification_level FROM app_user WHERE id=$1`,
      [applicant.userId],
    );
    expect(Number(rows[0]!.verification_level)).toBe(0);
  });

  it('refuses approval with the flag on but no documents attached', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    const verifier = await staffWith('VERIFIER');

    await api.post(`/admin/verification/requests/${id}/actions`, { action: 'TAKE' }, { token: verifier.token });
    const res = await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'APPROVE' },
      { token: verifier.token },
    );
    expect(res.status).toBe(409);

    const { rows } = await db.query<{ verification_level: number }>(
      `SELECT verification_level FROM app_user WHERE id=$1`,
      [applicant.userId],
    );
    expect(Number(rows[0]!.verification_level)).toBe(0);
  });

  it('refuses approval with a document but no selfie', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await attachEvidence(id, ['PASSPORT']);
    const verifier = await staffWith('VERIFIER');

    await api.post(`/admin/verification/requests/${id}/actions`, { action: 'TAKE' }, { token: verifier.token });
    const res = await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'APPROVE' },
      { token: verifier.token },
    );
    expect(res.status).toBe(409);
  });

  it('grants the level once the evidence is genuinely there', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await attachEvidence(id, ['PASSPORT', 'SELFIE']);
    const verifier = await staffWith('VERIFIER');

    await api.post(`/admin/verification/requests/${id}/actions`, { action: 'TAKE' }, { token: verifier.token });
    const res = await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'APPROVE', internalNote: 'Документ читается, селфи совпадает.' },
      { token: verifier.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');

    const { rows } = await db.query<{ verification_level: number }>(
      `SELECT verification_level FROM app_user WHERE id=$1`,
      [applicant.userId],
    );
    expect(Number(rows[0]!.verification_level)).toBe(1);
  });

  it('reaches level 2 only through a property request by somebody who holds level 1', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const listingId = await publishedListingFor(applicant.token);
    await db.query(`UPDATE app_user SET verification_level=1 WHERE id=$1`, [applicant.userId]);

    const submitted = await api.post(
      '/me/verification',
      { targetLevel: 2, propertyId: listingId, ownershipBasis: 'SOLE_OWNER' },
      { token: applicant.token },
    );
    const id = submitted.body.id as string;
    await attachEvidence(id, ['PASSPORT', 'SELFIE', 'OWNERSHIP_CERTIFICATE']);

    const verifier = await staffWith('VERIFIER');
    await api.post(`/admin/verification/requests/${id}/actions`, { action: 'TAKE' }, { token: verifier.token });
    const decided = await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'APPROVE' },
      { token: verifier.token },
    );
    expect(decided.status).toBe(200);

    const user = await db.query<{ verification_level: number }>(
      `SELECT verification_level FROM app_user WHERE id=$1`,
      [applicant.userId],
    );
    expect(Number(user.rows[0]!.verification_level)).toBe(2);

    const property = await db.query<{ property_verified_at: string | null }>(
      `SELECT property_verified_at FROM property WHERE id=$1`,
      [listingId],
    );
    expect(property.rows[0]!.property_verified_at).not.toBeNull();
  });

  it('never lowers a level somebody already holds', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    await db.query(`UPDATE app_user SET verification_level=2 WHERE id=$1`, [applicant.userId]);

    // A stale level-1 request approved later must not demote them.
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO verification_request (id, user_id, kind, target_level, status)
       VALUES ($1,$2,'IDENTITY',1,'IN_REVIEW')`,
      [id, applicant.userId],
    );
    await attachEvidence(id, ['PASSPORT', 'SELFIE']);

    const verifier = await staffWith('VERIFIER');
    await api.post(`/admin/verification/requests/${id}/actions`, { action: 'APPROVE' }, { token: verifier.token });

    const { rows } = await db.query<{ verification_level: number }>(
      `SELECT verification_level FROM app_user WHERE id=$1`,
      [applicant.userId],
    );
    expect(Number(rows[0]!.verification_level)).toBe(2);
  });
});

/* ================================================================== *
 * Identity documents — the rule that must not bend
 * ================================================================== */

describe('identity documents stay VERIFIER-only', () => {
  it('is refused to MODERATOR, SUPPORT, FINANCE and ADMIN', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await attachEvidence(id, ['PASSPORT']);

    const { rows } = await db.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM verification_document WHERE request_id=$1`,
      [id],
    );
    const documentId = rows[0]!.id;
    const key = rows[0]!.storage_key;

    for (const role of ['MODERATOR', 'SUPPORT', 'FINANCE', 'ADMIN']) {
      const staff = await staffWith(role);
      const opened = await api.get(`/admin/verification/documents/${documentId}?purpose=проверка`, {
        token: staff.token,
      });
      expect(opened.status, `${role} must not open a document`).toBe(403);

      // And no key leaks through the case file either.
      const detail = await api.get(`/admin/verification/requests/${id}`, { token: staff.token });
      if (detail.status === 200) {
        expect(JSON.stringify(detail.body), role).not.toContain(key);
        expect(detail.body.entitlements.openDocuments, role).toBe(false);
      }
    }
  });

  it('is refused to the applicant themselves', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await attachEvidence(id, ['PASSPORT']);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM verification_document WHERE request_id=$1`,
      [id],
    );
    const res = await api.get(`/admin/verification/documents/${rows[0]!.id}?purpose=моё`, {
      token: applicant.token,
    });
    expect(res.status).toBe(403);
  });

  it('lets VERIFIER open one, demands a purpose, and logs it', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await attachEvidence(id, ['PASSPORT']);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM verification_document WHERE request_id=$1`,
      [id],
    );
    const documentId = rows[0]!.id;
    const verifier = await staffWith('VERIFIER');

    expect((await api.get(`/admin/verification/documents/${documentId}`, { token: verifier.token })).status).toBe(422);

    const opened = await api.get(
      `/admin/verification/documents/${documentId}?purpose=${encodeURIComponent('сверка с заявкой')}`,
      { token: verifier.token },
    );
    expect(opened.status).toBe(200);

    const log = await db.query<{ actor_user_id: string; purpose: string }>(
      `SELECT actor_user_id, purpose FROM document_access_log WHERE document_id=$1`,
      [documentId],
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]!.actor_user_id).toBe(verifier.userId);
    expect(log.rows[0]!.purpose).toContain('сверка');

    // The log is append-only: an access cannot be edited away afterwards.
    await expect(db.query(`UPDATE document_access_log SET purpose='x'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM document_access_log`)).rejects.toThrow();
  });

  it('is refused even to VERIFIER while the legal flag is off', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await attachEvidence(id, ['PASSPORT']);
    const { rows } = await db.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM verification_document WHERE request_id=$1`,
      [id],
    );
    const verifier = await staffWith('VERIFIER');

    const res = await api.get(`/admin/verification/documents/${rows[0]!.id}?purpose=проверка`, {
      token: verifier.token,
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain(rows[0]!.storage_key);
  });

  it('never returns a storage key from the queue or the case file', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await attachEvidence(id, ['PASSPORT', 'SELFIE']);
    const { rows } = await db.query<{ storage_key: string }>(
      `SELECT storage_key FROM verification_document WHERE request_id=$1`,
      [id],
    );
    const verifier = await staffWith('VERIFIER');

    const queue = await api.get('/admin/verification/requests?status=ACTIVE', { token: verifier.token });
    const detail = await api.get(`/admin/verification/requests/${id}`, { token: verifier.token });

    for (const key of rows.map((r) => r.storage_key)) {
      expect(JSON.stringify(queue.body)).not.toContain(key);
      expect(JSON.stringify(detail.body)).not.toContain(key);
    }
    // The count is there; the key is not.
    expect(detail.body.documents).toHaveLength(2);
  });
});

/* ================================================================== *
 * ADMIN cannot grant what it cannot examine
 * ================================================================== */

describe('deciding requires having been able to look', () => {
  it('refuses ADMIN an approval, and offers it no approve action', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await attachEvidence(id, ['PASSPORT', 'SELFIE']);
    const admin = await staffWith('ADMIN');

    await api.post(`/admin/verification/requests/${id}/actions`, { action: 'TAKE' }, { token: admin.token });

    const detail = await api.get(`/admin/verification/requests/${id}`, { token: admin.token });
    const actions = (detail.body.availableActions as { action: string }[]).map((a) => a.action);
    expect(actions).not.toContain('APPROVE');

    const res = await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'APPROVE' },
      { token: admin.token },
    );
    // 403 and not 500: a correct refusal is not a server fault, and reporting
    // it as one puts a line in the error log every time.
    expect(res.status).toBe(403);
    expect(res.errorCode).toBe('FORBIDDEN');

    const { rows } = await db.query<{ verification_level: number }>(
      `SELECT verification_level FROM app_user WHERE id=$1`,
      [applicant.userId],
    );
    expect(Number(rows[0]!.verification_level)).toBe(0);
  });

  it('still lets ADMIN refuse — you need not look to say "incomplete"', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    const admin = await staffWith('ADMIN');

    const res = await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'REJECT', reasonCodes: ['DOCUMENT_MISSING'], applicantMessage: 'Документов нет.' },
      { token: admin.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');
  });

  it('holds through the legacy decide endpoint too', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await attachEvidence(id, ['PASSPORT', 'SELFIE']);
    const admin = await staffWith('ADMIN');

    // The older /decide route now delegates to the same domain rules, so it is
    // not a way around them.
    const res = await api.post(
      `/admin/verification/${id}/decide`,
      { decision: 'APPROVED', note: 'выглядит нормально' },
      { token: admin.token },
    );
    expect(res.status).toBe(403);

    const { rows } = await db.query<{ verification_level: number }>(
      `SELECT verification_level FROM app_user WHERE id=$1`,
      [applicant.userId],
    );
    expect(Number(rows[0]!.verification_level)).toBe(0);
  });

  it('lets VERIFIER approve through the legacy endpoint', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await attachEvidence(id, ['PASSPORT', 'SELFIE']);
    const verifier = await staffWith('VERIFIER');

    const res = await api.post(
      `/admin/verification/${id}/decide`,
      { decision: 'APPROVED', note: 'документ читается' },
      { token: verifier.token },
    );
    expect(res.status).toBe(200);

    const { rows } = await db.query<{ verification_level: number }>(
      `SELECT verification_level FROM app_user WHERE id=$1`,
      [applicant.userId],
    );
    expect(Number(rows[0]!.verification_level)).toBe(1);
  });
});

/* ================================================================== *
 * Rejection, resubmission and what the applicant is told
 * ================================================================== */

describe('rejection and resubmission', () => {
  it('refuses an empty rejection', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    const verifier = await staffWith('VERIFIER');

    const res = await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'REJECT' },
      { token: verifier.token },
    );
    expect(res.status).toBe(422);

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM verification_request WHERE id=$1`,
      [id],
    );
    expect(rows[0]!.status).toBe('SUBMITTED');
  });

  it('tells the applicant what to fix and never the internal note', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    const verifier = await staffWith('VERIFIER');

    const secret = 'Третья попытка с того же устройства, фото похоже на монтаж.';
    await api.post(
      `/admin/verification/requests/${id}/actions`,
      {
        action: 'REJECT',
        reasonCodes: ['IDENTITY_DOCUMENT_UNREADABLE'],
        internalNote: secret,
        applicantMessage: 'Сфотографируйте документ при дневном свете.',
      },
      { token: verifier.token },
    );

    const mine = await api.get('/me/verification', { token: applicant.token });
    const serialised = JSON.stringify(mine.body);
    expect(serialised).toContain('IDENTITY_DOCUMENT_UNREADABLE');
    expect(serialised).toContain('дневном свете');
    expect(serialised).not.toContain('монтаж');
    expect(serialised).not.toContain('устройства');

    const timeline = await api.get(`/me/verification/${id}/timeline`, { token: applicant.token });
    expect(JSON.stringify(timeline.body)).not.toContain('монтаж');
  });

  it('keeps a refused request and creates a new one on resubmission', async () => {
    const applicant = await api.signUp();
    const first = await submitIdentity(applicant.token);
    const verifier = await staffWith('VERIFIER');
    await api.post(
      `/admin/verification/requests/${first}/actions`,
      { action: 'REJECT', reasonCodes: ['DOCUMENT_EXPIRED'], applicantMessage: 'Документ просрочен.' },
      { token: verifier.token },
    );

    const again = await api.post(
      '/me/verification',
      { targetLevel: 1, supersedesId: first },
      { token: applicant.token },
    );
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(first);

    // The refusal survives — a pattern of attempts has to stay visible.
    const { rows } = await db.query<{ id: string; status: string; supersedes_id: string | null }>(
      `SELECT id, status, supersedes_id FROM verification_request WHERE user_id=$1 ORDER BY created_at`,
      [applicant.userId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe('REJECTED');
    expect(rows[1]!.supersedes_id).toBe(first);
  });

  it('refuses to supersede somebody else’s request, or one still under review', async () => {
    const applicant = await api.signUp();
    const mine = await submitIdentity(applicant.token);
    const other = await api.signUp();

    const stranger = await api.post(
      '/me/verification',
      { targetLevel: 1, supersedesId: mine },
      { token: other.token },
    );
    expect(stranger.status).toBe(404);

    // Still SUBMITTED, so not yet superseded by its own owner either.
    const early = await api.post(
      '/me/verification',
      { targetLevel: 1, supersedesId: mine },
      { token: applicant.token },
    );
    expect(early.status).toBe(409);
  });

  it('reopens the queue after NEEDS_INFO without a duplicate', async () => {
    const applicant = await api.signUp();
    const first = await submitIdentity(applicant.token);
    const verifier = await staffWith('VERIFIER');

    await api.post(`/admin/verification/requests/${first}/actions`, { action: 'TAKE' }, { token: verifier.token });
    await api.post(
      `/admin/verification/requests/${first}/actions`,
      { action: 'REQUEST_INFO', reasonCodes: ['DOCUMENT_MISSING'], applicantMessage: 'Приложите селфи.' },
      { token: verifier.token },
    );

    const again = await api.post(
      '/me/verification',
      { targetLevel: 1, supersedesId: first },
      { token: applicant.token },
    );
    expect(again.status).toBe(201);

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM verification_request
        WHERE user_id=$1 AND status IN ('SUBMITTED','IN_REVIEW','NEEDS_INFO')`,
      [applicant.userId],
    );
    expect(rows[0]!.c).toBe('1');
  });

  it('records a decision with its author, and the database insists', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    const verifier = await staffWith('VERIFIER');
    await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'REJECT', reasonCodes: ['OTHER'], applicantMessage: 'Не подходит.' },
      { token: verifier.token },
    );

    const { rows } = await db.query<Record<string, any>>(
      `SELECT decided_by, decided_at, reason_codes FROM verification_request WHERE id=$1`,
      [id],
    );
    expect(rows[0]!.decided_by).toBe(verifier.userId);
    expect(rows[0]!.decided_at).not.toBeNull();

    // A rejection with no reason code cannot be written at all.
    await expect(
      db.query(
        `INSERT INTO verification_request (id, user_id, kind, target_level, status, decided_by, decided_at)
         VALUES ($1,$2,'IDENTITY',1,'REJECTED',$2, now())`,
        [crypto.randomUUID(), applicant.userId],
      ),
    ).rejects.toThrow();
  });
});

/* ================================================================== *
 * Privacy and enumeration
 * ================================================================== */

describe('privacy', () => {
  it('keeps the console away from ordinary accounts, and cases unguessable', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    const stranger = await api.signUp();

    for (const [who, token] of [
      ['applicant', applicant.token],
      ['stranger', stranger.token],
    ] as const) {
      expect((await api.get('/admin/verification/requests', { token })).status, who).toBe(403);
      expect((await api.get(`/admin/verification/requests/${id}`, { token })).status, who).toBe(403);
    }

    // A real id and an invented one answer identically.
    const real = await api.get(`/admin/verification/requests/${id}`, { token: stranger.token });
    const fake = await api.get('/admin/verification/requests/00000000-0000-4000-8000-000000000000', {
      token: stranger.token,
    });
    expect(real.status).toBe(fake.status);
  });

  it('answers a malformed id the same way as a missing one', async () => {
    const verifier = await staffWith('VERIFIER');
    const malformed = await api.get('/admin/verification/requests/not-a-uuid', { token: verifier.token });
    const missing = await api.get('/admin/verification/requests/00000000-0000-4000-8000-000000000000', {
      token: verifier.token,
    });
    expect(malformed.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it('shows an applicant only their own requests', async () => {
    const a = await api.signUp();
    const idA = await submitIdentity(a.token);
    const b = await api.signUp();
    await submitIdentity(b.token);

    const mine = await api.get('/me/verification', { token: b.token });
    expect(JSON.stringify(mine.body)).not.toContain(idA);
    expect((await api.get(`/me/verification/${idA}/timeline`, { token: b.token })).status).toBe(404);
  });

  it('keeps fraud signals and the applicant’s contacts out of what they can see', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await db.query(`INSERT INTO fraud_signal (user_id, kind, severity) VALUES ($1,'DEVICE_REUSE',3)`, [
      applicant.userId,
    ]);
    const verifier = await staffWith('VERIFIER');

    const detail = await api.get(`/admin/verification/requests/${id}`, { token: verifier.token });
    // Staff see the signal…
    expect(JSON.stringify(detail.body)).toContain('DEVICE_REUSE');
    // …and it never appears on the applicant's own view.
    const mine = await api.get('/me/verification', { token: applicant.token });
    expect(JSON.stringify(mine.body)).not.toContain('DEVICE_REUSE');
  });

  it('keeps the public profile free of verification internals', async () => {
    await enableCollection();
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    await attachEvidence(id, ['PASSPORT', 'SELFIE']);
    const verifier = await staffWith('VERIFIER');
    await api.post(`/admin/verification/requests/${id}/actions`, { action: 'TAKE' }, { token: verifier.token });
    await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'APPROVE', internalNote: 'Совпало с базой.' },
      { token: verifier.token },
    );

    const profile = await api.get(`/profiles/${applicant.userId}`);
    const serialised = JSON.stringify(profile.body);
    expect(profile.body.verificationLevel).toBe(1);
    expect(profile.body.identityVerified).toBe(true);
    expect(serialised).not.toContain('Совпало');
    expect(serialised).not.toContain('PASSPORT');
    expect(serialised).not.toContain('private/');
    expect(serialised).not.toContain(id);
  });
});

/* ================================================================== *
 * Queue behaviour
 * ================================================================== */

describe('the queue', () => {
  it('puts somebody with a live listing above somebody without one', async () => {
    const quiet = await api.signUp();
    const quietId = await submitIdentity(quiet.token);

    const active = await api.signUp();
    await publishedListingFor(active.token);
    const activeId = await submitIdentity(active.token);

    const verifier = await staffWith('VERIFIER');
    const queue = await api.get('/admin/verification/requests?status=ACTIVE', { token: verifier.token });
    const ids = (queue.body.items as { id: string }[]).map((i) => i.id);
    expect(ids[0]).toBe(activeId);
    expect(ids).toContain(quietId);
  });

  it('filters and paginates server-side', async () => {
    const a = await api.signUp();
    await submitIdentity(a.token);
    const b = await api.signUp();
    await submitIdentity(b.token);

    const verifier = await staffWith('VERIFIER');
    const page1 = await api.get('/admin/verification/requests?status=ACTIVE&limit=1&offset=0', {
      token: verifier.token,
    });
    const page2 = await api.get('/admin/verification/requests?status=ACTIVE&limit=1&offset=1', {
      token: verifier.token,
    });
    expect(page1.body.items).toHaveLength(1);
    expect(page2.body.items).toHaveLength(1);
    expect(page1.body.items[0].id).not.toBe(page2.body.items[0].id);

    const byLevel = await api.get('/admin/verification/requests?status=ACTIVE&level=2', {
      token: verifier.token,
    });
    expect(byLevel.body.items).toHaveLength(0);
  });

  it('assigns only to somebody who can review', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    const verifier = await staffWith('VERIFIER');
    const moderator = await staffWith('MODERATOR');

    const wrong = await api.post(
      `/admin/verification/requests/${id}/assign`,
      { assigneeId: moderator.userId },
      { token: verifier.token },
    );
    expect(wrong.status).toBe(422);

    const right = await api.post(
      `/admin/verification/requests/${id}/assign`,
      { assigneeId: verifier.userId },
      { token: verifier.token },
    );
    expect(right.body.assignedTo).toBe(verifier.userId);

    const mine = await api.get('/admin/verification/requests?status=ACTIVE&assigned=ME', {
      token: verifier.token,
    });
    expect((mine.body.items as { id: string }[]).map((i) => i.id)).toEqual([id]);
  });
});

/* ================================================================== *
 * Audit and notifications
 * ================================================================== */

describe('audit and notifications', () => {
  it('records every staff act with actor, role and reason', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    const verifier = await staffWith('VERIFIER');

    await api.post(`/admin/verification/requests/${id}/actions`, { action: 'TAKE' }, { token: verifier.token });
    await api.post(
      `/admin/verification/requests/${id}/assign`,
      { assigneeId: verifier.userId },
      { token: verifier.token },
    );
    await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'REJECT', reasonCodes: ['DOCUMENT_MISSING'], internalNote: 'Ничего не приложено.' },
      { token: verifier.token },
    );

    const { rows } = await db.query<Record<string, any>>(
      `SELECT action, actor_user_id, actor_role, reason FROM audit_log
        WHERE actor_user_id=$1 AND action LIKE 'verification.%' ORDER BY id`,
      [verifier.userId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'verification.take',
      'verification.assign',
      'verification.reject',
    ]);
    for (const r of rows) expect(r.actor_role).toBe('VERIFIER');
    expect(rows[2]!.reason).toContain('Ничего не приложено');

    // The applicant's own submission is audited too.
    const submitted = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM audit_log WHERE action='verification.submit' AND actor_user_id=$1`,
      [applicant.userId],
    );
    expect(submitted.rows[0]!.c).toBe('1');
  });

  it('keeps the request history append-only', async () => {
    const applicant = await api.signUp();
    const id = await submitIdentity(applicant.token);
    const verifier = await staffWith('VERIFIER');
    await api.post(`/admin/verification/requests/${id}/actions`, { action: 'TAKE' }, { token: verifier.token });

    await expect(db.query(`UPDATE verification_event SET note='подменено'`)).rejects.toThrow();
    await expect(db.query(`DELETE FROM verification_event`)).rejects.toThrow();
  });

  it('queues notifications without pretending to deliver them', async () => {
    const applicant = await api.signUp();
    const verifier = await staffWith('VERIFIER');
    const id = await submitIdentity(applicant.token);

    await api.post(
      `/admin/verification/requests/${id}/actions`,
      { action: 'REJECT', reasonCodes: ['DOCUMENT_MISSING'], applicantMessage: 'Приложите документ.' },
      { token: verifier.token },
    );

    const inbox = await api.get('/notifications', { token: applicant.token });
    const serialised = JSON.stringify(inbox.body);
    expect(serialised).toContain('DOCUMENT_MISSING');
    expect(serialised).toContain('Приложите документ');

    const { rows } = await db.query<{ status: string; sent_at: string | null }>(
      `SELECT status, sent_at FROM notification WHERE category='VERIFICATION'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.status).not.toBe('SENT');
      expect(r.sent_at).toBeNull();
    }
  });
});
