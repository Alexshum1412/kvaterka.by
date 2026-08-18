import { z } from 'zod';
import { defineRoute, ok, type AnyRoute } from '../http.ts';
import { can, type Role } from '../../auth/rbac.ts';
import {
  KINDS,
  OWNERSHIP_BASES,
  VERIFICATION_ACTIONS,
  VERIFICATION_PRIORITIES,
  VERIFICATION_REASON_CODES,
  VERIFICATION_STATUSES,
} from '../../domain/verification.ts';
import type { VerifierContext } from '../../services/verification-service.ts';

/**
 * Verification, both sides of it.
 *
 * The applicant routes are the half that did not exist: before this, nothing in
 * the product could create a `verification_request`, so the review queue was
 * permanently empty and the decision endpoint had nothing to decide.
 *
 * ENTITLEMENTS ARE RESOLVED ONCE, HERE, and the third one is the point:
 * `document.read` is VERIFIER's alone and ADMIN does not hold it (rbac.ts). It
 * is passed to the service as `canReadDocuments`, and the domain requires it for
 * APPROVE — so an administrator can work and refuse a queue but cannot grant an
 * identity badge they are structurally forbidden to examine.
 *
 * No route in this file returns a document storage key. Opening a document is
 * the pre-existing `GET /admin/verification/documents/:documentId`, which
 * demands a stated purpose and writes an access-log row before the key leaves
 * the server.
 */

function verifierContext(caller: { userId: string; roles: readonly Role[] }): VerifierContext {
  const roles = caller.roles;
  return {
    userId: caller.userId,
    role: roles.includes('VERIFIER') ? 'VERIFIER' : roles.includes('ADMIN') ? 'ADMIN' : (roles[0] ?? 'STAFF'),
    canReview: can(roles, 'verification.review'),
    canDecide: can(roles, 'verification.decide'),
    canReadDocuments: can(roles, 'document.read'),
  };
}

const reasonCodes = z.array(z.enum(VERIFICATION_REASON_CODES)).max(10);

/* ================================================================== *
 * Applicant
 * ================================================================== */

export const verificationSelfRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/me/verification',
    summary: 'The caller’s own verification level, requests and what to fix',
    tags: ['verification'],
    auth: 'required',
    async handler({ ctx, caller }) {
      return ctx.services.verification.forApplicant(caller.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/me/verification',
    summary: 'Ask for a verification level',
    tags: ['verification'],
    auth: 'required',
    idempotent: true,
    // Deliberately tight. A verification request costs a human being time, and
    // the partial unique index already refuses a second live one per kind.
    rateLimit: { limit: 10, windowSeconds: 86_400, by: 'user', bucket: 'verification:submit' },
    legalReview: 'LEGAL-004 — identity document handling is unconfirmed',
    body: z.object({
      targetLevel: z.union([z.literal(1), z.literal(2)]),
      propertyId: z.string().uuid().optional(),
      ownershipBasis: z.enum(OWNERSHIP_BASES).optional(),
      note: z.string().trim().max(1000).optional(),
      /** Set when trying again after a refusal, so prior answers are kept. */
      supersedesId: z.string().uuid().optional(),
    }),
    successStatus: 201,
    async handler({ body, ctx, caller }) {
      const result = await ctx.services.verification.submit({
        userId: caller.userId,
        targetLevel: body.targetLevel,
        propertyId: body.propertyId,
        declared: {
          ...(body.ownershipBasis ? { ownershipBasis: body.ownershipBasis } : {}),
          ...(body.note ? { note: body.note } : {}),
        },
        supersedesId: body.supersedesId,
      });

      // Staff who can review get told there is something to review. Addressed
      // by permission rather than by a hardcoded list of people.
      const { rows: staff } = await ctx.db.query<{ user_id: string }>(
        `SELECT DISTINCT user_id FROM user_role WHERE role IN ('VERIFIER','ADMIN')`,
      );
      for (const row of staff) {
        await ctx.services.notifications.enqueue({
          userId: row.user_id,
          category: 'VERIFICATION',
          dedupeKey: `verification-submitted:${result.id}:${row.user_id}`,
          payload: { requestId: result.id, targetLevel: body.targetLevel },
        });
      }

      return ok(result, 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/me/verification/:id/timeline',
    summary: 'What the applicant is entitled to see about their own request',
    tags: ['verification'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      return ctx.services.verification.applicantTimeline(params.id!, caller.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/me/verification/:id/documents',
    summary: 'Attach a document to the caller’s own request',
    tags: ['verification'],
    auth: 'required',
    legalReview: 'LEGAL-004 — collection is gated by verification.identity_documents',
    body: z.object({
      docType: z.enum([
        'PASSPORT',
        'ID_CARD',
        'SELFIE',
        'OWNERSHIP_CERTIFICATE',
        'POWER_OF_ATTORNEY',
        'UTILITY_BILL',
        'OTHER',
      ]),
    }),
    successStatus: 201,
    async handler({ params, body, ctx, caller }) {
      /* Refuses today, twice over: the legal flag is off, and no private
         storage is configured. Both are checked in the service so the same
         answer is given wherever it is called from. The route exists so that
         answering LEGAL-004 and provisioning a bucket is a configuration
         change rather than a coding task. */
      const result = await ctx.services.verification.attachDocument(
        params.id!,
        caller.userId,
        body.docType,
      );
      // The key is returned to the OWNER of the request only, so a client can
      // complete an upload. It is never returned to staff by any route.
      return ok(result, 201);
    },
  }),
];

/* ================================================================== *
 * Staff
 * ================================================================== */

export const verificationStaffRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/admin/verification/requests',
    summary: 'Verification queue, ordered by who is being kept waiting worst',
    tags: ['admin', 'verification'],
    auth: 'required',
    permission: 'verification.review',
    query: z.object({
      status: z.enum([...VERIFICATION_STATUSES, 'ALL', 'ACTIVE']).optional(),
      kind: z.enum(KINDS).optional(),
      level: z.coerce.number().int().min(1).max(2).optional(),
      city: z.string().trim().max(80).optional(),
      priority: z.enum(VERIFICATION_PRIORITIES).optional(),
      assigned: z.string().trim().max(80).optional(),
      q: z.string().trim().max(200).optional(),
      sort: z.enum(['OLDEST', 'NEWEST', 'PRIORITY', 'WAITING_LONGEST']).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
    async handler({ query, ctx, caller }) {
      return ctx.services.verification.queue(query, verifierContext(caller));
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/verification/requests/staff',
    summary: 'Who a verification request may be assigned to',
    tags: ['admin', 'verification'],
    auth: 'required',
    permission: 'verification.review',
    async handler({ ctx, caller }) {
      return ctx.services.verification.assignableStaff(verifierContext(caller));
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/admin/verification/requests/:id',
    summary: 'The case file — document metadata only, never a storage key',
    tags: ['admin', 'verification'],
    auth: 'required',
    permission: 'verification.review',
    async handler({ params, ctx, caller }) {
      return ctx.services.verification.detail(params.id!, verifierContext(caller));
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/verification/requests/:id/assign',
    summary: 'Assign, reassign or unassign a verification request',
    tags: ['admin', 'verification'],
    auth: 'required',
    permission: 'verification.review',
    idempotent: true,
    body: z.object({ assigneeId: z.string().uuid().nullable() }),
    async handler({ params, body, ctx, caller }) {
      const result = await ctx.services.verification.assign(
        params.id!,
        verifierContext(caller),
        body.assigneeId,
      );
      if (body.assigneeId && body.assigneeId !== caller.userId) {
        await ctx.services.notifications.enqueue({
          userId: body.assigneeId,
          category: 'VERIFICATION',
          dedupeKey: `verification-assigned:${params.id}:${body.assigneeId}`,
          payload: { requestId: params.id },
        });
      }
      return result;
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/admin/verification/requests/:id/actions',
    summary: 'Take, request information, approve or reject',
    tags: ['admin', 'verification'],
    auth: 'required',
    // The coarse gate. Which permission each action actually costs is decided
    // by the transition table in the domain: APPROVE and REJECT need
    // `verification.decide`, and APPROVE additionally needs `document.read`.
    permission: 'verification.review',
    idempotent: true,
    legalReview: 'LEGAL-004 — approval is refused while document collection is disabled',
    body: z.object({
      action: z.enum(VERIFICATION_ACTIONS),
      reasonCodes: reasonCodes.optional(),
      /** Staff-only. Never delivered to the applicant by any path. */
      internalNote: z.string().trim().max(4000).optional(),
      /** What the applicant is told, in addition to the coded reasons. */
      applicantMessage: z.string().trim().max(2000).optional(),
    }),
    async handler({ params, body, ctx, caller }) {
      const staff = verifierContext(caller);
      const result = await ctx.services.verification.act(params.id!, staff, body.action, {
        reasonCodes: body.reasonCodes,
        internalNote: body.internalNote,
        applicantMessage: body.applicantMessage,
      });

      /* Telling the applicant, without telling them anything internal. The
         payload carries the codes and the message written for them — never
         `internalNote`, and never the fraud signals the console showed. */
      if (['APPROVE', 'REJECT', 'REQUEST_INFO'].includes(body.action)) {
        const { rows } = await ctx.db.query<{ user_id: string; target_level: number }>(
          `SELECT user_id, target_level FROM verification_request WHERE id=$1`,
          [params.id!],
        );
        const applicant = rows[0];
        if (applicant) {
          await ctx.services.notifications.enqueue({
            userId: applicant.user_id,
            category: 'VERIFICATION',
            dedupeKey: `verification-${body.action.toLowerCase()}:${params.id}`,
            payload: {
              requestId: params.id,
              status: result.status,
              targetLevel: Number(applicant.target_level),
              reasonCodes: body.reasonCodes ?? [],
              ...(body.applicantMessage ? { message: body.applicantMessage } : {}),
            },
          });
        }
      }

      return result;
    },
  }),
];
