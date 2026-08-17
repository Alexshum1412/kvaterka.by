import { z } from 'zod';
import { defineRoute, ok, type AnyRoute } from '../http.ts';
import { availableEvents, type BookingState } from '../../domain/booking/states.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');

/**
 * Booking endpoints are a thin shell over BookingService. There is deliberately
 * no state logic here: the HTTP layer must never become a second state machine
 * that can disagree with the first one.
 */
export const bookingRoutes: AnyRoute[] = [
  defineRoute({
    method: 'POST',
    path: '/bookings',
    summary: 'Request or instantly book a stay',
    tags: ['bookings'],
    auth: 'required',
    idempotent: true,
    rateLimit: { limit: 30, windowSeconds: 3600, by: 'user', bucket: 'booking:create' },
    body: z.object({
      propertyId: z.string().uuid(),
      from: isoDate,
      to: isoDate,
      guests: z.number().int().min(1).max(50).optional(),
      message: z.string().trim().max(2000).optional(),
      instant: z.boolean().optional(),
    }),
    successStatus: 201,
    async handler({ body, ctx, caller }) {
      const booking = await ctx.services.bookings.requestBooking({
        propertyId: body.propertyId,
        tenantId: caller.userId,
        from: body.from,
        to: body.to,
        guests: body.guests,
        message: body.message,
        instant: body.instant,
        correlationId: ctx.correlationId,
        // The domain-level key as well as the HTTP one: a client that omits the
        // header still cannot create two bookings by double-clicking.
        idempotencyKey: ctx.headers['idempotency-key'],
      });

      // The tenant's note was previously accepted, validated and then
      // dropped on the floor. It becomes a real first message in the
      // property's conversation, which means the existing contact filter
      // applies to it — a phone number in a booking request must not be a
      // way around the rules that govern chat.
      //
      // A blocked or redacted message does not fail the booking: the dates
      // matter more than the note, and the filter has already done its job.
      if (body.message) {
        try {
          const conversation = await ctx.services.messaging.startConversation(
            body.propertyId,
            caller.userId,
          );
          await ctx.services.messaging.sendMessage(conversation.id, caller.userId, body.message);
        } catch {
          // Never surface why: the filter's behaviour is not something a
          // sender should be able to probe.
        }
      }

      await ctx.services.notifications.enqueue({
        userId: booking.landlord_id,
        category: booking.status === 'CONFIRMED' ? 'BOOKING_DECISION' : 'BOOKING_REQUEST',
        dedupeKey: `booking-created:${booking.id}`,
        payload: { bookingId: booking.id, reference: booking.reference, status: booking.status },
      });

      return ok(present(booking, caller.userId), 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/bookings',
    summary: 'Bookings involving the caller',
    tags: ['bookings'],
    auth: 'required',
    query: z.object({
      role: z.enum(['TENANT', 'LANDLORD', 'ANY']).optional(),
      status: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
    async handler({ query, ctx, caller }) {
      const statuses = query.status ? query.status.split(',').map((s) => s.trim()) : null;
      const role = query.role ?? 'ANY';

      const { rows } = await ctx.db.query(
        `SELECT b.id, b.reference, b.status, b.property_id, b.tenant_id, b.landlord_id,
                lower(b.stay_period)::text AS stay_from, upper(b.stay_period)::text AS stay_to,
                b.nights, b.guests,
                b.total_expected_minor::text AS total_expected_minor,
                b.fee_base_minor::text AS fee_base_minor,
                b.rent_minor::text AS rent_minor,
                b.created_at, b.confirmed_at, b.expires_at, b.completion_deadline_at,
                b.tenant_completion_answer, b.landlord_completion_answer,
                p.title AS property_title, p.city AS property_city,
                (SELECT storage_key FROM property_photo ph
                  WHERE ph.property_id = p.id ORDER BY is_cover DESC, sort_order LIMIT 1) AS cover_photo
           FROM booking b
           JOIN property p ON p.id = b.property_id
          WHERE (
                  ($2 = 'ANY'      AND (b.tenant_id = $1 OR b.landlord_id = $1))
               OR ($2 = 'TENANT'   AND b.tenant_id = $1)
               OR ($2 = 'LANDLORD' AND b.landlord_id = $1)
                )
            AND ($3::text[] IS NULL OR b.status = ANY($3))
          ORDER BY b.created_at DESC
          LIMIT $4 OFFSET $5`,
        [caller.userId, role, statuses, Math.min(query.limit ?? 20, 50), query.offset ?? 0],
      );

      return rows.map((r: Record<string, unknown>) => present(r, caller.userId));
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/bookings/:id',
    summary: 'Booking detail with the actions available to the caller',
    tags: ['bookings'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      const booking = await ctx.services.bookings.get(params.id!);
      if (booking.tenant_id !== caller.userId && booking.landlord_id !== caller.userId) {
        // 404 rather than 403: whether a booking exists is itself information.
        const { notFound } = await import('../../services/errors.ts');
        throw notFound('Бронирование');
      }

      const counterpartyId =
        booking.tenant_id === caller.userId ? booking.landlord_id : booking.tenant_id;

      const [{ rows: events }, { rows: people }] = await Promise.all([
        ctx.db.query(
          `SELECT event_type, actor, from_status, to_status, occurred_at
             FROM booking_event WHERE booking_id=$1 ORDER BY id`,
          [params.id!],
        ),
        // Public trust facts only. A landlord deciding on a request needs to
        // know who is asking; they do not need an email, a phone number or
        // anything from the verification documents. The columns selected
        // here are the whole allowance.
        ctx.db.query(
          `SELECT u.id, u.display_name, u.account_kind, u.company_name,
                  u.verification_level, u.created_at,
                  u.completed_rentals_as_tenant, u.completed_rentals_as_landlord,
                  (SELECT round(avg(r.overall)::numeric, 2) FROM review r
                    WHERE r.subject_id = u.id AND r.status = 'PUBLISHED') AS rating,
                  (SELECT count(*)::int FROM review r
                    WHERE r.subject_id = u.id AND r.status = 'PUBLISHED') AS review_count
             FROM app_user u WHERE u.id = $1`,
          [counterpartyId],
        ),
      ]);

      const person = people[0] as Record<string, any> | undefined;

      return {
        ...present(booking, caller.userId),
        timeline: events,
        counterparty: person
          ? {
              id: person.id,
              displayName: person.display_name,
              accountKind: person.account_kind,
              companyName: person.company_name,
              verificationLevel: person.verification_level,
              memberSince: String(person.created_at),
              // The count that matters is the one for the role they are
              // playing in THIS booking.
              completedRentals:
                booking.tenant_id === caller.userId
                  ? person.completed_rentals_as_landlord
                  : person.completed_rentals_as_tenant,
              rating: person.rating === null ? null : Number(person.rating),
              reviewCount: person.review_count,
            }
          : null,
      };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/bookings/:id/accept',
    summary: 'Landlord accepts a request',
    tags: ['bookings'],
    auth: 'required',
    idempotent: true,
    async handler({ params, ctx, caller }) {
      await ctx.services.finance.assertNotRestricted(caller.userId, 'CANNOT_ACCEPT_NEW_BOOKINGS');
      const booking = await ctx.services.bookings.acceptRequest(params.id!, caller.userId, ctx.correlationId);
      await ctx.services.notifications.enqueue({
        userId: booking.tenant_id,
        category: 'BOOKING_DECISION',
        dedupeKey: `booking-accepted:${booking.id}`,
        payload: { bookingId: booking.id, status: booking.status },
      });
      return present(booking, caller.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/bookings/:id/decline',
    summary: 'Landlord declines a request',
    tags: ['bookings'],
    auth: 'required',
    body: z.object({ reason: z.string().trim().max(500).optional() }),
    async handler({ params, body, ctx, caller }) {
      const booking = await ctx.services.bookings.declineRequest(params.id!, caller.userId, body.reason);
      await ctx.services.notifications.enqueue({
        userId: booking.tenant_id,
        category: 'BOOKING_DECISION',
        dedupeKey: `booking-declined:${booking.id}`,
        payload: { bookingId: booking.id, status: booking.status },
      });
      return present(booking, caller.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/bookings/:id/withdraw',
    summary: 'Tenant withdraws a request',
    tags: ['bookings'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      return present(await ctx.services.bookings.withdraw(params.id!, caller.userId), caller.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/bookings/:id/cancel',
    summary: 'Cancel a confirmed booking',
    tags: ['bookings'],
    auth: 'required',
    body: z.object({ reason: z.string().trim().max(500).optional() }),
    async handler({ params, body, ctx, caller }) {
      const existing = await ctx.services.bookings.get(params.id!);
      // The service resolves the actor from the row; the route only chooses
      // which cancellation event applies.
      const booking =
        existing.tenant_id === caller.userId
          ? await ctx.services.bookings.cancelByTenant(params.id!, caller.userId, body.reason)
          : await ctx.services.bookings.cancelByLandlord(params.id!, caller.userId, body.reason);

      await ctx.services.notifications.enqueue({
        userId: existing.tenant_id === caller.userId ? existing.landlord_id : existing.tenant_id,
        category: 'BOOKING_CANCELLED',
        dedupeKey: `booking-cancelled:${booking.id}`,
        payload: { bookingId: booking.id, status: booking.status },
      });
      return present(booking, caller.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/bookings/:id/check-in',
    summary: 'Tenant confirms arrival',
    tags: ['bookings'],
    auth: 'required',
    idempotent: true,
    async handler({ params, ctx, caller }) {
      return present(await ctx.services.bookings.checkIn(params.id!, caller.userId), caller.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/bookings/:id/completion',
    summary: 'Confirm whether the rental actually took place',
    tags: ['bookings'],
    auth: 'required',
    idempotent: true,
    body: z.object({ answer: z.enum(['TOOK_PLACE', 'DID_NOT_TAKE_PLACE']) }),
    async handler({ params, body, ctx, caller }) {
      const result = await ctx.services.bookings.confirmCompletion(params.id!, caller.userId, body.answer, {
        now: ctx.now,
        correlationId: ctx.correlationId,
      });

      if (result.booking.status === 'COMPLETED') {
        for (const userId of [result.booking.tenant_id, result.booking.landlord_id]) {
          await ctx.services.notifications.enqueue({
            userId,
            category: 'REVIEW_REQUEST',
            dedupeKey: `review-request:${result.booking.id}:${userId}`,
            payload: { bookingId: result.booking.id },
          });
        }
        if (result.feeAccrued) {
          await ctx.services.notifications.enqueue({
            userId: result.booking.landlord_id,
            category: 'DEBT',
            dedupeKey: `fee-accrued:${result.booking.id}`,
            payload: { bookingId: result.booking.id },
          });
        }
      }

      return {
        ...present(result.booking, caller.userId),
        feeAccrued: result.feeAccrued,
      };
    },
  }),

  defineRoute({
    method: 'GET',
    // A quote is a property of the listing, not of a booking that does not yet
    // exist, so it lives under /listings.
    path: '/listings/:id/quote',
    summary: 'Price breakdown for a prospective stay',
    tags: ['bookings'],
    auth: 'none',
    query: z.object({ from: isoDate, to: isoDate }),
    async handler({ params, query, ctx }) {
      const { rows } = await ctx.db.query(
        `SELECT base_price_minor::text AS base_price_minor, price_unit,
                cleaning_fee_minor::text AS cleaning_fee_minor, utilities_mode,
                utilities_fixed_minor::text AS utilities_fixed_minor,
                deposit_minor::text AS deposit_minor, min_nights, max_nights
           FROM property WHERE id=$1 AND status='PUBLISHED' AND deleted_at IS NULL`,
        [params.id!],
      );
      const p = rows[0] as Record<string, string> | undefined;
      if (!p) {
        const { notFound } = await import('../../services/errors.ts');
        throw notFound('Объявление');
      }

      const { quote } = await import('../../domain/pricing.ts');
      const { toDecimalString } = await import('../../domain/money.ts');
      const q = quote(query.from, query.to, {
        basePriceMinor: BigInt(p.base_price_minor!),
        basePriceUnit: p.price_unit as 'NIGHT' | 'MONTH',
        cleaningFeeMinor: BigInt(p.cleaning_fee_minor!),
        utilitiesMode: p.utilities_mode as 'INCLUDED' | 'FIXED_EXTRA' | 'VARIABLE_METERED',
        utilitiesFixedMinor: BigInt(p.utilities_fixed_minor!),
        depositMinor: BigInt(p.deposit_minor!),
      });

      return {
        nights: q.nights,
        lines: q.lines.map((l) => ({
          code: l.code,
          label: l.label,
          amountMinor: l.amount.amountMinor.toString(),
          amountFormatted: toDecimalString(l.amount),
          variable: l.variable,
        })),
        totalExpectedMinor: q.totalExpected.amountMinor.toString(),
        depositMinor: q.deposit.amountMinor.toString(),
        hasVariableCosts: q.hasVariableCosts,
        // Shown to landlords, and to tenants as a transparency measure: the
        // platform's cut is never hidden.
        estimatedServiceFeeMinor: q.estimatedServiceFee.amountMinor.toString(),
      };
    },
  }),
];

/**
 * Booking projection.
 *
 * Includes the actions the caller may currently take, computed from the same
 * transition table the service enforces — so a button never appears for an
 * action the server would refuse.
 */
function present(source: unknown, viewerId: string): Record<string, unknown> {
  // Accepts both a BookingRow from the service and a wider row from the list
  // query, which carries extra joined columns.
  const booking = source as Record<string, unknown>;
  const role = booking.tenant_id === viewerId ? 'TENANT' : 'LANDLORD';
  return {
    id: booking.id,
    reference: booking.reference,
    status: booking.status,
    role,
    propertyId: booking.property_id,
    propertyTitle: booking.property_title,
    propertyCity: booking.property_city,
    coverPhoto: booking.cover_photo,
    stay: { from: booking.stay_from, to: booking.stay_to, nights: booking.nights },
    guests: booking.guests,
    money: {
      rentMinor: booking.rent_minor,
      totalExpectedMinor: booking.total_expected_minor,
      feeBaseMinor: booking.fee_base_minor,
    },
    completion: {
      tenantAnswer: booking.tenant_completion_answer,
      landlordAnswer: booking.landlord_completion_answer,
      deadlineAt: booking.completion_deadline_at,
    },
    createdAt: booking.created_at,
    confirmedAt: booking.confirmed_at,
    expiresAt: booking.expires_at,
    availableActions: availableEvents(booking.status as BookingState, role),
  };
}
