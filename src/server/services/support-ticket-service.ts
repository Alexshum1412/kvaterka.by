/**
 * Support ticket operations.
 *
 * The general-purpose "contact support" channel (DEC-073): the queue, the
 * ticket file, and every action on it — the same shape as
 * `DisputeService`, deliberately smaller. Two of that file's three rules
 * still apply here:
 *
 *   1. NOTHING BUSINESS-CRITICAL IS DECIDED HERE. A ticket never touches a
 *      booking, a listing or the ledger. It optionally NAMES a listing
 *      (`property_id`), but this service never writes one.
 *
 *   2. EVERY STATUS CHANGE IS TWO WRITES. An append-only `ticket_event` so
 *      the ticket reads as a history — and doubles as the "support chat"
 *      thread once the UI renders its PARTIES-visible rows as messages —
 *      plus an `audit_log` row so the platform-wide trail is complete. Both
 *      go in the same transaction as the change.
 *
 * The dispute service's first rule (least privilege on evidence — a
 * different case file per permission) does not apply: a ticket carries no
 * message history, no finance section and no identity documents to gate,
 * so there is only one case file, shown to anyone holding `case.view`.
 */

import type { Db, Sql } from '../db/sql.ts';
import { uuidv7, humanReference } from '../../lib/id.ts';
import {
  applyTicketAction,
  availableTicketActions,
  isTerminalTicket,
  TICKET_CATEGORIES,
  TICKET_TRANSITIONS,
  type TicketAction,
  type TicketCategory,
  type TicketStatus,
} from '../domain/support-ticket.ts';
import { forbidden, invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

/**
 * What the caller is allowed to do. Resolved from the session's roles by the
 * route layer and passed in, so this service never guesses at authorisation
 * — identical arrangement to `DisputeService`'s `StaffContext`, minus the
 * evidence-gating booleans a ticket has no use for.
 */
export interface TicketStaffContext {
  readonly userId: string;
  readonly role: string;
  readonly canView: boolean;
  readonly canHandle: boolean;
  readonly canResolve: boolean;
}

export interface TicketQueueFilters {
  readonly status?: string;
  readonly category?: string;
  readonly assigned?: string;
  readonly q?: string;
  readonly limit?: number;
  readonly offset?: number;
}

const MAX_PAGE = 50;

export class TicketService {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------------- *
   * Creation and the user's own view
   * ---------------------------------------------------------------- */

  /**
   * Open a ticket. Always OPEN, always the caller's own — there is no way
   * to file one on somebody else's behalf, which is also why this needs no
   * permission check: every signed-in person may ask for help.
   */
  async create(
    userId: string,
    input: { category: TicketCategory; propertyId?: string | null; summary: string },
  ): Promise<{ id: string; reference: string }> {
    const summary = input.summary.trim();
    if (summary.length < 10) throw invalid('Опишите проблему подробнее — минимум 10 символов');
    if (!TICKET_CATEGORIES.includes(input.category)) throw invalid('Неизвестная категория обращения');

    return this.db.transaction(async (tx) => {
      if (input.propertyId) {
        // Existence only, deliberately no ownership check: "this listing
        // looks like a scam" legitimately names someone ELSE's property.
        const { rows } = await tx.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM property WHERE id = $1`,
          [input.propertyId],
        );
        if (Number(rows[0]!.c) === 0) throw invalid('Объявление не найдено');
      }

      const id = uuidv7();
      const reference = humanReference('TK');
      await tx.query(
        `INSERT INTO support_ticket (id, reference, opened_by, category, property_id, summary, status)
         VALUES ($1,$2,$3,$4,$5,$6,'OPEN')`,
        [id, reference, userId, input.category, input.propertyId ?? null, summary],
      );

      // Visible to the author: this is their own account of their own
      // problem, the same reasoning `OPENED_BY_PARTY` uses for a dispute.
      await recordTicketEvent(tx, {
        ticketId: id,
        actorUserId: userId,
        actorRole: 'USER',
        eventType: 'OPENED',
        note: summary,
        visibility: 'PARTIES',
      });

      await writeAudit(tx, {
        actorUserId: userId,
        action: 'ticket.create',
        targetType: 'support_ticket',
        targetId: id,
        source: 'web',
      });

      return { id, reference };
    });
  }

  /** The caller's own tickets, newest first. */
  async myTickets(userId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT st.id, st.reference, st.status, st.category, st.summary,
              st.created_at, st.updated_at, st.resolved_at,
              p.title AS property_title
         FROM support_ticket st
         LEFT JOIN property p ON p.id = st.property_id
        WHERE st.opened_by = $1
        ORDER BY st.created_at DESC`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status,
      category: r.category as TicketCategory,
      summary: String(r.summary).slice(0, 160),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      resolvedAt: iso(r.resolved_at),
      propertyTitle: r.property_title,
    }));
  }

  /**
   * One ticket, as its own author sees it — only ever their own. A ticket
   * that exists but belongs to somebody else reads exactly like one that
   * does not exist, same anti-enumeration answer `DisputeService` gives a
   * party probing a case id that is not theirs.
   *
   * Only `PARTIES`-visible events are ever assembled here: an internal
   * staff note must never reach this projection, whatever else changes
   * about it later.
   */
  async ownDetail(ticketId: string, userId: string): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT st.*, p.title AS property_title, p.city AS property_city
         FROM support_ticket st
         LEFT JOIN property p ON p.id = st.property_id
        WHERE st.id = $1 AND st.opened_by = $2`,
      [ticketId, userId],
    );
    const t = rows[0];
    if (!t) throw notFound('Обращение');

    const events = await this.partyEvents(ticketId);

    return {
      id: t.id,
      reference: t.reference,
      status: t.status,
      category: t.category as TicketCategory,
      summary: t.summary,
      createdAt: iso(t.created_at),
      updatedAt: iso(t.updated_at),
      // The decision itself, once there is one — same rule
      // `DisputeService.forBooking()` uses: the platform's verdict about you
      // is yours to see the moment it exists; the internal path to it is not.
      resolution: t.resolved_at ? t.resolution : null,
      resolvedAt: iso(t.resolved_at),
      property: t.property_id ? { id: t.property_id, title: t.property_title, city: t.property_city } : null,
      canReply: !['RESOLVED', 'CLOSED'].includes(t.status),
      messages: events,
    };
  }

  /**
   * The user's own reply — the other half of the "support chat": staff's
   * `REQUEST_INFO` note is the platform's line, this is the person's.
   *
   * A reply while `WAITING_ON_USER` moves the ticket back to `IN_PROGRESS`
   * automatically. This is NOT run through `applyTicketAction()` — that
   * table is gated by STAFF permission (`case.handle`/`case.resolve`), and
   * nothing here is a staff action; it is a direct consequence of the
   * person answering. The status vocabulary stays the one the transition
   * table defines, only the actor granted to move it is different.
   */
  async reply(
    ticketId: string,
    userId: string,
    message: string,
  ): Promise<{ id: string; status: TicketStatus; eventId: string }> {
    const text = message.trim();
    if (text.length < 2) throw invalid('Сообщение не может быть пустым');

    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string; status: TicketStatus }>(
        `SELECT id, status FROM support_ticket WHERE id = $1 AND opened_by = $2 FOR UPDATE`,
        [ticketId, userId],
      );
      const current = rows[0];
      if (!current) throw notFound('Обращение');
      if (isTerminalTicket(current.status)) {
        throw invalid('Обращение уже закрыто. Если проблема повторилась, создайте новое обращение.');
      }

      // The event's own id, not the wall clock, is what the caller uses to
      // dedupe the notification it sends about this reply — deterministic
      // under a retried request, unlike a timestamp taken here.
      const eventId = await recordTicketEvent(tx, {
        ticketId,
        actorUserId: userId,
        actorRole: 'USER',
        eventType: 'USER_REPLY',
        note: text,
        visibility: 'PARTIES',
      });

      let status = current.status;
      if (status === 'WAITING_ON_USER') {
        status = 'IN_PROGRESS';
        await tx.query(`UPDATE support_ticket SET status = 'IN_PROGRESS' WHERE id = $1`, [ticketId]);
        await recordTicketEvent(tx, {
          ticketId,
          actorUserId: userId,
          actorRole: 'USER',
          eventType: 'RESUMED_BY_REPLY',
          visibility: 'INTERNAL',
          payload: { from: 'WAITING_ON_USER', to: 'IN_PROGRESS' },
        });
      }

      await writeAudit(tx, {
        actorUserId: userId,
        action: 'ticket.reply',
        targetType: 'support_ticket',
        targetId: ticketId,
        source: 'web',
      });

      return { id: ticketId, status, eventId };
    });
  }

  private async partyEvents(ticketId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT te.id, te.occurred_at, te.event_type, te.note, te.actor_role, te.actor_user_id,
              u.display_name AS actor_name
         FROM ticket_event te
         LEFT JOIN app_user u ON u.id = te.actor_user_id
        WHERE te.ticket_id = $1 AND te.visibility = 'PARTIES'
        ORDER BY te.occurred_at, te.id`,
      [ticketId],
    );
    return rows.map((r) => ({
      at: iso(r.occurred_at),
      type: r.event_type,
      note: r.note,
      actorName: r.actor_name,
      actorRole: r.actor_role,
      // The one fact the "chat" bubble needs to align left/right: whether
      // this line came from the ticket's own author or from staff.
      fromAuthor: r.actor_role === 'USER',
    }));
  }

  /* ---------------------------------------------------------------- *
   * Staff queue and ticket file
   * ---------------------------------------------------------------- */

  async queue(
    filters: TicketQueueFilters,
    staff: TicketStaffContext,
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
      if (filters.status === 'ACTIVE') where.push(`st.status NOT IN ('RESOLVED','CLOSED')`);
      else where.push(`st.status = ${push(filters.status)}`);
    }
    if (filters.category) where.push(`st.category = ${push(filters.category)}`);
    if (filters.assigned === 'ME') where.push(`st.assigned_to = ${push(staff.userId)}`);
    else if (filters.assigned === 'UNASSIGNED') where.push(`st.assigned_to IS NULL`);
    else if (filters.assigned) where.push(`st.assigned_to = ${push(filters.assigned)}`);
    if (filters.q) {
      const like = `%${filters.q}%`;
      where.push(`(st.reference ILIKE ${push(like)} OR st.summary ILIKE ${push(like)} OR p.title ILIKE ${push(like)})`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await this.db.query<Record<string, any>>(
      `SELECT st.id, st.reference, st.status, st.category, st.summary, st.created_at, st.updated_at,
              st.assigned_to, st.property_id,
              EXTRACT(EPOCH FROM (now() - st.created_at)) / 3600 AS age_hours,
              p.title AS property_title, p.city AS property_city,
              opener.display_name AS opened_by_name,
              assignee.display_name AS assignee_name,
              (SELECT count(*)::int FROM ticket_event te WHERE te.ticket_id = st.id) AS event_count
         FROM support_ticket st
         LEFT JOIN property p ON p.id = st.property_id
         JOIN app_user opener ON opener.id = st.opened_by
         LEFT JOIN app_user assignee ON assignee.id = st.assigned_to
       ${whereSql}
       ORDER BY
         -- Terminal tickets last whatever their age: they need nobody.
         CASE WHEN st.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END,
         st.created_at ASC
       LIMIT ${push(limit)} OFFSET ${push(offset)}`,
      values,
    );

    // Counts for the tabs, from the same filter-free base so a tab always
    // shows how many tickets are in it rather than how many survived the
    // current search — same reasoning as DisputeService.queue.
    const counts = await this.db.query<{ status: string; total: string }>(
      `SELECT status, count(*)::text AS total FROM support_ticket GROUP BY status`,
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
    return {
      id: r.id,
      reference: r.reference,
      status: r.status,
      category: r.category as TicketCategory,
      summary: String(r.summary).slice(0, 160),
      ageHours: Math.round(Number(r.age_hours)),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      propertyId: r.property_id,
      propertyTitle: r.property_title,
      propertyCity: r.property_city,
      openedByName: r.opened_by_name,
      assignedTo: r.assigned_to,
      assigneeName: r.assignee_name,
      eventCount: Number(r.event_count),
    };
  }

  /** The full ticket file, for a caller holding `case.view`. */
  async detail(ticketId: string, staff: TicketStaffContext): Promise<Record<string, unknown>> {
    if (!staff.canView) throw notFound('Обращение');

    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT st.*, p.title AS property_title, p.city AS property_city,
              opener.display_name AS opened_by_name, opener.email AS opened_by_email,
              EXTRACT(EPOCH FROM (now() - st.created_at)) / 3600 AS age_hours
         FROM support_ticket st
         LEFT JOIN property p ON p.id = st.property_id
         JOIN app_user opener ON opener.id = st.opened_by
        WHERE st.id = $1`,
      [ticketId],
    );
    const t = rows[0];
    if (!t) throw notFound('Обращение');

    const events = await this.allEvents(ticketId);

    return {
      id: t.id,
      reference: t.reference,
      status: t.status,
      category: t.category as TicketCategory,
      summary: t.summary,
      ageHours: Math.round(Number(t.age_hours)),
      createdAt: iso(t.created_at),
      updatedAt: iso(t.updated_at),
      resolution: t.resolution,
      resolvedAt: iso(t.resolved_at),
      assignedTo: t.assigned_to,
      openedBy: { id: t.opened_by, displayName: t.opened_by_name, email: t.opened_by_email },
      property: t.property_id ? { id: t.property_id, title: t.property_title, city: t.property_city } : null,
      timeline: events,
      // What this caller may do next, from the same table the service
      // enforces — the console cannot offer a refused move.
      availableActions: availableTicketActions(t.status as TicketStatus, {
        canHandle: staff.canHandle,
        canResolve: staff.canResolve,
      }).map((tr) => ({ action: tr.action, to: tr.to, requiresReason: tr.requiresReason })),
    };
  }

  private async allEvents(ticketId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT te.occurred_at, te.event_type, te.note, te.actor_role, te.visibility,
              u.display_name AS actor_name
         FROM ticket_event te
         LEFT JOIN app_user u ON u.id = te.actor_user_id
        WHERE te.ticket_id = $1 ORDER BY te.occurred_at, te.id`,
      [ticketId],
    );
    return rows.map((r) => ({
      at: iso(r.occurred_at),
      type: r.event_type,
      note: r.note,
      actorName: r.actor_name,
      actorRole: r.actor_role,
      internal: r.visibility === 'INTERNAL',
    }));
  }

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */

  /**
   * Move a ticket through its workflow. Same shape as `DisputeService.act`:
   * the pure table decides whether the move is legal and whether it needs a
   * reason, this method only performs it, and a terminal status
   * additionally records who decided and what — enforced by the database
   * (`support_ticket_resolution_is_recorded`), not trusted to this code.
   *
   * `opts.resolution` is the text stored on the ticket when the move lands
   * on a terminal status (the decision, later shown to the ticket's own
   * author by `ownDetail()`); `opts.note` is the reason for every other
   * move — in particular `REQUEST_INFO`'s note IS the message the person
   * receives, so it is the one action whose text is written PARTIES rather
   * than INTERNAL, same rule as dispute's `REQUEST_INFORMATION`.
   */
  async act(
    ticketId: string,
    staff: TicketStaffContext,
    action: TicketAction,
    opts: { note?: string; resolution?: string } = {},
  ): Promise<Record<string, unknown>> {
    if (!staff.canView) throw notFound('Обращение');

    return this.db.transaction(async (tx) => {
      const current = await lockTicket(tx, ticketId);

      // Which transition this would be, before we know whether it is legal,
      // so we know which of the two text fields to read as "the reason".
      const candidate = TICKET_TRANSITIONS.find(
        (t) => t.from === current.status && t.action === action,
      );
      const landsTerminal = candidate ? isTerminalTicket(candidate.to) : false;
      const written = (landsTerminal ? opts.resolution : opts.note)?.trim() ?? '';

      const transition = applyTicketAction(current.status as TicketStatus, action, {
        hasReason: written.length > 0,
      });

      const allowed = transition.permission === 'case.resolve' ? staff.canResolve : staff.canHandle;
      if (!allowed) throw forbidden('Недостаточно прав для этого действия');

      const terminal = isTerminalTicket(transition.to);
      await tx.query(
        `UPDATE support_ticket
            SET status = $2,
                resolution = CASE WHEN $4 THEN $3 ELSE resolution END,
                resolved_at = CASE WHEN $4 THEN now() ELSE resolved_at END,
                resolved_by = CASE WHEN $4 THEN $5 ELSE resolved_by END
          WHERE id = $1`,
        [ticketId, transition.to, written, terminal, staff.userId],
      );

      await recordTicketEvent(tx, {
        ticketId,
        actorUserId: staff.userId,
        actorRole: staff.role,
        eventType: `STATUS_${action}`,
        note: written || null,
        visibility: action === 'REQUEST_INFO' ? 'PARTIES' : 'INTERNAL',
        payload: { from: current.status, to: transition.to },
      });

      await writeAudit(tx, {
        actorUserId: staff.userId,
        actorRole: staff.role,
        action: `ticket.${action.toLowerCase()}`,
        targetType: 'support_ticket',
        targetId: ticketId,
        changes: { status: { from: current.status, to: transition.to } },
        reason: written || null,
        source: 'admin',
      });

      return { id: ticketId, status: transition.to, previousStatus: current.status };
    });
  }

  /** An internal note. Never reaches the ticket's own author. */
  async addNote(ticketId: string, staff: TicketStaffContext, note: string): Promise<{ id: string }> {
    if (!staff.canHandle) throw forbidden('Нет прав на работу с обращениями');
    const text = note.trim();
    if (text.length < 2) throw invalid('Заметка не может быть пустой');

    return this.db.transaction(async (tx) => {
      await lockTicket(tx, ticketId);
      await recordTicketEvent(tx, {
        ticketId,
        actorUserId: staff.userId,
        actorRole: staff.role,
        eventType: 'INTERNAL_NOTE',
        note: text,
        visibility: 'INTERNAL',
      });
      await writeAudit(tx, {
        actorUserId: staff.userId,
        actorRole: staff.role,
        action: 'ticket.note',
        targetType: 'support_ticket',
        targetId: ticketId,
        source: 'admin',
      });
      return { id: ticketId };
    });
  }

  /** Assign, reassign or unassign. */
  async assign(
    ticketId: string,
    staff: TicketStaffContext,
    assigneeId: string | null,
  ): Promise<{ assignedTo: string | null }> {
    if (!staff.canHandle) throw forbidden('Нет прав на работу с обращениями');

    return this.db.transaction(async (tx) => {
      const current = await lockTicket(tx, ticketId);

      if (assigneeId !== null) {
        const { rows } = await tx.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM user_role
            WHERE user_id = $1 AND role IN ('ADMIN','SUPPORT','MODERATOR')`,
          [assigneeId],
        );
        if (Number(rows[0]!.c) === 0) throw invalid('Этот пользователь не работает с обращениями');
      }

      await tx.query(`UPDATE support_ticket SET assigned_to = $2 WHERE id = $1`, [ticketId, assigneeId]);

      await recordTicketEvent(tx, {
        ticketId,
        actorUserId: staff.userId,
        actorRole: staff.role,
        eventType: assigneeId ? 'ASSIGNED' : 'UNASSIGNED',
        visibility: 'INTERNAL',
        payload: { from: current.assigned_to, to: assigneeId },
      });
      await writeAudit(tx, {
        actorUserId: staff.userId,
        actorRole: staff.role,
        action: 'ticket.assign',
        targetType: 'support_ticket',
        targetId: ticketId,
        changes: { assignedTo: { from: current.assigned_to, to: assigneeId } },
        source: 'admin',
      });

      return { assignedTo: assigneeId };
    });
  }

  /** Who a ticket may be handed to. Names and roles only. */
  async assignableStaff(staff: TicketStaffContext): Promise<Record<string, unknown>[]> {
    if (!staff.canHandle) throw forbidden('Нет прав на работу с обращениями');
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT u.id, u.display_name, array_agg(ur.role ORDER BY ur.role) AS roles
         FROM app_user u JOIN user_role ur ON ur.user_id = u.id
        WHERE ur.role IN ('ADMIN','SUPPORT','MODERATOR') AND u.deleted_at IS NULL
        GROUP BY u.id, u.display_name ORDER BY u.display_name LIMIT 100`,
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, roles: r.roles }));
  }
}

/* ================================================================== *
 * helpers
 * ================================================================== */

async function lockTicket(tx: Sql, ticketId: string): Promise<Record<string, any>> {
  const { rows } = await tx.query<Record<string, any>>(
    `SELECT id, status, assigned_to, opened_by, property_id
       FROM support_ticket WHERE id = $1 FOR UPDATE`,
    [ticketId],
  );
  const row = rows[0];
  if (!row) throw notFound('Обращение');
  return row;
}

interface TicketEventInput {
  ticketId: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  eventType: string;
  note?: string | null;
  visibility: 'INTERNAL' | 'PARTIES';
  payload?: Record<string, unknown>;
}

/** Returns the new row's id, as a string (`ticket_event.id` is `bigserial`). */
export async function recordTicketEvent(tx: Sql, e: TicketEventInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO ticket_event (ticket_id, actor_user_id, actor_role, event_type, note, visibility, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     RETURNING id::text`,
    [
      e.ticketId,
      e.actorUserId ?? null,
      e.actorRole ?? null,
      e.eventType,
      e.note ?? null,
      e.visibility,
      e.payload ? JSON.stringify(e.payload) : null,
    ],
  );
  return rows[0]!.id;
}

/** timestamptz arrives as a Date; every projection here promises a string. */
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
