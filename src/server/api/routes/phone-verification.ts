import { defineRoute, type AnyRoute } from '../http.ts';

/**
 * Phone verification via a linked messenger account (0018) — the identity
 * signal that replaced passport upload. See the long comment on
 * `NotificationService`'s phone-verification methods for what each channel
 * actually proves.
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
      // Each channel is null, not omitted, when unconfigured — same posture
      // as the Telegram notification-link route — so the client can tell
      // "not offered" apart from "still loading" for every channel at once.
      return {
        token,
        expiresInSeconds: 1800,
        telegram: process.env.TELEGRAM_BOT_TOKEN
          ? { botUsername: process.env.TELEGRAM_BOT_USERNAME ?? null }
          : null,
        vk: process.env.VK_GROUP_TOKEN ? { groupId: process.env.VK_GROUP_ID ?? null } : null,
        whatsapp: process.env.WHATSAPP_ACCESS_TOKEN
          ? { businessNumber: process.env.WHATSAPP_BUSINESS_NUMBER ?? null }
          : null,
      };
    },
  }),
];
