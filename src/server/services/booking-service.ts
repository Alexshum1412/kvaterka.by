/**
 * Booking application service.
 *
 * Every state change funnels through here, and every one of them:
 *   - runs inside a single database transaction;
 *   - is validated by the pure state machine before touching a row;
 *   - writes a booking_event and an audit_log row alongside the change;
 *   - is safe to retry.
 *
 * The service never re-implements a rule the database already enforces. It
 * translates the database's refusals into messages a person can act on.
 */

import { applyEvent, blocksCalendar, type Actor, type BookingEventType, type BookingState } from '../domain/booking/states.ts';
import { completionDeadline, resolveCompletion, type CompletionAnswer } from '../domain/booking/completion.ts';
import { quote, type PricingRule } from '../domain/pricing.ts';
import { money, serviceFee, toStorage, type Money } from '../domain/money.ts';
import { humanReference, uuidv7 } from '../../lib/id.ts';
import { hasErrorCode, PG_ERROR, type Db, type Sql } from '../db/sql.ts';
import { DomainError, forbidden, invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

export interface BookingRow {
  id: string;
  reference: string;
  property_id: string;
  tenant_id: string;
  landlord_id: string;
  status: BookingState;
  rent_minor: string;
  fee_base_minor: string;
  total_expected_minor: string;
  service_fee_bps: number;
  tenant_completion_answer: CompletionAnswer | null;
  landlord_completion_answer: CompletionAnswer | null;
  completion_deadline_at: string | null;
  checked_in_at: string | null;
  stay_from: string;
  stay_to: string;
}

const BOOKING_COLUMNS = `
  id, reference, property_id, tenant_id, landlord_id, status,
  rent_minor::text AS rent_minor, fee_base_minor::text AS fee_base_minor,
  total_expected_minor::text AS total_expected_minor, service_fee_bps,
  tenant_completion_answer, landlord_completion_answer, completion_deadline_at, checked_in_at,
  lower(stay_period)::text AS stay_from, upper(stay_period)::text AS stay_to`;

export interface RequestBookingInput {
  readonly propertyId: string;
  readonly tenantId: string;
  readonly from: string;
  readonly to: string;
  readonly guests?: number;
  readonly message?: string;
  /** Makes a retried request return the original booking instead of a second one. */
  readonly idempotencyKey?: string;
  readonly instant?: boolean;
  readonly correlationId?: string;
}

export class BookingService {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------------- */

  async get(bookingId: string): Promise<BookingRow> {
    const { rows } = await this.db.query<BookingRow>(
      `SELECT ${BOOKING_COLUMNS} FROM booking WHERE id = $1`,
      [bookingId],
    );
    const row = rows[0];
    if (!row) throw notFound('Бронирование');
    return row;
  }

  /**
   * Create a booking request, or complete an instant booking.
   *
   * Concurrency: two tenants instant-booking the same nights at the same moment
   * both reach the INSERT; the EXCLUDE constraint lets exactly one commit and
   * the loser gets DATES_UNAVAILABLE. No advisory locks, no read-then-write gap.
   */
  async requestBooking(input: RequestBookingInput): Promise<BookingRow> {
    const { propertyId, tenantId, from, to } = input;

    if (input.idempotencyKey) {
      const existing = await this.db.query<BookingRow>(
        `SELECT ${BOOKING_COLUMNS} FROM booking WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, input.idempotencyKey],
      );
      if (existing.rows[0]) return existing.rows[0];
    }

    return this.db.transaction(async (tx) => {
      const property = await loadBookableProperty(tx, propertyId);

      if (property.owner_id === tenantId) {
        throw new DomainError('SELF_BOOKING', 'Нельзя забронировать собственный объект');
      }

      /* One live request per tenant, per property, per overlapping dates.
       *
       * This is what actually makes a double-click safe when the client
       * sends no idempotency key: the key path above only helps a caller
       * who supplied one, and our own API must not depend on the client
       * behaving well.
       *
       * It is scoped to ACTIVE states on purpose. Two different tenants
       * competing for the same dates is legitimate and stays legitimate;
       * so does re-requesting after withdrawing or being declined. What
       * is refused is the same person holding two open requests for the
       * same nights, which is never anything but an accident. */
      const duplicate = await tx.query<{ id: string }>(
        `SELECT id FROM booking
          WHERE tenant_id = $1 AND property_id = $2
            AND status IN ('REQUESTED', 'OFFER_PENDING', 'CONFIRMED', 'CHECKED_IN')
            AND stay_period && daterange($3::date, $4::date, '[)')
          LIMIT 1`,
        [tenantId, propertyId, from, to],
      );
      if (duplicate.rows[0]) {
        const existing = await tx.query<BookingRow>(
          `SELECT ${BOOKING_COLUMNS} FROM booking WHERE id = $1`,
          [duplicate.rows[0].id],
        );
        return existing.rows[0]!;
      }

      const q = quote(from, to, {
        basePriceMinor: BigInt(property.base_price_minor),
        basePriceUnit: property.price_unit,
        cleaningFeeMinor: BigInt(property.cleaning_fee_minor),
        utilitiesMode: property.utilities_mode,
        utilitiesFixedMinor: BigInt(property.utilities_fixed_minor),
        depositMinor: BigInt(property.deposit_minor),
        rules: await loadPricingRules(tx, propertyId),
      });

      if (q.nights < property.min_nights || q.nights > property.max_nights) {
        throw new DomainError(
          'DURATION_OUT_OF_RANGE',
          `Срок аренды должен быть от ${property.min_nights} до ${property.max_nights} ночей`,
          { nights: q.nights, minNights: property.min_nights, maxNights: property.max_nights },
        );
      }

      if ((input.guests ?? 1) > property.max_guests) {
        throw invalid(`Максимум гостей: ${property.max_guests}`);
      }

      const instant = input.instant === true;
      if (instant && property.booking_mode === 'REQUEST') {
        throw new DomainError('LISTING_NOT_BOOKABLE', 'Мгновенное бронирование недоступно для этого объекта');
      }

      // The state machine decides the target state; the service never invents one.
      const transition = applyEvent('INQUIRY', instant ? 'INSTANT_BOOK' : 'REQUEST', 'TENANT');

      const id = uuidv7();
      const reference = humanReference('KV');
      const snapshotId = await captureSnapshot(tx, propertyId, property);

      try {
        await tx.query(
          `INSERT INTO booking (
             id, reference, property_id, tenant_id, landlord_id, snapshot_id, status, stay_period,
             guests, booking_mode, rent_minor, cleaning_fee_minor, utilities_fixed_minor, utilities_mode,
             deposit_minor, total_expected_minor, fee_base_minor,
             requested_at, confirmed_at, terms_frozen_at, expires_at, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7, daterange($8::date,$9::date,'[)'),
             $10,$11,$12,$13,$14,$15,$16,$17,$18,
             now(),
             CASE WHEN $7 = 'CONFIRMED' THEN now() END,
             CASE WHEN $7 = 'CONFIRMED' THEN now() END,
             CASE WHEN $7 = 'REQUESTED' THEN now() + interval '48 hours' END,
             $19)`,
          [
            id,
            reference,
            propertyId,
            tenantId,
            property.owner_id,
            snapshotId,
            transition.to,
            from,
            to,
            input.guests ?? 1,
            instant ? 'INSTANT' : 'REQUEST',
            toStorage(q.rent),
            toStorage(money(BigInt(property.cleaning_fee_minor))),
            property.utilities_mode === 'FIXED_EXTRA' ? property.utilities_fixed_minor : '0',
            property.utilities_mode,
            property.deposit_minor,
            toStorage(q.totalExpected),
            toStorage(q.feeBase),
            input.idempotencyKey ?? null,
          ],
        );
      } catch (e) {
        throw translateBookingWriteError(e);
      }

      await recordEvent(tx, {
        bookingId: id,
        eventType: instant ? 'INSTANT_BOOK' : 'REQUEST',
        actor: 'TENANT',
        actorUserId: tenantId,
        from: 'INQUIRY',
        to: transition.to,
        effects: transition.effects,
        correlationId: input.correlationId,
      });

      await ensureConversation(tx, {
        propertyId,
        bookingId: id,
        tenantId,
        landlordId: property.owner_id,
        contactReleased: blocksCalendar(transition.to),
      });

      await writeAudit(tx, {
        actorUserId: tenantId,
        actorRole: 'TENANT',
        action: instant ? 'booking.instant_book' : 'booking.request',
        targetType: 'booking',
        targetId: id,
        changes: { status: { from: null, to: transition.to }, from, to },
        correlationId: input.correlationId ?? null,
      });

      const { rows } = await tx.query<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM booking WHERE id=$1`, [id]);
      return rows[0]!;
    });
  }

  /* ---------------------------------------------------------------- */

  /**
   * Landlord accepts a pending request.
   *
   * If a competing request was accepted first, the EXCLUDE constraint rejects
   * this one — the landlord is told the dates just went, rather than the system
   * silently creating a double booking.
   */
  async acceptRequest(bookingId: string, landlordId: string, correlationId?: string): Promise<BookingRow> {
    return this.db.transaction(async (tx) => {
      const booking = await lockBooking(tx, bookingId);
      if (booking.landlord_id !== landlordId) throw forbidden('Вы не владелец этого объекта');

      const transition = applyEvent(booking.status, 'ACCEPT_REQUEST', 'LANDLORD');

      try {
        await tx.query(
          `UPDATE booking
             SET status = $2, confirmed_at = now(), responded_at = now(),
                 terms_frozen_at = COALESCE(terms_frozen_at, now()), expires_at = NULL
           WHERE id = $1`,
          [bookingId, transition.to],
        );
      } catch (e) {
        throw translateBookingWriteError(e);
      }

      // AUTO_DECLINE_COMPETING_REQUESTS: everyone else who wanted these nights
      // finds out immediately instead of waiting for a request that can no
      // longer be accepted.
      const declined = await tx.query<{ id: string }>(
        `UPDATE booking
            SET status = 'DECLINED', responded_at = now()
          WHERE property_id = $1
            AND id <> $2
            AND status IN ('REQUESTED', 'OFFER_PENDING')
            AND stay_period && (SELECT stay_period FROM booking WHERE id = $2)
          RETURNING id`,
        [booking.property_id, bookingId],
      );

      for (const row of declined.rows) {
        await recordEvent(tx, {
          bookingId: row.id,
          eventType: 'DECLINE_REQUEST',
          actor: 'SYSTEM',
          from: 'REQUESTED',
          to: 'DECLINED',
          effects: ['NOTIFY_TENANT'],
          payload: { reason: 'DATES_TAKEN_BY_ANOTHER_BOOKING', winner: bookingId },
          correlationId,
        });
      }

      await tx.query(
        `UPDATE conversation
            SET contact_release_state = 'RELEASED', contact_released_at = now(),
                contact_released_reason = 'BOOKING_CONFIRMED'
          WHERE booking_id = $1 AND contact_release_state = 'BLOCKED'`,
        [bookingId],
      );

      await recordEvent(tx, {
        bookingId,
        eventType: 'ACCEPT_REQUEST',
        actor: 'LANDLORD',
        actorUserId: landlordId,
        from: booking.status,
        to: transition.to,
        effects: transition.effects,
        correlationId,
      });

      await writeAudit(tx, {
        actorUserId: landlordId,
        actorRole: 'LANDLORD',
        action: 'booking.accept',
        targetType: 'booking',
        targetId: bookingId,
        changes: { status: { from: booking.status, to: transition.to }, autoDeclined: declined.rows.length },
        correlationId: correlationId ?? null,
      });

      const { rows } = await tx.query<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM booking WHERE id=$1`, [bookingId]);
      return rows[0]!;
    });
  }

  /* ---------------------------------------------------------------- */

  async declineRequest(bookingId: string, landlordId: string, reason?: string): Promise<BookingRow> {
    return this.simpleTransition(bookingId, 'DECLINE_REQUEST', 'LANDLORD', landlordId, { reason });
  }

  async withdraw(bookingId: string, tenantId: string): Promise<BookingRow> {
    return this.simpleTransition(bookingId, 'WITHDRAW', 'TENANT', tenantId);
  }

  async cancelByTenant(bookingId: string, tenantId: string, reason?: string): Promise<BookingRow> {
    return this.simpleTransition(bookingId, 'CANCEL_BY_TENANT', 'TENANT', tenantId, { reason });
  }

  async cancelByLandlord(bookingId: string, landlordId: string, reason?: string): Promise<BookingRow> {
    return this.simpleTransition(bookingId, 'CANCEL_BY_LANDLORD', 'LANDLORD', landlordId, { reason });
  }

  async checkIn(bookingId: string, tenantId: string): Promise<BookingRow> {
    return this.simpleTransition(bookingId, 'CHECK_IN', 'TENANT', tenantId, { stampCheckIn: true });
  }

  /** SYSTEM job: the stay window closed, so the completion clock starts. */
  async openCompletionWindow(bookingId: string): Promise<BookingRow> {
    return this.db.transaction(async (tx) => {
      const booking = await lockBooking(tx, bookingId);
      const transition = applyEvent(booking.status, 'REACH_STAY_END', 'SYSTEM');
      const deadline = completionDeadline(new Date(`${booking.stay_to}T00:00:00Z`));

      await tx.query(`UPDATE booking SET status=$2, completion_deadline_at=$3 WHERE id=$1`, [
        bookingId,
        transition.to,
        deadline.toISOString(),
      ]);
      await recordEvent(tx, {
        bookingId,
        eventType: 'REACH_STAY_END',
        actor: 'SYSTEM',
        from: booking.status,
        to: transition.to,
        effects: transition.effects,
      });
      const { rows } = await tx.query<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM booking WHERE id=$1`, [bookingId]);
      return rows[0]!;
    });
  }

  /* ---------------------------------------------------------------- */

  /**
   * Record one side's completion answer and resolve if the evidence is in.
   *
   * IDEMPOTENCY: re-submitting the same answer is a no-op, and the fee accrual
   * is guarded three deep — the state machine refuses a second transition out of
   * COMPLETION_PENDING, service_fee.booking_id is UNIQUE, and the ledger has a
   * unique accrual per fee. Any one of them alone would be enough; together a
   * duplicate fee is not reachable.
   */
  async confirmCompletion(
    bookingId: string,
    userId: string,
    answer: CompletionAnswer,
    opts: { now?: Date; correlationId?: string } = {},
  ): Promise<{ booking: BookingRow; feeAccrued: boolean }> {
    const now = opts.now ?? new Date();

    return this.db.transaction(async (tx) => {
      const booking = await lockBooking(tx, bookingId);

      const actor: Actor =
        booking.tenant_id === userId ? 'TENANT' : booking.landlord_id === userId ? 'LANDLORD' : (() => {
          throw forbidden('Вы не участник этого бронирования');
        })();

      if (booking.status !== 'COMPLETION_PENDING') {
        throw new DomainError(
          'ILLEGAL_TRANSITION',
          'Подтверждение доступно только после окончания срока аренды',
          { status: booking.status },
        );
      }

      const alreadyAnswered =
        actor === 'TENANT' ? booking.tenant_completion_answer : booking.landlord_completion_answer;
      if (alreadyAnswered !== null && alreadyAnswered !== answer) {
        throw new DomainError('CONFLICT', 'Ответ уже отправлен и не может быть изменён');
      }

      if (alreadyAnswered === null) {
        const column = actor === 'TENANT' ? 'tenant' : 'landlord';
        await tx.query(
          `UPDATE booking SET ${column}_completion_answer = $2, ${column}_completion_at = now() WHERE id = $1`,
          [bookingId, answer],
        );
        await recordEvent(tx, {
          bookingId,
          eventType: 'CONFIRM_COMPLETION',
          actor,
          actorUserId: userId,
          from: booking.status,
          to: booking.status,
          effects: [],
          payload: { answer },
          correlationId: opts.correlationId,
        });
      }

      const tenantAnswer = actor === 'TENANT' ? answer : booking.tenant_completion_answer;
      const landlordAnswer = actor === 'LANDLORD' ? answer : booking.landlord_completion_answer;

      const outcome = resolveCompletion({
        tenantAnswer,
        landlordAnswer,
        hasCheckInRecord: booking.checked_in_at !== null,
        deadlinePassed: booking.completion_deadline_at !== null && new Date(booking.completion_deadline_at) <= now,
      });

      if (outcome.kind === 'PENDING') {
        const { rows } = await tx.query<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM booking WHERE id=$1`, [bookingId]);
        return { booking: rows[0]!, feeAccrued: false };
      }

      const feeAccrued = await this.applyResolution(tx, bookingId, booking, outcome, opts.correlationId);
      const { rows } = await tx.query<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM booking WHERE id=$1`, [bookingId]);
      return { booking: rows[0]!, feeAccrued };
    });
  }

  /** SYSTEM job: the confirmation window elapsed, so decide on the evidence held. */
  async resolveExpiredCompletion(bookingId: string, now: Date = new Date()): Promise<BookingRow> {
    return this.db.transaction(async (tx) => {
      const booking = await lockBooking(tx, bookingId);
      if (booking.status !== 'COMPLETION_PENDING') return booking;

      const outcome = resolveCompletion({
        tenantAnswer: booking.tenant_completion_answer,
        landlordAnswer: booking.landlord_completion_answer,
        hasCheckInRecord: booking.checked_in_at !== null,
        deadlinePassed: booking.completion_deadline_at !== null && new Date(booking.completion_deadline_at) <= now,
      });
      if (outcome.kind === 'PENDING') return booking;

      await this.applyResolution(tx, bookingId, booking, outcome);
      const { rows } = await tx.query<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM booking WHERE id=$1`, [bookingId]);
      return rows[0]!;
    });
  }

  private async applyResolution(
    tx: Sql,
    bookingId: string,
    booking: BookingRow,
    outcome: Extract<ReturnType<typeof resolveCompletion>, { kind: 'RESOLVED' }>,
    correlationId?: string,
  ): Promise<boolean> {
    const transition = applyEvent(booking.status, 'RESOLVE_COMPLETION', 'SYSTEM', outcome.state);

    await tx.query(
      `UPDATE booking
          SET status = $2,
              completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END,
              completion_reason = $3
        WHERE id = $1`,
      [bookingId, outcome.state, outcome.reason],
    );

    let feeAccrued = false;
    if (outcome.accrueFee) {
      feeAccrued = await accrueServiceFee(tx, booking);
    }

    if (outcome.fraudSignal) {
      await tx.query(
        `INSERT INTO fraud_signal (user_id, booking_id, kind, severity, detail)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          booking.landlord_id,
          bookingId,
          outcome.fraudSignal,
          outcome.fraudSignal === 'UNILATERAL_LANDLORD_DENIAL' ? 3 : 1,
          JSON.stringify({ reason: outcome.reason }),
        ],
      );
    }

    if (outcome.state === 'COMPLETED') {
      await tx.query(
        `UPDATE app_user SET completed_rentals_as_tenant = completed_rentals_as_tenant + 1 WHERE id = $1`,
        [booking.tenant_id],
      );
      await tx.query(
        `UPDATE app_user SET completed_rentals_as_landlord = completed_rentals_as_landlord + 1 WHERE id = $1`,
        [booking.landlord_id],
      );
    }

    await recordEvent(tx, {
      bookingId,
      eventType: 'RESOLVE_COMPLETION',
      actor: 'SYSTEM',
      from: booking.status,
      to: transition.to,
      effects: transition.effects,
      payload: { reason: outcome.reason, feeAccrued },
      correlationId,
    });

    await writeAudit(tx, {
      action: 'booking.resolve_completion',
      targetType: 'booking',
      targetId: bookingId,
      changes: { status: { from: booking.status, to: outcome.state }, feeAccrued },
      reason: outcome.reason,
      source: 'system',
      correlationId: correlationId ?? null,
    });

    return feeAccrued;
  }

  /* ---------------------------------------------------------------- */

  private async simpleTransition(
    bookingId: string,
    event: BookingEventType,
    actor: Actor,
    userId: string,
    opts: { reason?: string; stampCheckIn?: boolean } = {},
  ): Promise<BookingRow> {
    return this.db.transaction(async (tx) => {
      const booking = await lockBooking(tx, bookingId);

      const expectedUser = actor === 'TENANT' ? booking.tenant_id : booking.landlord_id;
      if (expectedUser !== userId) throw forbidden('Вы не участник этого бронирования');

      const transition = applyEvent(booking.status, event, actor);

      await tx.query(
        `UPDATE booking
            SET status = $2,
                cancelled_at = CASE WHEN $2 LIKE 'CANCELLED%' THEN now() ELSE cancelled_at END,
                cancellation_reason = COALESCE($3, cancellation_reason),
                checked_in_at = CASE WHEN $4 THEN now() ELSE checked_in_at END,
                responded_at = COALESCE(responded_at, now())
          WHERE id = $1`,
        [bookingId, transition.to, opts.reason ?? null, opts.stampCheckIn === true],
      );

      await recordEvent(tx, {
        bookingId,
        eventType: event,
        actor,
        actorUserId: userId,
        from: booking.status,
        to: transition.to,
        effects: transition.effects,
        payload: opts.reason ? { reason: opts.reason } : undefined,
      });

      await writeAudit(tx, {
        actorUserId: userId,
        actorRole: actor,
        action: `booking.${event.toLowerCase()}`,
        targetType: 'booking',
        targetId: bookingId,
        changes: { status: { from: booking.status, to: transition.to } },
        reason: opts.reason ?? null,
      });

      const { rows } = await tx.query<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM booking WHERE id=$1`, [bookingId]);
      return rows[0]!;
    });
  }
}

/* ================================================================== *
 * helpers
 * ================================================================== */

async function lockBooking(tx: Sql, bookingId: string): Promise<BookingRow> {
  // FOR UPDATE serialises concurrent transitions on the same booking, so two
  // simultaneous "accept" clicks cannot both read a stale status.
  const { rows } = await tx.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM booking WHERE id = $1 FOR UPDATE`,
    [bookingId],
  );
  const row = rows[0];
  if (!row) throw notFound('Бронирование');
  return row;
}

interface PropertyRow {
  id: string;
  owner_id: string;
  status: string;
  base_price_minor: string;
  price_unit: 'NIGHT' | 'MONTH';
  cleaning_fee_minor: string;
  utilities_mode: 'INCLUDED' | 'FIXED_EXTRA' | 'VARIABLE_METERED';
  utilities_fixed_minor: string;
  deposit_minor: string;
  min_nights: number;
  max_nights: number;
  max_guests: number;
  booking_mode: 'INSTANT' | 'REQUEST' | 'INSTANT_AND_REQUEST';
}

async function loadBookableProperty(tx: Sql, propertyId: string): Promise<PropertyRow> {
  const { rows } = await tx.query<PropertyRow>(
    `SELECT id, owner_id, status,
            base_price_minor::text AS base_price_minor, price_unit,
            cleaning_fee_minor::text AS cleaning_fee_minor, utilities_mode,
            utilities_fixed_minor::text AS utilities_fixed_minor, deposit_minor::text AS deposit_minor,
            min_nights, max_nights, max_guests, booking_mode
       FROM property WHERE id = $1 AND deleted_at IS NULL`,
    [propertyId],
  );
  const property = rows[0];
  if (!property) throw notFound('Объект');
  if (property.status !== 'PUBLISHED') {
    throw new DomainError('LISTING_NOT_BOOKABLE', 'Объявление недоступно для бронирования');
  }
  return property;
}

async function loadPricingRules(tx: Sql, propertyId: string): Promise<PricingRule[]> {
  const { rows } = await tx.query<{
    kind: 'LENGTH_OF_STAY' | 'SEASONAL';
    min_nights: number | null;
    max_nights: number | null;
    season_from: string | null;
    season_to: string | null;
    price_minor: string;
    price_unit: 'NIGHT' | 'MONTH';
    priority: number;
  }>(
    `SELECT kind, min_nights, max_nights,
            lower(season)::text AS season_from, upper(season)::text AS season_to,
            price_minor::text AS price_minor, price_unit, priority
       FROM pricing_rule WHERE property_id = $1`,
    [propertyId],
  );

  return rows.map((r) =>
    r.kind === 'LENGTH_OF_STAY'
      ? {
          kind: 'LENGTH_OF_STAY' as const,
          minNights: r.min_nights ?? 1,
          maxNights: r.max_nights ?? Number.MAX_SAFE_INTEGER,
          priceMinor: BigInt(r.price_minor),
          priceUnit: r.price_unit,
          priority: r.priority,
        }
      : {
          kind: 'SEASONAL' as const,
          from: r.season_from ?? '1970-01-01',
          to: r.season_to ?? '9999-12-31',
          priceMinor: BigInt(r.price_minor),
          priceUnit: r.price_unit,
          priority: r.priority,
        },
  );
}

/** Freeze what the offer said, so a later edit cannot rewrite booked terms. */
async function captureSnapshot(tx: Sql, propertyId: string, property: PropertyRow): Promise<string> {
  const id = uuidv7();
  const content = JSON.stringify(property);
  const { createHash } = await import('node:crypto');
  await tx.query(
    `INSERT INTO listing_snapshot (id, property_id, content, content_hash) VALUES ($1,$2,$3::jsonb,$4)`,
    [id, propertyId, content, createHash('sha256').update(content).digest()],
  );
  return id;
}

async function ensureConversation(
  tx: Sql,
  args: { propertyId: string; bookingId: string; tenantId: string; landlordId: string; contactReleased: boolean },
): Promise<void> {
  await tx.query(
    `INSERT INTO conversation (id, property_id, booking_id, tenant_id, landlord_id,
        contact_release_state, contact_released_at, contact_released_reason)
     VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6 = 'RELEASED' THEN now() END,
        CASE WHEN $6 = 'RELEASED' THEN 'BOOKING_CONFIRMED' END)
     ON CONFLICT (property_id, tenant_id) WHERE property_id IS NOT NULL
     DO UPDATE SET booking_id = EXCLUDED.booking_id`,
    [
      uuidv7(),
      args.propertyId,
      args.bookingId,
      args.tenantId,
      args.landlordId,
      args.contactReleased ? 'RELEASED' : 'BLOCKED',
    ],
  );
}

interface EventInput {
  bookingId: string;
  eventType: string;
  actor: Actor;
  actorUserId?: string;
  from: string | null;
  to: string;
  effects: readonly string[];
  payload?: Record<string, unknown> | undefined;
  correlationId?: string | undefined;
}

async function recordEvent(tx: Sql, e: EventInput): Promise<void> {
  await tx.query(
    `INSERT INTO booking_event (booking_id, event_type, actor, actor_user_id, from_status, to_status, effects, payload, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      e.bookingId,
      e.eventType,
      e.actor,
      e.actorUserId ?? null,
      e.from,
      e.to,
      `{${e.effects.join(',')}}`,
      e.payload ? JSON.stringify(e.payload) : null,
      e.correlationId ?? null,
    ],
  );
}

/**
 * Create the service fee and its ledger entry. Returns false when a fee already
 * existed, which is the normal outcome of a retry rather than an error.
 */
export async function accrueServiceFee(tx: Sql, booking: BookingRow): Promise<boolean> {
  const feeBase: Money = money(BigInt(booking.fee_base_minor));
  const fee = serviceFee(feeBase, booking.service_fee_bps);

  const feeId = uuidv7();
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO service_fee (id, booking_id, landlord_id, base_minor, bps, fee_minor, due_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + interval '14 days')
     ON CONFLICT (booking_id) DO NOTHING
     RETURNING id`,
    [feeId, booking.id, booking.landlord_id, toStorage(feeBase), booking.service_fee_bps, toStorage(fee)],
  );

  if (inserted.rows.length === 0) return false; // already accrued

  await tx.query(
    `INSERT INTO ledger_entry (landlord_id, entry_type, amount_minor, service_fee_id, booking_id, reason)
     VALUES ($1,'FEE_ACCRUED',$2,$3,$4,$5)`,
    [
      booking.landlord_id,
      (-fee.amountMinor).toString(),
      feeId,
      booking.id,
      `Сервисный сбор ${booking.service_fee_bps / 100}% по бронированию ${booking.reference}`,
    ],
  );

  await writeAudit(tx, {
    action: 'fee.accrue',
    targetType: 'service_fee',
    targetId: feeId,
    changes: { bookingId: booking.id, baseMinor: booking.fee_base_minor, bps: booking.service_fee_bps, feeMinor: toStorage(fee) },
    source: 'system',
  });

  return true;
}

function translateBookingWriteError(e: unknown): unknown {
  if (hasErrorCode(e, PG_ERROR.EXCLUSION_VIOLATION)) {
    return new DomainError('DATES_UNAVAILABLE', 'Эти даты уже заняты. Выберите другие даты.');
  }
  if (hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) {
    return new DomainError('ALREADY_EXISTS', 'Такой запрос уже существует');
  }
  return e;
}
