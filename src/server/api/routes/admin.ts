import { z } from 'zod';
import { defineRoute, type AnyRoute } from '../http.ts';
import { writeAudit } from '../../services/audit.ts';
import { invalid } from '../../services/errors.ts';

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
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
    async handler({ query, ctx }) {
      const { rows } = await ctx.db.query(
        `SELECT p.id, p.title, p.city, p.status, p.created_at, p.base_price_minor::text AS base_price_minor,
                u.display_name AS owner_name, u.verification_level AS owner_verification,
                (SELECT count(*)::int FROM property_photo ph WHERE ph.property_id = p.id) AS photo_count
           FROM property p JOIN app_user u ON u.id = p.owner_id
          WHERE p.status = 'PENDING_MODERATION' AND p.deleted_at IS NULL
          ORDER BY p.created_at
          LIMIT $1`,
        [query.limit ?? 50],
      );
      return rows;
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
      reason: z.string().trim().max(1000).optional(),
    }),
    async handler({ params, body, ctx, caller }) {
      await ctx.services.listings.moderate(params.id!, caller.userId, body.decision, body.reason);

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
    summary: 'Approve or reject a verification request',
    tags: ['admin'],
    auth: 'required',
    permission: 'verification.decide',
    body: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: reason }),
    async handler({ params, body, ctx, caller }) {
      await ctx.db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `UPDATE verification_request
              SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4
            WHERE id=$1 AND status IN ('SUBMITTED','IN_REVIEW')
            RETURNING user_id, property_id, kind, target_level`,
          [params.requestId!, body.decision, caller.userId, body.note],
        );
        const request = rows[0] as Record<string, unknown> | undefined;
        if (!request) throw invalid('Заявка уже обработана или не найдена');

        if (body.decision === 'APPROVED') {
          if (request.kind === 'IDENTITY') {
            await tx.query(
              `UPDATE app_user SET verification_level = GREATEST(verification_level, $2) WHERE id=$1`,
              [request.user_id, request.target_level ?? 1],
            );
          } else if (request.property_id) {
            // Property verification is tracked separately from identity: a
            // fully verified person may still list an unverified property.
            await tx.query(
              `UPDATE property SET property_verified_at = now(), property_verified_by = $2 WHERE id=$1`,
              [request.property_id, caller.userId],
            );
          }
        }

        await writeAudit(tx, {
          actorUserId: caller.userId,
          actorRole: 'VERIFIER',
          action: 'verification.decide',
          targetType: 'verification_request',
          targetId: params.requestId!,
          changes: { decision: { from: 'SUBMITTED', to: body.decision } },
          reason: body.note,
          source: 'admin',
        });
      });
      return { ok: true };
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
];
