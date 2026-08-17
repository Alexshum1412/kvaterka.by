import { z } from 'zod';
import { defineRoute, ok, type AnyRoute } from '../http.ts';
import { can, type Role } from '../../auth/rbac.ts';
import { DISPUTE_ACTIONS, DISPUTE_CATEGORIES, DISPUTE_STATUSES, DISPUTE_PRIORITIES } from '../../domain/dispute.ts';
import type { StaffContext } from '../../services/dispute-service.ts';

/**
 * Staff operations: the dispute console and the operations overview.
 *
 * These sit under `/admin` beside the moderation, verification and finance
 * routes rather than under a new prefix, because they are the same kind of
 * thing and share the same authorisation model. Every route names an explicit
 * permission; there is no route here that ADMIN reaches by being ADMIN.
 *
 * ENTITLEMENTS ARE RESOLVED ONCE, HERE. `staffContext()` turns the session's
 * roles into the five booleans the service understands, so the service never
 * inspects a role name and a role can be re-scoped in rbac.ts without touching
 * either. In particular `identityDocuments` is not among them: no route in this
 * file can reach a verification document, and the only one that can lives in
 * admin.ts behind `document.read`, which VERIFIER alone holds.
 */

const reason = z.string().trim().min(3, 'Укажите причину').max(2000);

function staffContext(caller: { userId: string; roles: readonly Role[] }): StaffContext {
  const roles = caller.roles;
  return {
    userId: caller.userId,
    // The most privileged role the caller holds, for the audit row. The
    // decision is still made per-permission below.
    role: roles.includes('ADMIN') ? 'ADMIN' : (roles[0] ?? 'STAFF'),
    canView: can(roles, 'case.view'),
    canHandle: can(roles, 'case.handle'),
    canResolve: can(roles, 'case.resolve'),
    // Reading somebody's private conversation is its own entitlement, held by
    // MODERATOR and ADMIN. SUPPORT and FINANCE work cases without it.
    canReadMessages: can(roles, 'message.review'),
    canViewFinance: can(roles, 'debt.view'),
  };
}

export const staffRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/admin/overview',
    summary: 'What needs a person right now',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.view',
    async handler({ ctx, caller }) {
      return ctx.services.disputes.overview(staffContext(caller));
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/disputes',
    summary: 'Dispute queue, ordered by what is most pressing',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.view',
    query: z.object({
      status: z.enum([...DISPUTE_STATUSES, 'ALL', 'ACTIVE']).optional(),
      priority: z.enum(DISPUTE_PRIORITIES).optional(),
      category: z.enum(DISPUTE_CATEGORIES).optional(),
      city: z.string().trim().max(80).optional(),
      assigned: z.string().trim().max(80).optional(),
      q: z.string().trim().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
    async handler({ query, ctx, caller }) {
      return ctx.services.disputes.queue(query, staffContext(caller));
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/disputes/staff',
    summary: 'Staff a case may be assigned to',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.handle',
    async handler({ ctx, caller }) {
      return ctx.services.disputes.assignableStaff(staffContext(caller));
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/disputes/:id',
    summary: 'The case file, assembled for this caller’s entitlements',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.view',
    async handler({ params, ctx, caller }) {
      return ctx.services.disputes.detail(params.id!, staffContext(caller));
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/disputes/:id/notes',
    summary: 'Add an internal note (never visible to the parties)',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.handle',
    rateLimit: { limit: 120, windowSeconds: 3600, by: 'user', bucket: 'dispute:note' },
    body: z.object({ note: z.string().trim().min(2).max(4000) }),
    successStatus: 201,
    async handler({ params, body, ctx, caller }) {
      return ok(await ctx.services.disputes.addNote(params.id!, staffContext(caller), body.note), 201);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/disputes/:id/assign',
    summary: 'Assign, reassign or unassign a case',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.handle',
    idempotent: true,
    body: z.object({ assigneeId: z.string().uuid().nullable() }),
    async handler({ params, body, ctx, caller }) {
      const result = await ctx.services.disputes.assign(
        params.id!,
        staffContext(caller),
        body.assigneeId,
      );
      if (body.assigneeId && body.assigneeId !== caller.userId) {
        await ctx.services.notifications.enqueue({
          userId: body.assigneeId,
          category: 'MODERATION',
          dedupeKey: `dispute-assigned:${params.id}:${body.assigneeId}`,
          payload: { caseId: params.id },
        });
      }
      return result;
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/disputes/:id/actions',
    summary: 'Move a case through its workflow',
    tags: ['admin'],
    auth: 'required',
    // The coarse gate. Which specific permission each action costs is decided
    // by the transition table inside the service — RESOLVE and CLOSE need
    // `case.resolve`, which a SUPPORT session does not carry.
    permission: 'case.handle',
    idempotent: true,
    body: z.object({
      action: z.enum(DISPUTE_ACTIONS),
      reason: z.string().trim().max(2000).optional(),
    }),
    async handler({ params, body, ctx, caller }) {
      const staff = staffContext(caller);
      const result = await ctx.services.disputes.act(params.id!, staff, body.action, body.reason);

      /* Telling the parties what happened, without showing them the console.
         REQUEST_INFORMATION carries the staff member's words because that is
         the whole point of it; the others carry only the new state, because a
         resolution rationale is a record for the platform and the parties get
         the decision itself, not the reasoning behind every internal step. */
      const { rows } = await ctx.db.query<{ opened_by: string; against_user_id: string | null }>(
        `SELECT opened_by, against_user_id FROM dispute_case WHERE id = $1`,
        [params.id!],
      );
      const parties = [rows[0]?.opened_by, rows[0]?.against_user_id].filter(Boolean) as string[];
      const audience = body.action === 'REQUEST_INFORMATION' ? [rows[0]?.opened_by!] : parties;

      for (const userId of audience) {
        await ctx.services.notifications.enqueue({
          userId,
          category: 'MODERATION',
          dedupeKey: `dispute-${body.action.toLowerCase()}:${params.id}:${userId}:${result.status}`,
          payload: {
            caseId: params.id,
            status: result.status,
            ...(body.action === 'REQUEST_INFORMATION' ? { request: body.reason } : {}),
          },
        });
      }

      return result;
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/disputes/:id/booking-outcome',
    summary: 'Decide the disputed booking through the booking state machine',
    tags: ['admin'],
    auth: 'required',
    // Deciding what happens to somebody's money is the resolver's act, not the
    // handler's, and it maps to the ADMIN actor the FSM already requires.
    permission: 'case.resolve',
    idempotent: true,
    legalReview: 'LEGAL-016 — fee enforceability is unconfirmed',
    body: z.object({
      outcome: z.enum(['COMPLETED', 'NOT_TAKEN_PLACE', 'CANCELLED']),
      reason,
    }),
    async handler({ params, body, ctx, caller }) {
      const { rows } = await ctx.db.query<{ booking_id: string | null }>(
        `SELECT booking_id FROM dispute_case WHERE id = $1`,
        [params.id!],
      );
      const bookingId = rows[0]?.booking_id;
      if (!bookingId) {
        const { invalid } = await import('../../services/errors.ts');
        throw invalid('К этому обращению не привязано бронирование');
      }

      /* The console never writes a booking status, a fee or a ledger row.
         It calls the domain service, which runs the transition table, derives
         the fee from the booking's own frozen terms, and writes the booking
         event and the audit row in one transaction. There is no amount in this
         request body, deliberately: nothing a staff member types can become a
         number in the ledger. */
      const result = await ctx.services.bookings.resolveDispute(
        bookingId,
        caller.userId,
        body.outcome,
        body.reason,
        ctx.correlationId,
      );

      const staff = staffContext(caller);
      await ctx.db.transaction(async (tx) => {
        const { recordCaseEvent } = await import('../../services/dispute-service.ts');
        await recordCaseEvent(tx, {
          caseId: params.id!,
          actorUserId: caller.userId,
          actorRole: staff.role,
          eventType: 'BOOKING_OUTCOME',
          note: body.reason,
          visibility: 'INTERNAL',
          payload: {
            outcome: body.outcome,
            bookingStatus: result.booking.status,
            feeAccrued: result.feeAccrued,
          },
        });
      });

      for (const userId of [result.booking.tenant_id, result.booking.landlord_id]) {
        await ctx.services.notifications.enqueue({
          userId,
          category: 'MODERATION',
          dedupeKey: `dispute-outcome:${params.id}:${userId}`,
          payload: { caseId: params.id, bookingId, status: result.booking.status },
        });
      }

      return {
        bookingId,
        bookingStatus: result.booking.status,
        feeAccrued: result.feeAccrued,
      };
    },
  }),
];
