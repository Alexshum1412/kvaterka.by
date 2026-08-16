/**
 * Trust profile and score (spec §31).
 *
 * Three constraints shaped this:
 *
 *   1. TRUST CANNOT BE BOUGHT. Only behaviour and verification feed the score.
 *      Paid promotion may affect placement; it never touches this number.
 *   2. IT MUST BE EXPLAINABLE. The score is returned with the components that
 *      produced it. A number nobody can explain is a number nobody trusts, and
 *      an opaque automated judgement about a person is also a legal exposure
 *      (LEGAL-009).
 *   3. IT MUST NOT LEAK. Fraud signals, moderation notes and internal risk data
 *      never appear in a public profile, however useful they would be.
 */

import type { Db } from '../db/sql.ts';
import { notFound } from './errors.ts';

export interface TrustComponent {
  readonly code: string;
  readonly label: string;
  readonly points: number;
  readonly maxPoints: number;
  readonly detail: string;
}

export interface TrustProfile {
  readonly userId: string;
  readonly displayName: string;
  readonly accountKind: string;
  readonly verificationLevel: number;
  readonly identityVerified: boolean;
  readonly memberSince: string;
  readonly completedRentalsAsTenant: number;
  readonly completedRentalsAsLandlord: number;
  readonly activeListings: number;
  readonly rating: number | null;
  readonly reviewCount: number;
  readonly cancellationRate: number | null;
  readonly responseRate: number | null;
  readonly trustScore: number;
  readonly trustBand: 'NEW' | 'DEVELOPING' | 'ESTABLISHED' | 'HIGH';
  readonly components: readonly TrustComponent[];
}

/**
 * Weights. Deliberately spread so no single factor dominates: a landlord cannot
 * reach a high score on verification alone, and a handful of five-star reviews
 * from friends cannot either.
 */
const WEIGHTS = {
  verification: 25,
  completedRentals: 25,
  reviews: 25,
  reliability: 15,
  tenure: 10,
} as const;

export class TrustService {
  constructor(private readonly db: Db) {}

  async profile(userId: string): Promise<TrustProfile> {
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT u.id, u.display_name, u.company_name, u.account_kind, u.verification_level,
              u.created_at, u.completed_rentals_as_tenant, u.completed_rentals_as_landlord,
              (SELECT count(*)::int FROM property p
                WHERE p.owner_id = u.id AND p.status = 'PUBLISHED' AND p.deleted_at IS NULL) AS active_listings,
              (SELECT round(avg(r.overall)::numeric, 2) FROM review r
                WHERE r.subject_id = u.id AND r.status = 'PUBLISHED') AS rating,
              (SELECT count(*)::int FROM review r
                WHERE r.subject_id = u.id AND r.status = 'PUBLISHED') AS review_count,
              (SELECT count(*)::int FROM booking b
                WHERE (b.tenant_id = u.id OR b.landlord_id = u.id)
                  AND b.status IN ('CANCELLED_BY_TENANT','CANCELLED_BY_LANDLORD')) AS cancellations,
              (SELECT count(*)::int FROM booking b
                WHERE (b.tenant_id = u.id OR b.landlord_id = u.id)
                  AND b.confirmed_at IS NOT NULL) AS confirmed_total,
              (SELECT count(*)::int FROM booking b
                WHERE b.landlord_id = u.id AND b.status = 'REQUESTED') AS open_requests,
              (SELECT count(*)::int FROM booking b
                WHERE b.landlord_id = u.id AND b.responded_at IS NOT NULL) AS answered_requests,
              (SELECT count(*)::int FROM booking b
                WHERE b.landlord_id = u.id AND b.status = 'EXPIRED') AS ignored_requests
         FROM app_user u
        WHERE u.id = $1 AND u.deleted_at IS NULL AND u.status <> 'DELETED'`,
      [userId],
    );

    const u = rows[0];
    if (!u) throw notFound('Профиль');

    const completedTotal = Number(u.completed_rentals_as_tenant) + Number(u.completed_rentals_as_landlord);
    const reviewCount = Number(u.review_count);
    const rating = u.rating === null ? null : Number(u.rating);
    const confirmedTotal = Number(u.confirmed_total);
    const cancellations = Number(u.cancellations);
    const answered = Number(u.answered_requests);
    const ignored = Number(u.ignored_requests);

    const cancellationRate = confirmedTotal > 0 ? round2(cancellations / confirmedTotal) : null;
    const responseRate = answered + ignored > 0 ? round2(answered / (answered + ignored)) : null;
    const tenureDays = (Date.now() - Date.parse(u.created_at)) / 86_400_000;

    const components: TrustComponent[] = [
      {
        code: 'VERIFICATION',
        label: 'Подтверждение личности',
        points: Math.round((Number(u.verification_level) / 2) * WEIGHTS.verification),
        maxPoints: WEIGHTS.verification,
        detail:
          Number(u.verification_level) >= 2
            ? 'Личность и право сдавать подтверждены'
            : Number(u.verification_level) === 1
              ? 'Личность подтверждена'
              : 'Подтверждены телефон и email',
      },
      {
        code: 'COMPLETED_RENTALS',
        // Saturating rather than linear: the difference between 0 and 5 rentals
        // is meaningful, between 50 and 100 it is not.
        label: 'Завершённые аренды',
        points: Math.round(saturate(completedTotal, 10) * WEIGHTS.completedRentals),
        maxPoints: WEIGHTS.completedRentals,
        detail: `${completedTotal} завершённых аренд`,
      },
      {
        code: 'REVIEWS',
        label: 'Отзывы',
        // Rating scaled by confidence in it: a single 5.0 is worth far less
        // than twenty averaging 4.6. This is the main anti-gaming lever.
        points:
          rating === null
            ? 0
            : Math.round(((rating - 1) / 4) * saturate(reviewCount, 8) * WEIGHTS.reviews),
        maxPoints: WEIGHTS.reviews,
        detail: rating === null ? 'Пока нет отзывов' : `${rating} из 5 по ${reviewCount} отзывам`,
      },
      {
        code: 'RELIABILITY',
        label: 'Надёжность',
        points: Math.round(
          ((cancellationRate === null ? 0.6 : 1 - Math.min(cancellationRate, 1)) * 0.6 +
            (responseRate === null ? 0.6 : responseRate) * 0.4) *
            WEIGHTS.reliability,
        ),
        maxPoints: WEIGHTS.reliability,
        detail:
          cancellationRate === null
            ? 'Недостаточно данных'
            : `Отмены: ${Math.round(cancellationRate * 100)}%`,
      },
      {
        code: 'TENURE',
        label: 'Время на платформе',
        points: Math.round(saturate(tenureDays, 365) * WEIGHTS.tenure),
        maxPoints: WEIGHTS.tenure,
        detail: `${Math.max(1, Math.round(tenureDays))} дней на платформе`,
      },
    ];

    const trustScore = Math.min(100, components.reduce((sum, c) => sum + c.points, 0));

    // Cold start: a brand-new account is shown as NEW rather than as "low
    // trust". It has not done anything wrong; it has not done anything yet.
    const isNew = completedTotal === 0 && reviewCount === 0;

    return {
      userId: u.id,
      displayName: u.account_kind === 'COMPANY' ? (u.company_name ?? u.display_name) : u.display_name,
      accountKind: u.account_kind,
      verificationLevel: Number(u.verification_level),
      identityVerified: Number(u.verification_level) >= 1,
      memberSince: u.created_at,
      completedRentalsAsTenant: Number(u.completed_rentals_as_tenant),
      completedRentalsAsLandlord: Number(u.completed_rentals_as_landlord),
      activeListings: Number(u.active_listings),
      rating,
      reviewCount,
      cancellationRate,
      responseRate,
      trustScore,
      trustBand: isNew ? 'NEW' : trustScore >= 80 ? 'HIGH' : trustScore >= 55 ? 'ESTABLISHED' : 'DEVELOPING',
      components,
    };
  }

  /** Cache the score on the user row for ranking. Never authoritative. */
  async refreshScore(userId: string): Promise<number> {
    const profile = await this.profile(userId);
    await this.db.query(`UPDATE app_user SET trust_score=$2 WHERE id=$1`, [userId, profile.trustScore]);
    return profile.trustScore;
  }
}

/** Diminishing returns: 0 → 0, `half` → 0.5, ∞ → 1. */
function saturate(value: number, half: number): number {
  if (value <= 0) return 0;
  return value / (value + half);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
