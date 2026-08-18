import { z } from 'zod';
import { defineRoute, ok, type AnyRoute } from '../http.ts';
import { can, type Role } from '../../auth/rbac.ts';
import { HOLD_REASON_CODES, HOLD_TARGET_TYPES } from '../../domain/retention.ts';
import type { StaffActor } from '../../services/retention-service.ts';

/**
 * Data lifecycle: holds, the purge job, and account closure.
 *
 * THE PURGE JOB IS ITS OWN ROUTE, NOT PART OF `/admin/lifecycle/run`.
 *
 * That is one more cron entry and it is worth it. `lifecycle.run` is held by
 * ADMIN, and ADMIN deliberately does not hold `document.read` — the property
 * that makes «мы ограничиваем доступ к документам» a fact rather than a policy.
 * The retention handler reads document storage keys internally. Folding it into
 * a route whose response an ADMIN already reads would put that property one
 * careless `SELECT *` away from being false. Separate permission, separate
 * route, separate response shape that has never contained a key.
 *
 * ACCOUNT CLOSURE IS CLOSURE, NOT ERASURE. `POST /me/account/close` revokes
 * every way in, hides the profile and pauses the listings. It destroys nothing,
 * and the response says so in as many words, because a person who asked to be
 * forgotten and was told «готово» deserves to know what actually happened.
 * Erasure itself waits on LEGAL-003 and is not built.
 */

const reason = z.string().trim().min(3, 'Укажите причину').max(2000);

function retentionActor(caller: { userId: string; roles: readonly Role[] }): StaffActor {
  const roles = caller.roles;
  return {
    userId: caller.userId,
    role: roles.includes('ADMIN') ? 'ADMIN' : (roles[0] ?? 'STAFF'),
    canHold: can(roles, 'retention.hold'),
    // Releasing re-enables destruction, so it is ADMIN's alone even though the
    // permission to place a hold is shared.
    canRelease: roles.includes('ADMIN'),
    canRun: can(roles, 'retention.run'),
  };
}

/* ================================================================== *
 * Staff
 * ================================================================== */

export const retentionStaffRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/admin/retention',
    summary: 'Retention posture: the catalogue, holds, runs and what is stuck',
    tags: ['admin'],
    auth: 'required',
    permission: 'retention.hold',
    async handler({ ctx }) {
      return ctx.services.retention.overview(ctx.now);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/legal-holds',
    summary: 'Holds currently stopping destruction',
    tags: ['admin'],
    auth: 'required',
    permission: 'retention.hold',
    query: z.object({
      targetType: z.enum(HOLD_TARGET_TYPES).optional(),
      targetId: z.string().uuid().optional(),
      active: z
        .enum(['true', 'false'])
        .optional()
        .transform((v) => (v === undefined ? undefined : v === 'true')),
    }),
    async handler({ ctx, query }) {
      return ctx.services.retention.holds(query);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/legal-holds',
    summary: 'Freeze data so retention cannot destroy it',
    tags: ['admin'],
    auth: 'required',
    permission: 'retention.hold',
    idempotent: true,
    body: z.object({
      targetType: z.enum(HOLD_TARGET_TYPES),
      targetId: z.string().uuid(),
      reasonCode: z.enum(HOLD_REASON_CODES),
      reason,
    }),
    async handler({ ctx, caller, body }) {
      const hold = await ctx.services.retention.placeHold(body, retentionActor(caller!));
      return ok(hold, 201);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/legal-holds/:holdId/release',
    summary: 'Lift a hold — ADMIN only, and always with a stated reason',
    tags: ['admin'],
    auth: 'required',
    permission: 'retention.hold',
    idempotent: true,
    body: z.object({ reason }),
    async handler({ ctx, caller, params, body }) {
      return ctx.services.retention.releaseHold(params.holdId!, body.reason, retentionActor(caller!));
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/retention/run',
    summary: 'Run the retention sweep once',
    tags: ['admin'],
    auth: 'required',
    permission: 'retention.run',
    idempotent: true,
    legalReview: 'LEGAL-004 — no document retention window may be chosen until it is answered',
    async handler({ ctx, caller }) {
      /* A cron calls this. It is a route rather than a timer for the same
         reason `/admin/lifecycle/run` is: a Next.js server may run as several
         short-lived instances, so a timer would either never fire or fire N
         times. The job_run row makes N times harmless — the second runner
         finds the partial unique index occupied and does nothing. */
      return ctx.services.retention.runPurgeJob({ now: ctx.now, triggeredBy: caller?.userId ?? null });
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/notifications/run',
    summary: 'Drain the notification outbox once',
    tags: ['admin'],
    auth: 'required',
    permission: 'notifications.run',
    idempotent: true,
    async handler({ ctx, caller }) {
      /* Separate from the other two job routes because this one reaches
         OUTSIDE the platform — it hands an address and a subject line to a
         third party — while the lifecycle sweep and the retention purge never
         leave the database. Same mechanism underneath: one job_run row, whose
         partial unique index refuses a second concurrent runner. */
      return ctx.services.delivery.run({ now: ctx.now, triggeredBy: caller?.userId ?? null });
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/notifications/backlog',
    summary: 'What is queued, delivered and stuck, by channel',
    tags: ['admin'],
    auth: 'required',
    permission: 'retention.hold',
    async handler({ ctx }) {
      return {
        ...(await ctx.services.notifications.backlog()),
        channels: ctx.services.delivery.describeChannels(),
      };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/retention/runs',
    summary: 'Did the job run, and what did it do',
    tags: ['admin'],
    auth: 'required',
    permission: 'retention.hold',
    async handler({ ctx }) {
      return { runs: await ctx.services.retention.recentRuns(undefined, 25) };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/users/:userId/close',
    summary: 'Close an account on a person’s behalf',
    tags: ['admin'],
    auth: 'required',
    // `user.suspend` rather than a new permission: closing an account is a
    // stronger form of the suspension this role already performs, and it
    // destroys nothing that suspension does not.
    permission: 'user.suspend',
    idempotent: true,
    body: z.object({ reason }),
    async handler({ ctx, caller, params, body }) {
      return ctx.services.retention.closeAccount(
        params.userId!,
        { reason: body.reason, requestedBySelf: false },
        { userId: caller!.userId, role: 'ADMIN' },
      );
    },
  }),
];

/* ================================================================== *
 * The person whose data it is
 * ================================================================== */

export const accountSelfRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/me/account/closure',
    summary: 'What closing this account would and would not do',
    tags: ['account'],
    auth: 'required',
    async handler({ ctx, caller }) {
      return ctx.services.retention.erasureStatus(caller!.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/me/account/close',
    summary: 'Close this account',
    tags: ['account'],
    auth: 'required',
    idempotent: true,
    // Closing is irreversible from the person's side and ends every session.
    // A tight limit means a stolen session cannot be used to lock somebody out
    // repeatedly while they are trying to recover the account.
    rateLimit: { limit: 3, windowSeconds: 3600, by: 'user', bucket: 'account:close' },
    legalReview: 'LEGAL-003 — erasure scope is unresolved; this closes access and destroys nothing',
    body: z.object({
      reason: z.string().trim().max(2000).optional(),
      /* Typed confirmation rather than a bare boolean. `true` is what a
         mis-sent client request contains by accident; this word is not. */
      confirm: z.literal('ЗАКРЫТЬ'),
    }),
    async handler({ ctx, caller, body }) {
      return ctx.services.retention.closeAccount(
        caller!.userId,
        { reason: body.reason ?? 'Запрошено пользователем', requestedBySelf: true },
        { userId: caller!.userId, role: 'SELF' },
      );
    },
  }),
];
