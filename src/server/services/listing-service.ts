/**
 * Listing lifecycle.
 *
 *   DRAFT → PENDING_MODERATION → PUBLISHED ⇄ PAUSED
 *                     ↓                        ↓
 *                 REJECTED                 ARCHIVED
 *
 * Two rules shape every method here:
 *
 *   1. Editing is only unrestricted while a listing is not live. A published
 *      listing may be corrected, but a change to price, duration or rules
 *      never reaches an already-confirmed booking — those terms are frozen on
 *      the booking row and in its listing snapshot.
 *   2. The exact address is not part of the public representation. It is
 *      released to a tenant only once their booking is confirmed.
 */

import { uuidv7 } from '../../lib/id.ts';
import { isValidLatLng, isWithinBelarus, publicLocationFor } from '../domain/geo.ts';
import { hasErrorCode, PG_ERROR, type Db, type Sql } from '../db/sql.ts';
import { DomainError, forbidden, invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

/** timestamptz arrives as a Date; every interface here promises a string. */
const iso = (value: unknown): string => new Date(value as string).toISOString();
import {
  MODERATION_REASON_CODES,
  reasonSentence,
  type ModerationReasonCode,
} from '../domain/moderation.ts';

export type ListingStatus =
  | 'DRAFT'
  | 'PENDING_MODERATION'
  | 'PUBLISHED'
  | 'PAUSED'
  | 'REJECTED'
  | 'ARCHIVED';

/** Who may move a listing where. The owner cannot approve their own listing. */
const OWNER_TRANSITIONS: Partial<Record<ListingStatus, readonly ListingStatus[]>> = {
  DRAFT: ['PENDING_MODERATION', 'ARCHIVED'],
  REJECTED: ['PENDING_MODERATION', 'ARCHIVED'],
  PUBLISHED: ['PAUSED', 'ARCHIVED'],
  PAUSED: ['PUBLISHED', 'ARCHIVED'],
  PENDING_MODERATION: ['DRAFT'],
};

const MODERATOR_TRANSITIONS: Partial<Record<ListingStatus, readonly ListingStatus[]>> = {
  PENDING_MODERATION: ['PUBLISHED', 'REJECTED'],
  PUBLISHED: ['PAUSED', 'REJECTED'],
  PAUSED: ['PUBLISHED', 'REJECTED'],
};

/** Fields a landlord may not change while people can book the listing. */
const LOCKED_WHILE_LIVE: readonly string[] = [];

export interface ModerationReview {
  readonly id: string;
  readonly decision: string;
  readonly reasonCodes: readonly string[];
  readonly comment: string | null;
  readonly fromStatus: string;
  readonly createdAt: string;
  readonly moderatorName: string | null;
}



/**
 * Everything except the property type is optional, because the wizard
 * asks for the type on its first screen and the price on its ninth, and
 * a draft has to be saveable in between (migration 0008). The database
 * enforces completeness on the way OUT of DRAFT, not on the way in.
 */
export interface ListingDraftInput {
  readonly title?: string;
  readonly description?: string;
  readonly propertyType: 'APARTMENT' | 'ROOM' | 'HOUSE' | 'COTTAGE' | 'STUDIO' | 'TOWNHOUSE';
  readonly city?: string;
  readonly region?: string;
  readonly district?: string;
  readonly street?: string;
  readonly houseNumber?: string;
  readonly apartmentNumber?: string;
  readonly postalCode?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly locationPrecision?: 'EXACT' | 'APPROXIMATE';
  readonly rooms?: number;
  readonly areaSqm?: number;
  readonly floor?: number;
  readonly totalFloors?: number;
  readonly beds?: number;
  readonly bathrooms?: number;
  readonly maxGuests?: number;
  readonly smokingPolicy?: 'PROHIBITED' | 'ALLOWED' | 'BALCONY_ONLY';
  readonly petsPolicy?: 'PROHIBITED' | 'ALLOWED' | 'SMALL_ONLY' | 'ON_REQUEST';
  readonly childrenAllowed?: boolean;
  readonly partiesAllowed?: boolean;
  readonly quietHoursFrom?: string;
  readonly quietHoursTo?: string;
  readonly checkInFrom?: string;
  readonly checkOutUntil?: string;
  readonly minNights?: number;
  readonly maxNights?: number;
  readonly basePriceMinor?: string;
  readonly priceUnit?: 'NIGHT' | 'MONTH';
  readonly cleaningFeeMinor?: string;
  readonly utilitiesMode?: 'INCLUDED' | 'FIXED_EXTRA' | 'VARIABLE_METERED';
  readonly utilitiesFixedMinor?: string;
  readonly utilitiesNote?: string;
  readonly depositMinor?: string;
  readonly bookingMode?: 'INSTANT' | 'REQUEST' | 'INSTANT_AND_REQUEST';
  readonly negotiationEnabled?: boolean;
  readonly amenities?: readonly string[];
}

export type ListingUpdateInput = Partial<ListingDraftInput>;

export interface PricingRuleInput {
  readonly kind: 'LENGTH_OF_STAY' | 'SEASONAL';
  readonly minNights?: number;
  readonly maxNights?: number;
  readonly seasonFrom?: string;
  readonly seasonTo?: string;
  readonly priceMinor: string;
  readonly priceUnit: 'NIGHT' | 'MONTH';
  readonly priority?: number;
}

/** Column mapping kept in one place so update and insert cannot drift apart. */
const COLUMN_FOR: Record<string, string> = {
  title: 'title',
  description: 'description',
  propertyType: 'property_type',
  city: 'city',
  region: 'region',
  district: 'district',
  street: 'street',
  houseNumber: 'house_number',
  apartmentNumber: 'apartment_number',
  postalCode: 'postal_code',
  locationPrecision: 'location_precision',
  rooms: 'rooms',
  areaSqm: 'area_sqm',
  floor: 'floor',
  totalFloors: 'total_floors',
  beds: 'beds',
  bathrooms: 'bathrooms',
  maxGuests: 'max_guests',
  smokingPolicy: 'smoking_policy',
  petsPolicy: 'pets_policy',
  childrenAllowed: 'children_allowed',
  partiesAllowed: 'parties_allowed',
  quietHoursFrom: 'quiet_hours_from',
  quietHoursTo: 'quiet_hours_to',
  checkInFrom: 'check_in_from',
  checkOutUntil: 'check_out_until',
  minNights: 'min_nights',
  maxNights: 'max_nights',
  basePriceMinor: 'base_price_minor',
  priceUnit: 'price_unit',
  cleaningFeeMinor: 'cleaning_fee_minor',
  utilitiesMode: 'utilities_mode',
  utilitiesFixedMinor: 'utilities_fixed_minor',
  utilitiesNote: 'utilities_note',
  depositMinor: 'deposit_minor',
  bookingMode: 'booking_mode',
  negotiationEnabled: 'negotiation_enabled',
};

export class ListingService {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------------- */

  async createDraft(ownerId: string, input: ListingDraftInput): Promise<{ id: string }> {
    // A location is optional at creation but never half-specified: one
    // coordinate without the other cannot be blurred, mapped or searched.
    const hasLocation = input.latitude !== undefined && input.longitude !== undefined;
    if (input.latitude !== undefined || input.longitude !== undefined) {
      if (!hasLocation) throw invalid('Укажите широту и долготу вместе');
      assertLocation(input.latitude!, input.longitude!);
    }
    assertDurations(input.minNights, input.maxNights);

    const id = uuidv7();
    const publicPoint = hasLocation
      ? publicLocationFor(id, { latitude: input.latitude!, longitude: input.longitude! })
      : null;

    return this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO property (
           id, owner_id, status, title, description, property_type,
           country_code, region, city, district, street, house_number, apartment_number, postal_code,
           latitude, longitude, location_precision, public_latitude, public_longitude,
           rooms, area_sqm, floor, total_floors, beds, bathrooms, max_guests,
           smoking_policy, pets_policy, children_allowed, parties_allowed,
           quiet_hours_from, quiet_hours_to, check_in_from, check_out_until,
           min_nights, max_nights,
           base_price_minor, price_unit, cleaning_fee_minor,
           utilities_mode, utilities_fixed_minor, utilities_note, deposit_minor,
           booking_mode, negotiation_enabled)
         VALUES ($1,$2,'DRAFT',$3,$4,$5,
           'BY',$6,$7,$8,$9,$10,$11,$12,
           $13,$14,$15,$16,$17,
           $18,$19,$20,$21,$22,$23,$24,
           $25,$26,$27,$28,
           $29::time,$30::time,COALESCE($31::time,'14:00'::time),COALESCE($32::time,'12:00'::time),
           COALESCE($33::integer,1),COALESCE($34::integer,365),
           $35::bigint,COALESCE($36::text,'NIGHT'),COALESCE($37::bigint,0),
           COALESCE($38::text,'INCLUDED'),COALESCE($39::bigint,0),$40,COALESCE($41::bigint,0),
           COALESCE($42::text,'REQUEST'),COALESCE($43::boolean,false))`,
        [
          id,
          ownerId,
          input.title ?? null,
          input.description ?? '',
          input.propertyType,
          input.region ?? null,
          input.city ?? null,
          input.district ?? null,
          input.street ?? null,
          input.houseNumber ?? null,
          input.apartmentNumber ?? null,
          input.postalCode ?? null,
          input.latitude ?? null,
          input.longitude ?? null,
          input.locationPrecision ?? 'APPROXIMATE',
          publicPoint?.latitude ?? null,
          publicPoint?.longitude ?? null,
          input.rooms ?? null,
          input.areaSqm ?? null,
          input.floor ?? null,
          input.totalFloors ?? null,
          input.beds ?? null,
          input.bathrooms ?? null,
          input.maxGuests ?? 1,
          input.smokingPolicy ?? 'PROHIBITED',
          input.petsPolicy ?? 'PROHIBITED',
          input.childrenAllowed ?? true,
          input.partiesAllowed ?? false,
          input.quietHoursFrom ?? null,
          input.quietHoursTo ?? null,
          input.checkInFrom ?? null,
          input.checkOutUntil ?? null,
          input.minNights ?? null,
          input.maxNights ?? null,
          input.basePriceMinor,
          input.priceUnit ?? null,
          input.cleaningFeeMinor ?? null,
          input.utilitiesMode ?? null,
          input.utilitiesFixedMinor ?? null,
          input.utilitiesNote ?? null,
          input.depositMinor ?? null,
          input.bookingMode ?? null,
          input.negotiationEnabled ?? null,
        ],
      );

      if (input.amenities?.length) await this.replaceAmenities(tx, id, input.amenities);

      // A landlord role is granted on first listing rather than at signup, so
      // a browsing account carries no listing permissions it does not need.
      await tx.query(
        `INSERT INTO user_role (user_id, role) VALUES ($1,'LANDLORD') ON CONFLICT DO NOTHING`,
        [ownerId],
      );

      await writeAudit(tx, {
        actorUserId: ownerId,
        actorRole: 'LANDLORD',
        action: 'listing.create',
        targetType: 'property',
        targetId: id,
        changes: { status: { from: null, to: 'DRAFT' } },
      });

      return { id };
    });
  }

  /* ---------------------------------------------------------------- */

  /**
   * The owner's own view, including a draft that is nowhere near
   * publishable. Deliberately separate from `getPublicListing`, which
   * only ever returns PUBLISHED rows and strips the exact address — this
   * one returns the street and house number, because the person asking
   * is the person who typed them.
   */
  async getForOwner(propertyId: string, ownerId: string): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT p.*, p.base_price_minor::text AS base_price_minor,
              p.cleaning_fee_minor::text     AS cleaning_fee_minor,
              p.utilities_fixed_minor::text  AS utilities_fixed_minor,
              p.deposit_minor::text          AS deposit_minor,
              p.area_sqm::text               AS area_sqm
         FROM property p
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [propertyId],
    );
    const row = rows[0];
    if (!row) throw notFound('Объявление');
    // Same answer for "not yours" as for "does not exist": otherwise the
    // endpoint reports whether a stranger's draft exists.
    if (row.owner_id !== ownerId) throw notFound('Объявление');

    const [photos, amenities, lastReview] = await Promise.all([
      this.db.query<Record<string, any>>(
        `SELECT id, storage_key, is_cover, sort_order, caption
           FROM property_photo WHERE property_id = $1 ORDER BY sort_order, created_at`,
        [propertyId],
      ),
      this.db.query<{ amenity_code: string }>(
        `SELECT amenity_code FROM property_amenity WHERE property_id = $1`,
        [propertyId],
      ),
      // The codes behind the current rejection, so the wizard can offer to
      // open the step that needs fixing rather than just naming it.
      this.db.query<{ reason_codes: string[]; comment: string | null }>(
        `SELECT reason_codes, comment FROM listing_moderation_review
          WHERE property_id = $1 AND decision = 'REJECTED'
          ORDER BY created_at DESC LIMIT 1`,
        [propertyId],
      ),
    ]);

    return {
      id: row.id,
      status: row.status,
      rejectionReason: row.rejection_reason,
      // Only meaningful while the listing is actually rejected; once it is
      // resubmitted the notice must stop being shown.
      rejectionCodes: row.status === 'REJECTED' ? (lastReview.rows[0]?.reason_codes ?? []) : [],
      moderatorComment: row.status === 'REJECTED' ? (lastReview.rows[0]?.comment ?? null) : null,
      title: row.title,
      description: row.description,
      propertyType: row.property_type,
      city: row.city,
      region: row.region,
      district: row.district,
      street: row.street,
      houseNumber: row.house_number,
      apartmentNumber: row.apartment_number,
      postalCode: row.postal_code,
      latitude: row.latitude,
      longitude: row.longitude,
      rooms: row.rooms,
      areaSqm: row.area_sqm === null ? null : Number(row.area_sqm),
      floor: row.floor,
      totalFloors: row.total_floors,
      beds: row.beds,
      bathrooms: row.bathrooms,
      maxGuests: row.max_guests,
      smokingPolicy: row.smoking_policy,
      petsPolicy: row.pets_policy,
      childrenAllowed: row.children_allowed,
      partiesAllowed: row.parties_allowed,
      quietHoursFrom: row.quiet_hours_from,
      quietHoursTo: row.quiet_hours_to,
      checkInFrom: row.check_in_from,
      checkOutUntil: row.check_out_until,
      minNights: row.min_nights,
      maxNights: row.max_nights,
      basePriceMinor: row.base_price_minor,
      priceUnit: row.price_unit,
      cleaningFeeMinor: row.cleaning_fee_minor,
      utilitiesMode: row.utilities_mode,
      utilitiesFixedMinor: row.utilities_fixed_minor,
      utilitiesNote: row.utilities_note,
      depositMinor: row.deposit_minor,
      bookingMode: row.booking_mode,
      negotiationEnabled: row.negotiation_enabled,
      amenities: amenities.rows.map((a) => a.amenity_code),
      photos: photos.rows.map((p) => ({
        id: p.id,
        storageKey: p.storage_key,
        isCover: p.is_cover,
        sortOrder: p.sort_order,
        caption: p.caption,
      })),
    };
  }

  async update(propertyId: string, ownerId: string, input: ListingUpdateInput): Promise<void> {
    if (input.latitude !== undefined || input.longitude !== undefined) {
      if (input.latitude === undefined || input.longitude === undefined) {
        throw invalid('Укажите широту и долготу вместе');
      }
      assertLocation(input.latitude, input.longitude);
    }

    await this.db.transaction(async (tx) => {
      const current = await this.loadOwned(tx, propertyId, ownerId, true);

      if (current.status === 'ARCHIVED') {
        throw new DomainError('CONFLICT', 'Архивное объявление нельзя редактировать');
      }

      const minNights = input.minNights ?? current.min_nights;
      const maxNights = input.maxNights ?? current.max_nights;
      assertDurations(minNights, maxNights);

      const sets: string[] = [];
      const values: unknown[] = [propertyId];
      const changes: Record<string, { from: unknown; to: unknown }> = {};

      for (const [key, value] of Object.entries(input)) {
        if (value === undefined) continue;
        if (key === 'latitude' || key === 'longitude' || key === 'amenities') continue;
        const column = COLUMN_FOR[key];
        if (!column) continue;
        if (LOCKED_WHILE_LIVE.includes(key) && current.status === 'PUBLISHED') {
          throw new DomainError('CONFLICT', `Поле ${key} нельзя менять у опубликованного объявления`);
        }
        values.push(value);
        sets.push(`${column} = $${values.length}`);
        changes[key] = { from: current[column] ?? null, to: value };
      }

      if (input.latitude !== undefined && input.longitude !== undefined) {
        const publicPoint = publicLocationFor(propertyId, {
          latitude: input.latitude,
          longitude: input.longitude,
        });
        values.push(input.latitude, input.longitude, publicPoint.latitude, publicPoint.longitude);
        sets.push(
          `latitude = $${values.length - 3}`,
          `longitude = $${values.length - 2}`,
          `public_latitude = $${values.length - 1}`,
          `public_longitude = $${values.length}`,
        );
        changes['location'] = { from: 'previous', to: 'updated' };
      }

      if (sets.length > 0) {
        sets.push('content_updated_at = now()');
        await tx.query(`UPDATE property SET ${sets.join(', ')} WHERE id = $1`, values);
      }

      if (input.amenities) await this.replaceAmenities(tx, propertyId, input.amenities);

      await writeAudit(tx, {
        actorUserId: ownerId,
        actorRole: 'LANDLORD',
        action: 'listing.update',
        targetType: 'property',
        targetId: propertyId,
        changes,
      });
    });
  }

  /* ---------------------------------------------------------------- */

  async submitForModeration(propertyId: string, ownerId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await this.loadOwned(tx, propertyId, ownerId, true);
      assertOwnerTransition(current.status, 'PENDING_MODERATION');

      // Publication requirements are checked here rather than at save time, so
      // a landlord can build a listing gradually without being nagged.
      const { rows } = await tx.query<{ photos: string }>(
        `SELECT count(*)::text AS photos FROM property_photo WHERE property_id = $1`,
        [propertyId],
      );
      if (Number(rows[0]!.photos) < 1) {
        throw invalid('Добавьте хотя бы одну фотографию перед публикацией', { field: 'photos' });
      }
      if (!current.title || String(current.title).trim().length < 8) {
        throw invalid('Добавьте название объявления — не короче 8 символов', { field: 'title' });
      }
      if (!current.city || String(current.city).trim() === '') {
        throw invalid('Укажите город', { field: 'city' });
      }
      // Nullable since migration 0008, so this is a presence check before it
      // is a value check — BigInt(null) throws.
      if (current.latitude === null || current.longitude === null) {
        throw invalid('Отметьте расположение на карте', { field: 'location' });
      }
      if (current.base_price_minor === null || BigInt(current.base_price_minor) <= 0n) {
        throw invalid('Укажите цену или выберите «Цена договорная»', { field: 'basePriceMinor' });
      }

      // submitted_at is the queue's clock: a resubmission moves the listing
      // to the back of the line rather than keeping its original place,
      // which is the honest ordering when the content has changed.
      await tx.query(
        `UPDATE property SET status='PENDING_MODERATION', rejection_reason=NULL, submitted_at=now() WHERE id=$1`,
        [propertyId],
      );
      await writeAudit(tx, {
        actorUserId: ownerId,
        actorRole: 'LANDLORD',
        action: 'listing.submit',
        targetType: 'property',
        targetId: propertyId,
        changes: { status: { from: current.status, to: 'PENDING_MODERATION' } },
      });
    });
  }

  /** Moderator decision. Rejection must always carry a reason the owner can act on. */
  async moderate(
    propertyId: string,
    moderatorId: string,
    decision: 'PUBLISHED' | 'REJECTED' | 'PAUSED',
    reason?: string,
    reasonCodes?: readonly ModerationReasonCode[],
  ): Promise<void> {
    const codes = [...new Set(reasonCodes ?? [])];
    for (const code of codes) {
      if (!MODERATION_REASON_CODES.includes(code)) {
        throw invalid(`Неизвестная причина: ${code}`);
      }
    }

    // A rejection must say something actionable. Codes are the structured
    // form; a bare comment is accepted and recorded as OTHER so that
    // callers predating the vocabulary keep working rather than silently
    // losing their explanation.
    if (decision !== 'PUBLISHED' && codes.length === 0 && !reason?.trim()) {
      throw invalid('Укажите причину решения');
    }
    const effectiveCodes = codes.length > 0 ? codes : decision === 'PUBLISHED' ? [] : ['OTHER' as const];

    await this.db.transaction(async (tx) => {
      const current = await this.load(tx, propertyId, true);
      assertModeratorTransition(current.status, decision);

      await tx.query(
        `UPDATE property
            SET status = $2,
                rejection_reason = $3,
                submitted_at = CASE WHEN $2 = 'PUBLISHED' THEN NULL ELSE submitted_at END,
                published_at = CASE WHEN $2 = 'PUBLISHED' THEN COALESCE(published_at, now()) ELSE published_at END
          WHERE id = $1`,
        [propertyId, decision, decision === 'REJECTED' ? (reason?.trim() || reasonSentence(effectiveCodes)) : null],
      );

      // The decision as a domain record, kept forever. A resubmission adds
      // a row; it never overwrites one.
      await tx.query(
        `INSERT INTO listing_moderation_review
           (id, property_id, moderator_id, decision, reason_codes, comment, from_status)
         VALUES ($1,$2,$3,$4,$5::text[],$6,$7)`,
        [
          uuidv7(),
          propertyId,
          moderatorId,
          decision,
          effectiveCodes,
          reason?.trim() || null,
          current.status,
        ],
      );

      await writeAudit(tx, {
        actorUserId: moderatorId,
        actorRole: 'MODERATOR',
        action: 'listing.moderate',
        targetType: 'property',
        targetId: propertyId,
        changes: {
          status: { from: current.status, to: decision },
          ...(effectiveCodes.length > 0 ? { reasonCodes: { from: null, to: effectiveCodes } } : {}),
        },
        reason: reason ?? null,
        source: 'admin',
      });
    });
  }

  /**
   * The moderator's view.
   *
   * Deliberately built from the same public projection a tenant gets,
   * plus the owner's public trust facts and the photo set. It does NOT
   * include the street, house or apartment number: DEC-020 gives the
   * exact address a single entitlement-checked accessor, and "a
   * moderator is looking at it" is not an entitlement. A moderator
   * verifies that the *approximate* location is plausible, which is what
   * a tenant will see anyway.
   *
   * It contains no identity documents. Those live in a separate private
   * bucket reachable only with `document.read`, which only VERIFIER
   * holds, and every read of one is logged.
   */
  async getForModeration(propertyId: string): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT p.id, p.status, p.rejection_reason, p.title, p.description, p.property_type,
              p.city, p.district, p.region,
              p.public_latitude, p.public_longitude, p.location_precision,
              p.rooms, p.area_sqm::text AS area_sqm, p.floor, p.total_floors,
              p.beds, p.bathrooms, p.max_guests,
              p.smoking_policy, p.pets_policy, p.children_allowed, p.parties_allowed,
              p.quiet_hours_from, p.quiet_hours_to, p.check_in_from, p.check_out_until,
              p.min_nights, p.max_nights,
              p.base_price_minor::text AS base_price_minor, p.price_unit,
              p.cleaning_fee_minor::text AS cleaning_fee_minor,
              p.utilities_mode, p.utilities_fixed_minor::text AS utilities_fixed_minor, p.utilities_note,
              p.deposit_minor::text AS deposit_minor,
              p.booking_mode, p.negotiation_enabled,
              p.created_at, p.submitted_at, p.published_at,
              p.property_verified_at,
              u.id AS owner_id, u.display_name AS owner_name, u.account_kind,
              u.verification_level, u.created_at AS owner_since,
              (SELECT count(*)::int FROM booking b
                WHERE b.landlord_id = u.id AND b.status = 'COMPLETED') AS completed_rentals,
              (SELECT count(*)::int FROM property p2
                WHERE p2.owner_id = u.id AND p2.deleted_at IS NULL) AS listing_count,
              (SELECT round(avg(r.overall)::numeric, 2) FROM review r
                WHERE r.subject_id = u.id AND r.status = 'PUBLISHED') AS owner_rating
         FROM property p JOIN app_user u ON u.id = p.owner_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [propertyId],
    );
    const row = rows[0];
    if (!row) throw notFound('Объявление');

    const [photos, amenities] = await Promise.all([
      this.db.query<Record<string, any>>(
        `SELECT id, storage_key, is_cover, sort_order, width, height, byte_size
           FROM property_photo WHERE property_id = $1 ORDER BY sort_order, created_at`,
        [propertyId],
      ),
      this.db.query<Record<string, any>>(
        `SELECT a.code, a.category, a.name_ru, a.icon
           FROM property_amenity pa JOIN amenity a ON a.code = pa.amenity_code
          WHERE pa.property_id = $1 ORDER BY a.sort_order`,
        [propertyId],
      ),
    ]);

    return {
      id: row.id,
      status: row.status,
      rejectionReason: row.rejection_reason,
      title: row.title,
      description: row.description,
      propertyType: row.property_type,
      city: row.city,
      district: row.district,
      region: row.region,
      // The blurred point, the same one the public map shows.
      location: {
        latitude: row.public_latitude,
        longitude: row.public_longitude,
        precision: row.location_precision,
      },
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
      },
      bookingMode: row.booking_mode,
      negotiationEnabled: row.negotiation_enabled,
      createdAt: iso(row.created_at),
      submittedAt: row.submitted_at === null ? null : iso(row.submitted_at),
      publishedAt: row.published_at === null ? null : iso(row.published_at),
      propertyVerified: row.property_verified_at !== null,
      owner: {
        id: row.owner_id,
        displayName: row.owner_name,
        accountKind: row.account_kind,
        verificationLevel: row.verification_level,
        memberSince: iso(row.owner_since),
        completedRentals: row.completed_rentals,
        listingCount: row.listing_count,
        rating: row.owner_rating === null ? null : Number(row.owner_rating),
      },
      photos: photos.rows.map((p) => ({
        id: p.id,
        storageKey: p.storage_key,
        isCover: p.is_cover,
        width: p.width,
        height: p.height,
        byteSize: p.byte_size,
      })),
      amenities: amenities.rows.map((a) => ({
        code: a.code,
        category: a.category,
        name_ru: a.name_ru,
        icon: a.icon,
      })),
    };
  }

  /** Every decision ever taken on a listing, newest first. */
  async moderationHistory(propertyId: string): Promise<ModerationReview[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT r.id, r.decision, r.reason_codes, r.comment, r.from_status, r.created_at,
              u.display_name AS moderator_name
         FROM listing_moderation_review r
         LEFT JOIN app_user u ON u.id = r.moderator_id
        WHERE r.property_id = $1
        ORDER BY r.created_at DESC`,
      [propertyId],
    );
    return rows.map((r) => ({
      id: r.id,
      decision: r.decision,
      reasonCodes: r.reason_codes ?? [],
      comment: r.comment,
      fromStatus: r.from_status,
      createdAt: iso(r.created_at),
      moderatorName: r.moderator_name,
    }));
  }

  async setStatusByOwner(
    propertyId: string,
    ownerId: string,
    next: 'PAUSED' | 'PUBLISHED' | 'ARCHIVED' | 'DRAFT',
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await this.loadOwned(tx, propertyId, ownerId, true);
      assertOwnerTransition(current.status, next);

      // Resuming a listing that a moderator paused must go back through review.
      await tx.query(`UPDATE property SET status=$2 WHERE id=$1`, [propertyId, next]);
      await writeAudit(tx, {
        actorUserId: ownerId,
        actorRole: 'LANDLORD',
        action: `listing.${next.toLowerCase()}`,
        targetType: 'property',
        targetId: propertyId,
        changes: { status: { from: current.status, to: next } },
      });
    });
  }

  /* ---------------------------------------------------------------- */

  async addPhoto(
    propertyId: string,
    ownerId: string,
    photo: { storageKey: string; width?: number; height?: number; byteSize?: number; caption?: string; contentHash?: Buffer },
  ): Promise<{ id: string }> {
    /* The key must live in this listing's own namespace.
     *
     * `POST /api/uploads` generates `listings/<propertyId>/<uuid>.<ext>` and
     * never lets a client influence it. This assertion is the second lock on
     * the same door: it means no caller — a future route, a script, a careless
     * refactor — can attach a photo row pointing at another listing's object,
     * at a private document key, or at anything outside the media namespace.
     *
     * It matters most in the deployment that does not exist yet. Once a real
     * bucket is configured, `/media/<key>` redirects to it without consulting
     * the database, so a row pointing at somebody else's key would publish
     * somebody else's object under this listing. */
    const namespace = `listings/${propertyId}/`;
    if (!photo.storageKey.startsWith(namespace) || photo.storageKey.includes('..')) {
      throw invalid('Недопустимый ключ файла');
    }

    return this.db.transaction(async (tx) => {
      await this.loadOwned(tx, propertyId, ownerId, true);
      const id = uuidv7();

      const { rows } = await tx.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM property_photo WHERE property_id=$1`,
        [propertyId],
      );
      const existing = Number(rows[0]!.c);
      if (existing >= 30) throw invalid('Достигнут лимит фотографий (30)');

      await tx.query(
        `INSERT INTO property_photo (id, property_id, storage_key, width, height, byte_size, caption, content_hash, sort_order, is_cover)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          propertyId,
          photo.storageKey,
          photo.width ?? null,
          photo.height ?? null,
          photo.byteSize ?? null,
          photo.caption ?? null,
          photo.contentHash ?? null,
          existing,
          existing === 0, // the first photo becomes the cover automatically
        ],
      );
      await tx.query(`UPDATE property SET content_updated_at = now() WHERE id=$1`, [propertyId]);
      return { id };
    });
  }

  async setCoverPhoto(propertyId: string, ownerId: string, photoId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.loadOwned(tx, propertyId, ownerId, true);
      // Clear first: the database permits only one cover per property, so the
      // two statements must not overlap.
      await tx.query(`UPDATE property_photo SET is_cover=false WHERE property_id=$1 AND is_cover`, [
        propertyId,
      ]);
      const { rowCount } = await tx.query(
        `UPDATE property_photo SET is_cover=true WHERE id=$1 AND property_id=$2`,
        [photoId, propertyId],
      );
      if (rowCount === 0) throw notFound('Фотография');
    });
  }

  async removePhoto(propertyId: string, ownerId: string, photoId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const property = await this.loadOwned(tx, propertyId, ownerId, true);

      const { rows } = await tx.query<{ is_cover: boolean; total: string }>(
        `SELECT p.is_cover, (SELECT count(*)::text FROM property_photo WHERE property_id=$2) AS total
           FROM property_photo p WHERE p.id=$1 AND p.property_id=$2`,
        [photoId, propertyId],
      );
      const photo = rows[0];
      if (!photo) throw notFound('Фотография');

      if (Number(photo.total) <= 1 && property.status === 'PUBLISHED') {
        throw invalid('У опубликованного объявления должна остаться хотя бы одна фотография');
      }

      await tx.query(`DELETE FROM property_photo WHERE id=$1`, [photoId]);

      if (photo.is_cover) {
        await tx.query(
          `UPDATE property_photo SET is_cover=true
            WHERE id = (SELECT id FROM property_photo WHERE property_id=$1 ORDER BY sort_order LIMIT 1)`,
          [propertyId],
        );
      }
      await tx.query(`UPDATE property SET content_updated_at = now() WHERE id=$1`, [propertyId]);
    });
  }

  /* ---------------------------------------------------------------- */

  async replacePricingRules(
    propertyId: string,
    ownerId: string,
    rules: readonly PricingRuleInput[],
  ): Promise<void> {
    for (const r of rules) {
      if (r.kind === 'LENGTH_OF_STAY') {
        if (r.minNights === undefined || r.maxNights === undefined) {
          throw invalid('Для тарифа по длительности укажите диапазон ночей');
        }
        if (r.maxNights < r.minNights) throw invalid('Неверный диапазон ночей');
      } else if (!r.seasonFrom || !r.seasonTo) {
        throw invalid('Для сезонного тарифа укажите период');
      } else if (r.seasonTo <= r.seasonFrom) {
        throw invalid('Конец сезона должен быть позже начала');
      }
      if (BigInt(r.priceMinor) <= 0n) throw invalid('Цена должна быть больше нуля');
    }

    await this.db.transaction(async (tx) => {
      await this.loadOwned(tx, propertyId, ownerId, true);
      await tx.query(`DELETE FROM pricing_rule WHERE property_id=$1`, [propertyId]);

      for (const r of rules) {
        await tx.query(
          `INSERT INTO pricing_rule (id, property_id, kind, min_nights, max_nights, season, price_minor, price_unit, priority)
           VALUES ($1,$2,$3,$4,$5,
             CASE WHEN $3='SEASONAL' THEN daterange($6::date,$7::date,'[)') END,
             $8,$9,COALESCE($10,0))`,
          [
            uuidv7(),
            propertyId,
            r.kind,
            r.kind === 'LENGTH_OF_STAY' ? r.minNights : null,
            r.kind === 'LENGTH_OF_STAY' ? r.maxNights : null,
            r.seasonFrom ?? null,
            r.seasonTo ?? null,
            r.priceMinor,
            r.priceUnit,
            r.priority ?? null,
          ],
        );
      }

      await tx.query(`UPDATE property SET content_updated_at = now() WHERE id=$1`, [propertyId]);
      await writeAudit(tx, {
        actorUserId: ownerId,
        actorRole: 'LANDLORD',
        action: 'listing.pricing_rules',
        targetType: 'property',
        targetId: propertyId,
        changes: { ruleCount: { from: null, to: rules.length } },
      });
    });
  }

  private async replaceAmenities(tx: Sql, propertyId: string, codes: readonly string[]): Promise<void> {
    const unique = [...new Set(codes)];
    await tx.query(`DELETE FROM property_amenity WHERE property_id=$1`, [propertyId]);
    for (const code of unique) {
      try {
        await tx.query(`INSERT INTO property_amenity (property_id, amenity_code) VALUES ($1,$2)`, [
          propertyId,
          code,
        ]);
      } catch (e) {
        if (hasErrorCode(e, PG_ERROR.FOREIGN_KEY_VIOLATION)) {
          throw invalid(`Неизвестное удобство: ${code}`, { field: 'amenities' });
        }
        throw e;
      }
    }
  }

  /* ---------------------------------------------------------------- */

  private async load(tx: Sql, propertyId: string, forUpdate = false): Promise<Record<string, any>> {
    const { rows } = await tx.query<Record<string, any>>(
      `SELECT *, base_price_minor::text AS base_price_minor FROM property
        WHERE id=$1 AND deleted_at IS NULL ${forUpdate ? 'FOR UPDATE' : ''}`,
      [propertyId],
    );
    const row = rows[0];
    if (!row) throw notFound('Объявление');
    return row;
  }

  private async loadOwned(
    tx: Sql,
    propertyId: string,
    ownerId: string,
    forUpdate = false,
  ): Promise<Record<string, any>> {
    const row = await this.load(tx, propertyId, forUpdate);
    if (row.owner_id !== ownerId) throw forbidden('Это не ваше объявление');
    return row;
  }
}

/* ================================================================== */

function assertLocation(latitude: number, longitude: number): void {
  if (!isValidLatLng({ latitude, longitude })) throw invalid('Некорректные координаты');
  if (!isWithinBelarus({ latitude, longitude })) {
    throw invalid('Платформа пока работает только в Беларуси');
  }
}

function assertDurations(minNights?: number | null, maxNights?: number | null): void {
  const min = minNights ?? 1;
  const max = maxNights ?? 365;
  if (min < 1) throw invalid('Минимальный срок — от 1 ночи', { field: 'minNights' });
  if (max < min) throw invalid('Максимальный срок должен быть не меньше минимального', { field: 'maxNights' });
  if (max > 365 * 5) throw invalid('Максимальный срок слишком большой', { field: 'maxNights' });
}

function assertOwnerTransition(from: ListingStatus, to: ListingStatus): void {
  if (!OWNER_TRANSITIONS[from]?.includes(to)) {
    throw new DomainError('CONFLICT', `Нельзя перевести объявление из ${from} в ${to}`);
  }
}

function assertModeratorTransition(from: ListingStatus, to: ListingStatus): void {
  if (!MODERATOR_TRANSITIONS[from]?.includes(to)) {
    throw new DomainError('CONFLICT', `Нельзя перевести объявление из ${from} в ${to}`);
  }
}

export { OWNER_TRANSITIONS, MODERATOR_TRANSITIONS };
