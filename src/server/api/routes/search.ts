import { z } from 'zod';
import { defineRoute, type AnyRoute } from '../http.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const csv = z
  .string()
  .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
  .pipe(z.array(z.string()).max(40));

const searchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  district: z.string().trim().max(80).optional(),

  // Map bounds, sent by the map view as it pans.
  north: z.coerce.number().min(-90).max(90).optional(),
  south: z.coerce.number().min(-90).max(90).optional(),
  east: z.coerce.number().min(-180).max(180).optional(),
  west: z.coerce.number().min(-180).max(180).optional(),

  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radius: z.coerce.number().int().min(100).max(100_000).optional(),

  from: isoDate.optional(),
  to: isoDate.optional(),
  durationMode: z.enum(['SHORT', 'MEDIUM', 'LONG', 'ANY']).optional(),
  minNights: z.coerce.number().int().min(1).optional(),
  maxNights: z.coerce.number().int().min(1).optional(),

  priceMin: z.string().regex(/^\d{1,15}$/).optional(),
  priceMax: z.string().regex(/^\d{1,15}$/).optional(),

  types: csv.optional(),
  rooms: z.coerce.number().int().min(0).max(30).optional(),
  beds: z.coerce.number().int().min(0).max(50).optional(),
  guests: z.coerce.number().int().min(1).max(50).optional(),
  amenities: csv.optional(),

  smoking: z.coerce.boolean().optional(),
  pets: z.coerce.boolean().optional(),
  children: z.coerce.boolean().optional(),
  instant: z.coerce.boolean().optional(),
  negotiable: z.coerce.boolean().optional(),
  verified: z.coerce.boolean().optional(),
  minRating: z.coerce.number().min(1).max(5).optional(),
  ownerKind: z.enum(['PRIVATE', 'COMPANY']).optional(),

  sort: z.enum(['RELEVANCE', 'PRICE_ASC', 'PRICE_DESC', 'RATING', 'NEWEST']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
});

export const searchRoutes: AnyRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/search',
    summary: 'Search listings',
    tags: ['search'],
    auth: 'none',
    // Generous but bounded: search is the most-hit endpoint and also the
    // easiest to abuse for scraping the whole catalogue.
    rateLimit: { limit: 120, windowSeconds: 60, by: 'ip', bucket: 'search' },
    query: searchQuery,
    async handler({ query, ctx }) {
      const bounds =
        query.north !== undefined && query.south !== undefined && query.east !== undefined && query.west !== undefined
          ? { north: query.north, south: query.south, east: query.east, west: query.west }
          : undefined;

      const near =
        query.lat !== undefined && query.lng !== undefined
          ? { latitude: query.lat, longitude: query.lng, radiusMeters: query.radius ?? 3000 }
          : undefined;

      return ctx.services.search.search({
        query: query.q,
        city: query.city,
        district: query.district,
        bounds,
        near,
        from: query.from,
        to: query.to,
        durationMode: query.durationMode,
        minNights: query.minNights,
        maxNights: query.maxNights,
        priceMinMinor: query.priceMin,
        priceMaxMinor: query.priceMax,
        propertyTypes: query.types,
        rooms: query.rooms,
        minBeds: query.beds,
        guests: query.guests,
        amenities: query.amenities,
        smoking: query.smoking,
        pets: query.pets,
        children: query.children,
        instantBooking: query.instant,
        negotiable: query.negotiable,
        verifiedOnly: query.verified,
        minRating: query.minRating,
        ownerKind: query.ownerKind,
        sort: query.sort,
        limit: query.limit,
        offset: query.offset,
      });
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/search/map',
    summary: 'Map markers for the current viewport',
    tags: ['search'],
    auth: 'none',
    rateLimit: { limit: 240, windowSeconds: 60, by: 'ip', bucket: 'search:map' },
    query: searchQuery,
    async handler({ query, ctx }) {
      const bounds =
        query.north !== undefined && query.south !== undefined && query.east !== undefined && query.west !== undefined
          ? { north: query.north, south: query.south, east: query.east, west: query.west }
          : undefined;

      const result = await ctx.services.search.search({
        city: query.city,
        bounds,
        from: query.from,
        to: query.to,
        priceMinMinor: query.priceMin,
        priceMaxMinor: query.priceMax,
        amenities: query.amenities,
        guests: query.guests,
        instantBooking: query.instant,
        // A marker layer needs many points but little detail per point.
        limit: 50,
        offset: query.offset,
      });

      // Markers carry the blurred coordinate only — the same rule as everywhere
      // else, restated here because a map endpoint is the obvious place to leak.
      return {
        total: result.total,
        markers: result.items.map((i) => ({
          id: i.id,
          latitude: i.location.latitude,
          longitude: i.location.longitude,
          precision: i.location.precision,
          priceMinor: i.stayTotalMinor ?? i.basePriceMinor,
          priceUnit: i.stayTotalMinor ? 'TOTAL' : i.priceUnit,
          title: i.title,
          coverPhoto: i.photos.find((p) => p.isCover)?.storageKey ?? i.photos[0]?.storageKey ?? null,
          rating: i.rating,
          verified: i.propertyVerified,
        })),
      };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/search/suggestions',
    summary: 'City and district suggestions',
    tags: ['search'],
    auth: 'none',
    rateLimit: { limit: 120, windowSeconds: 60, by: 'ip', bucket: 'search:suggest' },
    query: z.object({ q: z.string().trim().min(1).max(80) }),
    async handler({ query, ctx }) {
      const { rows } = await ctx.db.query(
        `SELECT city, district, count(*)::int AS listings
           FROM property
          WHERE status='PUBLISHED' AND deleted_at IS NULL
            AND (city ILIKE $1 || '%' OR district ILIKE $1 || '%' OR city % $1)
          GROUP BY city, district
          ORDER BY listings DESC
          LIMIT 10`,
        [query.q],
      );
      return rows;
    },
  }),
];
