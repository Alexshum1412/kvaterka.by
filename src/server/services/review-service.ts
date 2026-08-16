/**
 * Two-sided reviews (spec §28–§30).
 *
 * Publication model: a review becomes visible when BOTH sides have submitted,
 * or when the review window closes — whichever happens first. Until then
 * neither party can read the other's, which is what stops a retaliatory
 * "you gave me 3 stars so I'll give you 1".
 *
 * Eligibility is anchored to a completed booking, and the database enforces
 * one review per side per booking, so a duplicate submit cannot slip through
 * even if this code is wrong.
 */

import { uuidv7 } from '../../lib/id.ts';
import { hasErrorCode, PG_ERROR, type Db, type Sql } from '../db/sql.ts';
import { DomainError, forbidden, invalid, notFound } from './errors.ts';
import { writeAudit } from './audit.ts';

export const REVIEW_WINDOW_DAYS = 14;

export interface TenantReviewInput {
  readonly overall: number;
  readonly cleanliness: number;
  readonly accuracy: number;
  readonly communication: number;
  readonly checkIn?: number;
  readonly location?: number;
  readonly value?: number;
  readonly rulesClarity?: number;
  readonly body?: string;
  readonly whatWasGood?: string;
  readonly whatToImprove?: string;
  readonly wouldRentAgain?: boolean;
  /** Facts the guest can confirm first-hand, e.g. { WIFI: true } (spec §35). */
  readonly confirmedFacts?: Record<string, boolean>;
}

export interface LandlordReviewInput {
  readonly overall: number;
  readonly communication: number;
  readonly ruleCompliance: number;
  readonly propertyCondition: number;
  readonly timeliness?: number;
  readonly body?: string;
  readonly whatWasGood?: string;
  readonly whatToImprove?: string;
  readonly wouldRentAgain?: boolean;
}

export type ReviewInput = TenantReviewInput | LandlordReviewInput;

const MIN_TEXT_FOR_LOW_RATING = 20;

export class ReviewService {
  constructor(private readonly db: Db) {}

  /** What the current user may still do about reviews for this booking. */
  async eligibility(
    bookingId: string,
    userId: string,
  ): Promise<{ canReview: boolean; role: 'TENANT' | 'LANDLORD' | null; reason?: string; deadline?: string | null }> {
    const { rows } = await this.db.query<{
      status: string;
      tenant_id: string;
      landlord_id: string;
      review_deadline_at: string | null;
      already: string;
    }>(
      `SELECT b.status, b.tenant_id, b.landlord_id, b.review_deadline_at,
              (SELECT count(*)::text FROM review r
                WHERE r.booking_id = b.id
                  AND r.author_role = CASE WHEN b.tenant_id = $2 THEN 'TENANT' ELSE 'LANDLORD' END) AS already
         FROM booking b WHERE b.id = $1`,
      [bookingId, userId],
    );
    const b = rows[0];
    if (!b) throw notFound('Бронирование');

    const role = b.tenant_id === userId ? 'TENANT' : b.landlord_id === userId ? 'LANDLORD' : null;
    if (!role) return { canReview: false, role: null, reason: 'NOT_A_PARTICIPANT' };
    if (b.status !== 'COMPLETED') return { canReview: false, role, reason: 'RENTAL_NOT_COMPLETED' };
    if (Number(b.already) > 0) return { canReview: false, role, reason: 'ALREADY_REVIEWED' };
    if (b.review_deadline_at && new Date(b.review_deadline_at) < new Date()) {
      return { canReview: false, role, reason: 'WINDOW_CLOSED', deadline: b.review_deadline_at };
    }
    return { canReview: true, role, deadline: b.review_deadline_at };
  }

  async submit(bookingId: string, authorId: string, input: ReviewInput): Promise<{ id: string; published: boolean }> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<{
        status: string;
        tenant_id: string;
        landlord_id: string;
        property_id: string;
        review_deadline_at: string | null;
      }>(
        `SELECT status, tenant_id, landlord_id, property_id, review_deadline_at
           FROM booking WHERE id=$1 FOR UPDATE`,
        [bookingId],
      );
      const booking = rows[0];
      if (!booking) throw notFound('Бронирование');

      const role =
        booking.tenant_id === authorId ? 'TENANT' : booking.landlord_id === authorId ? 'LANDLORD' : null;
      if (!role) throw forbidden('Вы не участник этого бронирования');

      // The single most important rule: no rental, no review (spec §30).
      if (booking.status !== 'COMPLETED') {
        throw new DomainError('CONFLICT', 'Отзыв можно оставить только после завершённой аренды');
      }
      if (booking.review_deadline_at && new Date(booking.review_deadline_at) < new Date()) {
        throw new DomainError('CONFLICT', 'Срок для отзыва истёк');
      }

      assertReviewQuality(role, input);

      const subjectId = role === 'TENANT' ? booking.landlord_id : booking.tenant_id;
      const id = uuidv7();

      try {
        if (role === 'TENANT') {
          const t = input as TenantReviewInput;
          await tx.query(
            `INSERT INTO review (id, booking_id, author_id, subject_id, property_id, author_role,
                overall, cleanliness, accuracy, check_in_rating, location_rating, value_rating,
                rules_clarity, communication, body, what_was_good, what_to_improve, would_rent_again,
                confirmed_facts, status)
             VALUES ($1,$2,$3,$4,$5,'TENANT',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,'PENDING')`,
            [
              id, bookingId, authorId, subjectId, booking.property_id,
              t.overall, t.cleanliness, t.accuracy, t.checkIn ?? null, t.location ?? null,
              t.value ?? null, t.rulesClarity ?? null, t.communication,
              t.body ?? '', t.whatWasGood ?? null, t.whatToImprove ?? null, t.wouldRentAgain ?? null,
              JSON.stringify(t.confirmedFacts ?? {}),
            ],
          );
        } else {
          const l = input as LandlordReviewInput;
          await tx.query(
            `INSERT INTO review (id, booking_id, author_id, subject_id, author_role,
                overall, communication, rule_compliance, property_condition, timeliness,
                body, what_was_good, what_to_improve, would_rent_again, status)
             VALUES ($1,$2,$3,$4,'LANDLORD',$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING')`,
            [
              id, bookingId, authorId, subjectId,
              l.overall, l.communication, l.ruleCompliance, l.propertyCondition, l.timeliness ?? null,
              l.body ?? '', l.whatWasGood ?? null, l.whatToImprove ?? null, l.wouldRentAgain ?? null,
            ],
          );
        }
      } catch (e) {
        if (hasErrorCode(e, PG_ERROR.UNIQUE_VIOLATION)) {
          throw new DomainError('ALREADY_EXISTS', 'Вы уже оставили отзыв по этой аренде');
        }
        throw e;
      }

      // Both sides in → publish both at once, so neither could have read the
      // other's first.
      const published = await this.publishIfBothSubmitted(tx, bookingId);

      await writeAudit(tx, {
        actorUserId: authorId,
        actorRole: role,
        action: 'review.submit',
        targetType: 'review',
        targetId: id,
        changes: { bookingId, published },
      });

      return { id, published };
    });
  }

  private async publishIfBothSubmitted(tx: Sql, bookingId: string): Promise<boolean> {
    const { rows } = await tx.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM review WHERE booking_id=$1`,
      [bookingId],
    );
    if (Number(rows[0]!.c) < 2) return false;

    await tx.query(
      `UPDATE review SET status='PUBLISHED', published_at=now()
        WHERE booking_id=$1 AND status='PENDING'`,
      [bookingId],
    );
    return true;
  }

  /**
   * Scheduled job: publish reviews whose window has closed.
   *
   * A one-sided review still publishes at the deadline; otherwise a party could
   * suppress criticism forever simply by never writing their own.
   */
  async publishExpiredWindows(now: Date = new Date()): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE review SET status='PUBLISHED', published_at=now()
        WHERE status='PENDING'
          AND booking_id IN (
            SELECT id FROM booking
             WHERE status='COMPLETED' AND review_deadline_at IS NOT NULL AND review_deadline_at <= $1)
        RETURNING id`,
      [now.toISOString()],
    );
    return rows.length;
  }

  async listForProperty(propertyId: string, limit = 20, offset = 0): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT r.id, r.overall, r.cleanliness, r.accuracy, r.check_in_rating, r.location_rating,
              r.value_rating, r.rules_clarity, r.communication, r.body, r.what_was_good,
              r.what_to_improve, r.would_rent_again, r.published_at,
              u.display_name AS author_name, u.verification_level AS author_verification,
              b.nights
         FROM review r
         JOIN app_user u ON u.id = r.author_id
         JOIN booking b ON b.id = r.booking_id
        WHERE r.property_id=$1 AND r.status='PUBLISHED' AND r.author_role='TENANT'
        ORDER BY r.published_at DESC
        LIMIT $2 OFFSET $3`,
      [propertyId, Math.min(limit, 50), offset],
    );

    return rows.map((r) => ({
      id: r.id,
      ratings: {
        overall: r.overall,
        cleanliness: r.cleanliness,
        accuracy: r.accuracy,
        checkIn: r.check_in_rating,
        location: r.location_rating,
        value: r.value_rating,
        rulesClarity: r.rules_clarity,
        communication: r.communication,
      },
      body: r.body,
      whatWasGood: r.what_was_good,
      whatToImprove: r.what_to_improve,
      wouldRentAgain: r.would_rent_again,
      publishedAt: r.published_at,
      author: { name: r.author_name, verificationLevel: r.author_verification },
      // Duration, never the exact dates — publishing when a home stood empty
      // is a security problem, not a feature (spec §29).
      stayLength: humaniseNights(Number(r.nights)),
    }));
  }

  /**
   * Aggregate facts guests actually confirmed, so the listing can distinguish
   * "landlord says Wi-Fi" from "94% of guests confirmed Wi-Fi" (spec §35).
   */
  async confirmedFacts(propertyId: string): Promise<Record<string, { confirmed: number; total: number }>> {
    const { rows } = await this.db.query<{ confirmed_facts: Record<string, boolean> }>(
      `SELECT confirmed_facts FROM review
        WHERE property_id=$1 AND status='PUBLISHED' AND author_role='TENANT'
          AND confirmed_facts <> '{}'::jsonb`,
      [propertyId],
    );

    const out: Record<string, { confirmed: number; total: number }> = {};
    for (const row of rows) {
      for (const [fact, value] of Object.entries(row.confirmed_facts ?? {})) {
        const entry = (out[fact] ??= { confirmed: 0, total: 0 });
        entry.total += 1;
        if (value) entry.confirmed += 1;
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */

/**
 * Reject empty reviews (spec §30). A five-star "все хорошо" carries no
 * information; a one-star with no text is unfair to the person being rated and
 * unusable by the next tenant.
 */
function assertReviewQuality(role: 'TENANT' | 'LANDLORD', input: ReviewInput): void {
  const ratings = Object.entries(input).filter(([k, v]) => k !== 'overall' && typeof v === 'number');
  for (const [key, value] of [...ratings, ['overall', input.overall] as const]) {
    if (typeof value === 'number' && (!Number.isInteger(value) || value < 1 || value > 5)) {
      throw invalid(`Оценка «${key}» должна быть от 1 до 5`, { field: key });
    }
  }

  const required =
    role === 'TENANT'
      ? ['cleanliness', 'accuracy', 'communication']
      : ['communication', 'ruleCompliance', 'propertyCondition'];
  for (const field of required) {
    if (typeof (input as unknown as Record<string, unknown>)[field] !== 'number') {
      throw invalid('Заполните все обязательные оценки', { field });
    }
  }

  const text = `${input.body ?? ''} ${input.whatWasGood ?? ''} ${input.whatToImprove ?? ''}`.trim();

  // A harsh rating must be explained: it damages someone's livelihood or their
  // ability to rent again, and an unexplained one cannot be moderated fairly.
  if (input.overall <= 2 && text.length < MIN_TEXT_FOR_LOW_RATING) {
    throw invalid(
      'Пожалуйста, опишите, что именно пошло не так — низкая оценка без пояснения не публикуется',
      { field: 'body' },
    );
  }
}

function humaniseNights(nights: number): string {
  if (nights >= 365) {
    const years = Math.round(nights / 365);
    return `снимал(а) около ${years} ${plural(years, 'года', 'лет', 'лет')}`;
  }
  if (nights >= 60) {
    const months = Math.round(nights / 30);
    return `снимал(а) около ${months} ${plural(months, 'месяца', 'месяцев', 'месяцев')}`;
  }
  if (nights >= 28) return 'снимал(а) около месяца';
  return `останавливался(ась) на ${nights} ${plural(nights, 'ночь', 'ночи', 'ночей')}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
