import { z } from 'zod';
import { defineRoute, ok, type AnyRoute } from '../http.ts';
import { NOTIFICATION_CATEGORIES } from '../../services/notification-service.ts';

/* ================================================================== *
 * Chat
 * ================================================================== */

export const chatRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/chat/conversations',
    summary: 'Conversations involving the caller',
    tags: ['chat'],
    auth: 'required',
    async handler({ ctx, caller }) {
      return ctx.services.messaging.listConversations(caller.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/chat/conversations',
    summary: 'Open (or reuse) a conversation about a listing',
    tags: ['chat'],
    auth: 'required',
    idempotent: true,
    rateLimit: { limit: 40, windowSeconds: 3600, by: 'user', bucket: 'chat:start' },
    body: z.object({ propertyId: z.string().uuid() }),
    successStatus: 201,
    async handler({ body, ctx, caller }) {
      const result = await ctx.services.messaging.startConversation(body.propertyId, caller.userId);
      return ok({ id: result.id }, 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/chat/conversations/:id/messages',
    summary: 'Message history',
    tags: ['chat'],
    auth: 'required',
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      before: z.string().datetime().optional(),
    }),
    async handler({ params, query, ctx, caller }) {
      return ctx.services.messaging.listMessages(params.id!, caller.userId, {
        limit: query.limit,
        before: query.before,
      });
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/chat/conversations/:id/messages',
    summary: 'Send a message (server-side contact filtering applies)',
    tags: ['chat'],
    auth: 'required',
    idempotent: true,
    // Tight enough to make bulk contact-spraying impractical without getting in
    // the way of a real conversation.
    rateLimit: { limit: 60, windowSeconds: 300, by: 'user', bucket: 'chat:send' },
    body: z.object({ text: z.string().min(1).max(4000) }),
    successStatus: 201,
    async handler({ params, body, ctx, caller }) {
      const message = await ctx.services.messaging.sendMessage(params.id!, caller.userId, body.text);

      const conversations = await ctx.services.messaging.listConversations(caller.userId);
      const conversation = conversations.find((c) => c.id === params.id);
      if (conversation) {
        await ctx.services.notifications.enqueue({
          userId: conversation.counterparty.id,
          category: 'MESSAGE',
          dedupeKey: `message:${message.id}`,
          payload: { conversationId: params.id, messageId: message.id },
        });
      }
      return ok(message, 201);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/chat/conversations/:id/read',
    summary: 'Mark a conversation as read',
    tags: ['chat'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      return { read: await ctx.services.messaging.markRead(params.id!, caller.userId) };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/chat/messages/:messageId/report',
    summary: 'Report a message',
    tags: ['chat'],
    auth: 'required',
    rateLimit: { limit: 20, windowSeconds: 3600, by: 'user', bucket: 'chat:report' },
    body: z.object({
      category: z.enum(['SPAM', 'ABUSE', 'FRAUD', 'OFF_PLATFORM', 'OTHER']),
      detail: z.string().trim().max(1000).optional(),
    }),
    async handler({ params, body, ctx, caller }) {
      await ctx.services.messaging.reportMessage(params.messageId!, caller.userId, body.category, body.detail);
      return { ok: true };
    },
  }),
];

/* ================================================================== *
 * Reviews
 * ================================================================== */

const rating = z.number().int().min(1).max(5);

export const reviewRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/bookings/:id/review-eligibility',
    summary: 'Whether the caller may review this rental',
    tags: ['reviews'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      return ctx.services.reviews.eligibility(params.id!, caller.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/bookings/:id/reviews',
    summary: 'Submit a review for a completed rental',
    tags: ['reviews'],
    auth: 'required',
    idempotent: true,
    rateLimit: { limit: 30, windowSeconds: 3600, by: 'user', bucket: 'review:submit' },
    body: z.union([
      z.object({
        role: z.literal('TENANT'),
        overall: rating,
        cleanliness: rating,
        accuracy: rating,
        communication: rating,
        checkIn: rating.optional(),
        location: rating.optional(),
        value: rating.optional(),
        rulesClarity: rating.optional(),
        body: z.string().trim().max(4000).optional(),
        whatWasGood: z.string().trim().max(1000).optional(),
        whatToImprove: z.string().trim().max(1000).optional(),
        wouldRentAgain: z.boolean().optional(),
        confirmedFacts: z.record(z.string().regex(/^[A-Z_]{2,40}$/), z.boolean()).optional(),
      }),
      z.object({
        role: z.literal('LANDLORD'),
        overall: rating,
        communication: rating,
        ruleCompliance: rating,
        propertyCondition: rating,
        timeliness: rating.optional(),
        body: z.string().trim().max(4000).optional(),
        whatWasGood: z.string().trim().max(1000).optional(),
        whatToImprove: z.string().trim().max(1000).optional(),
        wouldRentAgain: z.boolean().optional(),
      }),
    ]),
    successStatus: 201,
    async handler({ params, body, ctx, caller }) {
      const result = await ctx.services.reviews.submit(params.id!, caller.userId, body);
      return ok({ id: result.id, published: result.published }, 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/listings/:id/reviews',
    summary: 'Published reviews for a listing',
    tags: ['reviews'],
    auth: 'none',
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
    async handler({ params, query, ctx }) {
      const [reviews, confirmedFacts] = await Promise.all([
        ctx.services.reviews.listForProperty(params.id!, query.limit, query.offset),
        ctx.services.reviews.confirmedFacts(params.id!),
      ]);
      // "Landlord says Wi-Fi" versus "16 of 17 guests confirmed Wi-Fi" (spec §35).
      return { reviews, confirmedFacts };
    },
  }),
];

/* ================================================================== *
 * Profiles and trust
 * ================================================================== */

export const profileRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/profiles/:id',
    summary: 'Public trust profile',
    tags: ['profiles'],
    auth: 'none',
    async handler({ params, ctx }) {
      // Returns only the public trust surface. Fraud signals, moderation notes
      // and verification internals are never part of this projection.
      return ctx.services.trust.profile(params.id!);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/me/profile',
    summary: 'The caller’s own profile',
    tags: ['profiles'],
    auth: 'required',
    async handler({ ctx, caller }) {
      const { rows } = await ctx.db.query(
        `SELECT id, email, phone, display_name, account_kind, company_name, locale,
                email_verified_at, phone_verified_at, verification_level, status, created_at
           FROM app_user WHERE id=$1`,
        [caller.userId],
      );
      const u = rows[0] as Record<string, unknown>;
      return {
        id: u.id,
        email: u.email,
        phone: u.phone,
        displayName: u.display_name,
        accountKind: u.account_kind,
        companyName: u.company_name,
        locale: u.locale,
        emailVerified: u.email_verified_at !== null,
        phoneVerified: u.phone_verified_at !== null,
        verificationLevel: u.verification_level,
        status: u.status,
        memberSince: u.created_at,
        trust: await ctx.services.trust.profile(caller.userId),
      };
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/me/profile',
    summary: 'Update the caller’s profile',
    tags: ['profiles'],
    auth: 'required',
    body: z.object({
      displayName: z.string().trim().min(2).max(80).optional(),
      locale: z.enum(['ru', 'be', 'en']).optional(),
      companyName: z.string().trim().max(200).optional(),
    }),
    async handler({ body, ctx, caller }) {
      const sets: string[] = [];
      const values: unknown[] = [caller.userId];
      for (const [key, column] of [
        ['displayName', 'display_name'],
        ['locale', 'locale'],
        ['companyName', 'company_name'],
      ] as const) {
        const value = body[key];
        if (value !== undefined) {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        }
      }
      if (sets.length > 0) {
        await ctx.db.query(`UPDATE app_user SET ${sets.join(', ')} WHERE id=$1`, values);
      }
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/me/favorites',
    summary: 'Saved listings',
    tags: ['profiles'],
    auth: 'required',
    async handler({ ctx, caller }) {
      const { rows } = await ctx.db.query(
        `SELECT f.property_id, f.created_at, p.title, p.city,
                p.base_price_minor::text AS base_price_minor, p.price_unit, p.status,
                (SELECT storage_key FROM property_photo ph
                  WHERE ph.property_id = p.id ORDER BY is_cover DESC, sort_order LIMIT 1) AS cover_photo
           FROM favorite f JOIN property p ON p.id = f.property_id
          WHERE f.user_id=$1 ORDER BY f.created_at DESC LIMIT 200`,
        [caller.userId],
      );
      return rows;
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/me/favorites/:propertyId',
    summary: 'Save a listing',
    tags: ['profiles'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      await ctx.db.query(
        `INSERT INTO favorite (user_id, property_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [caller.userId, params.propertyId!],
      );
      return { saved: true };
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/me/favorites/:propertyId',
    summary: 'Remove a saved listing',
    tags: ['profiles'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      await ctx.db.query(`DELETE FROM favorite WHERE user_id=$1 AND property_id=$2`, [
        caller.userId,
        params.propertyId!,
      ]);
      return { saved: false };
    },
  }),
];

/* ================================================================== *
 * Notifications
 * ================================================================== */

export const notificationRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/notifications',
    summary: 'In-app inbox',
    tags: ['notifications'],
    auth: 'required',
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
    async handler({ query, ctx, caller }) {
      return ctx.services.notifications.inbox(caller.userId, query.limit, query.offset);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/notifications/read',
    summary: 'Mark notifications read',
    tags: ['notifications'],
    auth: 'required',
    body: z.object({ id: z.string().uuid().optional() }),
    async handler({ body, ctx, caller }) {
      return { read: await ctx.services.notifications.markRead(caller.userId, body.id) };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/notifications/preferences',
    summary: 'Notification preferences',
    tags: ['notifications'],
    auth: 'required',
    async handler({ ctx, caller }) {
      return ctx.services.notifications.getPreferences(caller.userId);
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/notifications/preferences',
    summary: 'Update a notification preference',
    tags: ['notifications'],
    auth: 'required',
    body: z.object({
      category: z.enum(NOTIFICATION_CATEGORIES),
      channel: z.enum(['IN_APP', 'EMAIL', 'TELEGRAM']),
      enabled: z.boolean(),
    }),
    async handler({ body, ctx, caller }) {
      await ctx.services.notifications.setPreference(
        caller.userId,
        body.category,
        body.channel,
        body.enabled,
      );
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/notifications/telegram/link',
    summary: 'Start Telegram linking (explicit opt-in)',
    tags: ['notifications'],
    auth: 'required',
    rateLimit: { limit: 10, windowSeconds: 3600, by: 'user', bucket: 'telegram:link' },
    async handler({ ctx, caller }) {
      const token = await ctx.services.notifications.beginTelegramLink(caller.userId);
      // Returned to the user's own authenticated session so they can paste it
      // into the bot. Telegram is never enabled without this deliberate step.
      return { linkCode: token, expiresInSeconds: 900 };
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/notifications/telegram',
    summary: 'Unlink Telegram and stop sending to it',
    tags: ['notifications'],
    auth: 'required',
    async handler({ ctx, caller }) {
      await ctx.services.notifications.unlinkTelegram(caller.userId);
      return { ok: true };
    },
  }),
];

/* ================================================================== *
 * Landlord dashboard
 * ================================================================== */

export const dashboardRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/dashboard/summary',
    summary: 'Everything the landlord overview needs, in one call',
    tags: ['dashboard'],
    auth: 'required',
    async handler({ ctx, caller }) {
      // Scoped to the caller by the service query itself — there is no
      // parameter here that could be pointed at somebody else's data.
      return ctx.services.dashboard.landlordSummary(caller.userId);
    },
  }),
];
