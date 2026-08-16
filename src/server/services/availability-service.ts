/**
 * Calendar and availability.
 *
 * The API can express only states the database already permits. Overlapping
 * blocks are rejected by an EXCLUDE constraint, and a block cannot be placed
 * over a confirmed booking — checked here so the landlord gets an explanation
 * rather than a constraint error, but the constraint remains the guarantee.
 */

import { uuidv7 } from '../../lib/id.ts';
import { hasErrorCode, PG_ERROR, type Db } from '../db/sql.ts';
import { DomainError, forbidden, invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

export type DayStatus = 'AVAILABLE' | 'BOOKED' | 'PENDING' | 'BLOCKED' | 'MAINTENANCE' | 'OWNER_BLOCKED';

export interface CalendarDay {
  readonly date: string;
  readonly status: DayStatus;
  readonly bookingId?: string;
  readonly blockId?: string;
}

export interface CalendarView {
  readonly propertyId: string;
  readonly from: string;
  readonly to: string;
  readonly days: readonly CalendarDay[];
  readonly minNights: number;
  readonly maxNights: number;
  readonly calendarUpdatedAt: string;
  /** Freshness signal used by search ranking and shown to tenants (spec §24). */
  readonly freshness: 'FRESH' | 'AGEING' | 'STALE';
}

const MAX_RANGE_DAYS = 400;

export class AvailabilityService {
  constructor(private readonly db: Db) {}

  /**
   * Day-by-day calendar.
   *
   * `includePending` is false for the public view: whether somebody else has a
   * pending request is not a tenant's business, and pending requests do not
   * hold the calendar anyway (DEC-007).
   */
  async getCalendar(
    propertyId: string,
    from: string,
    to: string,
    opts: { includePending?: boolean; viewerId?: string | null } = {},
  ): Promise<CalendarView> {
    const days = daysBetween(from, to);
    if (days <= 0) throw invalid('Некорректный период');
    if (days > MAX_RANGE_DAYS) throw invalid(`Период не может превышать ${MAX_RANGE_DAYS} дней`);

    const { rows: propertyRows } = await this.db.query<{
      owner_id: string;
      status: string;
      min_nights: number;
      max_nights: number;
      calendar_updated_at: string;
    }>(
      `SELECT owner_id, status, min_nights, max_nights, calendar_updated_at
         FROM property WHERE id=$1 AND deleted_at IS NULL`,
      [propertyId],
    );
    const property = propertyRows[0];
    if (!property) throw notFound('Объявление');

    const isOwner = opts.viewerId != null && property.owner_id === opts.viewerId;
    if (property.status !== 'PUBLISHED' && !isOwner) throw notFound('Объявление');

    const includePending = opts.includePending === true && isOwner;

    const [bookings, blocks] = await Promise.all([
      this.db.query<{ id: string; status: string; stay_from: string; stay_to: string }>(
        `SELECT id, status, lower(stay_period)::text AS stay_from, upper(stay_period)::text AS stay_to
           FROM booking
          WHERE property_id=$1
            AND stay_period && daterange($2::date,$3::date,'[)')
            AND status IN ('CONFIRMED','CHECKED_IN','COMPLETION_PENDING','DISPUTED','COMPLETED'
                           ${includePending ? ",'REQUESTED','OFFER_PENDING'" : ''})`,
        [propertyId, from, to],
      ),
      this.db.query<{ id: string; reason: string; block_from: string; block_to: string }>(
        `SELECT id, reason, lower(period)::text AS block_from, upper(period)::text AS block_to
           FROM calendar_block
          WHERE property_id=$1 AND period && daterange($2::date,$3::date,'[)')`,
        [propertyId, from, to],
      ),
    ]);

    const byDate = new Map<string, CalendarDay>();
    for (let i = 0; i < days; i += 1) {
      const date = addDays(from, i);
      byDate.set(date, { date, status: 'AVAILABLE' });
    }

    for (const b of blocks.rows) {
      const status: DayStatus =
        b.reason === 'MAINTENANCE' ? 'MAINTENANCE' : b.reason === 'PERSONAL_USE' ? 'OWNER_BLOCKED' : 'BLOCKED';
      for (const date of eachDate(b.block_from, b.block_to)) {
        if (byDate.has(date)) byDate.set(date, { date, status, blockId: b.id });
      }
    }

    // Bookings are applied last: a booked night outranks a block, because that
    // is the state a landlord most needs to see accurately.
    for (const b of bookings.rows) {
      const status: DayStatus = b.status === 'REQUESTED' || b.status === 'OFFER_PENDING' ? 'PENDING' : 'BOOKED';
      for (const date of eachDate(b.stay_from, b.stay_to)) {
        if (byDate.has(date)) byDate.set(date, { date, status, bookingId: b.id });
      }
    }

    const ageDays = (Date.now() - Date.parse(property.calendar_updated_at)) / 86_400_000;

    return {
      propertyId,
      from,
      to,
      days: [...byDate.values()],
      minNights: property.min_nights,
      maxNights: property.max_nights,
      calendarUpdatedAt: property.calendar_updated_at,
      freshness: ageDays <= 3 ? 'FRESH' : ageDays <= 21 ? 'AGEING' : 'STALE',
    };
  }

  /* ---------------------------------------------------------------- */

  async block(
    propertyId: string,
    ownerId: string,
    from: string,
    to: string,
    reason: 'BLOCKED' | 'MAINTENANCE' | 'PERSONAL_USE' | 'EXTERNAL_BOOKING' = 'BLOCKED',
    note?: string,
  ): Promise<{ id: string }> {
    if (daysBetween(from, to) <= 0) throw invalid('Некорректный период');

    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ owner_id: string }>(
        `SELECT owner_id FROM property WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [propertyId],
      );
      if (!rows[0]) throw notFound('Объявление');
      if (rows[0].owner_id !== ownerId) throw forbidden('Это не ваше объявление');

      // Checked explicitly so the landlord gets a message naming the conflict,
      // rather than a raw constraint failure.
      const conflict = await tx.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM booking
          WHERE property_id=$1
            AND status IN ('CONFIRMED','CHECKED_IN','COMPLETION_PENDING','DISPUTED','COMPLETED')
            AND stay_period && daterange($2::date,$3::date,'[)')`,
        [propertyId, from, to],
      );
      if (Number(conflict.rows[0]!.c) > 0) {
        throw new DomainError('CONFLICT', 'На эти даты уже есть подтверждённое бронирование');
      }

      const id = uuidv7();
      try {
        await tx.query(
          `INSERT INTO calendar_block (id, property_id, period, reason, note, created_by)
           VALUES ($1,$2, daterange($3::date,$4::date,'[)'), $5,$6,$7)`,
          [id, propertyId, from, to, reason, note ?? null, ownerId],
        );
      } catch (e) {
        if (hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION)) {
          throw new DomainError('CONFLICT', 'Эти даты уже заблокированы');
        }
        throw e;
      }

      await this.touchCalendar(tx, propertyId);
      await writeAudit(tx, {
        actorUserId: ownerId,
        actorRole: 'LANDLORD',
        action: 'calendar.block',
        targetType: 'property',
        targetId: propertyId,
        changes: { from, to, reason },
      });
      return { id };
    });
  }

  async unblock(blockId: string, ownerId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{ property_id: string; owner_id: string }>(
        `SELECT cb.property_id, p.owner_id
           FROM calendar_block cb JOIN property p ON p.id = cb.property_id
          WHERE cb.id=$1`,
        [blockId],
      );
      const row = rows[0];
      if (!row) throw notFound('Блокировка');
      if (row.owner_id !== ownerId) throw forbidden('Это не ваше объявление');

      await tx.query(`DELETE FROM calendar_block WHERE id=$1`, [blockId]);
      await this.touchCalendar(tx, row.property_id);
      await writeAudit(tx, {
        actorUserId: ownerId,
        actorRole: 'LANDLORD',
        action: 'calendar.unblock',
        targetType: 'property',
        targetId: row.property_id,
        changes: { blockId },
      });
    });
  }

  /** Explicit "calendar is still accurate" action, which feeds freshness ranking. */
  async confirmUpToDate(propertyId: string, ownerId: string): Promise<void> {
    const { rowCount } = await this.db.query(
      `UPDATE property SET calendar_updated_at = now() WHERE id=$1 AND owner_id=$2`,
      [propertyId, ownerId],
    );
    if (rowCount === 0) throw forbidden('Это не ваше объявление');
  }

  private async touchCalendar(tx: { query: Db['query'] }, propertyId: string): Promise<void> {
    await tx.query(`UPDATE property SET calendar_updated_at = now() WHERE id=$1`, [propertyId]);
  }
}

/* ------------------------------------------------------------------ */

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw invalid('Некорректные даты');
  return Math.round((b - a) / 86_400_000);
}

function addDays(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Half-open [from, to): the checkout day is not occupied. */
function* eachDate(from: string, to: string): Generator<string> {
  const total = daysBetween(from, to);
  for (let i = 0; i < total; i += 1) yield addDays(from, i);
}
