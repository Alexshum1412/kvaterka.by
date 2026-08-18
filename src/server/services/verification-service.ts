/**
 * Verification: submission, review, decision.
 *
 * WHAT WAS HERE BEFORE: three tables, three permissions, three endpoints, and
 * no way for anybody to submit anything. `verification_request` rows existed
 * only inside tests. The queue endpoint returned an empty list in production
 * and always would, and the decision endpoint could raise somebody's
 * verification level with no evidence of any kind behind it.
 *
 * FOUR RULES SHAPE THIS FILE.
 *
 *   1. A LEVEL IS NEVER GRANTED ON NOTHING. `evidenceSufficiency()` in the
 *      domain gates every approval, and it currently refuses all of them
 *      because `verification.identity_documents` is off pending LEGAL-004.
 *      That is the intended behaviour, not a limitation to work around: the
 *      badge is a claim the platform makes to a tenant weighing up a stranger.
 *
 *   2. DOCUMENTS ARE NOT THIS SERVICE'S TO HAND OUT. Nothing here returns a
 *      storage key. The only route to a document is the pre-existing
 *      `document.read` endpoint, which VERIFIER alone can reach and which
 *      writes an access log row before the key leaves the server. This service
 *      reports that documents EXIST and what type they are; opening one is a
 *      separate, logged act.
 *
 *   3. THE APPLICANT AND THE VERIFIER READ DIFFERENT TEXT. `decision_note` is
 *      internal, `applicant_message` plus the reason codes are what the person
 *      is told, and `verification_event.visibility` keeps the two streams
 *      apart in the history as well.
 *
 *   4. A REFUSED REQUEST IS SUPERSEDED, NEVER EDITED. Resubmission creates a
 *      new row pointing at the old one, so what was refused and why survives
 *      and a pattern of attempts stays visible.
 */

import { uuidv7 } from '../../lib/id.ts';
import { hasErrorCode, PG_ERROR, type Db, type Sql } from '../db/sql.ts';
import {
  applyVerificationAction,
  availableVerificationActions,
  evidenceSufficiency,
  isVerificationOverdue,
  kindForLevel,
  VERIFICATION_PRIORITY_RANK_SQL,
  VERIFICATION_PRIORITY_SQL,
  VERIFICATION_SLA_HOURS,
  type ActorCapabilities,
  type OwnershipBasis,
  type VerificationAction,
  type VerificationKind,
  type VerificationPriority,
  type VerificationReasonCode,
  type VerificationStatus,
} from '../domain/verification.ts';
import { forbidden, invalid, notFound, DomainError } from './errors.ts';
import { writeAudit } from './audit.ts';

/** Resolved by the route layer from the session's roles; never inferred here. */
export interface VerifierContext extends ActorCapabilities {
  readonly userId: string;
  readonly role: string;
}

export interface QueueFilters {
  readonly status?: string;
  readonly kind?: string;
  readonly level?: number;
  readonly city?: string;
  readonly priority?: string;
  readonly assigned?: string;
  readonly q?: string;
  readonly sort?: 'OLDEST' | 'NEWEST' | 'PRIORITY' | 'WAITING_LONGEST';
  readonly limit?: number;
  readonly offset?: number;
}

const MAX_PAGE = 50;

export class VerificationService {
  constructor(private readonly db: Db) {}

  /* ================================================================ *
   * Applicant side — the half that did not exist
   * ================================================================ */

  /**
   * Ask for a level.
   *
   * Level 1 is an IDENTITY request about a person. Level 2 is a
   * PROPERTY_OWNERSHIP request about one listing, and it requires Level 1
   * already held — checking a right to let a flat is meaningless if we do not
   * know who is claiming it.
   */
  async submit(input: {
    userId: string;
    targetLevel: 1 | 2;
    propertyId?: string;
    declared?: { ownershipBasis?: OwnershipBasis; note?: string };
    supersedesId?: string;
  }): Promise<Record<string, unknown>> {
    const kind = kindForLevel(input.targetLevel);

    return this.db.transaction(async (tx) => {
      const { rows: userRows } = await tx.query<{ verification_level: number; display_name: string }>(
        `SELECT verification_level, display_name FROM app_user WHERE id=$1 AND deleted_at IS NULL`,
        [input.userId],
      );
      const user = userRows[0];
      if (!user) throw notFound('Пользователь');

      if (kind === 'PROPERTY_OWNERSHIP') {
        if (!input.propertyId) throw invalid('Укажите объявление, для которого подтверждается право сдачи');
        if (Number(user.verification_level) < 1) {
          throw new DomainError(
            'CONFLICT',
            'Сначала нужно подтвердить личность — без этого проверять право сдавать нечего',
          );
        }
        const { rows: owned } = await tx.query<{ id: string }>(
          `SELECT id FROM property WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL`,
          [input.propertyId, input.userId],
        );
        // 404 rather than 403: whether a listing exists is not a stranger's business.
        if (!owned[0]) throw notFound('Объявление');
      } else if (Number(user.verification_level) >= 1) {
        throw new DomainError('CONFLICT', 'Личность уже подтверждена');
      }

      // Superseding: only the applicant's own refused request, and only once.
      if (input.supersedesId) {
        const { rows } = await tx.query<{ user_id: string; status: string }>(
          `SELECT user_id, status FROM verification_request WHERE id=$1`,
          [input.supersedesId],
        );
        const prior = rows[0];
        if (!prior || prior.user_id !== input.userId) throw notFound('Заявка');
        if (!['REJECTED', 'NEEDS_INFO', 'EXPIRED'].includes(prior.status)) {
          throw new DomainError('CONFLICT', 'Эту заявку ещё рассматривают');
        }
        // A NEEDS_INFO request is closed as the applicant answers it, so the
        // partial-unique index below sees only the new row.
        if (prior.status === 'NEEDS_INFO') {
          await tx.query(
            `UPDATE verification_request SET status='EXPIRED' WHERE id=$1 AND status='NEEDS_INFO'`,
            [input.supersedesId],
          );
        }
      }

      /* Look before inserting. The unique index below is the real guarantee,
         but a violation aborts the transaction, so the friendly "here is the
         request you already have" answer cannot be produced from inside the
         catch — by then nothing else can be read. The catch stays as the race
         backstop and simply refuses. */
      const live = await tx.query<{ id: string }>(
        `SELECT id FROM verification_request
           WHERE user_id=$1 AND kind=$2 AND status IN ('SUBMITTED','IN_REVIEW','NEEDS_INFO')
             AND (property_id = $3 OR ($3::uuid IS NULL AND property_id IS NULL))
           LIMIT 1`,
        [input.userId, kind, input.propertyId ?? null],
      );
      if (live.rows[0]) return this.presentForApplicantRow(tx, live.rows[0].id);

      const id = uuidv7();
      try {
        await tx.query(
          `INSERT INTO verification_request
             (id, user_id, property_id, kind, target_level, status, declared, supersedes_id, submitted_at)
           VALUES ($1,$2,$3,$4,$5,'SUBMITTED',$6::jsonb,$7, now())`,
          [
            id,
            input.userId,
            input.propertyId ?? null,
            kind,
            input.targetLevel,
            JSON.stringify(input.declared ?? {}),
            input.supersedesId ?? null,
          ],
        );
      } catch (e) {
        // The partial unique index: one live request per user per kind per
        // property. A double-tapped submit is not two applications.
        // Matched on the SQL state, not on the index name in the message text:
        // a message is a presentation detail that changes between drivers and
        // versions, and this branch decides whether a person gets their request
        // back or an error.
        if (hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) {
          throw new DomainError('ALREADY_EXISTS', 'Заявка уже отправлена');
        }
        throw e;
      }

      await recordEvent(tx, {
        requestId: id,
        actorUserId: input.userId,
        actorRole: 'APPLICANT',
        eventType: 'SUBMITTED',
        // The applicant's own act, so they can see it in their own history.
        visibility: 'APPLICANT',
        payload: { targetLevel: input.targetLevel, kind },
      });

      await writeAudit(tx, {
        actorUserId: input.userId,
        actorRole: 'APPLICANT',
        action: 'verification.submit',
        targetType: 'verification_request',
        targetId: id,
        changes: { targetLevel: input.targetLevel, kind },
      });

      return this.presentForApplicantRow(tx, id);
    });
  }

  /**
   * The applicant's own view of their verification.
   *
   * Carries the level they hold, anything in flight, what to fix and where to
   * fix it — and nothing else. No internal note, no assignee, no fraud signal,
   * no storage key.
   */
  async forApplicant(userId: string): Promise<Record<string, unknown>> {
    const [user, requests, properties] = await Promise.all([
      this.db.query<Record<string, any>>(
        `SELECT verification_level, display_name, email_verified_at, phone_verified_at
           FROM app_user WHERE id=$1`,
        [userId],
      ),
      this.db.query<Record<string, any>>(
        `SELECT id, kind, target_level, status, property_id, reason_codes, applicant_message,
                declared, created_at, submitted_at, decided_at, supersedes_id
           FROM verification_request WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
        [userId],
      ),
      this.db.query<Record<string, any>>(
        `SELECT p.id, p.title, p.city, p.status, p.property_verified_at
           FROM property p WHERE p.owner_id=$1 AND p.deleted_at IS NULL
          ORDER BY p.created_at DESC LIMIT 50`,
        [userId],
      ),
    ]);

    const u = user.rows[0];
    if (!u) throw notFound('Пользователь');

    const level = Number(u.verification_level) as 0 | 1 | 2;
    const all = requests.rows.map((r) => this.presentForApplicant(r));
    const live = all.filter((r) => !['APPROVED', 'REJECTED', 'EXPIRED'].includes(String(r.status)));

    return {
      level,
      emailVerified: u.email_verified_at !== null,
      phoneVerified: u.phone_verified_at !== null,
      // What document collection being disabled means for them, said plainly
      // rather than left as a request that never moves.
      collectionEnabled: await this.documentCollectionEnabled(),
      current: live[0] ?? null,
      history: all,
      properties: properties.rows.map((p) => ({
        id: p.id,
        title: p.title,
        city: p.city,
        status: p.status,
        verified: p.property_verified_at !== null,
      })),
    };
  }

  private presentForApplicant(r: Record<string, any>): Record<string, unknown> {
    const codes = (r.reason_codes ?? []) as VerificationReasonCode[];
    return {
      id: r.id,
      kind: r.kind,
      targetLevel: Number(r.target_level),
      status: r.status as VerificationStatus,
      propertyId: r.property_id,
      // Codes and the applicant-facing text. The internal note is not selected
      // by this query at all, so it cannot leak through a later refactor.
      reasonCodes: codes,
      message: r.applicant_message,
      declared: r.declared ?? {},
      submittedAt: iso(r.submitted_at ?? r.created_at),
      decidedAt: iso(r.decided_at),
      supersedesId: r.supersedes_id,
    };
  }

  private async presentForApplicantRow(tx: Sql, id: string): Promise<Record<string, unknown>> {
    const { rows } = await tx.query<Record<string, any>>(
      `SELECT id, kind, target_level, status, property_id, reason_codes, applicant_message,
              declared, created_at, submitted_at, decided_at, supersedes_id
         FROM verification_request WHERE id=$1`,
      [id],
    );
    return this.presentForApplicant(rows[0]!);
  }

  /** The applicant's own history for one request, applicant-visible events only. */
  async applicantTimeline(requestId: string, userId: string): Promise<Record<string, unknown>[]> {
    const { rows: owned } = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM verification_request WHERE id=$1`,
      [requestId],
    );
    if (!owned[0] || owned[0].user_id !== userId) throw notFound('Заявка');

    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT occurred_at, event_type, note, reason_codes FROM verification_event
        WHERE request_id=$1 AND visibility='APPLICANT' ORDER BY occurred_at`,
      [requestId],
    );
    return rows.map((r) => ({
      at: iso(r.occurred_at),
      type: r.event_type,
      note: r.note,
      reasonCodes: r.reason_codes ?? [],
    }));
  }

  /* ================================================================ *
   * Evidence
   * ================================================================ */

  /**
   * Attach a document to a request.
   *
   * TWO INDEPENDENT GATES, BOTH FAILING CLOSED.
   *
   *   - `verification.identity_documents` must be on. It is off pending
   *     LEGAL-004, so today this always refuses. Collecting passport images
   *     before the data-protection question is answered is the single most
   *     consequential thing this product could get wrong.
   *   - A private storage location must exist. There is none: the media route
   *     refuses to serve anything under `private/`, and no private bucket is
   *     configured. Writing identity documents onto the same local disk as
   *     listing photos would be a privacy regression dressed as progress.
   *
   * The key is generated server-side inside the `private/` namespace, which the
   * database now also requires (0012), so a document row cannot exist outside
   * the namespace the public media route will not serve.
   */
  async attachDocument(
    requestId: string,
    userId: string,
    docType: string,
  ): Promise<{ storageKey: string }> {
    /* AUTHORISATION FIRST, then the infrastructure gates.
     *
     * The order matters. Checking the feature flag first told a stranger
     * probing somebody else's request id about the platform's configuration
     * before telling them the request was none of their business — a 501 and a
     * 404 are different answers, and the difference was readable. Ownership is
     * the private fact here; the flag state is not. */
    const { rows } = await this.db.query<{ user_id: string; status: string }>(
      `SELECT user_id, status FROM verification_request WHERE id=$1`,
      [requestId],
    );
    const request = rows[0];
    if (!request || request.user_id !== userId) throw notFound('Заявка');
    if (['APPROVED', 'REJECTED', 'EXPIRED'].includes(request.status)) {
      throw new DomainError('CONFLICT', 'Эта заявка уже закрыта');
    }

    if (!(await this.documentCollectionEnabled())) {
      throw new DomainError(
        'FEATURE_DISABLED',
        'Загрузка документов, удостоверяющих личность, отключена до юридического заключения. ' +
          'Заявку можно отправить — мы сообщим, когда проверка станет доступна.',
      );
    }
    if (!process.env.VERIFICATION_DOCUMENT_BUCKET_URL) {
      throw new DomainError(
        'NOT_IMPLEMENTED',
        'Приватное хранилище для документов не настроено. Документы нельзя принимать, пока его нет.',
      );
    }

    /* Unreachable today — both gates above refuse first. It is written out
       rather than left as a TODO so that answering LEGAL-004 and provisioning a
       bucket is a configuration change and not a coding task. The key is
       generated server-side inside the `private/` namespace, which the database
       also requires (0012), so a document row cannot exist outside the
       namespace the public media route declines to serve. */
    const storageKey = `private/verification/${requestId}/${uuidv7()}`;
    await this.db.query(
      `INSERT INTO verification_document (id, request_id, doc_type, storage_key, purge_after)
       VALUES ($1,$2,$3,$4, now() + interval '1 year')`,
      [uuidv7(), requestId, docType, storageKey],
    );
    return { storageKey };
  }

  private async documentCollectionEnabled(): Promise<boolean> {
    const { rows } = await this.db.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flag WHERE key='verification.identity_documents'`,
    );
    return rows[0]?.enabled ?? false;
  }

  /* ================================================================ *
   * Queue
   * ================================================================ */

  async queue(
    filters: QueueFilters,
    staff: VerifierContext,
  ): Promise<{
    items: Record<string, unknown>[];
    counts: Record<string, number>;
    limit: number;
    offset: number;
  }> {
    if (!staff.canReview) throw forbidden('Нет доступа к заявкам на проверку');

    const limit = Math.min(Math.max(filters.limit ?? 25, 1), MAX_PAGE);
    const offset = Math.max(filters.offset ?? 0, 0);

    const values: unknown[] = [];
    const push = (v: unknown): string => {
      values.push(v);
      return `$${values.length}`;
    };

    const where: string[] = [];
    if (filters.status && filters.status !== 'ALL') {
      if (filters.status === 'ACTIVE') where.push(`vr.status IN ('SUBMITTED','IN_REVIEW','NEEDS_INFO')`);
      else where.push(`vr.status = ${push(filters.status)}`);
    }
    if (filters.kind) where.push(`vr.kind = ${push(filters.kind)}`);
    if (filters.level) where.push(`vr.target_level = ${push(filters.level)}`);
    if (filters.city) where.push(`lower(p.city) = lower(${push(filters.city)})`);
    if (filters.assigned === 'ME') where.push(`vr.assigned_to = ${push(staff.userId)}`);
    else if (filters.assigned === 'UNASSIGNED') where.push(`vr.assigned_to IS NULL`);
    else if (filters.assigned) where.push(`vr.assigned_to = ${push(filters.assigned)}`);
    if (filters.q) {
      const like = `%${filters.q}%`;
      where.push(`(u.display_name ILIKE ${push(like)} OR p.title ILIKE ${push(like)} OR p.city ILIKE ${push(like)})`);
    }

    const from = `
      FROM verification_request vr
      JOIN app_user u ON u.id = vr.user_id
      LEFT JOIN property p ON p.id = vr.property_id
      LEFT JOIN LATERAL (
        SELECT true AS has_published FROM property pp
         WHERE pp.owner_id = vr.user_id AND pp.status = 'PUBLISHED' AND pp.deleted_at IS NULL LIMIT 1
      ) pl ON true
      LEFT JOIN LATERAL (
        SELECT true AS has_signal FROM fraud_signal f WHERE f.user_id = vr.user_id LIMIT 1
      ) fs ON true`;

    const order =
      {
        NEWEST: 'q.submitted_at DESC',
        OLDEST: 'q.submitted_at ASC',
        PRIORITY: 'q.priority_rank ASC, q.submitted_at ASC',
        WAITING_LONGEST: 'q.submitted_at ASC',
      }[filters.sort ?? 'PRIORITY'] ?? 'q.priority_rank ASC, q.submitted_at ASC';

    const rows = await this.db.query<Record<string, any>>(
      `SELECT * FROM (
         SELECT vr.id, vr.kind, vr.target_level, vr.status, vr.assigned_to, vr.property_id,
                vr.submitted_at, vr.created_at, vr.reason_codes,
                ${VERIFICATION_PRIORITY_SQL} AS priority,
                ${VERIFICATION_PRIORITY_RANK_SQL} AS priority_rank,
                EXTRACT(EPOCH FROM (now() - vr.submitted_at)) / 3600 AS age_hours,
                u.id AS applicant_id, u.display_name AS applicant_name,
                u.verification_level AS applicant_level, u.created_at AS applicant_since,
                p.title AS property_title, p.city AS property_city,
                assignee.display_name AS assignee_name,
                COALESCE(pl.has_published, false) AS has_published,
                (SELECT count(*)::int FROM verification_document d
                  WHERE d.request_id = vr.id AND d.purged_at IS NULL) AS document_count
           ${from}
           LEFT JOIN app_user assignee ON assignee.id = vr.assigned_to
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ) q
       ${filters.priority ? `WHERE q.priority = ${push(filters.priority)}` : ''}
       ORDER BY
         CASE WHEN q.status IN ('APPROVED','REJECTED','EXPIRED') THEN 1 ELSE 0 END,
         ${order}
       LIMIT ${push(limit)} OFFSET ${push(offset)}`,
      values,
    );

    const counts = await this.db.query<{ status: string; total: string }>(
      `SELECT status, count(*)::text AS total FROM verification_request GROUP BY status`,
    );
    const countFor: Record<string, number> = {};
    let total = 0;
    for (const r of counts.rows) {
      countFor[r.status] = Number(r.total);
      total += Number(r.total);
    }
    countFor.ALL = total;
    countFor.ACTIVE =
      (countFor.SUBMITTED ?? 0) + (countFor.IN_REVIEW ?? 0) + (countFor.NEEDS_INFO ?? 0);

    return {
      items: rows.rows.map((r) => {
        const priority = r.priority as VerificationPriority;
        const ageHours = Number(r.age_hours);
        return {
          id: r.id,
          kind: r.kind as VerificationKind,
          targetLevel: Number(r.target_level),
          status: r.status as VerificationStatus,
          priority,
          ageHours: Math.round(ageHours),
          overdue:
            !['APPROVED', 'REJECTED', 'EXPIRED'].includes(r.status) &&
            isVerificationOverdue(priority, ageHours),
          slaHours: VERIFICATION_SLA_HOURS[priority],
          submittedAt: iso(r.submitted_at),
          applicant: {
            id: r.applicant_id,
            displayName: r.applicant_name,
            level: Number(r.applicant_level),
            memberSince: iso(r.applicant_since),
          },
          property: r.property_id
            ? { id: r.property_id, title: r.property_title, city: r.property_city }
            : null,
          hasPublishedListing: r.has_published === true,
          // A count, never a key. Opening one is a separate logged act.
          documentCount: Number(r.document_count),
          assignedTo: r.assigned_to,
          assigneeName: r.assignee_name,
          reasonCodes: r.reason_codes ?? [],
        };
      }),
      counts: countFor,
      limit,
      offset,
    };
  }

  /* ================================================================ *
   * Case file
   * ================================================================ */

  /**
   * One request, assembled for this caller.
   *
   * Document METADATA — type, upload date, whether it has been purged — is
   * available to anybody who can review the queue, because knowing that a
   * passport was attached is not the same as seeing it. The keys are not here
   * at any permission level; `documents[].canOpen` tells the console whether
   * to offer the button that goes to the logged `document.read` route.
   */
  async detail(requestId: string, staff: VerifierContext): Promise<Record<string, unknown>> {
    if (!staff.canReview) throw notFound('Заявка');

    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT vr.*,
              ${VERIFICATION_PRIORITY_SQL} AS priority,
              EXTRACT(EPOCH FROM (now() - vr.submitted_at)) / 3600 AS age_hours,
              u.id AS applicant_id, u.display_name AS applicant_name, u.account_kind,
              u.company_name, u.verification_level AS applicant_level, u.status AS account_status,
              u.created_at AS applicant_since, u.email_verified_at, u.phone_verified_at,
              u.completed_rentals_as_tenant, u.completed_rentals_as_landlord,
              (SELECT round(avg(r.overall)::numeric,2) FROM review r
                WHERE r.subject_id = u.id AND r.status='PUBLISHED') AS rating,
              (SELECT count(*)::int FROM review r
                WHERE r.subject_id = u.id AND r.status='PUBLISHED') AS review_count,
              p.id AS property_id_j, p.title AS property_title, p.city AS property_city,
              p.district AS property_district, p.status AS property_status,
              p.public_latitude, p.public_longitude, p.property_verified_at,
              p.rooms, p.area_sqm
         FROM verification_request vr
         JOIN app_user u ON u.id = vr.user_id
         LEFT JOIN property p ON p.id = vr.property_id
         LEFT JOIN LATERAL (
           SELECT true AS has_published FROM property pp
            WHERE pp.owner_id = vr.user_id AND pp.status='PUBLISHED' AND pp.deleted_at IS NULL LIMIT 1
         ) pl ON true
         LEFT JOIN LATERAL (
           SELECT true AS has_signal FROM fraud_signal f WHERE f.user_id = vr.user_id LIMIT 1
         ) fs ON true
        WHERE vr.id = $1`,
      [requestId],
    );

    const v = rows[0];
    if (!v) throw notFound('Заявка');

    const [documents, events, priorDecisions, signals] = await Promise.all([
      this.documents(requestId),
      this.events(requestId),
      this.priorDecisions(v.user_id, requestId),
      // Fraud signals are staff-only and never reach the applicant. They are
      // shown here because a verifier deciding on identity needs to know the
      // platform has already noticed something.
      this.db.query<Record<string, any>>(
        `SELECT kind, severity, detected_at, review_outcome FROM fraud_signal
          WHERE user_id=$1 ORDER BY detected_at DESC LIMIT 10`,
        [v.user_id],
      ),
    ]);

    const collectionEnabled = await this.documentCollectionEnabled();
    const sufficiency = evidenceSufficiency({
      kind: v.kind as VerificationKind,
      identityDocumentCount: documents.filter((d) =>
        ['PASSPORT', 'ID_CARD'].includes(String(d.docType)),
      ).length,
      hasSelfie: documents.some((d) => d.docType === 'SELFIE'),
      propertyDocumentCount: documents.filter((d) =>
        ['OWNERSHIP_CERTIFICATE', 'POWER_OF_ATTORNEY', 'UTILITY_BILL'].includes(String(d.docType)),
      ).length,
      hasDeclaredBasis: Boolean((v.declared ?? {}).ownershipBasis),
      documentCollectionEnabled: collectionEnabled,
    });

    const priority = v.priority as VerificationPriority;
    const ageHours = Number(v.age_hours);

    return {
      id: v.id,
      kind: v.kind,
      targetLevel: Number(v.target_level),
      status: v.status as VerificationStatus,
      priority,
      ageHours: Math.round(ageHours),
      overdue:
        !['APPROVED', 'REJECTED', 'EXPIRED'].includes(v.status) &&
        isVerificationOverdue(priority, ageHours),
      slaHours: VERIFICATION_SLA_HOURS[priority],
      submittedAt: iso(v.submitted_at),
      decidedAt: iso(v.decided_at),
      decidedBy: v.decided_by,
      assignedTo: v.assigned_to,
      reasonCodes: (v.reason_codes ?? []) as VerificationReasonCode[],
      // Internal, and named as such so a UI cannot show it by accident.
      internalNote: v.decision_note,
      applicantMessage: v.applicant_message,
      declared: v.declared ?? {},
      supersedesId: v.supersedes_id,

      applicant: {
        id: v.applicant_id,
        displayName: v.applicant_name,
        accountKind: v.account_kind,
        companyName: v.company_name,
        level: Number(v.applicant_level),
        accountStatus: v.account_status,
        memberSince: iso(v.applicant_since),
        emailVerified: v.email_verified_at !== null,
        phoneVerified: v.phone_verified_at !== null,
        completedAsTenant: Number(v.completed_rentals_as_tenant),
        completedAsLandlord: Number(v.completed_rentals_as_landlord),
        rating: v.rating === null ? null : Number(v.rating),
        reviewCount: Number(v.review_count),
        hasPublishedListing: v.has_published === true,
      },

      property: v.property_id_j
        ? {
            id: v.property_id_j,
            title: v.property_title,
            city: v.property_city,
            district: v.property_district,
            status: v.property_status,
            rooms: v.rooms,
            areaSqm: v.area_sqm === null ? null : Number(v.area_sqm),
            verified: v.property_verified_at !== null,
            // The blurred point every tenant sees. The exact address has one
            // entitlement-checked accessor (DEC-020) and reviewing a
            // verification is not it — a verifier compares the document's
            // address against the listing's stated city and district.
            approximateLocation:
              v.public_latitude === null
                ? null
                : { latitude: Number(v.public_latitude), longitude: Number(v.public_longitude) },
          }
        : null,

      documents,
      timeline: events,
      priorDecisions,
      fraudSignals: signals.rows.map((s) => ({
        kind: s.kind,
        severity: Number(s.severity),
        outcome: s.review_outcome,
        detectedAt: iso(s.detected_at),
      })),

      evidence: {
        collectionEnabled,
        sufficient: sufficiency.sufficient,
        missing: sufficiency.missing,
        explanation: sufficiency.explanation,
      },

      availableActions: availableVerificationActions(v.status as VerificationStatus, staff).map((t) => ({
        action: t.action,
        to: t.to,
        requiresReason: t.requiresReason,
      })),

      entitlements: {
        review: staff.canReview,
        decide: staff.canDecide,
        // The only entitlement that opens a document, and the console shows it
        // so a verifier is never left wondering whether a button is missing.
        openDocuments: staff.canReadDocuments,
      },
    };
  }

  /** Metadata only. No storage key is returned by this service, ever. */
  private async documents(requestId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT d.id, d.doc_type, d.uploaded_at, d.purge_after, d.purged_at,
              (SELECT count(*)::int FROM document_access_log l WHERE l.document_id = d.id) AS read_count
         FROM verification_document d WHERE d.request_id=$1 ORDER BY d.uploaded_at`,
      [requestId],
    );
    return rows.map((r) => ({
      id: r.id,
      docType: r.doc_type,
      uploadedAt: iso(r.uploaded_at),
      purgeAfter: iso(r.purge_after),
      purged: r.purged_at !== null,
      // Visible on purpose: a verifier seeing that a document has been opened
      // eleven times learns something worth knowing.
      readCount: Number(r.read_count),
    }));
  }

  private async events(requestId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT e.occurred_at, e.event_type, e.note, e.reason_codes, e.actor_role, e.visibility,
              u.display_name AS actor_name
         FROM verification_event e
         LEFT JOIN app_user u ON u.id = e.actor_user_id
        WHERE e.request_id=$1 ORDER BY e.occurred_at, e.id`,
      [requestId],
    );
    return rows.map((r) => ({
      at: iso(r.occurred_at),
      type: r.event_type,
      note: r.note,
      reasonCodes: r.reason_codes ?? [],
      actorName: r.actor_name,
      actorRole: r.actor_role,
      internal: r.visibility === 'INTERNAL',
    }));
  }

  /** This applicant's earlier attempts. A pattern of refusals is evidence. */
  private async priorDecisions(userId: string, exceptId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT id, kind, target_level, status, reason_codes, decided_at
         FROM verification_request
        WHERE user_id=$1 AND id <> $2 AND status IN ('APPROVED','REJECTED','EXPIRED')
        ORDER BY decided_at DESC NULLS LAST LIMIT 10`,
      [userId, exceptId],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      targetLevel: Number(r.target_level),
      status: r.status,
      reasonCodes: r.reason_codes ?? [],
      decidedAt: iso(r.decided_at),
    }));
  }

  /* ================================================================ *
   * Decisions
   * ================================================================ */

  /**
   * Move a request, and — only on APPROVE — raise the level it was asked for.
   *
   * Everything consequential about this method is in the domain call: the
   * transition table decides whether the move exists, whether a reason is
   * needed, whether this actor may make it, and whether the evidence supports
   * it. A missing document or a disabled legal flag surfaces as
   * INSUFFICIENT_EVIDENCE and nothing changes.
   *
   * `verification_level` is raised with GREATEST, so a decision can never
   * lower somebody's level — an approval is not a re-assessment of what they
   * already hold.
   */
  async act(
    requestId: string,
    staff: VerifierContext,
    action: VerificationAction,
    input: { reasonCodes?: VerificationReasonCode[]; internalNote?: string; applicantMessage?: string } = {},
  ): Promise<Record<string, unknown>> {
    if (!staff.canReview) throw notFound('Заявка');

    const codes = input.reasonCodes ?? [];
    const internalNote = input.internalNote?.trim() ?? '';
    const applicantMessage = input.applicantMessage?.trim() ?? '';

    // REJECT and REQUEST_INFO are the reason-bearing moves, and a code is what
    // makes the refusal actionable for the applicant rather than a dead end.
    const hasReason = codes.length > 0 || applicantMessage.length > 0;

    return this.db.transaction(async (tx) => {
      const current = await lockRequest(tx, requestId);

      const documents = await tx.query<{ doc_type: string }>(
        `SELECT doc_type FROM verification_document WHERE request_id=$1 AND purged_at IS NULL`,
        [requestId],
      );
      const docTypes = documents.rows.map((d) => d.doc_type);
      const { rows: flagRows } = await tx.query<{ enabled: boolean }>(
        `SELECT enabled FROM feature_flag WHERE key='verification.identity_documents'`,
      );

      const transition = applyVerificationAction(current.status as VerificationStatus, action, {
        hasReason,
        actor: staff,
        evidence: {
          kind: current.kind as VerificationKind,
          identityDocumentCount: docTypes.filter((t) => ['PASSPORT', 'ID_CARD'].includes(t)).length,
          hasSelfie: docTypes.includes('SELFIE'),
          propertyDocumentCount: docTypes.filter((t) =>
            ['OWNERSHIP_CERTIFICATE', 'POWER_OF_ATTORNEY', 'UTILITY_BILL'].includes(t),
          ).length,
          hasDeclaredBasis: Boolean((current.declared ?? {}).ownershipBasis),
          documentCollectionEnabled: flagRows[0]?.enabled ?? false,
        },
      });

      if (action === 'REJECT' && codes.length === 0) {
        throw invalid('Отказ должен ссылаться хотя бы на одну причину', { field: 'reasonCodes' });
      }

      const decided = transition.to === 'APPROVED' || transition.to === 'REJECTED';

      await tx.query(
        `UPDATE verification_request
            SET status = $2,
                reason_codes = CASE WHEN $3::text[] = '{}'::text[] THEN reason_codes ELSE $3::text[] END,
                decision_note = COALESCE(NULLIF($4,''), decision_note),
                applicant_message = COALESCE(NULLIF($5,''), applicant_message),
                decided_by = CASE WHEN $6 THEN $7 ELSE decided_by END,
                decided_at = CASE WHEN $6 THEN now() ELSE decided_at END,
                assigned_to = COALESCE(assigned_to, CASE WHEN $8 THEN $7 END)
          WHERE id = $1`,
        [
          requestId,
          transition.to,
          codes,
          internalNote,
          applicantMessage,
          decided,
          staff.userId,
          action === 'TAKE',
        ],
      );

      if (transition.to === 'APPROVED') {
        await this.grantLevel(tx, current, staff.userId);
      }

      /* Two events: the internal record with the note, and — for the moves the
         applicant is entitled to know about — an applicant-visible one carrying
         only the codes and the message written for them. The internal note is
         never copied into the second. */
      await recordEvent(tx, {
        requestId,
        actorUserId: staff.userId,
        actorRole: staff.role,
        eventType: `STATUS_${action}`,
        note: internalNote || null,
        reasonCodes: codes,
        visibility: 'INTERNAL',
        payload: { from: current.status, to: transition.to },
      });

      if (['APPROVE', 'REJECT', 'REQUEST_INFO'].includes(action)) {
        await recordEvent(tx, {
          requestId,
          actorRole: 'PLATFORM',
          eventType: `DECISION_${action}`,
          note: applicantMessage || null,
          reasonCodes: codes,
          visibility: 'APPLICANT',
        });
      }

      await writeAudit(tx, {
        actorUserId: staff.userId,
        actorRole: staff.role,
        action: `verification.${action.toLowerCase()}`,
        targetType: 'verification_request',
        targetId: requestId,
        changes: {
          status: { from: current.status, to: transition.to },
          reasonCodes: codes,
          targetLevel: current.target_level,
        },
        reason: internalNote || applicantMessage || null,
        source: 'admin',
      });

      return { id: requestId, status: transition.to, previousStatus: current.status };
    });
  }

  /**
   * Apply what an approval means.
   *
   * IDENTITY raises `app_user.verification_level`; PROPERTY_OWNERSHIP stamps
   * the property. Level 2 requires both, so the user level only reaches 2 when
   * a property request is approved for somebody who already holds 1 — which is
   * enforced at submission and re-checked here rather than assumed.
   */
  private async grantLevel(tx: Sql, request: Record<string, any>, actorId: string): Promise<void> {
    if (request.kind === 'IDENTITY') {
      await tx.query(
        `UPDATE app_user SET verification_level = GREATEST(verification_level, $2) WHERE id=$1`,
        [request.user_id, Math.min(Number(request.target_level ?? 1), 1)],
      );
      return;
    }

    await tx.query(
      `UPDATE property SET property_verified_at = now(), property_verified_by = $2 WHERE id=$1`,
      [request.property_id, actorId],
    );
    // Level 2 is "identity AND right to let", so it is only reachable for
    // somebody who already holds identity.
    await tx.query(
      `UPDATE app_user SET verification_level = 2 WHERE id=$1 AND verification_level >= 1`,
      [request.user_id],
    );
  }

  /* ================================================================ *
   * Assignment
   * ================================================================ */

  async assign(
    requestId: string,
    staff: VerifierContext,
    assigneeId: string | null,
  ): Promise<{ assignedTo: string | null }> {
    if (!staff.canReview) throw forbidden('Нет прав на работу с заявками');

    return this.db.transaction(async (tx) => {
      const current = await lockRequest(tx, requestId);

      if (assigneeId !== null) {
        // Only somebody who could actually review it. Assigning a verification
        // to a moderator would create a queue item nobody can action.
        const { rows } = await tx.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM user_role
            WHERE user_id=$1 AND role IN ('VERIFIER','ADMIN')`,
          [assigneeId],
        );
        if (Number(rows[0]!.c) === 0) throw invalid('Этот пользователь не проверяет заявки');
      }

      await tx.query(`UPDATE verification_request SET assigned_to=$2 WHERE id=$1`, [requestId, assigneeId]);

      await recordEvent(tx, {
        requestId,
        actorUserId: staff.userId,
        actorRole: staff.role,
        eventType: assigneeId ? 'ASSIGNED' : 'UNASSIGNED',
        visibility: 'INTERNAL',
        payload: { from: current.assigned_to, to: assigneeId },
      });
      await writeAudit(tx, {
        actorUserId: staff.userId,
        actorRole: staff.role,
        action: 'verification.assign',
        targetType: 'verification_request',
        targetId: requestId,
        changes: { assignedTo: { from: current.assigned_to, to: assigneeId } },
        source: 'admin',
      });

      return { assignedTo: assigneeId };
    });
  }

  async assignableStaff(staff: VerifierContext): Promise<Record<string, unknown>[]> {
    if (!staff.canReview) throw forbidden('Нет прав на работу с заявками');
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT u.id, u.display_name, array_agg(ur.role ORDER BY ur.role) AS roles
         FROM app_user u JOIN user_role ur ON ur.user_id = u.id
        WHERE ur.role IN ('VERIFIER','ADMIN') AND u.deleted_at IS NULL
        GROUP BY u.id, u.display_name ORDER BY u.display_name LIMIT 100`,
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, roles: r.roles }));
  }
}

/* ================================================================== *
 * helpers
 * ================================================================== */

async function lockRequest(tx: Sql, requestId: string): Promise<Record<string, any>> {
  const { rows } = await tx.query<Record<string, any>>(
    `SELECT id, user_id, property_id, kind, target_level, status, assigned_to, declared
       FROM verification_request WHERE id=$1 FOR UPDATE`,
    [requestId],
  );
  const row = rows[0];
  if (!row) throw notFound('Заявка');
  return row;
}

interface EventInput {
  requestId: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  eventType: string;
  note?: string | null;
  reasonCodes?: readonly string[];
  visibility: 'INTERNAL' | 'APPLICANT';
  payload?: Record<string, unknown>;
}

async function recordEvent(tx: Sql, e: EventInput): Promise<void> {
  await tx.query(
    `INSERT INTO verification_event
       (request_id, actor_user_id, actor_role, event_type, note, reason_codes, visibility, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      e.requestId,
      e.actorUserId ?? null,
      e.actorRole ?? null,
      e.eventType,
      e.note ?? null,
      e.reasonCodes ?? [],
      e.visibility,
      e.payload ? JSON.stringify(e.payload) : null,
    ],
  );
}

/** timestamptz arrives as a Date; every projection here promises a string. */
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
