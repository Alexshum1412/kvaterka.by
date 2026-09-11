import { z } from 'zod';
import { defineRoute, ok, type AnyRoute } from '../http.ts';
import { SESSION_COOKIE, readSessionToken } from '../router.ts';
import { SESSION_TTL_DAYS } from '../../auth/auth-service.ts';
import { permissionsFor } from '../../auth/rbac.ts';

const email = z.string().trim().toLowerCase().email('Некорректный email').max(200);
const phone = z
  .string()
  .trim()
  .regex(/^\+375\d{9}$/, 'Телефон в формате +375XXXXXXXXX');

/**
 * Session cookie.
 *
 * HttpOnly so a cross-site scripting bug cannot read it; SameSite=Lax so a
 * cross-site form post cannot ride it (CSRF), while ordinary navigation still
 * works; Secure everywhere except local development over http.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

const clearedCookie = (): string =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export const authRoutes: AnyRoute[] = [
  defineRoute({
    method: 'POST',
    path: '/auth/register',
    summary: 'Create an account',
    tags: ['auth'],
    auth: 'none',
    rateLimit: { limit: 5, windowSeconds: 3600, by: 'ip', bucket: 'auth:register' },
    body: z
      .object({
        email: email.optional(),
        phone: phone.optional(),
        password: z.string().min(10, 'Пароль должен содержать не менее 10 символов').max(256),
        displayName: z.string().trim().min(2, 'Укажите имя').max(80),
        accountKind: z.enum(['PRIVATE', 'COMPANY']).optional(),
        companyName: z.string().trim().max(200).optional(),
        locale: z.enum(['ru', 'be', 'en']).optional(),
      })
      .refine((v) => v.email || v.phone, { message: 'Укажите email или телефон', path: ['email'] }),
    async handler({ body, ctx }) {
      const result = await ctx.services.auth.beginRegistration(body, {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      });
      // The code is delivered by email, never returned in the response —
      // returning it would let anyone who can POST confirm any address.
      // No app_user exists yet, so this cannot go through the ordinary
      // notification queue (it reads `notification_preference` by userId,
      // and there is no user row to key that on) — sent directly instead.
      //
      // Phone-only sign-up has no channel to deliver a code through: SMS was
      // never built (see `PHONE_OTP` sitting unused in auth_token's purpose
      // list). That gap predates this flow; it is not widened here, only
      // left exactly where it was rather than silently crashing on it.
      if (body.email) {
        await ctx.services.delivery.sendRegistrationCode(body.email, result.code, result.identifier);
      }
      return ok({ identifier: result.identifier, verificationRequired: true }, 201);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/register/confirm',
    summary: 'Confirm the code and finish creating the account',
    tags: ['auth'],
    auth: 'none',
    rateLimit: { limit: 20, windowSeconds: 3600, by: 'ip', bucket: 'auth:register-confirm' },
    body: z.object({
      identifier: z.string().trim().min(3).max(200),
      code: z.string().trim().min(4).max(10),
    }),
    async handler({ body, ctx }) {
      const { session, context } = await ctx.services.auth.confirmRegistration(body.identifier, body.code, {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      });
      return ok(
        {
          user: {
            id: context.userId,
            displayName: context.displayName,
            roles: context.roles,
            emailVerified: context.emailVerified,
            permissions: [...permissionsFor(context.roles)],
          },
          expiresAt: session.expiresAt.toISOString(),
        },
        200,
        { 'set-cookie': sessionCookie(session.token, SESSION_TTL_DAYS * 86_400) },
      );
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/register/resend',
    summary: 'Send a fresh registration code',
    tags: ['auth'],
    auth: 'none',
    rateLimit: { limit: 5, windowSeconds: 3600, by: 'ip', bucket: 'auth:register-resend' },
    body: z.object({ identifier: z.string().trim().min(3).max(200) }),
    async handler({ body, ctx }) {
      const code = await ctx.services.auth.resendRegistrationCode(body.identifier);
      if (code && email.safeParse(body.identifier).success) {
        await ctx.services.delivery.sendRegistrationCode(body.identifier, code, body.identifier);
      }
      // Identical response either way: this must not reveal whether a
      // registration is pending for this address.
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/login',
    summary: 'Sign in and open a session',
    tags: ['auth'],
    auth: 'none',
    // Tight, and by IP: an attacker spraying one password across many accounts
    // is not slowed down by a per-account limit.
    rateLimit: { limit: 10, windowSeconds: 900, by: 'ip', bucket: 'auth:login' },
    body: z.object({
      identifier: z.string().trim().min(3).max(200),
      password: z.string().min(1).max(256),
    }),
    async handler({ body, ctx }) {
      const { session, context } = await ctx.services.auth.login(body.identifier, body.password, {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      });
      return ok(
        {
          user: {
            id: context.userId,
            displayName: context.displayName,
            roles: context.roles,
            emailVerified: context.emailVerified,
            permissions: [...permissionsFor(context.roles)],
          },
          expiresAt: session.expiresAt.toISOString(),
        },
        200,
        { 'set-cookie': sessionCookie(session.token, SESSION_TTL_DAYS * 86_400) },
      );
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/logout',
    summary: 'Revoke the current session',
    tags: ['auth'],
    auth: 'required',
    // Leaving is always reachable — an account stuck behind the phone gate
    // must still be able to sign out.
    phoneGateExempt: true,
    body: z.object({}).optional(),
    async handler({ ctx }) {
      const token = readSessionToken(ctx.headers);
      if (token) await ctx.services.auth.logout(token, { correlationId: ctx.correlationId });
      return ok({ ok: true }, 200, { 'set-cookie': clearedCookie() });
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/refresh',
    summary: 'Rotate the session token',
    tags: ['auth'],
    auth: 'required',
    body: z.object({}).optional(),
    async handler({ ctx }) {
      const token = readSessionToken(ctx.headers);
      if (!token) return ok({ ok: false }, 401);
      const rotated = await ctx.services.auth.rotateSession(token, {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return ok({ expiresAt: rotated.expiresAt.toISOString() }, 200, {
        'set-cookie': sessionCookie(rotated.token, SESSION_TTL_DAYS * 86_400),
      });
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/auth/me',
    summary: 'Current session identity',
    tags: ['auth'],
    auth: 'required',
    // Must stay reachable WHILE gated: this is how the /verify-phone page
    // itself finds out whether it can stop polling.
    phoneGateExempt: true,
    async handler({ caller }) {
      return {
        id: caller.userId,
        displayName: caller.displayName,
        roles: caller.roles,
        emailVerified: caller.emailVerified,
        phoneVerified: caller.phoneVerified,
        permissions: [...permissionsFor(caller.roles)],
      };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/password-reset/request',
    summary: 'Request a password reset link',
    tags: ['auth'],
    auth: 'none',
    rateLimit: { limit: 5, windowSeconds: 3600, by: 'ip', bucket: 'auth:reset-request' },
    body: z.object({ identifier: z.string().trim().min(3).max(200) }),
    async handler({ body, ctx }) {
      const token = await ctx.services.auth.requestPasswordReset(body.identifier);
      if (token) {
        await ctx.services.notifications.enqueue({
          userId: (await lookupUserId(ctx, body.identifier))!,
          category: 'SECURITY',
          dedupeKey: `password-reset:${token.slice(0, 12)}`,
          payload: { kind: 'PASSWORD_RESET', token },
          channels: ['EMAIL'],
        });
      }
      // Identical response either way: this endpoint must not reveal which
      // addresses are registered.
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/password-reset/confirm',
    summary: 'Set a new password using a reset token',
    tags: ['auth'],
    auth: 'none',
    rateLimit: { limit: 10, windowSeconds: 3600, by: 'ip', bucket: 'auth:reset-confirm' },
    body: z.object({
      token: z.string().min(10).max(400),
      password: z.string().min(10).max(256),
    }),
    async handler({ body, ctx }) {
      await ctx.services.auth.resetPassword(body.token, body.password, {
        ip: ctx.ip,
        correlationId: ctx.correlationId,
      });
      return ok({ ok: true }, 200, { 'set-cookie': clearedCookie() });
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/auth/password',
    summary: 'Change the password of the signed-in account',
    tags: ['auth'],
    auth: 'required',
    rateLimit: { limit: 5, windowSeconds: 3600, by: 'user', bucket: 'auth:password-change' },
    body: z.object({
      currentPassword: z.string().min(1).max(256),
      newPassword: z.string().min(10).max(256),
    }),
    async handler({ body, ctx, caller }) {
      await ctx.services.auth.changePassword(caller.userId, body.currentPassword, body.newPassword, {
        ip: ctx.ip,
        correlationId: ctx.correlationId,
        // The caller keeps the session they are using; everything else dies.
        keepSessionId: caller.sessionId,
      });
      // Every other session dies with the old password; the caller keeps theirs.
      return ok({ ok: true, otherSessionsRevoked: true });
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/auth/sessions',
    summary: 'List active sessions',
    tags: ['auth'],
    auth: 'required',
    async handler({ ctx, caller }) {
      return ctx.services.auth.listSessions(caller.userId);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/auth/sessions',
    summary: 'Revoke all other sessions',
    tags: ['auth'],
    auth: 'required',
    async handler({ ctx, caller }) {
      const revoked = await ctx.services.auth.revokeOtherSessions(caller.userId, caller.sessionId);
      return { revoked };
    },
  }),
];

async function lookupUserId(
  ctx: { db: { query: (t: string, p?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } },
  identifier: string,
): Promise<string | null> {
  const { rows } = await ctx.db.query(
    `SELECT id FROM app_user WHERE (lower(email) = lower($1) OR phone = $1) AND deleted_at IS NULL`,
    [identifier.trim()],
  );
  return (rows[0]?.id as string) ?? null;
}
