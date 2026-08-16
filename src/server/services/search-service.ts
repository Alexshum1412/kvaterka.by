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

import { quote, type PricingRule } from '../domain/pricing.ts';
import { boundsAreReasonable, normalizeBounds, type Bounds } from '../domain/geo.ts';
import type { Db, Sql } from '../db/sql.ts';
import { forbidden, invalid, notFound } from './errors.ts';

export interface SearchFilters {
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
      // Bounding box first so the GiST index does the heavy lifting, then the
      // exact distance. Doing only the distance test would scan every row.
      const lat = push(filters.near.latitude);
      const lng = push(filters.near.longitude);
      const radius = push(filters.near.radiusMeters);
      where.push(
        `earth_box(ll_to_earth(${lat}, ${lng}), ${radius}) @> ll_to_earth(p.public_latitude, p.public_longitude)`,
        `earth_distance(ll_to_earth(${lat}, ${lng}), ll_to_earth(p.public_latitude, p.public_longitude)) <= ${radius}`,
      );
      distanceSelect = `, earth_distance(ll_to_earth(${lat}, ${lng}), ll_to_earth(p.public_latitude, p.public_longitude)) AS distance_m`;
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
      // Stemmed match OR trigram similarity, so a typo still finds the listing.
      const q = push(filters.query);
      where.push(
        `(to_tsvector('russian', p.title || ' ' || p.description || ' ' || p.city) @@ plainto_tsquery('russian', ${q})
          OR p.title % ${q} OR lower(p.city) = lower(${q}))`,
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
      where.push(
        `NOT EXISTS (
           SELECT 1 FROM booking b
            WHERE b.property_id = p.id
              AND b.status IN ('CONFIRMED','CHECKED_IN','COMPLETION_PENDING','DISPUTED','COMPLETED')
              AND b.stay_period && daterange(${from}::date, ${to}::date, '[)'))`,
        `NOT EXISTS (
           SELECT 1 FROM calendar_block cb
            WHERE cb.property_id = p.id
              AND cb.period && daterange(${from}::date, ${to}::date, '[)'))`,
      );
    }

    const ratingJoin = `
      LEFT JOIN LATERAL (
        SELECT round(avg(r.overall)::numeric, 2) AS rating, count(*)::int AS review_count
          FROM review r
         WHERE r.property_id = p.id AND r.status = 'PUBLISHED'
      ) rv ON true`;

    if (filters.minRating !== undefined) where.push(`COALESCE(rv.rating, 0) >= ${push(filters.minRating)}`);

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
             rv.rating, COALESCE(rv.review_count, 0) AS review_count
             ${distanceSelect}
        FROM property p
        JOIN app_user o ON o.id = p.owner_id
        ${ratingJoin}
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

  private orderClause(filters: SearchFilters, push: (v: unknown) => string): string {
    switch (filters.sort) {
      case 'PRICE_ASC':
        return 'p.base_price_minor ASC, p.id';
      case 'PRICE_DESC':
        return 'p.base_price_minor DESC, p.id';
      case 'RATING':
        return 'COALESCE(rv.rating, 0) DESC, rv.review_count DESC, p.id';
      case 'NEWEST':
        return 'p.published_at DESC NULLS LAST, p.id';
      default:
        // Relevance blends verification, freshness and rating. Paid placement is
        // deliberately absent: sponsored slots must never enter organic ranking
        // (spec §45).
        return `
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

    const exactLocationAllowed = isOwner || (viewerId ? await this.hasConfirmedBooking(propertyId, viewerId) : false);

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

function nightsBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}
