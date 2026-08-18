/**
 * Data lifecycle: holds, purges, sweeps, job runs and account closure.
 *
 * WHAT THIS SERVICE WILL AND WILL NOT DO
 *
 * It destroys expired credentials — sessions, one-time tokens, idempotency
 * records, rate-limit counters. Those are unambiguously safe: a session past
 * its own `expires_at` is expired by the schema's own definition, not by
 * anybody's policy judgement, and deleting it can only reduce what we hold.
 *
 * It will destroy identity documents whose stored window has passed, and today
 * it destroys none, because no window is ever set (LEGAL-004) and no object
 * store exists. Both refusals are independent and both fail closed. The job
 * runs anyway, reports every candidate with the reason it was skipped, and
 * changes nothing. That is not the job being broken.
 *
 * It does NOT anonymise anybody, redact any message, or purge any dispute.
 * Those all wait on LEGAL-003, LEGAL-010 and LEGAL-017 respectively, and each
 * is listed in the risk register as a consequence of an unfavourable answer —
 * a contingency, not a default. `ERASURE_STEPS` in the domain says which half
 * is built, and the account-closure path here refuses to claim more than it does.
 *
 * THREE INVARIANTS
 *
 * 1. Nothing here writes to `ledger_entry`, `service_fee` or `audit_log`
 *    except through `writeAudit`. Closing an account does not settle a debt.
 * 2. No method returns a `storage_key`. The purge path reads one internally to
 *    hand to the object store and never lets it out.
 * 3. `purged_at` is an assertion that bytes are gone. It is written only after
 *    the store confirms, never before, and never on a store that cannot confirm.
 */

import { uuidv7 } from '../../lib/id.ts';
import { hasErrorCode, PG_ERROR, type Db, type Sql } from '../db/sql.ts';
import {
  CLOSURE_SURVIVES,
  ERASURE_BLOCKER_EXPLANATION,
  ERASURE_STEPS,
  HOLD_REVIEW_DAYS,
  policyFor,
  purgeEligibility,
  RETENTION_CATALOGUE,
  retentionStateOf,
  type ErasureBlocker,
  type HoldReasonCode,
  type HoldTargetType,
  type RetentionState,
} from '../domain/retention.ts';
import { documentStore, type ObjectStore } from '../storage/object-store.ts';
import { writeAudit } from './audit.ts';
import { DomainError, forbidden, invalid, notFound } from './errors.ts';

/* ================================================================== *
 * Types
 * ================================================================== */

export interface StaffActor {
  readonly userId: string;
  readonly role: string;
  /** `retention.hold` — may freeze data. */
  readonly canHold: boolean;
  /** ADMIN. Releasing re-enables destruction, so it is the narrower grant. */
  readonly canRelease: boolean;
  /** `retention.run` — may trigger the purge job. */
  readonly canRun: boolean;
}

export interface HoldRow {
  readonly id: string;
  readonly target_type: HoldTargetType;
  readonly target_id: string;
  readonly reason_code: HoldReasonCode;
  readonly reason: string;
  readonly placed_by: string;
  readonly placed_at: Date;
  readonly released_at: Date | null;
}

export interface PurgeOutcome {
  readonly id: string;
  readonly result: 'PURGED' | 'SKIPPED' | 'FAILED';
  readonly reason?: string;
}

export interface SweepReport {
  readonly job: string;
  readonly runId: string | null;
  readonly startedAt: string;
  readonly processed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly documents: PurgeOutcome[];
  readonly credentials: Record<string, number>;
  readonly notes: string[];
}

const JOB_NAME = 'retention.purge';

/**
 * How long a RUNNING row may sit before another runner may take over.
 *
 * This is a crash-recovery lease, not a retention period: it bounds how long a
 * dead process can block the job, and it decides nothing about anybody's data.
 */
const RUN_LEASE_MINUTES = 60;

export class RetentionService {
  constructor(
    private readonly db: Db,
    /** Injected so a test can supply a store that succeeds, fails, or counts calls. */
    private readonly store: ObjectStore = documentStore(),
  ) {}

  /* ================================================================ *
   * Legal holds
   * ================================================================ */

  /**
   * Freeze something.
   *
   * The lock is the subtle part. A hold and a purge are writes to different
   * tables, so a row lock on the document says nothing about a hold row that
   * does not exist yet, and under READ COMMITTED a `NOT EXISTS` subquery in the
   * purge sees a snapshot from statement start — a hold committing microseconds
   * later is invisible, and by then the bytes are gone.
   *
   * So both paths take the same lock first: `SELECT … FOR UPDATE` on the target
   * row itself. The purge locks every row a covering hold could name, parent
   * first (user → request → document), which is also a fixed order and so
   * cannot deadlock against another purge. Whichever transaction gets there
   * first wins; the loser blocks and then sees the winner's committed effect.
   */
  async placeHold(
    input: {
      targetType: HoldTargetType;
      targetId: string;
      reasonCode: HoldReasonCode;
      reason: string;
    },
    actor: StaffActor,
  ): Promise<HoldRow> {
    if (!actor.canHold) throw forbidden('Устанавливать удержание может только сотрудник с правом retention.hold');
    if (!input.reason.trim()) throw invalid('Причина удержания обязательна');

    return this.db.transaction(async (tx) => {
      await this.lockTarget(tx, input.targetType, input.targetId);

      const existing = await tx.query<HoldRow>(
        `SELECT id, target_type, target_id, reason_code, reason, placed_by, placed_at, released_at
           FROM legal_hold
          WHERE target_type=$1 AND target_id=$2 AND released_at IS NULL`,
        [input.targetType, input.targetId],
      );
      // Already held is not an error worth surfacing: the caller's intent — that
      // this must not be destroyed — is already satisfied.
      if (existing.rows[0]) return existing.rows[0];

      const id = uuidv7();
      try {
        await tx.query(
          `INSERT INTO legal_hold (id, target_type, target_id, reason_code, reason, placed_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, input.targetType, input.targetId, input.reasonCode, input.reason.trim(), actor.userId],
        );
      } catch (e) {
        if (hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) {
          throw new DomainError('CONFLICT', 'На этот объект уже наложено удержание');
        }
        throw e;
      }

      await writeAudit(tx, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'retention.hold.place',
        targetType: input.targetType,
        targetId: input.targetId,
        changes: { hold: { from: null, to: input.reasonCode } },
        reason: input.reason.trim(),
        source: 'admin',
      });

      const { rows } = await tx.query<HoldRow>(
        `SELECT id, target_type, target_id, reason_code, reason, placed_by, placed_at, released_at
           FROM legal_hold WHERE id=$1`,
        [id],
      );
      return rows[0]!;
    });
  }

  /**
   * Unfreeze.
   *
   * Narrower than placing, on purpose. Placing a hold only ever prevents
   * destruction, so it can be widely granted; releasing one re-enables it, so
   * "who released this, and why?" must always have an answer.
   */
  async releaseHold(holdId: string, reason: string, actor: StaffActor): Promise<HoldRow> {
    if (!actor.canHold) throw forbidden('Недостаточно прав');
    if (!actor.canRelease) {
      throw forbidden('Снять удержание может только администратор — это снова разрешает уничтожение данных');
    }
    if (!reason.trim()) throw invalid('Причина снятия удержания обязательна');

    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<HoldRow>(
        `SELECT id, target_type, target_id, reason_code, reason, placed_by, placed_at, released_at
           FROM legal_hold WHERE id=$1 FOR UPDATE`,
        [holdId],
      );
      const hold = rows[0];
      if (!hold) throw notFound('Удержание');
      if (hold.released_at) throw new DomainError('CONFLICT', 'Удержание уже снято');

      await tx.query(
        `UPDATE legal_hold SET released_at=now(), released_by=$2, release_reason=$3 WHERE id=$1`,
        [holdId, actor.userId, reason.trim()],
      );

      await writeAudit(tx, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'retention.hold.release',
        targetType: hold.target_type,
        targetId: hold.target_id,
        changes: { hold: { from: hold.reason_code, to: null } },
        reason: reason.trim(),
        source: 'admin',
      });

      const after = await tx.query<HoldRow>(
        `SELECT id, target_type, target_id, reason_code, reason, placed_by, placed_at, released_at
           FROM legal_hold WHERE id=$1`,
        [holdId],
      );
      return after.rows[0]!;
    });
  }

  async holds(filter: { targetType?: HoldTargetType; targetId?: string; active?: boolean } = {}): Promise<
    Record<string, unknown>[]
  > {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.targetType) {
      params.push(filter.targetType);
      where.push(`h.target_type = $${params.length}`);
    }
    if (filter.targetId) {
      params.push(filter.targetId);
      where.push(`h.target_id = $${params.length}`);
    }
    if (filter.active !== false) where.push('h.released_at IS NULL');

    const { rows } = await this.db.query(
      `SELECT h.id, h.target_type, h.target_id, h.reason_code, h.reason,
              h.placed_at, h.released_at, h.release_reason,
              pb.display_name AS placed_by_name, rb.display_name AS released_by_name,
              (h.released_at IS NULL
                AND h.placed_at <= now() - ($${params.length + 1} || ' days')::interval) AS review_overdue
         FROM legal_hold h
         JOIN app_user pb ON pb.id = h.placed_by
         LEFT JOIN app_user rb ON rb.id = h.released_by
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY h.released_at IS NOT NULL, h.placed_at
        LIMIT 200`,
      [...params, String(HOLD_REVIEW_DAYS)],
    );
    return rows;
  }

  /* ================================================================ *
   * Document purge
   * ================================================================ */

  /**
   * Candidates.
   *
   * Advisory only — the transaction re-checks every condition before touching
   * anything, because a hold can land between this query and the purge. Returns
   * ids and never storage keys.
   */
  async dueForDocumentPurge(now: Date = new Date(), limit = 200): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT d.id
         FROM verification_document d
         JOIN verification_request r ON r.id = d.request_id
        WHERE d.purged_at IS NULL
          AND d.purge_after IS NOT NULL
          AND d.purge_after <= $1
          AND NOT EXISTS (
                SELECT 1 FROM legal_hold h
                 WHERE h.released_at IS NULL
                   AND ((h.target_type='verification_document' AND h.target_id = d.id)
                     OR (h.target_type='verification_request'  AND h.target_id = r.id)
                     OR (h.target_type='user'                  AND h.target_id = r.user_id)))
        ORDER BY d.purge_after
        LIMIT $2`,
      [now.toISOString(), limit],
    );
    return rows.map((r) => r.id);
  }

  /** Documents whose purge began and never finished. Retried, and shown to staff. */
  async stuckPurges(): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query(
      `SELECT id, request_id, doc_type, purge_started_at
         FROM verification_document
        WHERE purge_started_at IS NOT NULL AND purged_at IS NULL
        ORDER BY purge_started_at
        LIMIT 100`,
    );
    return rows;
  }

  /**
   * Destroy one document's bytes.
   *
   * Three steps and two short transactions, in the only order that is
   * recoverable from every crash point:
   *
   *   claim   — lock the coverage chain, re-check every condition, stamp
   *             `purge_started_at`, return the key. Commit.
   *   destroy — hand the key to the object store. NO transaction is open:
   *             holding a pooled connection and a row lock across a call to a
   *             storage provider is how a purge job takes the site down.
   *   confirm — stamp `purged_at` and write the audit row. Commit.
   *
   * The alternative ordering — stamp `purged_at` first — produces a row
   * asserting the bytes are gone while they sit in the bucket, and the scan
   * filters on `purged_at IS NULL` so nothing ever retries. `purged_at` is not
   * a request to purge; it is a claim that must not be made before it is true.
   */
  async purgeDocument(documentId: string, now: Date = new Date()): Promise<PurgeOutcome> {
    // Refuse before claiming. Stamping `purge_started_at` on a store that
    // cannot delete would leave a row looking like a stuck retry for ever.
    if (!this.store.configured) {
      return { id: documentId, result: 'SKIPPED', reason: 'STORAGE_UNAVAILABLE' };
    }

    const claim = await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ user_id: string; request_id: string }>(
        `SELECT r.user_id, r.id AS request_id
           FROM verification_document d JOIN verification_request r ON r.id = d.request_id
          WHERE d.id = $1`,
        [documentId],
      );
      const owner = rows[0];
      if (!owner) return null;

      // Parent first, always in this order, so two purges cannot deadlock.
      await tx.query(`SELECT id FROM app_user WHERE id=$1 FOR UPDATE`, [owner.user_id]);
      await tx.query(`SELECT id FROM verification_request WHERE id=$1 FOR UPDATE`, [owner.request_id]);

      const { rows: claimed } = await tx.query<{ id: string; storage_key: string }>(
        `UPDATE verification_document d
            SET purge_started_at = now()
          FROM verification_request r
          WHERE d.id = $1 AND d.request_id = r.id
            AND d.purged_at IS NULL
            AND d.purge_after IS NOT NULL
            AND d.purge_after <= $2
            AND NOT EXISTS (
                  SELECT 1 FROM legal_hold h
                   WHERE h.released_at IS NULL
                     AND ((h.target_type='verification_document' AND h.target_id = d.id)
                       OR (h.target_type='verification_request'  AND h.target_id = r.id)
                       OR (h.target_type='user'                  AND h.target_id = r.user_id)))
          RETURNING d.id, d.storage_key`,
        [documentId, now.toISOString()],
      );
      return claimed[0] ?? null;
    });

    if (!claim) return { id: documentId, result: 'SKIPPED', reason: 'NOT_ELIGIBLE' };

    try {
      await this.store.delete(claim.storage_key);
    } catch (e) {
      // `purged_at` stays NULL. The row is picked up again next run, which is
      // why `delete()` is required to be idempotent.
      return {
        id: documentId,
        result: 'FAILED',
        reason: e instanceof DomainError ? e.code : 'STORAGE_ERROR',
      };
    }

    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE verification_document SET purged_at = now() WHERE id=$1 AND purged_at IS NULL`, [
        documentId,
      ]);
      await writeAudit(tx, {
        actorUserId: null,
        actorRole: 'job',
        action: 'retention.document.purge',
        targetType: 'verification_document',
        targetId: documentId,
        // Deliberately no storage key: the audit row records that a document
        // was destroyed, not where it lived.
        changes: { purged: { from: false, to: true } },
        source: 'job',
      });
    });

    return { id: documentId, result: 'PURGED' };
  }

  /* ================================================================ *
   * Credential sweeps
   * ================================================================ */

  /**
   * Expired credentials and machinery.
   *
   * The only genuinely unambiguous deletions in the product. Each row here is
   * past a expiry the schema itself defined; none of it is evidence of
   * anything, and two of these tables were growing without bound because their
   * prune functions existed and were never called from anywhere.
   */
  async sweepExpiredCredentials(now: Date = new Date()): Promise<Record<string, number>> {
    const at = now.toISOString();
    const sessions = await this.db.query(
      `DELETE FROM user_session WHERE expires_at < $1`,
      [at],
    );
    const tokens = await this.db.query(
      `DELETE FROM auth_token WHERE expires_at < $1 OR consumed_at IS NOT NULL`,
      [at],
    );
    const idempotency = await this.db.query(`DELETE FROM idempotency_record WHERE expires_at < $1`, [at]);
    // The counter window is the rate limiter's own; anything outside it can
    // never be read again.
    const rateLimits = await this.db.query(
      `DELETE FROM rate_limit_counter WHERE window_start < $1::timestamptz - interval '24 hours'`,
      [at],
    );
    return {
      sessions: sessions.rowCount,
      authTokens: tokens.rowCount,
      idempotencyRecords: idempotency.rowCount,
      rateLimitCounters: rateLimits.rowCount,
    };
  }

  /* ================================================================ *
   * Job runs
   * ================================================================ */

  /**
   * Claim the right to run.
   *
   * The partial unique index on `job_run (job_name) WHERE status='RUNNING'` is
   * the mutex: a second concurrent runner gets a unique violation and is told
   * to go away rather than doing the work twice. Not an advisory lock, because
   * those live on a single connection and this application uses a pool.
   *
   * Returns null when another run holds the job. That is a normal outcome —
   * two crons firing on overlapping schedules is the case this exists for.
   */
  async beginRun(jobName: string, triggeredBy: string | null): Promise<string | null> {
    // A process that died mid-run leaves RUNNING for ever. Reclaim it after the
    // lease rather than requiring somebody to notice.
    await this.db.query(
      `UPDATE job_run SET status='ABANDONED', finished_at=now()
        WHERE job_name=$1 AND status='RUNNING'
          AND started_at < now() - ($2 || ' minutes')::interval`,
      [jobName, String(RUN_LEASE_MINUTES)],
    );

    const id = uuidv7();
    try {
      await this.db.query(`INSERT INTO job_run (id, job_name, triggered_by) VALUES ($1,$2,$3)`, [
        id,
        jobName,
        triggeredBy,
      ]);
      return id;
    } catch (e) {
      if (hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) return null;
      throw e;
    }
  }

  async finishRun(
    runId: string,
    outcome: { processed: number; skipped: number; failed: number; detail?: Record<string, unknown> },
  ): Promise<void> {
    await this.db.query(
      `UPDATE job_run
          SET status=$2, finished_at=now(), processed=$3, skipped=$4, failed=$5, detail=$6::jsonb
        WHERE id=$1 AND status='RUNNING'`,
      [
        runId,
        outcome.failed > 0 ? 'FAILED' : 'SUCCEEDED',
        outcome.processed,
        outcome.skipped,
        outcome.failed,
        JSON.stringify(outcome.detail ?? {}),
      ],
    );
  }

  async recentRuns(jobName?: string, limit = 20): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query(
      `SELECT id, job_name, status, started_at, finished_at, processed, skipped, failed, detail
         FROM job_run ${jobName ? 'WHERE job_name=$2' : ''}
        ORDER BY started_at DESC LIMIT $1`,
      jobName ? [limit, jobName] : [limit],
    );
    return rows;
  }

  /* ================================================================ *
   * The job itself
   * ================================================================ */

  /**
   * One pass.
   *
   * Every item is isolated: one document that throws must not abandon the rest,
   * because the next run would find the same document first and stall for ever
   * on it. Failures are collected and reported, exactly as the pre-existing
   * lifecycle sweep does.
   */
  async runPurgeJob(opts: { now?: Date; triggeredBy?: string | null } = {}): Promise<SweepReport> {
    const now = opts.now ?? new Date();
    const startedAt = now.toISOString();
    const runId = await this.beginRun(JOB_NAME, opts.triggeredBy ?? null);

    if (!runId) {
      return {
        job: JOB_NAME,
        runId: null,
        startedAt,
        processed: 0,
        skipped: 0,
        failed: 0,
        documents: [],
        credentials: {},
        notes: ['Задание уже выполняется — этот запуск ничего не делал.'],
      };
    }

    const documents: PurgeOutcome[] = [];
    const notes: string[] = [];
    let credentials: Record<string, number> = {};

    try {
      credentials = await this.sweepExpiredCredentials(now);

      const candidates = await this.dueForDocumentPurge(now);
      for (const id of candidates) {
        try {
          documents.push(await this.purgeDocument(id, now));
        } catch {
          documents.push({ id, result: 'FAILED', reason: 'UNEXPECTED' });
        }
      }

      if (!this.store.configured) {
        notes.push(
          `Приватное хранилище не настроено (${this.store.describe()}). ` +
            'Документы не уничтожаются: платформа не может подтвердить удаление файла.',
        );
      }
      const withoutPolicy = await this.db.query<{ c: string }>(
        `SELECT count(*)::text c FROM verification_document WHERE purge_after IS NULL AND purged_at IS NULL`,
      );
      if (Number(withoutPolicy.rows[0]!.c) > 0) {
        notes.push(
          `${withoutPolicy.rows[0]!.c} документ(ов) без установленного срока хранения — ` +
            'срок не выбран, потому что LEGAL-004 не решён. Они не уничтожаются.',
        );
      }
    } finally {
      const purged = documents.filter((d) => d.result === 'PURGED').length;
      const failed = documents.filter((d) => d.result === 'FAILED').length;
      const skipped = documents.filter((d) => d.result === 'SKIPPED').length;
      const credentialTotal = Object.values(credentials).reduce((a, b) => a + b, 0);
      await this.finishRun(runId, {
        processed: purged + credentialTotal,
        skipped,
        failed,
        detail: { documents: documents.length, credentials, notes },
      });
    }

    return {
      job: JOB_NAME,
      runId,
      startedAt,
      processed:
        documents.filter((d) => d.result === 'PURGED').length +
        Object.values(credentials).reduce((a, b) => a + b, 0),
      skipped: documents.filter((d) => d.result === 'SKIPPED').length,
      failed: documents.filter((d) => d.result === 'FAILED').length,
      documents,
      credentials,
      notes,
    };
  }

  /* ================================================================ *
   * Account closure
   * ================================================================ */

  /**
   * Why this account cannot be closed yet.
   *
   * Product rules, not legal ones. Closing an account mid-stay strands the
   * other party in a booking with a counterparty who no longer exists, and no
   * data-protection answer makes that acceptable.
   */
  async closureBlockers(userId: string): Promise<ErasureBlocker[]> {
    const { rows } = await this.db.query<{
      active_bookings: number;
      open_disputes: number;
      held: boolean;
    }>(
      `SELECT
         (SELECT count(*)::int FROM booking
           WHERE (tenant_id=$1 OR landlord_id=$1)
             AND status IN ('REQUESTED','OFFER_PENDING','CONFIRMED','CHECKED_IN','COMPLETION_PENDING','DISPUTED')
         ) AS active_bookings,
         (SELECT count(*)::int FROM dispute_case
           WHERE (opened_by=$1 OR against_user_id=$1) AND status NOT IN ('RESOLVED','CLOSED')
         ) AS open_disputes,
         EXISTS (SELECT 1 FROM legal_hold
                  WHERE released_at IS NULL AND target_type='user' AND target_id=$1) AS held`,
      [userId],
    );
    const r = rows[0]!;
    const blockers: ErasureBlocker[] = [];
    if (r.active_bookings > 0) blockers.push('ACTIVE_BOOKING');
    if (r.open_disputes > 0) blockers.push('OPEN_DISPUTE');
    if (r.held) blockers.push('LEGAL_HOLD');
    // Debt is deliberately absent — see CLOSURE_SURVIVES in the domain. The
    // ledger is unaffected by closure, so refusing over it would be leverage,
    // not protection.
    return blockers;
  }

  /** Whether the ledger still shows a balance owed. Reported, never enforced. */
  private async outstandingDebtMinor(userId: string): Promise<string> {
    const { rows } = await this.db.query<{ balance: string }>(
      `SELECT coalesce(sum(amount_minor),0)::text AS balance FROM ledger_entry WHERE landlord_id=$1`,
      [userId],
    );
    return rows[0]!.balance;
  }

  /**
   * What the product can honestly tell somebody who wants to be forgotten.
   *
   * The unbuilt steps are returned alongside the built ones on purpose. A
   * screen that lists only what happens would imply the rest happens too.
   */
  async erasureStatus(userId: string): Promise<Record<string, unknown>> {
    const blockers = await this.closureBlockers(userId);
    const { rows } = await this.db.query<{
      closure_requested_at: Date | null;
      deleted_at: Date | null;
      status: string;
    }>(`SELECT closure_requested_at, deleted_at, status FROM app_user WHERE id=$1`, [userId]);
    const user = rows[0];
    if (!user) throw notFound('Пользователь');

    return {
      status: user.status,
      closureRequestedAt: user.closure_requested_at,
      closedAt: user.deleted_at,
      canClose: blockers.length === 0,
      blockers: blockers.map((b) => ({ code: b, explanation: ERASURE_BLOCKER_EXPLANATION[b] })),
      steps: ERASURE_STEPS.map((s) => ({ ...s })),
      survives: CLOSURE_SURVIVES,
      outstandingBalanceMinor: await this.outstandingDebtMinor(userId),
    };
  }

  /**
   * Close an account: revoke every way in, hide the profile, stop the listings.
   *
   * Destroys nothing. This is deliberately the whole of what ships: removing
   * ACCESS is a superset of the SUSPENDED behaviour that already exists and
   * needs no legal answer, whereas destroying the person's data is LEGAL-003
   * and is not built. A half-finished erasure that removes a name and leaves
   * the chat history is worse than one that has not started, because it looks
   * finished to the person who asked for it.
   */
  async closeAccount(
    userId: string,
    input: { reason: string; requestedBySelf: boolean },
    actor: { userId: string; role: string },
  ): Promise<Record<string, unknown>> {
    const blockers = await this.closureBlockers(userId);
    if (blockers.length > 0) {
      throw new DomainError('CONFLICT', blockers.map((b) => ERASURE_BLOCKER_EXPLANATION[b]).join(' '), {
        blockers,
      });
    }

    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ status: string; deleted_at: Date | null }>(
        `SELECT status, deleted_at FROM app_user WHERE id=$1 FOR UPDATE`,
        [userId],
      );
      const user = rows[0];
      if (!user) throw notFound('Пользователь');
      // Idempotent: closing a closed account is a no-op, not an error, because
      // a retried request must not fail.
      if (user.deleted_at) return;

      await tx.query(
        `UPDATE app_user
            SET status='DELETED', deleted_at=now(),
                closure_requested_at = coalesce(closure_requested_at, now())
          WHERE id=$1`,
        [userId],
      );
      await tx.query(`UPDATE user_session SET revoked_at=now(), revoked_reason=$2 WHERE user_id=$1 AND revoked_at IS NULL`, [
        userId,
        'account_closed',
      ]);
      await tx.query(`DELETE FROM auth_token WHERE user_id=$1 AND consumed_at IS NULL`, [userId]);
      // Listings come down. A published home whose owner is gone is a listing
      // nobody can answer a question about.
      await tx.query(
        `UPDATE property SET status='PAUSED' WHERE owner_id=$1 AND status='PUBLISHED' AND deleted_at IS NULL`,
        [userId],
      );

      await writeAudit(tx, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'account.close',
        targetType: 'user',
        targetId: userId,
        changes: { status: { from: user.status, to: 'DELETED' } },
        reason: input.reason,
        source: input.requestedBySelf ? 'web' : 'admin',
      });
    });

    return this.erasureStatus(userId);
  }

  /* ================================================================ *
   * The console's view
   * ================================================================ */

  /** The catalogue, plus how much of it the job actually acts on. */
  async overview(now: Date = new Date()): Promise<Record<string, unknown>> {
    const { rows: docRows } = await this.db.query<{
      deleted_at: Date | null;
      purge_after: Date | null;
      purged_at: Date | null;
      held: boolean;
    }>(
      `SELECT NULL::timestamptz AS deleted_at, d.purge_after, d.purged_at,
              EXISTS (SELECT 1 FROM legal_hold h
                       WHERE h.released_at IS NULL
                         AND ((h.target_type='verification_document' AND h.target_id=d.id)
                           OR (h.target_type='verification_request'  AND h.target_id=r.id)
                           OR (h.target_type='user'                  AND h.target_id=r.user_id))) AS held
         FROM verification_document d JOIN verification_request r ON r.id=d.request_id`,
    );

    const byState: Record<string, number> = {};
    for (const row of docRows) {
      const state: RetentionState = retentionStateOf(
        {
          deletedAt: row.deleted_at,
          purgeAfter: row.purge_after,
          purgedAt: row.purged_at,
          held: row.held,
        },
        now,
      );
      byState[state] = (byState[state] ?? 0) + 1;
    }

    const sample = docRows[0];
    const eligibility = purgeEligibility(
      sample
        ? { deletedAt: null, purgeAfter: sample.purge_after, purgedAt: sample.purged_at, held: sample.held }
        : { deletedAt: null, purgeAfter: null, purgedAt: null, held: false },
      now,
      { storageConfigured: this.store.configured },
    );

    const [holds, runs, stuck] = await Promise.all([
      this.holds({ active: true }),
      this.recentRuns(JOB_NAME, 5),
      this.stuckPurges(),
    ]);

    return {
      storage: { configured: this.store.configured, describe: this.store.describe() },
      documents: { total: docRows.length, byState, exampleEligibility: eligibility },
      holds,
      runs,
      stuck,
      catalogue: RETENTION_CATALOGUE.map((p) => ({
        table: p.table,
        dataClass: p.dataClass,
        onErasure: p.onErasure,
        window: p.window,
        appendOnly: p.appendOnly === true,
        enforced: p.enforced === true,
        note: p.note ?? null,
      })),
    };
  }

  /** Exposed so a test can assert the catalogue covers the real schema. */
  async tablesWithoutPolicy(): Promise<string[]> {
    const { rows } = await this.db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migration'`,
    );
    return rows.map((r) => r.tablename).filter((t) => !policyFor(t)).sort();
  }

  /* ---------------------------------------------------------------- */

  /**
   * Take the lock a purge will also take.
   *
   * Locking the *target* row means a hold on a user and a purge of that user's
   * document contend on `app_user`, while a hold on the document itself
   * contends on `verification_document` — which the purge also locks through
   * its `UPDATE`. Every pairing meets on some row.
   */
  private async lockTarget(tx: Sql, targetType: HoldTargetType, targetId: string): Promise<void> {
    const table: Record<HoldTargetType, string> = {
      user: 'app_user',
      property: 'property',
      booking: 'booking',
      dispute_case: 'dispute_case',
      verification_request: 'verification_request',
      verification_document: 'verification_document',
      conversation: 'conversation',
    };
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM ${table[targetType]} WHERE id=$1 FOR UPDATE`,
      [targetId],
    );
    // 404 rather than a foreign-key error: whether an object exists is not
    // something a malformed id should be able to establish.
    if (!rows[0]) throw notFound('Объект для удержания');
  }
}
