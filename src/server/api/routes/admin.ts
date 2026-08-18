import { z } from 'zod';
import { defineRoute, type AnyRoute } from '../http.ts';
import { writeAudit } from '../../services/audit.ts';
import { invalid } from '../../services/errors.ts';
import { MODERATION_REASON_CODES } from '../../domain/moderation.ts';
import { VERIFICATION_REASON_CODES } from '../../domain/verification.ts';

/**
 * Staff endpoints.
 *
 * Every route carries an explicit `permission`. There is no "admin sees
 * everything" shortcut — in particular `/admin/verification/documents/:id`
 * requires `document.read`, which ADMIN does not hold. Reading somebody's
 * passport is a separate act from administering the platform, and it is granted
 * to VERIFIER alone (see rbac.ts).
 *
 * Sensitive actions require a written reason, which lands in the audit row.
 */

const reason = z.string().trim().min(3, 'Укажите причину').max(1000);

export const financeRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/me/balance',
    summary: 'The caller’s own balance and restrictions',
    tags: ['finance'],
    auth: 'required',
    legalReview: 'LEGAL-016 — fee enforceability is unconfirmed',
    async handler({ ctx, caller }) {
      return ctx.services.finance.balance(caller.userId);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/me/fees',
    summary: 'Service fees charged to the caller, with the arithmetic shown',
    tags: ['finance'],
    auth: 'required',
    legalReview: 'LEGAL-016',
    async handler({ ctx, caller }) {
      return ctx.services.finance.listFees(caller.userId);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/finance/:userId/balance',
    summary: 'Staff view of a landlord balance',
    tags: ['admin', 'finance'],
    auth: 'required',
    permission: 'debt.view',
    async handler({ params, ctx }) {
      return ctx.services.finance.balance(params.userId!);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/finance/:userId/payments',
    summary: 'Record a payment against a landlord balance',
    tags: ['admin', 'finance'],
    auth: 'required',
    permission: 'ledger.adjust',
    idempotent: true,
    body: z.object({ amountMinor: z.string().regex(/^\d{1,15}$/), reference: reason }),
    async handler({ params, body, ctx, caller }) {
      await ctx.services.finance.recordPayment(
        params.userId!,
        body.amountMinor,
        caller.userId,
        body.reference,
      );
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/finance/fees/:feeId/waive',
    summary: 'Waive a service fee',
    tags: ['admin', 'finance'],
    auth: 'required',
    permission: 'fee.waive',
    body: z.object({ reason }),
    async handler({ params, body, ctx, caller }) {
      await ctx.services.finance.waiveFee(params.feeId!, caller.userId, body.reason);
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/finance/:userId/adjustments',
    summary: 'Post a manual ledger adjustment',
    tags: ['admin', 'finance'],
    auth: 'required',
    permission: 'ledger.adjust',
    body: z.object({ amountMinor: z.string().regex(/^-?\d{1,15}$/), reason }),
    async handler({ params, body, ctx, caller }) {
      await ctx.services.finance.adjust(params.userId!, body.amountMinor, caller.userId, body.reason);
      return { ok: true };
    },
  }),
];

export const adminRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/admin/moderation/listings',
    summary: 'Listing moderation queue',
    tags: ['admin'],
    auth: 'required',
    permission: 'listing.moderate',
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      status: z.enum(['PENDING_MODERATION', 'PUBLISHED', 'REJECTED', 'PAUSED', 'ALL']).optional(),
      city: z.string().trim().max(80).optional(),
      q: z.string().trim().max(120).optional(),
      sort: z.enum(['WAITING_LONGEST', 'WAITING_SHORTEST', 'CITY', 'RECENTLY_DECIDED']).optional(),
    }),
    async handler({ query, ctx }) {
      const limit = query.limit ?? 25;
      const offset = query.offset ?? 0;
      const status = query.status ?? 'PENDING_MODERATION';

      const where: string[] = ['p.deleted_at IS NULL'];
      const params: unknown[] = [];
      const push = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };

      if (status === 'ALL') {
        // Everything a moderator has any business seeing. A DRAFT is the
        // landlord's private workspace and is never in this queue.
        where.push(`p.status IN ('PENDING_MODERATION','PUBLISHED','REJECTED','PAUSED')`);
      } else {
        where.push(`p.status = ${push(status)}`);
      }
      if (query.city) where.push(`lower(p.city) = lower(${push(query.city)})`);
      if (query.q) {
        const like = `%${query.q}%`;
        where.push(`(p.title ILIKE ${push(like)} OR u.display_name ILIKE ${push(like)} OR p.city ILIKE ${push(like)})`);
      }

      const order = {
        WAITING_LONGEST: 'COALESCE(p.submitted_at, p.created_at) ASC',
        WAITING_SHORTEST: 'COALESCE(p.submitted_at, p.created_at) DESC',
        CITY: 'p.city ASC, COALESCE(p.submitted_at, p.created_at) ASC',
        RECENTLY_DECIDED: 'p.updated_at DESC',
      }[query.sort ?? 'WAITING_LONGEST'];

      const sql = `
        SELECT p.id, p.title, p.city, p.district, p.status, p.property_type,
               p.created_at, p.submitted_at, p.rejection_reason,
               p.base_price_minor::text AS base_price_minor, p.price_unit,
               u.id AS owner_id, u.display_name AS owner_name,
               u.verification_level AS owner_verification,
               (SELECT count(*)::int FROM property_photo ph WHERE ph.property_id = p.id) AS photo_count,
               (SELECT storage_key FROM property_photo ph
                 WHERE ph.property_id = p.id ORDER BY is_cover DESC, sort_order LIMIT 1) AS cover_photo,
               (SELECT count(*)::int FROM listing_moderation_review r WHERE r.property_id = p.id) AS review_count
          FROM property p JOIN app_user u ON u.id = p.owner_id
         WHERE ${where.join(' AND ')}
         ORDER BY ${order}
         LIMIT ${push(limit)} OFFSET ${push(offset)}`;

      const [{ rows }, counts] = await Promise.all([
        ctx.db.query(sql, params),
        // The tab counts, in one pass rather than four queries.
        ctx.db.query<{ status: string; total: string }>(
          `SELECT status, count(*)::text AS total FROM property
            WHERE deleted_at IS NULL
              AND status IN ('PENDING_MODERATION','PUBLISHED','REJECTED','PAUSED')
            GROUP BY status`,
        ),
      ]);

      return {
        items: rows,
        limit,
        offset,
        counts: Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.total)])),
      };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/moderation/listings/:id',
    summary: 'Everything a moderator needs to decide, plus the decision history',
    tags: ['admin'],
    auth: 'required',
    permission: 'listing.moderate',
    async handler({ params, ctx }) {
      const listing = await ctx.services.listings.getForModeration(params.id!);
      const history = await ctx.services.listings.moderationHistory(params.id!);
      return { listing, history };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/moderation/listings/:id',
    summary: 'Approve, reject or pause a listing',
    tags: ['admin'],
    auth: 'required',
    permission: 'listing.moderate',
    body: z.object({
      decision: z.enum(['PUBLISHED', 'REJECTED', 'PAUSED']),
      /** The moderator's own words. Optional on top of the codes. */
      reason: z.string().trim().max(1000).optional(),
      reasonCodes: z.array(z.enum(MODERATION_REASON_CODES)).max(11).optional(),
    }),
    async handler({ params, body, ctx, caller }) {
      await ctx.services.listings.moderate(
        params.id!,
        caller.userId,
        body.decision,
        body.reason,
        body.reasonCodes,
      );

      const { rows } = await ctx.db.query(`SELECT owner_id FROM property WHERE id=$1`, [params.id!]);
      const ownerId = (rows[0] as { owner_id?: string })?.owner_id;
      if (ownerId) {
        await ctx.services.notifications.enqueue({
          userId: ownerId,
          category: 'MODERATION',
          dedupeKey: `listing-moderated:${params.id}:${body.decision}`,
          payload: { propertyId: params.id, decision: body.decision, reason: body.reason ?? null },
        });
      }
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/reports',
    summary: 'Report queue',
    tags: ['admin'],
    auth: 'required',
    permission: 'case.view',
    async handler({ ctx }) {
      const { rows } = await ctx.db.query(
        `SELECT id, reporter_id, target_type, target_id, category, detail, status, created_at
           FROM report WHERE status IN ('OPEN','REVIEWING') ORDER BY created_at LIMIT 100`,
      );
      return rows;
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/moderation/messages',
    summary: 'Messages the contact filter flagged or blocked',
    tags: ['admin'],
    auth: 'required',
    permission: 'message.review',
    async handler({ ctx }) {
      // Original text is included because moderating a redaction without seeing
      // what was redacted is impossible. Access lands in the audit log.
      const { rows } = await ctx.db.query(
        `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.body_original, m.moderation_state,
                m.created_at, e.detectors, e.confidence
           FROM message m
           LEFT JOIN LATERAL (
             SELECT detectors, confidence FROM message_moderation_event
              WHERE message_id = m.id ORDER BY id DESC LIMIT 1) e ON true
          WHERE m.moderation_state IN ('FLAGGED','REDACTED','BLOCKED')
          ORDER BY m.created_at DESC LIMIT 100`,
      );
      return rows;
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/verification/queue',
    summary: 'Verification queue (metadata only — no documents)',
    tags: ['admin'],
    auth: 'required',
    permission: 'verification.review',
    async handler({ ctx }) {
      const { rows } = await ctx.db.query(
        `SELECT vr.id, vr.user_id, vr.property_id, vr.kind, vr.target_level, vr.status, vr.created_at,
                u.display_name, u.verification_level,
                (SELECT count(*)::int FROM verification_document d WHERE d.request_id = vr.id) AS document_count
           FROM verification_request vr JOIN app_user u ON u.id = vr.user_id
          WHERE vr.status IN ('SUBMITTED','IN_REVIEW')
          ORDER BY vr.created_at LIMIT 100`,
      );
      // Document *keys* are absent by design; the queue shows only that
      // documents exist. Opening one is a separate, logged action.
      return rows;
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/verification/documents/:documentId',
    summary: 'Open an identity document — VERIFIER only, always logged',
    tags: ['admin'],
    auth: 'required',
    // NOT held by ADMIN. This is the narrowest permission in the system.
    permission: 'document.read',
    legalReview: 'LEGAL-004 — identity document handling is unconfirmed',
    query: z.object({ purpose: z.string().trim().min(3).max(200) }),
    async handler({ params, query, ctx, caller }) {
      const flagEnabled = await ctx.services.finance.flagEnabled('verification.identity_documents');
      if (!flagEnabled) {
        throw invalid('Работа с документами удостоверения личности отключена до юридического заключения');
      }

      const { rows } = await ctx.db.query(
        `SELECT id, request_id, doc_type, storage_key, uploaded_at, purged_at
           FROM verification_document WHERE id=$1`,
        [params.documentId!],
      );
      const doc = rows[0] as Record<string, unknown> | undefined;
      if (!doc) {
        const { notFound } = await import('../../services/errors.ts');
        throw notFound('Документ');
      }
      if (doc.purged_at) throw invalid('Документ удалён согласно политике хранения');

      // Written before the key is handed over, so an access is recorded even if
      // the response never reaches the client.
      await ctx.db.query(
        `INSERT INTO document_access_log (document_id, actor_user_id, actor_role, purpose)
         VALUES ($1,$2,'VERIFIER',$3)`,
        [params.documentId!, caller.userId, query.purpose],
      );

      return {
        id: doc.id,
        docType: doc.doc_type,
        storageKey: doc.storage_key,
        uploadedAt: doc.uploaded_at,
        accessLogged: true,
      };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/verification/:requestId/decide',
    summary: 'Approve or reject a verification request (delegates to the domain)',
    tags: ['admin', 'verification'],
    auth: 'required',
    permission: 'verification.decide',
    legalReview: 'LEGAL-004 — approval is refused while document collection is disabled',
    body: z.object({
      decision: z.enum(['APPROVED', 'REJECTED']),
      note: reason,
      reasonCodes: z.array(z.enum(VERIFICATION_REASON_CODES)).max(10).optional(),
    }),
    async handler({ params, body, ctx, caller }) {
      /* WHAT THIS USED TO DO, AND WHY IT DOES NOT ANY MORE.
       *
       * It wrote the status itself and raised `app_user.verification_level`
       * directly, with no check that any evidence existed — and since no
       * submission path existed and identity-document collection is off, that
       * meant «Личность подтверждена» could be granted on the strength of
       * nothing at all. It also ran on `verification.decide`, which ADMIN holds
       * while deliberately NOT holding `document.read`, so an administrator
       * could grant an identity badge they were structurally forbidden from
       * examining.
       *
       * It now delegates to VerificationService, which runs the transition
       * table: APPROVE requires `document.read` AND sufficient evidence, and a
       * rejection requires at least one structured reason code so the applicant
       * is told what to fix. The endpoint is kept because it is in the
       * published OpenAPI surface; `/admin/verification/requests/:id/actions`
       * is the fuller one. */
      const { can } = await import('../../auth/rbac.ts');
      const staff = {
        userId: caller.userId,
        role: caller.roles.includes('VERIFIER') ? 'VERIFIER' : 'ADMIN',
        canReview: can(caller.roles, 'verification.review'),
        canDecide: true,
        canReadDocuments: can(caller.roles, 'document.read'),
      };

      const current = await ctx.db.query<{ status: string }>(
        `SELECT status FROM verification_request WHERE id=$1`,
        [params.requestId!],
      );
      if (!current.rows[0]) throw invalid('Заявка не найдена');

      // APPROVE only exists from IN_REVIEW in the transition table, so taking
      // it first is part of the same act rather than an extra step for the
      // caller. Refusal still works straight from SUBMITTED.
      if (body.decision === 'APPROVED' && current.rows[0].status === 'SUBMITTED') {
        await ctx.services.verification.act(params.requestId!, staff, 'TAKE');
      }

      const result = await ctx.services.verification.act(
        params.requestId!,
        staff,
        body.decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
        {
          internalNote: body.note,
          ...(body.reasonCodes ? { reasonCodes: body.reasonCodes } : {}),
        },
      );
      return { ok: true, status: result.status };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/users',
    summary: 'User search',
    tags: ['admin'],
    auth: 'required',
    permission: 'user.view',
    query: z.object({ q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().max(100).optional() }),
    async handler({ query, ctx }) {
      const { rows } = await ctx.db.query(
        `SELECT id, display_name, email, account_kind, status, verification_level,
                completed_rentals_as_tenant, completed_rentals_as_landlord, created_at
           FROM app_user
          WHERE deleted_at IS NULL
            AND ($1::text IS NULL OR display_name ILIKE '%' || $1 || '%' OR email::text ILIKE '%' || $1 || '%')
          ORDER BY created_at DESC LIMIT $2`,
        [query.q ?? null, query.limit ?? 50],
      );
      return rows;
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/users/:userId/restrict',
    summary: 'Restrict or suspend an account',
    tags: ['admin'],
    auth: 'required',
    permission: 'user.suspend',
    body: z.object({ status: z.enum(['ACTIVE', 'RESTRICTED', 'SUSPENDED']), reason }),
    async handler({ params, body, ctx, caller }) {
      await ctx.db.transaction(async (tx) => {
        const { rows } = await tx.query(`SELECT status FROM app_user WHERE id=$1`, [params.userId!]);
        const before = (rows[0] as { status?: string })?.status;

        await tx.query(`UPDATE app_user SET status=$2, suspended_reason=$3 WHERE id=$1`, [
          params.userId!,
          body.status,
          body.status === 'ACTIVE' ? null : body.reason,
        ]);

        if (body.status === 'SUSPENDED') {
          await tx.query(
            `UPDATE user_session SET revoked_at=now(), revoked_reason='ACCOUNT_SUSPENDED'
              WHERE user_id=$1 AND revoked_at IS NULL`,
            [params.userId!],
          );
        }

        await writeAudit(tx, {
          actorUserId: caller.userId,
          actorRole: 'ADMIN',
          action: 'user.restrict',
          targetType: 'user',
          targetId: params.userId!,
          changes: { status: { from: before ?? null, to: body.status } },
          reason: body.reason,
          source: 'admin',
        });
      });
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/audit',
    summary: 'Audit log',
    tags: ['admin'],
    auth: 'required',
    permission: 'audit.read',
    query: z.object({
      targetType: z.string().max(50).optional(),
      targetId: z.string().max(100).optional(),
      actorId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
    async handler({ query, ctx }) {
      const { rows } = await ctx.db.query(
        `SELECT id, occurred_at, actor_user_id, actor_role, action, target_type, target_id,
                changes, reason, correlation_id, source
           FROM audit_log
          WHERE ($1::text IS NULL OR target_type = $1)
            AND ($2::text IS NULL OR target_id = $2)
            AND ($3::uuid IS NULL OR actor_user_id = $3)
          ORDER BY occurred_at DESC LIMIT $4`,
        [query.targetType ?? null, query.targetId ?? null, query.actorId ?? null, query.limit ?? 100],
      );
      return rows;
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/feature-flags',
    summary: 'Feature flags',
    tags: ['admin'],
    auth: 'required',
    permission: 'feature_flag.write',
    async handler({ ctx }) {
      const { rows } = await ctx.db.query(
        `SELECT key, enabled, description, requires_legal_approval, updated_at
           FROM feature_flag ORDER BY key`,
      );
      return rows;
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/admin/feature-flags/:key',
    summary: 'Toggle a feature flag',
    tags: ['admin'],
    auth: 'required',
    permission: 'feature_flag.write',
    body: z.object({
      enabled: z.boolean(),
      reason,
      /** Required to switch on anything gated behind a legal question. */
      legalApprovalReference: z.string().trim().max(300).optional(),
    }),
    async handler({ params, body, ctx, caller }) {
      const { rows } = await ctx.db.query(
        `SELECT requires_legal_approval, enabled FROM feature_flag WHERE key=$1`,
        [params.key!],
      );
      const flag = rows[0] as { requires_legal_approval?: boolean } | undefined;
      if (!flag) {
        const { notFound } = await import('../../services/errors.ts');
        throw notFound('Флаг');
      }

      // The rewards/lottery gate. Enabling one of these without a recorded legal
      // approval reference is refused outright (DEC-015, LEGAL-012).
      if (body.enabled && flag.requires_legal_approval && !body.legalApprovalReference) {
        throw invalid(
          'Этот флаг требует подтверждённого юридического заключения. Укажите legalApprovalReference.',
        );
      }

      await ctx.db.transaction(async (tx) => {
        await tx.query(`UPDATE feature_flag SET enabled=$2, updated_by=$3, updated_at=now() WHERE key=$1`, [
          params.key!,
          body.enabled,
          caller.userId,
        ]);
        await writeAudit(tx, {
          actorUserId: caller.userId,
          actorRole: 'ADMIN',
          action: 'feature_flag.update',
          targetType: 'feature_flag',
          targetId: params.key!,
          changes: { enabled: { from: !body.enabled, to: body.enabled } },
          reason: `${body.reason}${body.legalApprovalReference ? ` | legal: ${body.legalApprovalReference}` : ''}`,
          source: 'admin',
        });
      });
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/lifecycle/run',
    summary: 'Advance stay ends, completion deadlines and review publication',
    tags: ['admin'],
    auth: 'required',
    permission: 'lifecycle.run',
    idempotent: true,
    async handler({ ctx }) {
      /* The scheduled half of the rental lifecycle.
       *
       * Everything here delegates to a method that already existed and was
       * already tested — openCompletionWindow, resolveExpiredCompletion,
       * publishExpiredWindows. What was missing was anything that CALLS them:
       * a stay whose last night had passed sat in CONFIRMED forever, so the
       * completion window never opened and no fee could ever accrue.
       *
       * Each booking runs in its own transaction. One row that throws must not
       * abandon the rest of the batch, and none of these steps depends on
       * another having succeeded.
       *
       * It is a route rather than a background timer on purpose: a Next.js
       * server may run as several short-lived instances, so a timer would
       * either not run at all or run N times. A cron with a credential is
       * honest about who is doing the work, and `lifecycle.run` is auditable. */
      const now = ctx.now;
      const result = {
        requestsExpired: [] as string[],
        staysEnded: [] as string[],
        completionsResolved: [] as { id: string; status: string; feeAccrued: boolean }[],
        reviewsPublished: 0,
        failures: [] as { id: string; step: string }[],
        /** Null when another run already holds the job; nothing was done. */
        runId: null as string | null,
        note: undefined as string | undefined,
      };

      /* Claim the job before doing any of it.
       *
       * This route predates the job_run table and had neither a record that it
       * ran nor any protection against running twice. Two crons on overlapping
       * schedules would both walk the same booking list; the FSM would refuse
       * the duplicate transitions, so nothing corrupt could happen, but the
       * second runner would spend a transaction per booking discovering that,
       * and nobody could answer "did last night's job fire?".
       *
       * Same mechanism as the retention sweep, so there is one way to run a
       * scheduled job here rather than two. */
      const runId = await ctx.services.retention.beginRun('lifecycle.sweep', ctx.caller?.userId ?? null);
      if (!runId) {
        result.note = 'Задание уже выполняется — этот запуск ничего не делал.';
        return result;
      }
      result.runId = runId;

      /* Requests nobody answered. First, because an expired request should not
         be sitting in a queue while later steps run, and because it is the
         cheapest step — an indexed finder that usually returns nothing. */
      for (const id of await ctx.services.bookings.dueForExpiry(now)) {
        try {
          const before = await ctx.services.bookings.get(id);
          const after = await ctx.services.bookings.expireStale(id);
          // A no-op means the landlord answered a moment before the sweep
          // reached the row. That is a lost race, not a failure.
          if (after.status === before.status) continue;
          result.requestsExpired.push(id);
          for (const userId of [after.tenant_id, after.landlord_id]) {
            await ctx.services.notifications.enqueue({
              userId,
              category: 'BOOKING_DECISION',
              dedupeKey: `booking-expired:${id}:${userId}`,
              payload: { bookingId: id, status: after.status },
            });
          }
        } catch {
          result.failures.push({ id, step: 'EXPIRE_REQUEST' });
        }
      }

      for (const id of await ctx.services.bookings.dueForStayEnd(now)) {
        try {
          const booking = await ctx.services.bookings.openCompletionWindow(id);
          result.staysEnded.push(id);
          for (const userId of [booking.tenant_id, booking.landlord_id]) {
            await ctx.services.notifications.enqueue({
              userId,
              category: 'COMPLETION_REQUEST',
              dedupeKey: `completion-window:${id}:${userId}`,
              payload: { bookingId: id, deadlineAt: booking.completion_deadline_at },
            });
          }
        } catch {
          result.failures.push({ id, step: 'STAY_END' });
        }
      }

      for (const id of await ctx.services.bookings.dueForCompletionResolution(now)) {
        try {
          const before = await ctx.services.bookings.get(id);
          const after = await ctx.services.bookings.resolveExpiredCompletion(id, now);
          if (after.status === before.status) continue;

          const { rows } = await ctx.db.query<{ c: string }>(
            `SELECT count(*)::text AS c FROM service_fee WHERE booking_id=$1`,
            [id],
          );
          result.completionsResolved.push({
            id,
            status: after.status,
            feeAccrued: Number(rows[0]!.c) > 0,
          });
          for (const userId of [after.tenant_id, after.landlord_id]) {
            await ctx.services.notifications.enqueue({
              userId,
              category: after.status === 'COMPLETED' ? 'REVIEW_REQUEST' : 'BOOKING_REMINDER',
              dedupeKey: `completion-resolved:${id}:${userId}`,
              payload: { bookingId: id, status: after.status },
            });
          }
        } catch {
          result.failures.push({ id, step: 'COMPLETION' });
        }
      }

      /* The one step the original handler did not wrap. A throw here abandoned
         the whole response after the work above had already committed. */
      try {
        result.reviewsPublished = await ctx.services.reviews.publishExpiredWindows(now);
      } catch {
        result.failures.push({ id: 'reviews', step: 'PUBLISH_REVIEWS' });
      }

      await ctx.services.retention.finishRun(runId, {
        processed:
          result.requestsExpired.length +
          result.staysEnded.length +
          result.completionsResolved.length +
          result.reviewsPublished,
        skipped: 0,
        failed: result.failures.length,
        detail: { staysEnded: result.staysEnded.length, completionsResolved: result.completionsResolved.length },
      });

      return result;
    },
  }),
];
