import { defineRoute, type AnyRoute } from '../http.ts';

/**
 * Phone verification via a linked Telegram account (0018) — the identity
 * signal that replaced passport upload. See the long comment on
 * `NotificationService`'s phone-verification methods for what this proves.
 *
 * Every route here is `phoneGateExempt`: these ARE the routes that clear the
 * gate, so the gate cannot apply to them without deadlocking a caller who
 * has not cleared it yet.
 */
export const phoneVerificationRoutes: AnyRoute[] = [
  defineRoute({
    method: 'POST',
    path: '/verification/phone/begin',
    summary: 'Mint the token every channel below consumes',
    tags: ['verification'],
    auth: 'required',
    phoneGateExempt: true,
    rateLimit: { limit: 10, windowSeconds: 3600, by: 'user', bucket: 'phone-verify:begin' },
    async handler({ ctx, caller }) {
      const token = await ctx.services.notifications.beginPhoneVerification(caller.userId);
      // null, not omitted, when unconfigured — same posture as the Telegram
      // notification-link route — so the client can tell "not offered" apart
      // from "still loading".
      return {
        token,
        expiresInSeconds: 1800,
        telegram: process.env.TELEGRAM_BOT_TOKEN
          ? { botUsername: process.env.TELEGRAM_BOT_USERNAME ?? null }
          : null,
      };
    },
  }),
];
