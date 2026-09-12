import { z } from 'zod';
import { defineRoute, ok, type AnyRoute } from '../http.ts';
import { can, type Role } from '../../auth/rbac.ts';
import { TICKET_ACTIONS, TICKET_CATEGORIES, TICKET_STATUSES } from '../../domain/support-ticket.ts';
import type { TicketStaffContext } from '../../services/support-ticket-service.ts';

/**
 * Support tickets: the general "contact support" channel (DEC-073).
 *
 * Two audiences, same split `staff.ts` uses for disputes: `/me/tickets*` is
 * the ticket's own author working with their own submission (ownership,
 * not a permission, decides access — enforced inside the service itself),
 * `/admin/tickets*` is the staff console and sits beside `/admin/disputes*`
 * for the same reason those sit beside moderation and finance: same kind of
 * thing, same authorisation model, every route naming an explicit
 * permission.
 */

function staffContext(caller: { userId: string; roles: readonly Role[] }): TicketStaffContext {
  const roles = caller.roles;
  return {
    userId: caller.userId,
    role: roles.includes('ADMIN') ? 'ADMIN' : (roles[0] ?? 'STAFF'),
    canView: can(roles, 'case.view'),
    canHandle: can(roles, 'case.handle'),
    canResolve: can(roles, 'case.resolve'),
  };
}

/* ==================================================================== *
 * The ticket's own author
 * ==================================================================== */

export const supportTicketSelfRoutes: AnyRoute[] = [
  defineRoute({
    method: 'POST',
    path: '/me/tickets',
    summary: 'Open a support ticket',
    tags: ['tickets'],
    auth: 'required',
    rateLimit: { limit: 20, windowSeconds: 3600, by: 'user', bucket: 'ticket:create' },
    body: z.object({
      category: z.enum(TICKET_CATEGORIES),
      propertyId: z.string().uuid().nullable().optional(),
      summary: z.string().trim().min(10).max(4000),
    }),
    successStatus: 201,
    async handler({ body, ctx, caller }) {
      const result = await ctx.services.tickets.create(caller.userId, body);
      return ok(result, 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/me/tickets',
    summary: 'The caller’s own tickets',
    tags: ['tickets'],
    auth: 'required',
    async handler({ ctx, caller }) {
      return ctx.services.tickets.myTickets(caller.userId);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/me/tickets/:id',
    summary: 'One of the caller’s own tickets, with its chat thread',
    tags: ['tickets'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      return ctx.services.tickets.ownDetail(params.id!, caller.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/me/tickets/:id/reply',
    summary: 'Reply in the ticket’s own thread (the support chat)',
    tags: ['tickets'],
    auth: 'required',
    rateLimit: { limit: 60, windowSeconds: 3600, by: 'user', bucket: 'ticket:reply' },
    body: z.object({ message: z.string().trim().min(2).max(4000) }),
    async handler({ params, body, ctx, caller }) {
      const result = await ctx.services.tickets.reply(params.id!, caller.userId, body.message);

      // The assigned handler learns a person answered — nobody else needs to,
      // and an unassigned ticket simply queues for whoever takes it next.
      const { rows } = await ctx.db.query<{ assigned_to: string | null }>(
        `SELECT assigned_to FROM support_ticket WHERE id = $1`,
        [params.id!],
      );
      if (rows[0]?.assigned_to) {
        await ctx.services.notifications.enqueue({
          userId: rows[0].assigned_to,
          category: 'SUPPORT',
          // Keyed by the reply's own event id, not the wall clock, so a
          // retried request cannot double-notify the assignee.
          dedupeKey: `ticket-reply:${params.id}:${result.eventId}`,
          payload: { ticketId: params.id, status: result.status },
        });
      }
      return result;
    },
  }),
];

/* ==================================================================== *
 * Staff console
 * ==================================================================== */

export const supportTicketStaffRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/admin/tickets',
    summary: 'Ticket queue',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.view',
    query: z.object({
      status: z.enum([...TICKET_STATUSES, 'ALL', 'ACTIVE']).optional(),
      category: z.enum(TICKET_CATEGORIES).optional(),
      assigned: z.string().trim().max(80).optional(),
      q: z.string().trim().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
    async handler({ query, ctx, caller }) {
      return ctx.services.tickets.queue(query, staffContext(caller));
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/tickets/staff',
    summary: 'Staff a ticket may be assigned to',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.handle',
    async handler({ ctx, caller }) {
      return ctx.services.tickets.assignableStaff(staffContext(caller));
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/tickets/:id',
    summary: 'The ticket file',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.view',
    async handler({ params, ctx, caller }) {
      return ctx.services.tickets.detail(params.id!, staffContext(caller));
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/tickets/:id/notes',
    summary: 'Add an internal note (never visible to the ticket’s author)',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.handle',
    rateLimit: { limit: 120, windowSeconds: 3600, by: 'user', bucket: 'ticket:note' },
    body: z.object({ note: z.string().trim().min(2).max(4000) }),
    successStatus: 201,
    async handler({ params, body, ctx, caller }) {
      return ok(await ctx.services.tickets.addNote(params.id!, staffContext(caller), body.note), 201);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/tickets/:id/assign',
    summary: 'Assign, reassign or unassign a ticket',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.handle',
    idempotent: true,
    body: z.object({ assigneeId: z.string().uuid().nullable() }),
    async handler({ params, body, ctx, caller }) {
      const result = await ctx.services.tickets.assign(params.id!, staffContext(caller), body.assigneeId);
      if (body.assigneeId && body.assigneeId !== caller.userId) {
        await ctx.services.notifications.enqueue({
          userId: body.assigneeId,
          category: 'SUPPORT',
          dedupeKey: `ticket-assigned:${params.id}:${body.assigneeId}`,
          payload: { ticketId: params.id },
        });
      }
      return result;
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/tickets/:id/actions',
    summary: 'Move a ticket through its workflow',
    tags: ['admin'],
    auth: 'required',
    // The coarse gate. Which specific permission each action costs is
    // decided by the transition table inside the service — RESOLVE and
    // CLOSE need `case.resolve`, which a SUPPORT session does not carry.
    permission: 'case.handle',
    idempotent: true,
    body: z.object({
      action: z.enum(TICKET_ACTIONS),
      note: z.string().trim().max(2000).optional(),
      resolution: z.string().trim().max(4000).optional(),
    }),
    async handler({ params, body, ctx, caller }) {
      const staff = staffContext(caller);
      const result = await ctx.services.tickets.act(params.id!, staff, body.action, {
        note: body.note,
        resolution: body.resolution,
      });

      // Tell the ticket's own author what happened, without showing them the
      // console — same rule dispute's actions route follows. REQUEST_INFO
      // carries the staff member's words because that is the whole point of
      // it; the rest carry only the new state.
      const { rows } = await ctx.db.query<{ opened_by: string }>(
        `SELECT opened_by FROM support_ticket WHERE id = $1`,
        [params.id!],
      );
      const openedBy = rows[0]?.opened_by;
      if (openedBy) {
        await ctx.services.notifications.enqueue({
          userId: openedBy,
          category: 'SUPPORT',
          dedupeKey: `ticket-${body.action.toLowerCase()}:${params.id}:${result.status}`,
          payload: {
            ticketId: params.id,
            status: result.status,
            ...(body.action === 'REQUEST_INFO' ? { request: body.note } : {}),
          },
        });
      }

      return result;
    },
  }),
];
