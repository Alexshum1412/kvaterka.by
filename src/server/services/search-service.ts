/**
 * Search, map and listing detail.
 *
 * Two properties this file is built around:
 *
 *   1. NO N+1. A result page costs three queries regardless of page size:
 *      the listings, then their photos, then their amenities — each fetched
 *      with one `= ANY($1)` over the page's ids. Nothing loops over rows
 *      issuing more queries.
 *
 *   2. NO EXACT LOCATION LEAKS. Every public projection reads
 *      public_latitude/public_longitude and omits street, house and apartment.
 *      The exact address has exactly one accessor, `revealExactLocation`,
 *      which checks entitlement first.
 */

import { nightsBetween, quote, type PricingRule } from '../domain/pricing.ts';
import {
  boundsAreReasonable,
  normalizeBounds,
  EARTH_RADIUS_M,
  METRES_PER_DEGREE_LAT,
  type Bounds,
} from '../domain/geo.ts';
import type { Db, Sql } from '../db/sql.ts';
import { forbidden, invalid, notFound } from './errors.ts';

export interface SearchFilters {
  /**
   * Restrict to an explicit set of listings. Used by the favourites page,
   * which knows the ids but still needs the same public projection — the
   * one that omits the exact address — rather than a second hand-written
   * query that could forget to.
   */
  readonly ids?: readonly string[];
  readonly city?: string;
  readonly district?: string;
  readonly bounds?: Bounds;
  readonly near?: { latitude: number; longitude: number; radiusMeters: number };
  readonly from?: string;
  readonly to?: string;
  readonly minNights?: number;
  readonly maxNights?: number;
  readonly durationMode?: 'SHORT' | 'MEDIUM' | 'LONG' | 'ANY';
  readonly priceMinMinor?: string;
  readonly priceMaxMinor?: string;
  readonly propertyTypes?: readonly string[];
  readonly rooms?: number;
  readonly minBeds?: number;
  readonly guests?: number;
  readonly amenities?: readonly string[];
  readonly smoking?: boolean;
  readonly pets?: boolean;
  readonly children?: boolean;
  readonly instantBooking?: boolean;
  readonly negotiable?: boolean;
  readonly verifiedOnly?: boolean;
  readonly minRating?: number;
  readonly ownerKind?: 'PRIVATE' | 'COMPANY';
  readonly query?: string;
  readonly sort?: 'RELEVANCE' | 'PRICE_ASC' | 'PRICE_DESC' | 'RATING' | 'NEWEST';
  readonly limit?: number;
  readonly offset?: number;
}

export interface SearchResultItem {
  readonly id: string;
  readonly title: string;
  readonly propertyType: string;
  readonly city: string;
  readonly district: string | null;
  /** Blurred point. The exact location is never part of a search result. */
  readonly location: { latitude: number; longitude: number; precision: 'APPROXIMATE' };
  readonly rooms: number | null;
  readonly areaSqm: string | null;
  readonly beds: number | null;
  readonly maxGuests: number;
  readonly floor: number | null;
  readonly totalFloors: number | null;
  readonly basePriceMinor: string;
  readonly priceUnit: string;
  readonly cleaningFeeMinor: string;
  readonly utilitiesMode: string;
  readonly minNights: number;
  readonly maxNights: number;
  readonly bookingMode: string;
  readonly negotiationEnabled: boolean;
  readonly photos: readonly { id: string; storageKey: string; isCover: boolean }[];
  readonly amenities: readonly string[];
  readonly owner: {
    readonly id: string;
    readonly displayName: string;
    readonly accountKind: string;
    readonly verificationLevel: number;
    readonly completedRentals: number;
  };
  readonly propertyVerified: boolean;
  readonly rating: number | null;
  readonly reviewCount: number;
  readonly calendarUpdatedAt: string;
  /** Paid placement — a separate tier, never a factor in the relevance score. See orderClause(). */
  readonly isBoosted: boolean;
  /** The strongest paid placement — ranked above isBoosted. See orderClause(). */
  readonly isPinned: boolean;
  /** Visual treatment only (listing-card.tsx) — never joined into orderClause(). */
  readonly isHighlighted: boolean;
  readonly distanceMeters?: number;
  /** Total for the requested dates, present only when dates were supplied. */
  readonly stayTotalMinor?: string;
}

export interface SearchResult {
  readonly items: readonly SearchResultItem[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

const MAX_LIMIT = 50;

export class SearchService {
  constructor(private readonly db: Db) {}

  async search(filters: SearchFilters): Promise<SearchResult> {
    const limit = Math.min(Math.max(filters.limit ?? 20, 1), MAX_LIMIT);
    const offset = Math.max(filters.offset ?? 0, 0);

    if (filters.bounds && !boundsAreReasonable(filters.bounds)) {
      throw invalid('Слишком большая область поиска — уменьшите масштаб карты');
    }
    if (filters.from && filters.to && filters.to <= filters.from) {
      throw invalid('Дата выезда должна быть позже даты заезда');
    }

    const where: string[] = [`p.status = 'PUBLISHED'`, `p.deleted_at IS NULL`];
    const params: unknown[] = [];
    const push = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    // An empty id set means "nothing", not "everything" — a favourites page
    // with no saved listings must not fall through to the whole catalogue.
    if (filters.ids) where.push(`p.id = ANY(${push([...filters.ids])}::uuid[])`);
    if (filters.city) where.push(`lower(p.city) = lower(${push(filters.city)})`);
    if (filters.district) where.push(`lower(p.district) = lower(${push(filters.district)})`);

    if (filters.bounds) {
      const b = normalizeBounds(filters.bounds);
      where.push(
        `p.public_latitude BETWEEN ${push(b.south)} AND ${push(b.north)}`,
        `p.public_longitude BETWEEN ${push(b.west)} AND ${push(b.east)}`,
      );
    }

    // Placeholders for the origin point are captured here so the SELECT list can
    // reuse them; looking them up by value later would break on duplicates.
    let distanceSelect = '';
    if (filters.near) {
      const lat = push(filters.near.latitude);
      const lng = push(filters.near.longitude);
      const radius = push(filters.near.radiusMeters);

      /* Radius search without PostGIS and without earthdistance, which needs an
         extension the production host will not install.

         Two steps, and the order is the whole point. First a latitude/longitude
         rectangle, which property_geo_idx can answer with an index scan. Only
         then the exact great-circle distance on the handful of rows that
         survived — a trigonometric expression no index can help with, so
         running it first would mean evaluating it against every published
         listing in the country.

         The rectangle is deliberately the loose test: it always contains the
         circle, so it can over-select but never under-select, and the exact
         test that follows removes the corners. A degree of latitude is the same
         distance everywhere; a degree of longitude shrinks towards the poles by
         cos(latitude), which is why the two deltas differ. The greatest(...)
         floor keeps the longitude delta finite at the poles, where cos reaches
         zero and the division would not — Belarus never goes near it, but a
         search does not have to be in Belarus to avoid dividing by zero.

         The distance itself is haversine, identical term for term to
         distanceMeters() in src/server/domain/geo.ts, sharing its radius
         constant. Public coordinates are blurred by 120-350 m before they are
         ever stored (DEC-020), so arguing about metres here would be arguing
         about a number the data does not carry. */
      const lngScale = `greatest(cos(radians(${lat})), 0.01)`;
      const distance = `(2 * ${EARTH_RADIUS_M} * asin(least(1, sqrt(
             power(sin(radians(p.public_latitude - ${lat}) / 2), 2)
           + power(sin(radians(p.public_longitude - ${lng}) / 2), 2)
             * cos(radians(${lat})) * cos(radians(p.public_latitude))))))`;

      where.push(
        `p.public_latitude BETWEEN ${lat} - (${radius} / ${METRES_PER_DEGREE_LAT})
                               AND ${lat} + (${radius} / ${METRES_PER_DEGREE_LAT})`,
        `p.public_longitude BETWEEN ${lng} - (${radius} / (${METRES_PER_DEGREE_LAT} * ${lngScale}))
                                AND ${lng} + (${radius} / (${METRES_PER_DEGREE_LAT} * ${lngScale}))`,
        `${distance} <= ${radius}`,
      );
      distanceSelect = `, ${distance} AS distance_m`;
    }

    if (filters.propertyTypes?.length) where.push(`p.property_type = ANY(${push(filters.propertyTypes)})`);
    if (filters.rooms !== undefined) where.push(`p.rooms >= ${push(filters.rooms)}`);
    if (filters.minBeds !== undefined) where.push(`p.beds >= ${push(filters.minBeds)}`);
    if (filters.guests !== undefined) where.push(`p.max_guests >= ${push(filters.guests)}`);
    if (filters.priceMinMinor) where.push(`p.base_price_minor >= ${push(filters.priceMinMinor)}`);
    if (filters.priceMaxMinor) where.push(`p.base_price_minor <= ${push(filters.priceMaxMinor)}`);

    if (filters.smoking === true) where.push(`p.smoking_policy <> 'PROHIBITED'`);
    if (filters.pets === true) where.push(`p.pets_policy <> 'PROHIBITED'`);
    if (filters.children === true) where.push(`p.children_allowed`);

    if (filters.instantBooking === true) where.push(`p.booking_mode IN ('INSTANT','INSTANT_AND_REQUEST')`);
    if (filters.negotiable === true) where.push(`p.negotiation_enabled`);
    if (filters.verifiedOnly === true) where.push(`p.property_verified_at IS NOT NULL`);
    if (filters.ownerKind) where.push(`o.account_kind = ${push(filters.ownerKind)}`);

    // Duration: a listing matches when the requested stay length is inside the
    // landlord's own range, so nobody sees listings they cannot actually book.
    const requestedNights = filters.from && filters.to ? nightsBetween(filters.from, filters.to) : null;
    if (requestedNights !== null) {
      where.push(`p.min_nights <= ${push(requestedNights)}`, `p.max_nights >= ${push(requestedNights)}`);
    } else {
      if (filters.minNights !== undefined) where.push(`p.max_nights >= ${push(filters.minNights)}`);
      if (filters.maxNights !== undefined) where.push(`p.min_nights <= ${push(filters.maxNights)}`);
    }

    if (filters.durationMode && filters.durationMode !== 'ANY') {
      const band =
        filters.durationMode === 'SHORT'
          ? { lo: 1, hi: 30 }
          : filters.durationMode === 'MEDIUM'
            ? { lo: 30, hi: 180 }
            : { lo: 180, hi: 365 * 5 };
      where.push(`p.min_nights <= ${push(band.hi)}`, `p.max_nights >= ${push(band.lo)}`);
    }

    if (filters.query) {
      /* Stemmed full-text match, or an exact city name.

         WHAT WAS LOST HERE. There used to be a third branch, `p.title % $q`,
         which was pg_trgm's similarity operator and made the search tolerant of
         typos: "Немга" still found "Немига". pg_trgm needs a superuser to
         install and the production host does not give us one, so that branch is
         gone and typo tolerance with it. This is a real reduction in what the
         search box does, not a refactor — a misspelt query now returns nothing
         rather than the listing the tenant meant. It is recorded in
         DECISIONS.md and comes back as a one-line migration on any server that
         has the extension.

         What replaced it is not a substitute but it is not nothing: the
         full-text branch was doing the real work all along and had no index
         behind it. It has one now (property_fts_idx), and this expression is
         written to match that index character for character — change either and
         the planner silently stops using it, which is why a test asserts on the
         plan rather than only on the results.

         Both branches are indexable, so the OR becomes a bitmap union rather
         than a sequential scan. An ILIKE '%...%' branch was considered for
         partial words and rejected for exactly that reason: it cannot use an
         index, and one unindexable branch in an OR drags the whole query down
         to a full scan of every published listing. */
      const q = push(filters.query);
      where.push(
        `(to_tsvector('russian', p.title || ' ' || p.description || ' ' || p.city) @@ plainto_tsquery('russian', ${q})
          OR lower(p.city) = lower(${q}))`,
      );
    }

    // Amenities: every requested code must be present. A GROUP BY/HAVING count
    // would work too; this form keeps the main query flat and index-friendly.
    if (filters.amenities?.length) {
      const codes = push(filters.amenities);
      where.push(
        `(SELECT count(*) FROM property_amenity pa
           WHERE pa.property_id = p.id AND pa.amenity_code = ANY(${codes})) = ${push(filters.amenities.length)}`,
      );
    }

    // Availability: exclude anything already booked or blocked for the dates.
    if (filters.from && filters.to) {
      const from = push(filters.from);
      const to = push(filters.to);
      /* Two subqueries became one. Bookings and blocks used to be asked
         separately, each with a range-overlap test needing a GiST index; both
         now claim their nights in property_occupancy, so "is this property free"
         is a lookup on that table's primary key. Same answer — a night shared
         with a '[)' range is exactly a night in [from, to) — fewer moving parts,
         and an index that already exists. */
      where.push(
        `NOT EXISTS (
           SELECT 1 FROM property_occupancy po
            WHERE po.property_id = p.id
              AND po.night >= ${from}::date
              AND po.night <  ${to}::date)`,
      );
    }

    const ratingJoin = `
      LEFT JOIN LATERAL (
        SELECT round(avg(r.overall)::numeric, 2) AS rating, count(*)::int AS review_count
          FROM review r
         WHERE r.property_id = p.id AND r.status = 'PUBLISHED'
      ) rv ON true`;

    if (filters.minRating !== undefined) where.push(`COALESCE(rv.rating, 0) >= ${push(filters.minRating)}`);

    /* Paid placement, joined as its own sibling to ratingJoin rather than
       folded into any existing subquery. Only ever read for the fixed
       tie-breaks at the front of orderClause() and for `isBoosted`/`isPinned`
       below — never for the relevance score itself (see that method's
       comment). Not added to countSql: a LEFT JOIN cannot change how many
       rows match, and nothing here filters on it.

       `starts_at <= now()` matters here in a way it did not before a boost
       could be bought in bundles: a MONTHLY boost tier inserts four rows up
       front, three of them dated in the future, and without this check the
       third and fourth week's rows would already read as active the moment
       they were purchased. */
    const boostJoin = `
      LEFT JOIN listing_boost lb
        ON lb.property_id = p.id AND lb.status = 'ACTIVE'
       AND lb.starts_at <= now() AND lb.ends_at > now()`;

    // Same shape as boostJoin, against the stronger placement table — see
    // pin-service.ts. A pin has no multi-row schedule today, but the same
    // starts_at guard is kept for consistency and because nothing about this
    // join assumes a single row.
    const pinJoin = `
      LEFT JOIN listing_pin lp
        ON lp.property_id = p.id AND lp.status = 'ACTIVE'
       AND lp.starts_at <= now() AND lp.ends_at > now()`;

    // Visual-only — read for `isHighlighted` alone, never for ordering.
    const highlightJoin = `
      LEFT JOIN listing_highlight lh
        ON lh.property_id = p.id AND lh.status = 'ACTIVE'
       AND lh.starts_at <= now() AND lh.ends_at > now()`;

    const orderBy = this.orderClause(filters, push);
    const whereSql = where.join('\n  AND ');

    const listSql = `
      SELECT p.id, p.title, p.property_type, p.city, p.district,
             p.public_latitude, p.public_longitude,
             p.rooms, p.area_sqm::text AS area_sqm, p.beds, p.max_guests, p.floor, p.total_floors,
             p.base_price_minor::text AS base_price_minor, p.price_unit,
             p.cleaning_fee_minor::text AS cleaning_fee_minor, p.utilities_mode,
             p.utilities_fixed_minor::text AS utilities_fixed_minor,
             p.deposit_minor::text AS deposit_minor,
             p.min_nights, p.max_nights, p.booking_mode, p.negotiation_enabled,
             p.property_verified_at, p.calendar_updated_at,
             o.id AS owner_id, o.display_name AS owner_name, o.account_kind AS owner_kind,
             o.verification_level AS owner_verification, o.completed_rentals_as_landlord AS owner_completed,
             rv.rating, COALESCE(rv.review_count, 0) AS review_count,
             lb.id AS lb_id, lp.id AS lp_id, lh.id AS lh_id
             ${distanceSelect}
        FROM property p
        JOIN app_user o ON o.id = p.owner_id
        ${ratingJoin}
        ${boostJoin}
        ${pinJoin}
        ${highlightJoin}
       WHERE ${whereSql}
       ORDER BY ${orderBy}
       LIMIT ${push(limit)} OFFSET ${push(offset)}`;

    const countSql = `
      SELECT count(*)::int AS total
        FROM property p
        JOIN app_user o ON o.id = p.owner_id
        ${ratingJoin}
       WHERE ${whereSql}`;

    const [listResult, countResult] = await Promise.all([
      this.db.query<Record<string, any>>(listSql, params),
      this.db.query<{ total: number }>(countSql, params.slice(0, params.length - 2)),
    ]);

    const ids = listResult.rows.map((r) => r.id as string);
    const { photos, amenities } = await this.loadChildren(this.db, ids);

    const pricingRules = filters.from && filters.to ? await this.loadPricingRules(this.db, ids) : new Map();

    const items = listResult.rows.map((row): SearchResultItem => {
      const base: SearchResultItem = {
        id: row.id,
        title: row.title,
        propertyType: row.property_type,
        city: row.city,
        district: row.district,
        location: {
          latitude: Number(row.public_latitude),
          longitude: Number(row.public_longitude),
          precision: 'APPROXIMATE',
        },
        rooms: row.rooms,
        areaSqm: row.area_sqm,
        beds: row.beds,
        maxGuests: row.max_guests,
        floor: row.floor,
        totalFloors: row.total_floors,
        basePriceMinor: row.base_price_minor,
        priceUnit: row.price_unit,
        cleaningFeeMinor: row.cleaning_fee_minor,
        utilitiesMode: row.utilities_mode,
        minNights: row.min_nights,
        maxNights: row.max_nights,
        bookingMode: row.booking_mode,
        negotiationEnabled: row.negotiation_enabled,
        photos: photos.get(row.id) ?? [],
        amenities: amenities.get(row.id) ?? [],
        owner: {
          id: row.owner_id,
          displayName: row.owner_name,
          accountKind: row.owner_kind,
          verificationLevel: row.owner_verification,
          completedRentals: row.owner_completed,
        },
        propertyVerified: row.property_verified_at !== null,
        rating: row.rating === null ? null : Number(row.rating),
        reviewCount: Number(row.review_count),
        calendarUpdatedAt: row.calendar_updated_at,
        isBoosted: row.lb_id !== null,
        isPinned: row.lp_id !== null,
        isHighlighted: row.lh_id !== null,
        ...(row.distance_m !== undefined ? { distanceMeters: Math.round(Number(row.distance_m)) } : {}),
      };

      if (filters.from && filters.to) {
        const q = quote(filters.from, filters.to, {
          basePriceMinor: BigInt(row.base_price_minor),
          basePriceUnit: row.price_unit,
          cleaningFeeMinor: BigInt(row.cleaning_fee_minor),
          utilitiesMode: row.utilities_mode,
          utilitiesFixedMinor: BigInt(row.utilities_fixed_minor),
          depositMinor: BigInt(row.deposit_minor),
          rules: pricingRules.get(row.id) ?? [],
        });
        return { ...base, stayTotalMinor: q.totalExpected.amountMinor.toString() };
      }
      return base;
    });

    return { items, total: Number(countResult.rows[0]?.total ?? 0), limit, offset };
  }

  // `_push` is unused: every ordering is a fixed column list with no bound
  // parameters. It stays in the signature so the clause builders share one
  // shape with the filter builders that do bind values.
  private orderClause(filters: SearchFilters, _push: (v: unknown) => string): string {
    /* Paid placement is two separate top tiers, prepended as the FIRST keys
       of every branch below — never blended into any of them. A pinned
       listing floats above a merely boosted one, which floats above the
       untouched ordering for whichever sort the visitor picked; neither tier
       changes the relative order of the listings beneath it, because every
       branch's own keys still decide everything after these two. The
       relevance formula in the default branch stays exactly as it was:
       sponsored slots must never enter organic ranking (spec §45) — this is
       the "separate tier", not a repeal of that rule. */
    const pinTier = `(CASE WHEN lp.id IS NOT NULL THEN 1 ELSE 0 END) DESC`;
    const boostTier = `(CASE WHEN lb.id IS NOT NULL THEN 1 ELSE 0 END) DESC`;

    switch (filters.sort) {
      case 'PRICE_ASC':
        return `${pinTier}, ${boostTier}, p.base_price_minor ASC, p.id`;
      case 'PRICE_DESC':
        return `${pinTier}, ${boostTier}, p.base_price_minor DESC, p.id`;
      case 'RATING':
        return `${pinTier}, ${boostTier}, COALESCE(rv.rating, 0) DESC, rv.review_count DESC, p.id`;
      case 'NEWEST':
        return `${pinTier}, ${boostTier}, p.published_at DESC NULLS LAST, p.id`;
      default:
        // Relevance blends verification, freshness and rating. Paid placement
        // is deliberately absent FROM THIS FORMULA: sponsored slots must never
        // enter organic ranking (spec §45). pinTier/boostTier above are not
        // that — they are fixed tiers ABOVE the formula's output, not terms
        // inside it.
        return `
          ${pinTier}, ${boostTier},
          (CASE WHEN p.property_verified_at IS NOT NULL THEN 2 ELSE 0 END
           + CASE WHEN o.verification_level >= 1 THEN 1 ELSE 0 END
           + CASE WHEN p.calendar_updated_at > now() - interval '7 days' THEN 2
                  WHEN p.calendar_updated_at > now() - interval '30 days' THEN 1 ELSE 0 END
           + COALESCE(rv.rating, 0) / 2.5) DESC,
          p.published_at DESC NULLS LAST, p.id`;
    }
  }

  /** Two queries for the whole page, never one per row. */
  private async loadChildren(
    sql: Sql,
    ids: readonly string[],
  ): Promise<{
    photos: Map<string, { id: string; storageKey: string; isCover: boolean }[]>;
    amenities: Map<string, string[]>;
  }> {
    const photos = new Map<string, { id: string; storageKey: string; isCover: boolean }[]>();
    const amenities = new Map<string, string[]>();
    if (ids.length === 0) return { photos, amenities };

    const [photoRows, amenityRows] = await Promise.all([
      sql.query<{ id: string; property_id: string; storage_key: string; is_cover: boolean }>(
        `SELECT id, property_id, storage_key, is_cover FROM property_photo
          WHERE property_id = ANY($1) ORDER BY property_id, is_cover DESC, sort_order`,
        [ids],
      ),
      sql.query<{ property_id: string; amenity_code: string }>(
        `SELECT property_id, amenity_code FROM property_amenity WHERE property_id = ANY($1)`,
        [ids],
      ),
    ]);

    for (const r of photoRows.rows) {
      const list = photos.get(r.property_id) ?? [];
      list.push({ id: r.id, storageKey: r.storage_key, isCover: r.is_cover });
      photos.set(r.property_id, list);
    }
    for (const r of amenityRows.rows) {
      const list = amenities.get(r.property_id) ?? [];
      list.push(r.amenity_code);
      amenities.set(r.property_id, list);
    }
    return { photos, amenities };
  }

  private async loadPricingRules(sql: Sql, ids: readonly string[]): Promise<Map<string, PricingRule[]>> {
    const out = new Map<string, PricingRule[]>();
    if (ids.length === 0) return out;

    const { rows } = await sql.query<Record<string, any>>(
      `SELECT property_id, kind, min_nights, max_nights,
              lower(season)::text AS season_from, upper(season)::text AS season_to,
              price_minor::text AS price_minor, price_unit, priority
         FROM pricing_rule WHERE property_id = ANY($1)`,
      [ids],
    );

    for (const r of rows) {
      const list = out.get(r.property_id) ?? [];
      list.push(
        r.kind === 'LENGTH_OF_STAY'
          ? {
              kind: 'LENGTH_OF_STAY',
              minNights: r.min_nights ?? 1,
              maxNights: r.max_nights ?? Number.MAX_SAFE_INTEGER,
              priceMinor: BigInt(r.price_minor),
              priceUnit: r.price_unit,
              priority: r.priority,
            }
          : {
              kind: 'SEASONAL',
              from: r.season_from ?? '1970-01-01',
              to: r.season_to ?? '9999-12-31',
              priceMinor: BigInt(r.price_minor),
              priceUnit: r.price_unit,
              priority: r.priority,
            },
      );
      out.set(r.property_id, list);
    }
    return out;
  }

  /* ---------------------------------------------------------------- */

  /** Public listing detail. Never includes the exact address. */
  async getPublicListing(propertyId: string, viewerId?: string | null): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT p.*, p.base_price_minor::text AS base_price_minor,
              p.cleaning_fee_minor::text AS cleaning_fee_minor,
              p.utilities_fixed_minor::text AS utilities_fixed_minor,
              p.deposit_minor::text AS deposit_minor,
              p.area_sqm::text AS area_sqm,
              o.id AS owner_id, o.display_name AS owner_name, o.account_kind AS owner_kind,
              o.company_name AS owner_company, o.verification_level AS owner_verification,
              o.completed_rentals_as_landlord AS owner_completed, o.created_at AS owner_since,
              o.trust_score AS owner_trust
         FROM property p JOIN app_user o ON o.id = p.owner_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [propertyId],
    );
    const row = rows[0];
    if (!row) throw notFound('Объявление');

    const isOwner = viewerId !== null && viewerId !== undefined && row.owner_id === viewerId;
    if (row.status !== 'PUBLISHED' && !isOwner) throw notFound('Объявление');

    const { photos, amenities } = await this.loadChildren(this.db, [propertyId]);
    const rules = await this.loadPricingRules(this.db, [propertyId]);

    const reviews = await this.db.query<{ rating: string | null; review_count: number }>(
      `SELECT round(avg(overall)::numeric,2) AS rating, count(*)::int AS review_count
         FROM review WHERE property_id=$1 AND status='PUBLISHED'`,
      [propertyId],
    );

    const exactLocationAllowed =
      isOwner || (viewerId ? await this.hasConfirmedBooking(propertyId, viewerId) : false);

    return {
      id: row.id,
      status: row.status,
      title: row.title,
      description: row.description,
      propertyType: row.property_type,
      city: row.city,
      district: row.district,
      // Street-level and finer detail is withheld until the booking is confirmed.
      ...(exactLocationAllowed
        ? {
            address: {
              street: row.street,
              houseNumber: row.house_number,
              apartmentNumber: row.apartment_number,
              postalCode: row.postal_code,
            },
            location: {
              latitude: Number(row.latitude),
              longitude: Number(row.longitude),
              precision: 'EXACT',
            },
          }
        : {
            location: {
              latitude: Number(row.public_latitude),
              longitude: Number(row.public_longitude),
              precision: 'APPROXIMATE',
            },
          }),
      rooms: row.rooms,
      areaSqm: row.area_sqm,
      floor: row.floor,
      totalFloors: row.total_floors,
      beds: row.beds,
      bathrooms: row.bathrooms,
      maxGuests: row.max_guests,
      rules: {
        smoking: row.smoking_policy,
        pets: row.pets_policy,
        childrenAllowed: row.children_allowed,
        partiesAllowed: row.parties_allowed,
        quietHoursFrom: row.quiet_hours_from,
        quietHoursTo: row.quiet_hours_to,
        checkInFrom: row.check_in_from,
        checkOutUntil: row.check_out_until,
      },
      duration: { minNights: row.min_nights, maxNights: row.max_nights },
      pricing: {
        basePriceMinor: row.base_price_minor,
        priceUnit: row.price_unit,
        cleaningFeeMinor: row.cleaning_fee_minor,
        utilitiesMode: row.utilities_mode,
        utilitiesFixedMinor: row.utilities_fixed_minor,
        utilitiesNote: row.utilities_note,
        depositMinor: row.deposit_minor,
        rules: (rules.get(propertyId) ?? []).map((r) => ({ ...r, priceMinor: r.priceMinor.toString() })),
      },
      bookingMode: row.booking_mode,
      negotiationEnabled: row.negotiation_enabled,
      photos: photos.get(propertyId) ?? [],
      amenities: amenities.get(propertyId) ?? [],
      owner: {
        id: row.owner_id,
        // A company must be presented as a company (spec §4.2).
        displayName: row.owner_kind === 'COMPANY' ? (row.owner_company ?? row.owner_name) : row.owner_name,
        accountKind: row.owner_kind,
        verificationLevel: row.owner_verification,
        completedRentals: row.owner_completed,
        memberSince: row.owner_since,
        trustScore: row.owner_trust,
      },
      verification: {
        propertyVerified: row.property_verified_at !== null,
        propertyVerifiedAt: row.property_verified_at,
        identityVerified: row.owner_verification >= 1,
      },
      freshness: {
        calendarUpdatedAt: row.calendar_updated_at,
        contentUpdatedAt: row.content_updated_at,
        publishedAt: row.published_at,
      },
      rating: reviews.rows[0]?.rating ? Number(reviews.rows[0].rating) : null,
      reviewCount: Number(reviews.rows[0]?.review_count ?? 0),
    };
  }

  /**
   * The single accessor for an exact address. Everything else in this service
   * returns the blurred point, so there is exactly one place to audit.
   */
  async revealExactLocation(propertyId: string, viewerId: string): Promise<Record<string, unknown>> {
    const allowed = await this.hasConfirmedBooking(propertyId, viewerId);
    if (!allowed) {
      const { rows } = await this.db.query<{ owner_id: string }>(
        `SELECT owner_id FROM property WHERE id=$1`,
        [propertyId],
      );
      if (rows[0]?.owner_id !== viewerId) {
        throw forbidden('Точный адрес доступен после подтверждения бронирования');
      }
    }

    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT street, house_number, apartment_number, postal_code, latitude, longitude
         FROM property WHERE id=$1`,
      [propertyId],
    );
    const row = rows[0];
    if (!row) throw notFound('Объявление');
    return {
      street: row.street,
      houseNumber: row.house_number,
      apartmentNumber: row.apartment_number,
      postalCode: row.postal_code,
      location: { latitude: Number(row.latitude), longitude: Number(row.longitude), precision: 'EXACT' },
    };
  }

  private async hasConfirmedBooking(propertyId: string, viewerId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM booking
        WHERE property_id=$1 AND tenant_id=$2
          AND status IN ('CONFIRMED','CHECKED_IN','COMPLETION_PENDING','COMPLETED','DISPUTED')`,
      [propertyId, viewerId],
    );
    return Number(rows[0]!.c) > 0;
  }
}
