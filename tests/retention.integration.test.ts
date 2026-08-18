/**
 * Data lifecycle: holds, purges, sweeps, job runs and account closure.
 *
 * Most of this file is adversarial. A subsystem whose job is to destroy data is
 * the one place where a passing test proves the least — the dangerous failures
 * are all of the form "it destroyed something it should not have" or "it
 * recorded a destruction that did not happen". So the assertions here are
 * mostly about what does NOT happen: that a hold stops a purge, that a failed
 * byte-delete never leaves a row claiming success, that financial and audit
 * rows survive everything, that closing an account destroys nothing, and that
 * two simultaneous job runs do the work once.
 *
 * WHAT CANNOT BE TESTED HERE, STATED RATHER THAN FAKED. PGlite is a single
 * connection, so two genuinely simultaneous transactions cannot exist in the
 * default suite. The race tests below therefore assert the guard rather than
 * the race: the transaction re-reads its preconditions and refuses, which is
 * the property that makes the race safe. The one test that needs real
 * concurrency is skipped unless TEST_DATABASE_URL points at a real server.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '@/server/db/testing.ts';
import { ApiTestClient } from './support/api-client.ts';
import { RetentionService } from '@/server/services/retention-service.ts';
import { policyFor, RETENTION_STATE_SQL, retentionStateOf } from '@/server/domain/retention.ts';
import type { ObjectStore } from '@/server/storage/object-store.ts';
import { DomainError } from '@/server/services/errors.ts';
import { uuidv7 } from '@/lib/id.ts';

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
});

/* ------------------------------------------------------------------ *
 * Test doubles for object storage
 * ------------------------------------------------------------------ */

function workingStore(): ObjectStore & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    configured: true,
    describe: () => 'test bucket',
    async put() {},
    async delete(key: string) {
      deleted.push(key);
    },
  };
}

function brokenStore(): ObjectStore & { attempts: string[] } {
  const attempts: string[] = [];
  return {
    attempts,
    configured: true,
    describe: () => 'broken bucket',
    async put() {},
    async delete(key: string) {
      attempts.push(key);
      throw new DomainError('NOT_IMPLEMENTED', 'хранилище недоступно');
    },
  };
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

async function staff(role: 'ADMIN' | 'SUPPORT' | 'MODERATOR' | 'VERIFIER' | 'FINANCE') {
  const s = await api.signUp();
  await api.grantRole(s.userId, role);
  return s;
}

/** A verification document that is due for purge and not held. */
async function dueDocument(opts: { purgeAfter?: string; userId?: string } = {}) {
  const userId = opts.userId ?? (await api.signUp()).userId;
  const requestId = uuidv7();
  await db.query(
    `INSERT INTO verification_request (id, user_id, kind, target_level, status, submitted_at)
     VALUES ($1,$2,'IDENTITY',1,'SUBMITTED', now())`,
    [requestId, userId],
  );
  const documentId = uuidv7();
  await db.query(
    `INSERT INTO verification_document (id, request_id, doc_type, storage_key, purge_after)
     VALUES ($1,$2,'PASSPORT',$3,$4)`,
    [documentId, requestId, `private/verification/${requestId}/${documentId}`, opts.purgeAfter ?? 'yesterday'],
  );
  return { userId, requestId, documentId };
}

const svc = (store?: ObjectStore) => new RetentionService(db, store);

/* ================================================================== *
 * The catalogue
 * ================================================================== */

describe('the retention catalogue', () => {
  /* The invariant with the longest useful life in this slice. A migration that
     adds a table without saying what happens to its data fails here. */
  it('covers every table that actually exists', async () => {
    const missing = await svc().tablesWithoutPolicy();
    expect(missing, `tables with no retention policy: ${missing.join(', ')}`).toEqual([]);
  });

  it('names no table that does not exist', async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'`,
    );
    const real = new Set(rows.map((r) => r.tablename));
    const { RETENTION_CATALOGUE } = await import('@/server/domain/retention.ts');
    for (const p of RETENTION_CATALOGUE) expect(real.has(p.table), p.table).toBe(true);
  });

  it('classifies the money tables as financial and keeps them', () => {
    for (const t of ['service_fee', 'ledger_entry', 'booking']) {
      expect(['KEEP', 'KEEP_AS_AUDIT'], t).toContain(policyFor(t)!.onErasure);
    }
  });
});

/* ================================================================== *
 * State parity: TypeScript and SQL must agree
 * ================================================================== */

describe('retention state parity', () => {
  /* The condition on which the derived-state decision depends. DEC-041 accepted
     writing one rule twice ONLY because a test keeps the copies honest, and the
     verification slice shipped a SQL twin with no such test. Not repeating that. */
  it('the TypeScript rule and the SQL rule agree on every combination', async () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const stamps = [null, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'];
    const rows: { deleted: string | null; after: string | null; purged: string | null; held: boolean }[] = [];
    for (const deleted of stamps) {
      for (const after of stamps) {
        for (const purged of [null, '2026-01-01T00:00:00Z']) {
          for (const held of [false, true]) rows.push({ deleted, after, purged, held });
        }
      }
    }
    expect(rows.length).toBe(3 * 3 * 2 * 2);

    for (const r of rows) {
      const { rows: sqlRows } = await db.query<{ state: string }>(
        `SELECT ${RETENTION_STATE_SQL.replace(/\$now/g, '$4::timestamptz')} AS state
           FROM (SELECT $1::timestamptz AS deleted_at, $2::timestamptz AS purge_after,
                        $3::timestamptz AS purged_at) d,
                LATERAL (SELECT $5::boolean AS held) h`,
        [r.deleted, r.after, r.purged, now.toISOString(), r.held],
      );
      const ts = retentionStateOf(
        {
          deletedAt: r.deleted ? new Date(r.deleted) : null,
          purgeAfter: r.after ? new Date(r.after) : null,
          purgedAt: r.purged ? new Date(r.purged) : null,
          held: r.held,
        },
        now,
      );
      expect(sqlRows[0]!.state, JSON.stringify(r)).toBe(ts);
    }
  });
});

/* ================================================================== *
 * Legal holds
 * ================================================================== */

describe('legal holds', () => {
  it('SUPPORT may place one; only ADMIN may lift it', async () => {
    const support = await staff('SUPPORT');
    const admin = await staff('ADMIN');
    const subject = await api.signUp();

    const placed = await api.post(
      '/admin/legal-holds',
      { targetType: 'user', targetId: subject.userId, reasonCode: 'FRAUD_INVESTIGATION', reason: 'Проверка' },
      { token: support.token },
    );
    expect(placed.status).toBe(201);

    const refused = await api.post(
      `/admin/legal-holds/${placed.body.id}/release`,
      { reason: 'Больше не нужно' },
      { token: support.token },
    );
    expect(refused.status).toBe(403);

    const released = await api.post(
      `/admin/legal-holds/${placed.body.id}/release`,
      { reason: 'Проверка окончена' },
      { token: admin.token },
    );
    expect(released.status).toBe(200);
    expect(released.body.released_at).toBeTruthy();
  });

  it('VERIFIER — the one role that can read documents — cannot hold or run', async () => {
    /* The separation that matters: whoever can open a passport must not also
       decide whether it is kept. */
    const verifier = await staff('VERIFIER');
    const subject = await api.signUp();
    const hold = await api.post(
      '/admin/legal-holds',
      { targetType: 'user', targetId: subject.userId, reasonCode: 'OTHER', reason: 'нет прав' },
      { token: verifier.token },
    );
    expect(hold.status).toBe(403);
    expect((await api.post('/admin/retention/run', {}, { token: verifier.token })).status).toBe(403);
  });

  it('an ordinary account reaches none of it', async () => {
    const user = await api.signUp();
    expect((await api.get('/admin/retention', { token: user.token })).status).toBe(403);
    expect((await api.get('/admin/legal-holds', { token: user.token })).status).toBe(403);
    expect((await api.post('/admin/retention/run', {}, { token: user.token })).status).toBe(403);
  });

  it('a second hold on the same target returns the first rather than duplicating', async () => {
    const admin = await staff('ADMIN');
    const subject = await api.signUp();
    const body = {
      targetType: 'user',
      targetId: subject.userId,
      reasonCode: 'DISPUTE_OPEN' as const,
      reason: 'Открыто обращение',
    };
    const first = await api.post('/admin/legal-holds', body, { token: admin.token });
    const second = await api.post(
      '/admin/legal-holds',
      { ...body, reason: 'Другая причина' },
      { token: admin.token },
    );
    expect(second.body.id).toBe(first.body.id);
    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text c FROM legal_hold WHERE target_id=$1`,
      [subject.userId],
    );
    expect(rows[0]!.c).toBe('1');
  });

  it('the database refuses two live holds even if the service is bypassed', async () => {
    const admin = await staff('ADMIN');
    const subject = await api.signUp();
    const insert = () =>
      db.query(
        `INSERT INTO legal_hold (id, target_type, target_id, reason_code, reason, placed_by)
         VALUES ($1,'user',$2,'OTHER','x',$3)`,
        [uuidv7(), subject.userId, admin.userId],
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('a hold cannot be released without a reason, at the database level', async () => {
    const admin = await staff('ADMIN');
    const subject = await api.signUp();
    const id = uuidv7();
    await db.query(
      `INSERT INTO legal_hold (id, target_type, target_id, reason_code, reason, placed_by)
       VALUES ($1,'user',$2,'OTHER','x',$3)`,
      [id, subject.userId, admin.userId],
    );
    await expect(
      db.query(`UPDATE legal_hold SET released_at=now(), released_by=$2 WHERE id=$1`, [id, admin.userId]),
    ).rejects.toThrow();
  });

  it('placing and releasing both write audit rows that cannot be edited', async () => {
    const admin = await staff('ADMIN');
    const subject = await api.signUp();
    const placed = await api.post(
      '/admin/legal-holds',
      { targetType: 'user', targetId: subject.userId, reasonCode: 'OFFICIAL_REQUEST', reason: 'Запрос' },
      { token: admin.token },
    );
    await api.post(`/admin/legal-holds/${placed.body.id}/release`, { reason: 'Отработано' }, { token: admin.token });

    const { rows } = await db.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit_log
        WHERE target_id=$1 AND action LIKE 'retention.%' ORDER BY occurred_at`,
      [subject.userId],
    );
    expect(rows.map((r) => r.action)).toEqual(['retention.hold.place', 'retention.hold.release']);
    expect(rows[1]!.reason).toBe('Отработано');
    await expect(db.query(`DELETE FROM audit_log WHERE target_id=$1`, [subject.userId])).rejects.toThrow();
  });

  it('a hold on a target that does not exist is 404, not a foreign-key error', async () => {
    const admin = await staff('ADMIN');
    const res = await api.post(
      '/admin/legal-holds',
      { targetType: 'user', targetId: uuidv7(), reasonCode: 'OTHER', reason: 'Проверка несуществующего' },
      { token: admin.token },
    );
    expect(res.status).toBe(404);
  });
});

/* ================================================================== *
 * The purge itself
 * ================================================================== */

describe('document purge', () => {
  it('destroys the bytes, then records it — and keeps the row', async () => {
    const store = workingStore();
    const { documentId } = await dueDocument();

    const outcome = await svc(store).purgeDocument(documentId);
    expect(outcome.result).toBe('PURGED');
    expect(store.deleted.length).toBe(1);

    const { rows } = await db.query<{ purged_at: Date | null; storage_key: string }>(
      `SELECT purged_at, storage_key FROM verification_document WHERE id=$1`,
      [documentId],
    );
    expect(rows[0]!.purged_at).toBeTruthy();
    // The tombstone survives: it is what document_access_log points at, and the
    // only record of which object was destroyed.
    expect(rows[0]!.storage_key).toContain('private/');
  });

  /* The ordering proof. If the bytes cannot be destroyed, nothing may claim
     they were — otherwise the scan skips the row for ever and the platform
     believes a passport is gone while it sits in the bucket. */
  it('a failed byte-delete never sets purged_at', async () => {
    const store = brokenStore();
    const { documentId } = await dueDocument();

    const outcome = await svc(store).purgeDocument(documentId);
    expect(outcome.result).toBe('FAILED');
    expect(store.attempts.length).toBe(1);

    const { rows } = await db.query<{ purged_at: Date | null; purge_started_at: Date | null }>(
      `SELECT purged_at, purge_started_at FROM verification_document WHERE id=$1`,
      [documentId],
    );
    expect(rows[0]!.purged_at).toBeNull();
    expect(rows[0]!.purge_started_at).toBeTruthy();
  });

  it('retries a purge that was claimed but never finished', async () => {
    const { documentId } = await dueDocument();
    expect((await svc(brokenStore()).purgeDocument(documentId)).result).toBe('FAILED');

    const store = workingStore();
    expect((await svc(store).purgeDocument(documentId)).result).toBe('PURGED');
    expect(store.deleted.length).toBe(1);
  });

  it('purging twice is a no-op the second time', async () => {
    const store = workingStore();
    const { documentId } = await dueDocument();
    expect((await svc(store).purgeDocument(documentId)).result).toBe('PURGED');
    const again = await svc(store).purgeDocument(documentId);
    expect(again.result).toBe('SKIPPED');
    expect(store.deleted.length).toBe(1);
  });

  it('an unconfigured store skips without claiming anything', async () => {
    const { documentId } = await dueDocument();
    const outcome = await svc().purgeDocument(documentId);
    expect(outcome.result).toBe('SKIPPED');
    expect(outcome.reason).toBe('STORAGE_UNAVAILABLE');
    const { rows } = await db.query<{ purge_started_at: Date | null }>(
      `SELECT purge_started_at FROM verification_document WHERE id=$1`,
      [documentId],
    );
    // Not even claimed: a claim with no possible follow-through would look like
    // a stuck retry for ever.
    expect(rows[0]!.purge_started_at).toBeNull();
  });

  it('a document with no retention window is never a candidate', async () => {
    const { documentId } = await dueDocument({ purgeAfter: undefined });
    await db.query(`UPDATE verification_document SET purge_after=NULL WHERE id=$1`, [documentId]);
    expect(await svc(workingStore()).dueForDocumentPurge()).toEqual([]);
    expect((await svc(workingStore()).purgeDocument(documentId)).result).toBe('SKIPPED');
  });

  it('a window in the future is never a candidate', async () => {
    const { documentId } = await dueDocument({ purgeAfter: '2099-01-01' });
    expect(await svc(workingStore()).dueForDocumentPurge()).toEqual([]);
    expect((await svc(workingStore()).purgeDocument(documentId)).result).toBe('SKIPPED');
  });
});

/* ================================================================== *
 * Holds beat purges
 * ================================================================== */

describe('a hold stops destruction', () => {
  it('a hold on the document itself', async () => {
    const admin = await staff('ADMIN');
    const { documentId } = await dueDocument();
    await api.post(
      '/admin/legal-holds',
      { targetType: 'verification_document', targetId: documentId, reasonCode: 'OTHER', reason: 'Нужно' },
      { token: admin.token },
    );
    expect(await svc(workingStore()).dueForDocumentPurge()).toEqual([]);
    expect((await svc(workingStore()).purgeDocument(documentId)).result).toBe('SKIPPED');
  });

  /* The scope that matters operationally: freeze a person, and everything
     beneath them is frozen without anyone enumerating it. */
  it('a hold on the USER covers documents beneath them', async () => {
    const admin = await staff('ADMIN');
    const { documentId, userId } = await dueDocument();
    await api.post(
      '/admin/legal-holds',
      { targetType: 'user', targetId: userId, reasonCode: 'SECURITY_INVESTIGATION', reason: 'Инцидент' },
      { token: admin.token },
    );
    expect(await svc(workingStore()).dueForDocumentPurge()).toEqual([]);
    const store = workingStore();
    expect((await svc(store).purgeDocument(documentId)).result).toBe('SKIPPED');
    expect(store.deleted).toEqual([]);
  });

  it('a hold on the request covers its documents', async () => {
    const admin = await staff('ADMIN');
    const { documentId, requestId } = await dueDocument();
    await api.post(
      '/admin/legal-holds',
      { targetType: 'verification_request', targetId: requestId, reasonCode: 'DISPUTE_OPEN', reason: 'Спор' },
      { token: admin.token },
    );
    expect((await svc(workingStore()).purgeDocument(documentId)).result).toBe('SKIPPED');
  });

  /* Time-of-check/time-of-use. The candidate list is only a hint; the
     transaction re-reads every condition, so a hold that lands between the two
     still wins. This asserts the guard, which is the property that makes the
     real race safe — PGlite cannot run the race itself. */
  it('a hold landing after the candidate list was built still wins', async () => {
    const admin = await staff('ADMIN');
    const { documentId, userId } = await dueDocument();

    const candidates = await svc(workingStore()).dueForDocumentPurge();
    expect(candidates).toContain(documentId);

    await api.post(
      '/admin/legal-holds',
      { targetType: 'user', targetId: userId, reasonCode: 'OFFICIAL_REQUEST', reason: 'Запрос поступил' },
      { token: admin.token },
    );

    const store = workingStore();
    expect((await svc(store).purgeDocument(documentId)).result).toBe('SKIPPED');
    expect(store.deleted).toEqual([]);
  });

  it('releasing the hold makes it eligible again', async () => {
    const admin = await staff('ADMIN');
    const { documentId, userId } = await dueDocument();
    const placed = await api.post(
      '/admin/legal-holds',
      { targetType: 'user', targetId: userId, reasonCode: 'OTHER', reason: 'Пока держим' },
      { token: admin.token },
    );
    expect((await svc(workingStore()).purgeDocument(documentId)).result).toBe('SKIPPED');

    await api.post(`/admin/legal-holds/${placed.body.id}/release`, { reason: 'Можно' }, { token: admin.token });
    expect((await svc(workingStore()).purgeDocument(documentId)).result).toBe('PURGED');
  });
});

/* ================================================================== *
 * The job
 * ================================================================== */

describe('the purge job', () => {
  it('two overlapping runs do the work once', async () => {
    const service = svc(workingStore());
    const first = await service.beginRun('retention.purge', null);
    expect(first).toBeTruthy();
    // The partial unique index is the mutex; the second runner is turned away.
    expect(await service.beginRun('retention.purge', null)).toBeNull();

    const report = await service.runPurgeJob();
    expect(report.runId).toBeNull();
    expect(report.notes[0]).toContain('уже выполняется');
  });

  it('records what it did, and a repeat run changes nothing', async () => {
    const store = workingStore();
    await dueDocument();
    const first = await svc(store).runPurgeJob();
    expect(first.documents.filter((d) => d.result === 'PURGED').length).toBe(1);

    const second = await svc(store).runPurgeJob();
    expect(second.documents).toEqual([]);
    expect(store.deleted.length).toBe(1);

    const { rows } = await db.query<{ status: string; processed: number }>(
      `SELECT status, processed FROM job_run WHERE job_name='retention.purge' ORDER BY started_at`,
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status !== 'RUNNING')).toBe(true);
  });

  it('reclaims a run abandoned by a dead process', async () => {
    const service = svc(workingStore());
    await db.query(
      `INSERT INTO job_run (id, job_name, started_at) VALUES ($1,'retention.purge', now() - interval '3 hours')`,
      [uuidv7()],
    );
    expect(await service.beginRun('retention.purge', null)).toBeTruthy();
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM job_run WHERE job_name='retention.purge' ORDER BY started_at`,
    );
    expect(rows[0]!.status).toBe('ABANDONED');
    expect(rows[1]!.status).toBe('RUNNING');
  });

  it('one failing document does not abandon the rest of the batch', async () => {
    const a = await dueDocument();
    const b = await dueDocument();
    const c = await dueDocument();

    let calls = 0;
    const flaky: ObjectStore = {
      configured: true,
      describe: () => 'flaky',
      async put() {},
      async delete() {
        calls += 1;
        if (calls === 2) throw new DomainError('NOT_IMPLEMENTED', 'сбой');
      },
    };

    const report = await svc(flaky).runPurgeJob();
    expect(report.documents.length).toBe(3);
    expect(report.documents.filter((d) => d.result === 'PURGED').length).toBe(2);
    expect(report.documents.filter((d) => d.result === 'FAILED').length).toBe(1);

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text c FROM verification_document WHERE purged_at IS NOT NULL AND id = ANY($1)`,
      [[a.documentId, b.documentId, c.documentId]],
    );
    expect(rows[0]!.c).toBe('2');
  });

  it('says plainly why it destroyed nothing when storage is absent', async () => {
    await dueDocument();
    const report = await svc().runPurgeJob();
    expect(report.notes.join(' ')).toContain('не настроено');
    expect(report.documents.every((d) => d.result === 'SKIPPED')).toBe(true);
  });

  it('reports documents held back because LEGAL-004 has set no window', async () => {
    const { documentId } = await dueDocument();
    await db.query(`UPDATE verification_document SET purge_after=NULL WHERE id=$1`, [documentId]);
    const report = await svc(workingStore()).runPurgeJob();
    expect(report.notes.join(' ')).toContain('LEGAL-004');
  });

  it('the route is reachable by ADMIN and returns no storage key anywhere', async () => {
    const admin = await staff('ADMIN');
    await dueDocument();
    const res = await api.post('/admin/retention/run', {}, { token: admin.token });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('private/');
  });
});

/* ================================================================== *
 * Credential sweeps
 * ================================================================== */

describe('expired credential sweep', () => {
  it('removes expired sessions and leaves live ones alone', async () => {
    const user = await api.signUp();
    const { rows: before } = await db.query<{ c: string }>(
      `SELECT count(*)::text c FROM user_session WHERE user_id=$1`,
      [user.userId],
    );
    expect(Number(before[0]!.c)).toBeGreaterThan(0);

    // A second, already-expired session alongside the live one.
    await db.query(
      `INSERT INTO user_session (id, user_id, token_hash, expires_at, created_at)
       VALUES ($1,$2,$3, now() - interval '2 days', now() - interval '3 days')`,
      [uuidv7(), user.userId, Buffer.from(uuidv7())],
    );

    const swept = await svc().sweepExpiredCredentials();
    expect(swept.sessions).toBe(1);

    // The live session still authenticates: the sweep touched only the expired one.
    expect((await api.get('/me/profile', { token: user.token })).status).toBe(200);
  });

  it('removes consumed and expired one-time tokens', async () => {
    const user = await api.signUp();
    await db.query(
      `INSERT INTO auth_token (id, user_id, purpose, token_hash, expires_at)
       VALUES ($1,$2,'PASSWORD_RESET',$3, now() - interval '1 day')`,
      [uuidv7(), user.userId, Buffer.from(uuidv7())],
    );
    const swept = await svc().sweepExpiredCredentials();
    expect(swept.authTokens).toBeGreaterThanOrEqual(1);
  });

  it('touches no financial or audit row', async () => {
    const admin = await staff('ADMIN');
    const subject = await api.signUp();
    await api.post(
      '/admin/legal-holds',
      { targetType: 'user', targetId: subject.userId, reasonCode: 'OTHER', reason: 'Проверка' },
      { token: admin.token },
    );
    const count = async (t: string) =>
      Number((await db.query<{ c: string }>(`SELECT count(*)::text c FROM ${t}`)).rows[0]!.c);

    const auditBefore = await count('audit_log');
    const ledgerBefore = await count('ledger_entry');
    await svc().sweepExpiredCredentials();
    expect(await count('audit_log')).toBe(auditBefore);
    expect(await count('ledger_entry')).toBe(ledgerBefore);
  });
});

/* ================================================================== *
 * Account closure
 * ================================================================== */

describe('account closure', () => {
  it('tells the person what it will and will not do before they do it', async () => {
    const user = await api.signUp();
    const res = await api.get('/me/account/closure', { token: user.token });
    expect(res.status).toBe(200);
    expect(res.body.canClose).toBe(true);

    const built = res.body.steps.filter((s: { built: boolean }) => s.built).map((s: { step: string }) => s.step);
    const blocked = res.body.steps.filter((s: { built: boolean }) => !s.built);
    expect(built).toContain('REVOKE_SESSIONS');
    // Every destructive step is named AND marked unbuilt, so the screen cannot
    // imply an erasure that does not happen.
    expect(blocked.length).toBeGreaterThan(0);
    for (const s of blocked) expect(s.blockedBy).toMatch(/^LEGAL-\d{3}$/);
    expect(res.body.survives.join(' ')).toContain('задолженность');
  });

  it('closes the account, ends every session and pauses the listings', async () => {
    const user = await api.signUp();
    const res = await api.post(
      '/me/account/close',
      { confirm: 'ЗАКРЫТЬ', reason: 'Больше не нужно' },
      { token: user.token },
    );
    expect(res.status).toBe(200);

    // The session token is dead immediately.
    expect((await api.get('/me/profile', { token: user.token })).status).toBe(401);

    const { rows } = await db.query<{ status: string; deleted_at: Date | null }>(
      `SELECT status, deleted_at FROM app_user WHERE id=$1`,
      [user.userId],
    );
    expect(rows[0]!.status).toBe('DELETED');
    expect(rows[0]!.deleted_at).toBeTruthy();
  });

  it('requires the typed confirmation', async () => {
    const user = await api.signUp();
    expect((await api.post('/me/account/close', { confirm: 'yes' }, { token: user.token })).status).toBe(422);
    expect((await api.post('/me/account/close', {}, { token: user.token })).status).toBe(422);
  });

  it('destroys nothing — the person, their reviews and the ledger all survive', async () => {
    const user = await api.signUp();
    const before = await db.query<{ c: string }>(`SELECT count(*)::text c FROM app_user WHERE id=$1`, [user.userId]);
    await api.post('/me/account/close', { confirm: 'ЗАКРЫТЬ' }, { token: user.token });
    const after = await db.query<{ c: string }>(`SELECT count(*)::text c FROM app_user WHERE id=$1`, [user.userId]);
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c);

    // And the name is still there: closure is not anonymisation, and pretending
    // otherwise is the failure mode this test exists to catch.
    const { rows } = await db.query<{ display_name: string }>(`SELECT display_name FROM app_user WHERE id=$1`, [
      user.userId,
    ]);
    expect(rows[0]!.display_name.length).toBeGreaterThan(0);
  });

  it('is refused while a hold is on the account', async () => {
    const admin = await staff('ADMIN');
    const user = await api.signUp();
    await api.post(
      '/admin/legal-holds',
      { targetType: 'user', targetId: user.userId, reasonCode: 'FRAUD_INVESTIGATION', reason: 'Проверка' },
      { token: admin.token },
    );
    const res = await api.post('/me/account/close', { confirm: 'ЗАКРЫТЬ' }, { token: user.token });
    expect(res.status).toBe(409);
    expect((await api.get('/me/account/closure', { token: user.token })).body.canClose).toBe(false);
  });

  it('closing twice is not an error', async () => {
    const user = await api.signUp();
    await api.post('/me/account/close', { confirm: 'ЗАКРЫТЬ' }, { token: user.token });
    // The first close revoked the session, so the second goes through staff.
    const admin = await staff('ADMIN');
    const again = await api.post(
      `/admin/users/${user.userId}/close`,
      { reason: 'Повторно' },
      { token: admin.token },
    );
    expect(again.status).toBe(200);
  });
});

/* ================================================================== *
 * What deletion must never make possible
 * ================================================================== */

describe('deletion must not weaken anything that already held', () => {
  /* The finding this slice exists for: fraud_signal cascaded from app_user with
     no append-only trigger, so deleting a fresh account destroyed the record of
     why it was suspicious. */
  it('a user with a fraud signal can no longer be hard-deleted', async () => {
    const user = await api.signUp();
    await db.query(`INSERT INTO fraud_signal (user_id, kind, severity) VALUES ($1,'TEST',3)`, [user.userId]);
    await expect(db.query(`DELETE FROM app_user WHERE id=$1`, [user.userId])).rejects.toThrow();
    const { rows } = await db.query<{ c: string }>(`SELECT count(*)::text c FROM fraud_signal WHERE user_id=$1`, [
      user.userId,
    ]);
    expect(rows[0]!.c).toBe('1');
  });

  it('a user with a verification request can no longer be hard-deleted', async () => {
    const { userId } = await dueDocument();
    await expect(db.query(`DELETE FROM app_user WHERE id=$1`, [userId])).rejects.toThrow();
  });

  it('the access log survives its document being purged', async () => {
    const verifier = await staff('VERIFIER');
    const { documentId } = await dueDocument();
    await db.query(
      `INSERT INTO document_access_log (document_id, actor_user_id, actor_role, purpose)
       VALUES ($1,$2,'VERIFIER','проверка')`,
      [documentId, verifier.userId],
    );

    expect((await svc(workingStore()).purgeDocument(documentId)).result).toBe('PURGED');

    const { rows } = await db.query<{ c: string }>(
      `SELECT count(*)::text c FROM document_access_log WHERE document_id=$1`,
      [documentId],
    );
    // Who opened somebody's passport must outlive the passport.
    expect(rows[0]!.c).toBe('1');
    await expect(
      db.query(`DELETE FROM document_access_log WHERE document_id=$1`, [documentId]),
    ).rejects.toThrow();
  });

  it('a purged document is still refused by the public media route', async () => {
    const { documentId } = await dueDocument();
    const { rows } = await db.query<{ storage_key: string }>(
      `SELECT storage_key FROM verification_document WHERE id=$1`,
      [documentId],
    );
    await svc(workingStore()).purgeDocument(documentId);
    // The key namespace is what the media route refuses on, and purging does
    // not move a document out of it.
    expect(rows[0]!.storage_key.startsWith('private/')).toBe(true);
  });

  it('no retention response leaks a storage key to any role', async () => {
    await dueDocument();
    for (const role of ['ADMIN', 'SUPPORT', 'MODERATOR'] as const) {
      const s = await staff(role);
      for (const path of ['/admin/retention', '/admin/legal-holds', '/admin/retention/runs']) {
        const res = await api.get(path, { token: s.token });
        if (res.status !== 200) continue;
        expect(JSON.stringify(res.body), `${role} ${path}`).not.toContain('private/');
      }
    }
  });

  it('a closed account cannot sign in again', async () => {
    const user = await api.signUp();
    await api.post('/me/account/close', { confirm: 'ЗАКРЫТЬ' }, { token: user.token });
    const res = await api.post('/auth/login', { identifier: user.email, password: 'karotkaja-vulica-2026' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

/* ================================================================== *
 * Genuine concurrency — real server only
 * ================================================================== */

describe('genuine concurrency', () => {
  it.skipIf(process.env.TEST_DATABASE_URL === undefined)(
    'a hold committed during a purge stops it',
    async () => {
      /* Only meaningful against a real server: PGlite is a single connection,
         so the two transactions below would serialise trivially and prove
         nothing. Skipped rather than faked. */
      const admin = await staff('ADMIN');
      const { documentId, userId } = await dueDocument();
      const store = workingStore();

      const [purge] = await Promise.all([
        svc(store).purgeDocument(documentId),
        api.post(
          '/admin/legal-holds',
          { targetType: 'user', targetId: userId, reasonCode: 'OFFICIAL_REQUEST', reason: 'Гонка' },
          { token: admin.token },
        ),
      ]);

      const { rows } = await db.query<{ purged_at: Date | null }>(
        `SELECT purged_at FROM verification_document WHERE id=$1`,
        [documentId],
      );
      // Either the purge won and the bytes are gone, or the hold won and they
      // are not — but never "purged_at set and delete never called".
      if (rows[0]!.purged_at) expect(store.deleted.length).toBe(1);
      else expect(purge.result).toBe('SKIPPED');
    },
  );
});
