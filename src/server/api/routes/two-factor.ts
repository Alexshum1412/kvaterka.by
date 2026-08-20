import { z } from 'zod';
import { defineRoute, ok, type AnyRoute } from '../http.ts';

/**
 * Two-factor enrolment, challenge and recovery.
 *
 * NONE OF THESE CARRIES A `permission`, deliberately.
 *
 * A staff member who has not yet satisfied their second factor holds no staff
 * roles — that is the whole enforcement mechanism — so a permission on the
 * enrolment route would lock the only door out of the state it creates. Every
 * route here is `auth: 'required'` and nothing more: you must be signed in,
 * and that is the correct bar for proving possession of your own authenticator.
 *
 * RATE LIMITS ARE ADDITIVE TO THE ACCOUNT LOCKOUT, not a substitute for it.
 * The per-account escalating lockout lives in the service and follows the
 * account wherever it is attacked from; these limits bound how fast a single
 * source can drive it. Neither alone is sufficient: an account limit without an
 * IP limit lets an attacker cheaply lock a colleague out, and an IP limit
 * without an account limit lets a botnet spread the guessing.
 */

const code = z
  .string()
  .trim()
  .min(6, 'Введите код')
  .max(20)
  // Six digits from an authenticator, or a recovery code like A2C4-E6G8.
  .regex(/^[0-9A-Za-z\s-]+$/, 'Код содержит недопустимые символы');

export const twoFactorRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/me/2fa',
    summary: 'Whether a second factor is set up, and whether this session passed it',
    tags: ['auth'],
    auth: 'required',
    async handler({ ctx, caller }) {
      const granted = await ctx.services.auth.grantedRoles(caller.userId);
      return {
        enrolled: caller.twoFactorEnrolled,
        required: await ctx.services.auth.twoFactorRequired(caller.userId),
        // What this session cannot currently do, so the UI can say why rather
        // than showing an empty console.
        withheldRoles: caller.withheldRoles,
        grantedRoles: granted,
        recoveryCodesRemaining: caller.twoFactorEnrolled
          ? await ctx.services.auth.recoveryCodesRemaining(caller.userId)
          : 0,
      };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/me/2fa/enrol',
    summary: 'Begin enrolment: returns a secret and an otpauth URI for a QR code',
    tags: ['auth'],
    auth: 'required',
    rateLimit: { limit: 10, windowSeconds: 3600, by: 'user', bucket: '2fa:enrol' },
    /* THE PASSWORD, not merely a session.
     *
     * Disabling a second factor already required a current code, on the
     * reasoning that a stolen session must not be able to remove it. Enrolling
     * one required nothing at all, which left the mirror image wide open: on an
     * account that has NOT yet enrolled, a stolen PASSWORD-level session could
     * register its own authenticator and, from that moment, hold the second
     * factor. The owner could then no longer disable it — that path needs a
     * code they do not have — and would need an administrator to reset it.
     *
     * So the weaker credential could be traded for durable control of a
     * staff-privileged identity, silently. A session token is what a borrowed
     * browser or an XSS bug yields; the password is what distinguishes the
     * owner from somebody sitting at their unlocked laptop. */
    body: z.object({ password: z.string().min(1).max(256) }),
    async handler({ ctx, caller, body }) {
      await ctx.services.auth.assertPassword(caller.userId, body.password);
      /* The account label inside the authenticator app. A person with two work
         accounts otherwise sees two identical six-digit codes. */
      const { rows } = await ctx.db.query<{ email: string | null; display_name: string }>(
        `SELECT email, display_name FROM app_user WHERE id=$1`,
        [caller.userId],
      );
      const account = rows[0]?.email ?? rows[0]?.display_name ?? caller.userId;
      return ctx.services.auth.beginTotpEnrolment(caller.userId, account);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/me/2fa/confirm',
    summary: 'Finish enrolment by proving the authenticator works',
    tags: ['auth'],
    auth: 'required',
    rateLimit: { limit: 10, windowSeconds: 900, by: 'user', bucket: '2fa:confirm' },
    body: z.object({ code }),
    async handler({ ctx, caller, body }) {
      // Returns the recovery codes ONCE. They are stored hashed, so this
      // response is the only time they exist in readable form anywhere.
      return ctx.services.auth.confirmTotpEnrolment(caller.userId, caller.sessionId, body.code, ctx.now);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/me/2fa/challenge',
    summary: 'Answer a challenge with an authenticator code or a recovery code',
    tags: ['auth'],
    auth: 'required',
    /* Tighter than the account lockout on purpose: this bounds a single source,
       while the escalating per-account counter bounds the account. */
    rateLimit: { limit: 10, windowSeconds: 900, by: 'ip', bucket: '2fa:challenge' },
    body: z.object({ code }),
    async handler({ ctx, caller, body }) {
      return ctx.services.auth.answerChallenge(caller.userId, caller.sessionId, body.code, ctx.now);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/me/2fa/disable',
    summary: 'Turn off two-factor authentication for this account',
    tags: ['auth'],
    auth: 'required',
    rateLimit: { limit: 5, windowSeconds: 3600, by: 'user', bucket: '2fa:disable' },
    // A current code is required: otherwise a stolen session — the exact thing
    // a second factor exists to survive — could simply remove it.
    body: z.object({ code }),
    async handler({ ctx, caller, body }) {
      await ctx.services.auth.disableTotp(caller.userId, body.code, ctx.now);
      return ok({ enrolled: false });
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/users/:userId/2fa/reset',
    summary: 'Clear somebody’s authenticator — the lost-phone path',
    tags: ['admin'],
    auth: 'required',
    /* `role.grant`, which only ADMIN holds. Removing another person's second
       factor is the ability to become them, so it sits with handing out
       privilege rather than with support work — and SUPPORT therefore cannot
       do it, by permission selection rather than by a special check. */
    permission: 'role.grant',
    idempotent: true,
    body: z.object({ reason: z.string().trim().min(3, 'Укажите причину').max(1000) }),
    async handler({ ctx, caller, params, body }) {
      await ctx.services.auth.resetTotpFor(
        params.userId!,
        { userId: caller.userId, role: 'ADMIN' },
        body.reason,
      );
      // Every session of theirs is revoked, so they sign in and enrol again.
      // No replacement secret is minted: an administrator never sees one.
      return ok({ reset: true });
    },
  }),
];
