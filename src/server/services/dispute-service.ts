/**
 * Dispute case operations.
 *
 * The queue, the case file, and every staff action on it. Three rules shape
 * this file, and all three are about restraint rather than capability:
 *
 *   1. LEAST PRIVILEGE ON EVIDENCE. `detail()` takes the caller's permissions
 *      and assembles a different case file for each of them. Message bodies
 *      need `message.review`; the financial picture needs `debt.view`. Nothing
 *      here can reach an identity document at all — that path exists once, in
 *      the verification routes, behind `document.read`, and is logged. There is
 *      no "staff sees everything" shortcut, including for ADMIN.
 *
 *   2. NOTHING BUSINESS-CRITICAL IS DECIDED HERE. A case status is workflow
 *      bookkeeping. The booking, the ledger and the trust score are moved by
 *      their own services through their own state machines, and the console
 *      calls those. A resolved case does not, by itself, change a single
 *      number anywhere.
 *
 *   3. EVERY ACTION IS TWO WRITES. An append-only `case_event` so the case
 *      file reads as a history, and an `audit_log` row so the platform-wide
 *      trail is complete. Both go in the same transaction as the change.
 */

import type { Db, Sql } from '../db/sql.ts';
import {
  applyDisputeAction,
  availableDisputeActions,
  isTerminalDispute,
  isOverdue,
  PRIORITY_RANK_SQL,
  PRIORITY_SQL,
  SLA_HOURS,
  type DisputeAction,
  type DisputeCategory,
  type DisputePriority,
  type DisputeStatus,
} from '../domain/dispute.ts';
import { forbidden, invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

/**
 * What the caller is allowed to see and do. Resolved from the session's roles
 * by the route layer and passed in, so this service never guesses at
 * authorisation and never reads roles itself.
 */
export interface StaffContext {
  readonly userId: string;
  readonly role: string;
  readonly canView: boolean;
  readonly canHandle: boolean;
  readonly canResolve: boolean;
  readonly canReadMessages: boolean;
  readonly canViewFinance: boolean;
}

export interface QueueFilters {
  readonly status?: string;
  readonly priority?: string;
  readonly category?: string;
  readonly city?: string;
  readonly assigned?: string;
  readonly q?: string;
  readonly limit?: number;
  readonly offset?: number;
}

const MAX_PAGE = 50;

export class DisputeService {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------------- *
   * Queue
   * ---------------------------------------------------------------- */

  /**
   * Filtered, ordered and paginated in SQL.
   *
   * The ordering is the point of the screen: a case about somebody currently
   * locked out of a flat they paid for must not sit below a month-old
   * complaint about a slow reply, and "newest first" would put it there.
   * Priority is computed in the database precisely so that ordering and
   * pagination can happen there too — computing it after the rows arrive would
   * mean fetching every case to sort them.
   */
  async queue(
    filters: QueueFilters,
    staff: StaffContext,
  ): Promise<{
    items: Record<string, unknown>[];
    total: number;
    counts: Record<string, number>;
    limit: number;
    offset: number;
  }> {
    if (!staff.canView) throw forbidden('Нет доступа к обращениям');

    const limit = Math.min(Math.max(filters.limit ?? 25, 1), MAX_PAGE);
    const offset = Math.max(filters.offset ?? 0, 0);

    const values: unknown[] = [];
    const push = (v: unknown): string => {
      values.push(v);
      return `$${values.length}`;
    };

    const where: string[] = [];
    if (filters.status && filters.status !== 'ALL') {
      if (filters.status === 'ACTIVE') where.push(`dc.status NOT IN ('RESOLVED','CLOSED')`);
      else where.push(`dc.status = ${push(filters.status)}`);
    }
    if (filters.category) where.push(`dc.category = ${push(filters.category)}`);
    if (filters.city) where.push(`lower(p.city) = lower(${push(filters.city)})`);
    if (filters.assigned === 'ME') where.push(`dc.assigned_to = ${push(staff.userId)}`);
    else if (filters.assigned === 'UNASSIGNED') where.push(`dc.assigned_to IS NULL`);
    else if (filters.assigned) where.push(`dc.assigned_to = ${push(filters.assigned)}`);
    if (filters.q) {
      const like = `%${filters.q}%`;
      where.push(
        `(dc.reference ILIKE ${push(like)} OR dc.summary ILIKE ${push(like)} OR p.title ILIKE ${push(like)} OR b.reference ILIKE ${push(like)})`,
      );
    }

    /* The joins the priority rule needs, and nothing more. `fs` is a lateral
       existence check rather than a join on fraud_signal so a party with many
       signals does not multiply their rows. */
    const from = `
      FROM dispute_case dc
      LEFT JOIN booking b ON b.id = dc.booking_id
      LEFT JOIN property p ON p.id = b.property_id
      LEFT JOIN LATERAL (
        SELECT true AS has_signal FROM fraud_signal f
         WHERE f.user_id IN (dc.opened_by, dc.against_user_id) LIMIT 1
      ) fs ON true`;

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const havingPriority = filters.priority ? `WHERE q.priority = ${push(filters.priority)}` : '';

    const rows = await this.db.query<Record<string, any>>(
      `SELECT * FROM (
         SELECT dc.id, dc.reference, dc.status, dc.category, dc.summary, dc.created_at, dc.updated_at,
                dc.assigned_to, dc.booking_id,
                ${PRIORITY_SQL} AS priority,
                ${PRIORITY_RANK_SQL} AS priority_rank,
                EXTRACT(EPOCH FROM (now() - dc.created_at)) / 3600 AS age_hours,
                b.reference AS booking_reference, b.status AS booking_status,
                lower(b.stay_period)::text AS stay_from, upper(b.stay_period)::text AS stay_to,
                p.title AS property_title, p.city AS property_city,
                opener.display_name AS opened_by_name,
                assignee.display_name AS assignee_name,
                (SELECT count(*)::int FROM case_event ce WHERE ce.case_id = dc.id) AS event_count
           ${from}
           JOIN app_user opener ON opener.id = dc.opened_by
           LEFT JOIN app_user assignee ON assignee.id = dc.assigned_to
         ${whereSql}
       ) q
       ${havingPriority}
       ORDER BY
         /* Terminal cases last whatever their priority: they need nobody. */
         CASE WHEN q.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END,
         q.priority_rank,
         q.created_at ASC
       LIMIT ${push(limit)} OFFSET ${push(offset)}`,
      values,
    );

    // Counts for the tabs, from the same filter-free base so a tab always shows
    // how many cases are in it rather than how many survived the current search.
    const counts = await this.db.query<{ status: string; total: string }>(
      `SELECT status, count(*)::text AS total FROM dispute_case GROUP BY status`,
    );
    const countFor: Record<string, number> = {};
    let total = 0;
    for (const r of counts.rows) {
      countFor[r.status] = Number(r.total);
      total += Number(r.total);
    }
    countFor.ALL = total;
    countFor.ACTIVE = total - (countFor.RESOLVED ?? 0) - (countFor.CLOSED ?? 0);

    return {
      items: rows.rows.map((r) => this.presentQueueRow(r)),
      total,
      counts: countFor,
      limit,
      offset,
    };
  }

  private presentQueueRow(r: Record<string, any>): Record<string, unknown> {
    const ageHours = Number(r.age_hours);
    const priority = r.priority as DisputePriority;
    return {
      id: r.id,
      reference: r.reference,
      status: r.status,
      category: r.category,
      // Truncated: a queue row is for triage, and the full text is one click
      // away on the case itself.
      summary: String(r.summary).slice(0, 160),
      priority,
      ageHours: Math.round(ageHours),
      overdue: !isTerminalDispute(r.status as DisputeStatus) && isOverdue(priority, ageHours),
      slaHours: SLA_HOURS[priority],
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      bookingId: r.booking_id,
      bookingReference: r.booking_reference,
      bookingStatus: r.booking_status,
      stay: r.stay_from ? { from: r.stay_from, to: r.stay_to } : null,
      propertyTitle: r.property_title,
      propertyCity: r.property_city,
      openedByName: r.opened_by_name,
      assignedTo: r.assigned_to,
      assigneeName: r.assignee_name,
      eventCount: Number(r.event_count),
    };
  }

  /* ---------------------------------------------------------------- *
   * Case file
   * ---------------------------------------------------------------- */

  /**
   * Everything the caller is entitled to see about one case.
   *
   * Each evidence section is gated separately, and a section the caller cannot
   * have is ABSENT rather than empty — an empty `messages: []` would read as
   * "there was no conversation", which is a different and false statement.
   */
  async detail(caseId: string, staff: StaffContext): Promise<Record<string, unknown>> {
    if (!staff.canView) throw notFound('Обращение');

    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT dc.*,
              ${PRIORITY_SQL} AS priority,
              EXTRACT(EPOCH FROM (now() - dc.created_at)) / 3600 AS age_hours,
              b.reference AS booking_reference, b.status AS booking_status,
              b.nights, b.guests,
              lower(b.stay_period)::text AS stay_from, upper(b.stay_period)::text AS stay_to,
              b.rent_minor::text AS rent_minor,
              b.total_expected_minor::text AS total_expected_minor,
              b.checked_in_at, b.completion_deadline_at,
              b.tenant_completion_answer, b.landlord_completion_answer,
              b.tenant_id, b.landlord_id,
              p.id AS property_id, p.title AS property_title, p.city AS property_city,
              p.district AS property_district, p.status AS property_status
         FROM dispute_case dc
         LEFT JOIN booking b ON b.id = dc.booking_id
         LEFT JOIN property p ON p.id = b.property_id
         LEFT JOIN LATERAL (
           SELECT true AS has_signal FROM fraud_signal f
            WHERE f.user_id IN (dc.opened_by, dc.against_user_id) LIMIT 1
         ) fs ON true
        WHERE dc.id = $1`,
      [caseId],
    );

    const c = rows[0];
    if (!c) throw notFound('Обращение');

    const priority = c.priority as DisputePriority;
    const ageHours = Number(c.age_hours);

    const [events, parties, bookingEvents, stayEvents, reviews, fraudSignals, moderation] =
      await Promise.all([
        this.caseEvents(caseId),
        this.parties(c),
        c.booking_id ? this.bookingTimeline(c.booking_id) : Promise.resolve([]),
        c.booking_id ? this.stayEvents(c.booking_id) : Promise.resolve([]),
        c.booking_id ? this.reviewState(c.booking_id) : Promise.resolve([]),
        this.fraudSignals(c),
        c.property_id ? this.moderationHistory(c.property_id) : Promise.resolve([]),
      ]);

    const detail: Record<string, unknown> = {
      id: c.id,
      reference: c.reference,
      status: c.status,
      category: c.category,
      summary: c.summary,
      priority,
      ageHours: Math.round(ageHours),
      overdue: !isTerminalDispute(c.status as DisputeStatus) && isOverdue(priority, ageHours),
      slaHours: SLA_HOURS[priority],
      createdAt: iso(c.created_at),
      updatedAt: iso(c.updated_at),
      resolution: c.resolution,
      resolvedAt: iso(c.resolved_at),
      assignedTo: c.assigned_to,

      booking: c.booking_id
        ? {
            id: c.booking_id,
            reference: c.booking_reference,
            status: c.booking_status,
            stay: { from: c.stay_from, to: c.stay_to, nights: Number(c.nights) },
            guests: c.guests,
            checkedInAt: iso(c.checked_in_at),
            completion: {
              tenantAnswer: c.tenant_completion_answer,
              landlordAnswer: c.landlord_completion_answer,
              deadlineAt: iso(c.completion_deadline_at),
            },
          }
        : null,

      property: c.property_id
        ? {
            id: c.property_id,
            title: c.property_title,
            // City and district only. The exact address has one
            // entitlement-checked accessor (DEC-020) and a dispute is not it.
            city: c.property_city,
            district: c.property_district,
            status: c.property_status,
          }
        : null,

      parties,
      timeline: [...events, ...bookingEvents, ...stayEvents].sort((a, b) =>
        String(a.at).localeCompare(String(b.at)),
      ),
      reviewState: reviews,
      fraudSignals,
      moderationHistory: moderation,

      // What this particular caller may do next, from the same table the
      // service enforces — so the console cannot offer a refused action.
      availableActions: availableDisputeActions(c.status as DisputeStatus, {
        canHandle: staff.canHandle,
        canResolve: staff.canResolve,
      }).map((t) => ({ action: t.action, to: t.to, requiresReason: t.requiresReason })),

      // Named so the console can explain an absence rather than imply a zero.
      entitlements: {
        messages: staff.canReadMessages,
        finance: staff.canViewFinance,
        // Nobody reaches an identity document from here, whatever their role.
        identityDocuments: false,
      },
    };

    if (staff.canReadMessages && c.booking_id) {
      detail.messages = await this.conversation(c.booking_id);
    }
    if (staff.canViewFinance && c.booking_id) {
      detail.finance = await this.financeState(c.booking_id, c.landlord_id);
    }

    return detail;
  }

  /* --- evidence sections ------------------------------------------ */

  private async caseEvents(caseId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT ce.id, ce.occurred_at, ce.event_type, ce.note, ce.actor_role, ce.visibility,
              u.display_name AS actor_name
         FROM case_event ce
         LEFT JOIN app_user u ON u.id = ce.actor_user_id
        WHERE ce.case_id = $1 ORDER BY ce.occurred_at, ce.id`,
      [caseId],
    );
    return rows.map((r) => ({
      kind: 'CASE' as const,
      at: iso(r.occurred_at),
      type: r.event_type,
      note: r.note,
      actorName: r.actor_name,
      actorRole: r.actor_role,
      internal: r.visibility === 'INTERNAL',
    }));
  }

  /**
   * The two parties, as public trust facts only.
   *
   * No email, no phone, no verification internals — the same projection a
   * counterparty gets. A staff member deciding a case needs to know who these
   * people are and what their history is; contacting them happens through the
   * platform, so their contact details are not part of the job.
   */
  private async parties(c: Record<string, any>): Promise<Record<string, unknown>[]> {
    const ids = [c.opened_by, c.against_user_id].filter(Boolean) as string[];
    if (ids.length === 0) return [];

    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT u.id, u.display_name, u.account_kind, u.verification_level, u.status, u.created_at,
              u.completed_rentals_as_tenant, u.completed_rentals_as_landlord,
              (SELECT round(avg(r.overall)::numeric,2) FROM review r
                WHERE r.subject_id = u.id AND r.status='PUBLISHED') AS rating,
              (SELECT count(*)::int FROM dispute_case d
                WHERE d.opened_by = u.id OR d.against_user_id = u.id) AS case_count
         FROM app_user u WHERE u.id = ANY($1::uuid[])`,
      [ids],
    );

    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      accountKind: r.account_kind,
      identityVerified: Number(r.verification_level) >= 1,
      accountStatus: r.status,
      memberSince: iso(r.created_at),
      completedAsTenant: Number(r.completed_rentals_as_tenant),
      completedAsLandlord: Number(r.completed_rentals_as_landlord),
      rating: r.rating === null ? null : Number(r.rating),
      totalCases: Number(r.case_count),
      role:
        r.id === c.tenant_id ? 'TENANT' : r.id === c.landlord_id ? 'LANDLORD' : null,
      side: r.id === c.opened_by ? 'OPENED' : 'AGAINST',
    }));
  }

  private async bookingTimeline(bookingId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT event_type, actor, from_status, to_status, occurred_at
         FROM booking_event WHERE booking_id = $1 ORDER BY id`,
      [bookingId],
    );
    return rows.map((r) => ({
      kind: 'BOOKING' as const,
      at: iso(r.occurred_at),
      type: r.event_type,
      from: r.from_status,
      to: r.to_status,
      actorRole: r.actor,
    }));
  }

  private async stayEvents(bookingId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT kind, reported_by, occurred_at, note FROM stay_event
        WHERE booking_id = $1 ORDER BY occurred_at`,
      [bookingId],
    );
    return rows.map((r) => ({
      kind: 'STAY' as const,
      at: iso(r.occurred_at),
      // Prefixed so it cannot collide with the booking event of the same name.
      // They are two different facts — one is a party's own record of arriving,
      // the other is the booking changing state — and a timeline that labels
      // both "Заселение" reads like a duplicated row rather than corroboration.
      type: `STAY_${r.kind}`,
      actorRole: r.reported_by,
      note: r.note,
    }));
  }

  private async reviewState(bookingId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT author_role, overall, status, created_at, published_at FROM review
        WHERE booking_id = $1 ORDER BY created_at`,
      [bookingId],
    );
    // Ratings and state, not the text. Whether a review exists and what it
    // scored is relevant evidence; reading an unpublished one would let staff
    // see what the publication delay is meant to conceal.
    return rows.map((r) => ({
      authorRole: r.author_role,
      overall: r.overall,
      status: r.status,
      createdAt: iso(r.created_at),
      publishedAt: iso(r.published_at),
    }));
  }

  private async fraudSignals(c: Record<string, any>): Promise<Record<string, unknown>[]> {
    const ids = [c.opened_by, c.against_user_id].filter(Boolean) as string[];
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<Record<string, any>>(
      // `detected_at`, not `created_at`: a signal is recorded when the platform
      // noticed it, and the column says so.
      `SELECT user_id, kind, severity, detected_at, review_outcome FROM fraud_signal
        WHERE user_id = ANY($1::uuid[]) ORDER BY detected_at DESC LIMIT 20`,
      [ids],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      kind: r.kind,
      severity: Number(r.severity),
      outcome: r.review_outcome,
      createdAt: iso(r.detected_at),
    }));
  }

  private async moderationHistory(propertyId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT decision, reason_codes, from_status, created_at FROM listing_moderation_review
        WHERE property_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [propertyId],
    );
    return rows.map((r) => ({
      decision: r.decision,
      reasonCodes: r.reason_codes ?? [],
      fromStatus: r.from_status,
      createdAt: iso(r.created_at),
    }));
  }

  /** `message.review` only. Original text included: moderating a redaction without seeing what was redacted is impossible. */
  private async conversation(bookingId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT m.id, m.sender_id, m.body, m.body_original, m.moderation_state, m.created_at,
              u.display_name AS sender_name
         FROM message m
         JOIN conversation c ON c.id = m.conversation_id
         LEFT JOIN app_user u ON u.id = m.sender_id
        WHERE c.booking_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.created_at LIMIT 200`,
      [bookingId],
    );
    return rows.map((r) => ({
      id: r.id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      body: r.body,
      originalBody: r.body_original,
      moderationState: r.moderation_state,
      createdAt: iso(r.created_at),
    }));
  }

  /** `debt.view` only. Read-only: nothing in this service writes to the ledger. */
  private async financeState(bookingId: string, landlordId: string | null): Promise<Record<string, unknown>> {
    const [fee, balance] = await Promise.all([
      this.db.query<Record<string, any>>(
        `SELECT base_minor::text AS base_minor, bps, fee_minor::text AS fee_minor,
                status, accrued_at, due_at, settled_at
           FROM service_fee WHERE booking_id = $1`,
        [bookingId],
      ),
      landlordId
        ? this.db.query<{ balance: string }>(
            `SELECT COALESCE(SUM(amount_minor),0)::text AS balance FROM ledger_entry WHERE landlord_id=$1`,
            [landlordId],
          )
        : Promise.resolve({ rows: [{ balance: '0' }] }),
    ]);

    const f = fee.rows[0];
    return {
      fee: f
        ? {
            baseMinor: f.base_minor,
            ratePercent: Number(f.bps) / 100,
            feeMinor: f.fee_minor,
            status: f.status,
            accruedAt: iso(f.accrued_at),
            dueAt: iso(f.due_at),
            settledAt: iso(f.settled_at),
          }
        : null,
      landlordBalanceMinor: balance.rows[0]?.balance ?? '0',
    };
  }

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */

  /**
   * Move a case through its workflow.
   *
   * The pure table decides whether the move is legal and whether it needs a
   * reason; this method only performs it. A terminal status additionally
   * records who decided and what they decided, which the database enforces
   * (`dispute_case_resolution_is_recorded`) rather than trusting this code.
   */
  async act(
    caseId: string,
    staff: StaffContext,
    action: DisputeAction,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    if (!staff.canView) throw notFound('Обращение');

    const written = reason?.trim() ?? '';

    return this.db.transaction(async (tx) => {
      const current = await lockCase(tx, caseId);
      const transition = applyDisputeAction(current.status as DisputeStatus, action, {
        hasReason: written.length > 0,
      });

      // The table says which permission this move costs; the caller's
      // entitlement is checked against that, not against a role name.
      const allowed = transition.permission === 'case.resolve' ? staff.canResolve : staff.canHandle;
      if (!allowed) throw forbidden('Недостаточно прав для этого действия');

      const terminal = isTerminalDispute(transition.to);
      await tx.query(
        `UPDATE dispute_case
            SET status = $2,
                resolution = CASE WHEN $4 THEN $3 ELSE resolution END,
                resolved_at = CASE WHEN $4 THEN now() ELSE resolved_at END,
                resolved_by = CASE WHEN $4 THEN $5 ELSE resolved_by END
          WHERE id = $1`,
        [caseId, transition.to, written, terminal, staff.userId],
      );

      /* REQUEST_INFORMATION is the one action whose text is meant for a
         party, so it is the one case_event visible to them. Everything else
         staff writes stays internal — a resolution rationale is a record for
         the platform, not a letter to the parties, and the message they do
         receive is sent separately through the notification service. */
      await recordCaseEvent(tx, {
        caseId,
        actorUserId: staff.userId,
        actorRole: staff.role,
        eventType: `STATUS_${action}`,
        note: written || null,
        visibility: action === 'REQUEST_INFORMATION' ? 'PARTIES' : 'INTERNAL',
        payload: { from: current.status, to: transition.to },
      });

      await writeAudit(tx, {
        actorUserId: staff.userId,
        actorRole: staff.role,
        action: `dispute.${action.toLowerCase()}`,
        targetType: 'dispute_case',
        targetId: caseId,
        changes: { status: { from: current.status, to: transition.to } },
        reason: written || null,
        source: 'admin',
      });

      return { id: caseId, status: transition.to, previousStatus: current.status };
    });
  }

  /**
   * An internal note.
   *
   * Never reaches a tenant or a landlord: `visibility = 'INTERNAL'`, and the
   * only reader is a caller who already holds `case.view`. Immutable, because
   * `case_event` is append-only — a note cannot be quietly rewritten after the
   * case is decided.
   */
  async addNote(caseId: string, staff: StaffContext, note: string): Promise<{ id: string }> {
    if (!staff.canHandle) throw forbidden('Нет прав на работу с обращениями');
    const text = note.trim();
    if (text.length < 2) throw invalid('Заметка не может быть пустой');

    return this.db.transaction(async (tx) => {
      await lockCase(tx, caseId);
      await recordCaseEvent(tx, {
        caseId,
        actorUserId: staff.userId,
        actorRole: staff.role,
        eventType: 'INTERNAL_NOTE',
        note: text,
        visibility: 'INTERNAL',
      });
      await writeAudit(tx, {
        actorUserId: staff.userId,
        actorRole: staff.role,
        action: 'dispute.note',
        targetType: 'dispute_case',
        targetId: caseId,
        source: 'admin',
      });
      return { id: caseId };
    });
  }

  /** Assign, reassign or unassign. Deliberately not a workforce system. */
  async assign(caseId: string, staff: StaffContext, assigneeId: string | null): Promise<{ assignedTo: string | null }> {
    if (!staff.canHandle) throw forbidden('Нет прав на работу с обращениями');

    return this.db.transaction(async (tx) => {
      const current = await lockCase(tx, caseId);

      if (assigneeId !== null) {
        // Only somebody who could actually work the case may be given it.
        const { rows } = await tx.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM user_role
            WHERE user_id = $1 AND role IN ('ADMIN','SUPPORT','MODERATOR')`,
          [assigneeId],
        );
        if (Number(rows[0]!.c) === 0) throw invalid('Этот пользователь не работает с обращениями');
      }

      await tx.query(`UPDATE dispute_case SET assigned_to = $2 WHERE id = $1`, [caseId, assigneeId]);

      await recordCaseEvent(tx, {
        caseId,
        actorUserId: staff.userId,
        actorRole: staff.role,
        eventType: assigneeId ? 'ASSIGNED' : 'UNASSIGNED',
        visibility: 'INTERNAL',
        payload: { from: current.assigned_to, to: assigneeId },
      });
      await writeAudit(tx, {
        actorUserId: staff.userId,
        actorRole: staff.role,
        action: 'dispute.assign',
        targetType: 'dispute_case',
        targetId: caseId,
        changes: { assignedTo: { from: current.assigned_to, to: assigneeId } },
        source: 'admin',
      });

      return { assignedTo: assigneeId };
    });
  }

  /** Who a case may be handed to. Names and roles only. */
  async assignableStaff(staff: StaffContext): Promise<Record<string, unknown>[]> {
    if (!staff.canHandle) throw forbidden('Нет прав на работу с обращениями');
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT u.id, u.display_name, array_agg(ur.role ORDER BY ur.role) AS roles
         FROM app_user u JOIN user_role ur ON ur.user_id = u.id
        WHERE ur.role IN ('ADMIN','SUPPORT','MODERATOR') AND u.deleted_at IS NULL
        GROUP BY u.id, u.display_name ORDER BY u.display_name LIMIT 100`,
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, roles: r.roles }));
  }

  /** Case ids and references the parties themselves may see for a booking. */
  async forBooking(bookingId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT id, reference, category, status, created_at, resolved_at, resolution
         FROM dispute_case WHERE booking_id = $1 ORDER BY created_at DESC`,
      [bookingId],
    );
    return rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      category: r.category as DisputeCategory,
      status: r.status,
      createdAt: iso(r.created_at),
      resolvedAt: iso(r.resolved_at),
      // The resolution text is the platform's decision about them, so the
      // parties see it once the case is decided. Internal notes never are.
      resolution: r.resolved_at ? r.resolution : null,
    }));
  }

  /* ---------------------------------------------------------------- *
   * Operations overview
   * ---------------------------------------------------------------- */

  /**
   * What needs a person right now. Counts only where a count leads to an
   * action — no totals for their own sake.
   */
  async overview(staff: StaffContext): Promise<Record<string, unknown>> {
    if (!staff.canView) throw forbidden('Нет доступа');

    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT
         (SELECT count(*)::int FROM dispute_case WHERE status = 'OPEN') AS open_cases,
         (SELECT count(*)::int FROM dispute_case WHERE status = 'ESCALATED') AS escalated_cases,
         (SELECT count(*)::int FROM dispute_case WHERE status NOT IN ('RESOLVED','CLOSED') AND assigned_to IS NULL) AS unassigned_cases,
         (SELECT count(*)::int FROM dispute_case WHERE status NOT IN ('RESOLVED','CLOSED') AND assigned_to = $1) AS mine,
         (SELECT count(*)::int FROM dispute_case dc
            LEFT JOIN booking b ON b.id = dc.booking_id
           WHERE dc.status NOT IN ('RESOLVED','CLOSED')
             AND (dc.category IN ('SAFETY_CONCERN','SUSPECTED_FRAUD')
                  OR b.status IN ('CONFIRMED','CHECKED_IN'))) AS pressing_cases,
         (SELECT count(*)::int FROM property WHERE status = 'PENDING_MODERATION' AND deleted_at IS NULL) AS pending_listings,
         (SELECT count(*)::int FROM report WHERE status IN ('OPEN','REVIEWING')) AS open_reports,
         (SELECT count(*)::int FROM message WHERE moderation_state IN ('FLAGGED','BLOCKED')) AS flagged_messages,
         (SELECT count(*)::int FROM verification_request WHERE status IN ('SUBMITTED','IN_REVIEW')) AS pending_verifications,
         (SELECT count(*)::int FROM booking WHERE status = 'DISPUTED') AS frozen_bookings,
         (SELECT count(*)::int FROM service_fee WHERE status = 'PAYABLE' AND due_at < now()) AS overdue_fees`,
      [staff.userId],
    );

    const c = rows[0] ?? {};
    return {
      disputes: {
        open: Number(c.open_cases ?? 0),
        escalated: Number(c.escalated_cases ?? 0),
        unassigned: Number(c.unassigned_cases ?? 0),
        mine: Number(c.mine ?? 0),
        pressing: Number(c.pressing_cases ?? 0),
      },
      // Sections the caller cannot act on are still counted here, but the
      // console only renders the ones their permissions cover.
      moderation: { pendingListings: Number(c.pending_listings ?? 0) },
      reports: { open: Number(c.open_reports ?? 0), flaggedMessages: Number(c.flagged_messages ?? 0) },
      verification: { pending: Number(c.pending_verifications ?? 0) },
      finance: {
        frozenBookings: Number(c.frozen_bookings ?? 0),
        overdueFees: Number(c.overdue_fees ?? 0),
      },
    };
  }
}

/* ================================================================== *
 * helpers
 * ================================================================== */

async function lockCase(tx: Sql, caseId: string): Promise<Record<string, any>> {
  const { rows } = await tx.query<Record<string, any>>(
    `SELECT id, status, assigned_to, booking_id, opened_by, against_user_id
       FROM dispute_case WHERE id = $1 FOR UPDATE`,
    [caseId],
  );
  const row = rows[0];
  if (!row) throw notFound('Обращение');
  return row;
}

interface CaseEventInput {
  caseId: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  eventType: string;
  note?: string | null;
  visibility: 'INTERNAL' | 'PARTIES';
  payload?: Record<string, unknown>;
}

export async function recordCaseEvent(tx: Sql, e: CaseEventInput): Promise<void> {
  await tx.query(
    `INSERT INTO case_event (case_id, actor_user_id, actor_role, event_type, note, visibility, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      e.caseId,
      e.actorUserId ?? null,
      e.actorRole ?? null,
      e.eventType,
      e.note ?? null,
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
