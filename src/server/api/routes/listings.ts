import { z } from 'zod';
import { defineRoute, ok, type AnyRoute } from '../http.ts';

const minorAmount = z
  .string()
  .regex(/^\d{1,15}$/, 'Сумма указывается в копейках целым числом')
  .describe('Amount in minor units (kopecks) as a decimal string');

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');

const listingCore = z.object({
  title: z.string().trim().min(8, 'Заголовок слишком короткий').max(120),
  description: z.string().trim().max(6000).optional(),
  propertyType: z.enum(['APARTMENT', 'ROOM', 'HOUSE', 'COTTAGE', 'STUDIO', 'TOWNHOUSE']),
  city: z.string().trim().min(2).max(80),
  region: z.string().trim().max(80).optional(),
  district: z.string().trim().max(80).optional(),
  street: z.string().trim().max(120).optional(),
  houseNumber: z.string().trim().max(20).optional(),
  apartmentNumber: z.string().trim().max(20).optional(),
  postalCode: z.string().trim().max(12).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  locationPrecision: z.enum(['EXACT', 'APPROXIMATE']).optional(),
  rooms: z.number().int().min(0).max(30).optional(),
  areaSqm: z.number().positive().max(9999).optional(),
  floor: z.number().int().min(-5).max(200).optional(),
  totalFloors: z.number().int().min(1).max(200).optional(),
  beds: z.number().int().min(0).max(50).optional(),
  bathrooms: z.number().int().min(0).max(20).optional(),
  maxGuests: z.number().int().min(1).max(50).optional(),
  smokingPolicy: z.enum(['PROHIBITED', 'ALLOWED', 'BALCONY_ONLY']).optional(),
  petsPolicy: z.enum(['PROHIBITED', 'ALLOWED', 'SMALL_ONLY', 'ON_REQUEST']).optional(),
  childrenAllowed: z.boolean().optional(),
  partiesAllowed: z.boolean().optional(),
  quietHoursFrom: timeOfDay.optional(),
  quietHoursTo: timeOfDay.optional(),
  checkInFrom: timeOfDay.optional(),
  checkOutUntil: timeOfDay.optional(),
  minNights: z.number().int().min(1).max(365 * 5).optional(),
  maxNights: z.number().int().min(1).max(365 * 5).optional(),
  basePriceMinor: minorAmount,
  priceUnit: z.enum(['NIGHT', 'MONTH']).optional(),
  cleaningFeeMinor: minorAmount.optional(),
  utilitiesMode: z.enum(['INCLUDED', 'FIXED_EXTRA', 'VARIABLE_METERED']).optional(),
  utilitiesFixedMinor: minorAmount.optional(),
  utilitiesNote: z.string().trim().max(500).optional(),
  depositMinor: minorAmount.optional(),
  bookingMode: z.enum(['INSTANT', 'REQUEST', 'INSTANT_AND_REQUEST']).optional(),
  negotiationEnabled: z.boolean().optional(),
  amenities: z.array(z.string().regex(/^[A-Z_]{2,40}$/)).max(60).optional(),
});

/**
 * Creating a draft asks for the property type and nothing else.
 *
 * The wizard's first screen is "что вы сдаёте?" and its price screen is
 * ninth; requiring a title, a location and a price up front would mean
 * there was nowhere to autosave the eight screens in between. Migration
 * 0008 moved the completeness requirement to the exit from DRAFT, and
 * this schema follows it.
 */
const listingDraft = listingCore.partial().extend({
  propertyType: listingCore.shape.propertyType,
});

export const listingRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/amenities',
    summary: 'The standardised amenity vocabulary',
    tags: ['listings'],
    auth: 'none',
    async handler({ ctx }) {
      const { rows } = await ctx.db.query(
        `SELECT code, category, name_ru, name_be, name_en, icon
           FROM amenity ORDER BY sort_order, code`,
      );
      return rows.map((r: Record<string, unknown>) => ({
        code: r.code,
        category: r.category,
        name: { ru: r.name_ru, be: r.name_be, en: r.name_en },
        icon: r.icon,
      }));
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/listings',
    summary: 'Create a listing draft',
    tags: ['listings'],
    auth: 'required',
    idempotent: true,
    rateLimit: { limit: 20, windowSeconds: 3600, by: 'user', bucket: 'listing:create' },
    body: listingDraft,
    successStatus: 201,
    async handler({ body, ctx, caller }) {
      // A landlord in arrears may keep managing what exists but may not add
      // more inventory (spec §12).
      await ctx.services.finance.assertNotRestricted(caller.userId, 'CANNOT_PUBLISH_NEW_LISTINGS');
      const result = await ctx.services.listings.createDraft(caller.userId, body);
      return ok({ id: result.id, status: 'DRAFT' }, 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/listings/mine',
    summary: 'Listings owned by the caller',
    tags: ['listings'],
    auth: 'required',
    async handler({ ctx, caller }) {
      const { rows } = await ctx.db.query(
        `SELECT p.id, p.title, p.status, p.city, p.rejection_reason,
                p.base_price_minor::text AS base_price_minor, p.price_unit,
                p.calendar_updated_at, p.published_at,
                (SELECT count(*)::int FROM property_photo ph WHERE ph.property_id = p.id) AS photo_count,
                (SELECT count(*)::int FROM booking b
                  WHERE b.property_id = p.id AND b.status = 'REQUESTED') AS pending_requests
           FROM property p
          WHERE p.owner_id = $1 AND p.deleted_at IS NULL
          ORDER BY p.created_at DESC`,
        [caller.userId],
      );
      return rows;
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/listings/:id/edit',
    summary: 'The owner’s own view of a listing, including an unfinished draft',
    tags: ['listings'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      return ctx.services.listings.getForOwner(params.id!, caller.userId);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/listings/:id',
    summary: 'Public listing detail',
    tags: ['listings'],
    auth: 'optional',
    async handler({ params, ctx }) {
      return ctx.services.search.getPublicListing(params.id!, ctx.caller?.userId ?? null);
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/listings/:id',
    summary: 'Update a listing',
    tags: ['listings'],
    auth: 'required',
    body: listingCore.partial(),
    async handler({ params, body, ctx, caller }) {
      await ctx.services.listings.update(params.id!, caller.userId, body);
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/listings/:id/address',
    summary: 'Exact address — released only after a confirmed booking',
    tags: ['listings'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      return ctx.services.search.revealExactLocation(params.id!, caller.userId);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/listings/:id/submit',
    summary: 'Submit a listing for moderation',
    tags: ['listings'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      await ctx.services.finance.assertNotRestricted(caller.userId, 'CANNOT_PUBLISH_NEW_LISTINGS');
      await ctx.services.listings.submitForModeration(params.id!, caller.userId);
      return { status: 'PENDING_MODERATION' };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/listings/:id/status',
    summary: 'Pause, resume or archive a listing',
    tags: ['listings'],
    auth: 'required',
    body: z.object({ status: z.enum(['PAUSED', 'PUBLISHED', 'ARCHIVED', 'DRAFT']) }),
    async handler({ params, body, ctx, caller }) {
      await ctx.services.listings.setStatusByOwner(params.id!, caller.userId, body.status);
      return { status: body.status };
    },
  }),

  /* THERE IS DELIBERATELY NO JSON ROUTE FOR ATTACHING A PHOTO.
   *
   * `POST /listings/:id/photos` used to accept `storageKey`, `width`, `height`
   * and `byteSize` straight from the client. It predated `POST /api/uploads`
   * and was never removed, so the codebase had two doors: one that decides the
   * content type by sniffing magic bytes, generates the key server-side and
   * strips EXIF, and one that took the client's word for all of it.
   *
   * DEC-029 states that "the client never influences" the storage key. That
   * was true of the upload endpoint and false of the product, which is the
   * worst combination — a documented guarantee with a registered bypass. No UI
   * called the JSON route; only tests did, one of them with a key literally
   * named `evil.jpg`, which is a fair description of what it permitted.
   *
   * Bytes arrive at `/api/uploads` or they do not arrive. See DEC-060. */

  defineRoute({
    method: 'POST',
    path: '/listings/:id/photos/:photoId/cover',
    summary: 'Set the cover photo',
    tags: ['listings'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      await ctx.services.listings.setCoverPhoto(params.id!, caller.userId, params.photoId!);
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/listings/:id/photos/:photoId',
    summary: 'Remove a photo',
    tags: ['listings'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      await ctx.services.listings.removePhoto(params.id!, caller.userId, params.photoId!);
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/listings/:id/pricing-rules',
    summary: 'Replace tiered and seasonal pricing rules',
    tags: ['listings'],
    auth: 'required',
    body: z.object({
      rules: z
        .array(
          z.object({
            kind: z.enum(['LENGTH_OF_STAY', 'SEASONAL']),
            minNights: z.number().int().min(1).optional(),
            maxNights: z.number().int().min(1).optional(),
            seasonFrom: isoDate.optional(),
            seasonTo: isoDate.optional(),
            priceMinor: minorAmount,
            priceUnit: z.enum(['NIGHT', 'MONTH']),
            priority: z.number().int().min(0).max(1000).optional(),
          }),
        )
        .max(60),
    }),
    async handler({ params, body, ctx, caller }) {
      await ctx.services.listings.replacePricingRules(params.id!, caller.userId, body.rules);
      return { ok: true, count: body.rules.length };
    },
  }),

  /* ---- availability ------------------------------------------------ */

  defineRoute({
    method: 'GET',
    path: '/listings/:id/availability',
    summary: 'Day-by-day calendar',
    tags: ['availability'],
    auth: 'optional',
    query: z.object({
      from: isoDate,
      to: isoDate,
      includePending: z.coerce.boolean().optional(),
    }),
    async handler({ params, query, ctx }) {
      return ctx.services.availability.getCalendar(params.id!, query.from, query.to, {
        includePending: query.includePending === true,
        viewerId: ctx.caller?.userId ?? null,
      });
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/listings/:id/availability/block',
    summary: 'Block dates',
    tags: ['availability'],
    auth: 'required',
    body: z.object({
      from: isoDate,
      to: isoDate,
      reason: z.enum(['BLOCKED', 'MAINTENANCE', 'PERSONAL_USE', 'EXTERNAL_BOOKING']).optional(),
      note: z.string().trim().max(300).optional(),
    }),
    successStatus: 201,
    async handler({ params, body, ctx, caller }) {
      const result = await ctx.services.availability.block(
        params.id!,
        caller.userId,
        body.from,
        body.to,
        body.reason,
        body.note,
      );
      return ok({ id: result.id }, 201);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/availability/blocks/:blockId',
    summary: 'Remove a calendar block',
    tags: ['availability'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      await ctx.services.availability.unblock(params.blockId!, caller.userId);
      return { ok: true };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/listings/:id/availability/confirm',
    summary: 'Confirm the calendar is up to date',
    tags: ['availability'],
    auth: 'required',
    async handler({ params, ctx, caller }) {
      await ctx.services.availability.confirmUpToDate(params.id!, caller.userId);
      return { ok: true };
    },
  }),
];
