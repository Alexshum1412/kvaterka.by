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

export interface ListingDraftInput {
  readonly title: string;
  readonly description?: string;
  readonly propertyType: 'APARTMENT' | 'ROOM' | 'HOUSE' | 'COTTAGE' | 'STUDIO' | 'TOWNHOUSE';
  readonly city: string;
  readonly region?: string;
  readonly district?: string;
  readonly street?: string;
  readonly houseNumber?: string;
  readonly apartmentNumber?: string;
  readonly postalCode?: string;
  readonly latitude: number;
  readonly longitude: number;
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
  readonly basePriceMinor: string;
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
    assertLocation(input.latitude, input.longitude);
    assertDurations(input.minNights, input.maxNights);

    const id = uuidv7();
    const publicPoint = publicLocationFor(id, { latitude: input.latitude, longitude: input.longitude });

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
          input.title,
          input.description ?? '',
          input.propertyType,
          input.region ?? null,
          input.city,
          input.district ?? null,
          input.street ?? null,
          input.houseNumber ?? null,
          input.apartmentNumber ?? null,
          input.postalCode ?? null,
          input.latitude,
          input.longitude,
          input.locationPrecision ?? 'APPROXIMATE',
          publicPoint.latitude,
          publicPoint.longitude,
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
        throw invalid('Заголовок слишком короткий', { field: 'title' });
      }
      if (BigInt(current.base_price_minor) <= 0n) {
        throw invalid('Укажите цену', { field: 'basePriceMinor' });
      }

      await tx.query(
        `UPDATE property SET status='PENDING_MODERATION', rejection_reason=NULL WHERE id=$1`,
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
  ): Promise<void> {
    if (decision !== 'PUBLISHED' && !reason?.trim()) {
      throw invalid('Укажите причину решения');
    }

    await this.db.transaction(async (tx) => {
      const current = await this.load(tx, propertyId, true);
      assertModeratorTransition(current.status, decision);

      await tx.query(
        `UPDATE property
            SET status = $2,
                rejection_reason = $3,
                published_at = CASE WHEN $2 = 'PUBLISHED' THEN COALESCE(published_at, now()) ELSE published_at END
          WHERE id = $1`,
        [propertyId, decision, decision === 'REJECTED' ? reason! : null],
      );

      await writeAudit(tx, {
        actorUserId: moderatorId,
        actorRole: 'MODERATOR',
        action: 'listing.moderate',
        targetType: 'property',
        targetId: propertyId,
        changes: { status: { from: current.status, to: decision } },
        reason: reason ?? null,
        source: 'admin',
      });
    });
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
