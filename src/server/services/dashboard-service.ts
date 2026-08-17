/**
 * Landlord dashboard aggregation.
 *
 * One query set, one round trip. A dashboard assembled from a dozen client
 * calls is slow on a phone and races itself; this returns everything the
 * overview needs in a single shape, and the counts come from the same tables
 * the rest of the product writes to — nothing here is precomputed or cached
 * into a column that could drift.
 *
 * The screen answers one question: «Что происходит с моими квартирами?»
 * So the payload leads with what NEEDS ACTION rather than with vanity totals.
 */

import type { Db } from '../db/sql.ts';

export type AttentionKind =
  | 'BOOKING_REQUEST'
  | 'AWAITING_CHECK_IN'
  | 'CONFIRM_COMPLETION'
  | 'LISTING_REJECTED'
  | 'LISTING_DRAFT'
  | 'UNREAD_MESSAGES'
  | 'OUTSTANDING_DEBT'
  | 'STALE_CALENDAR'
  | 'REVIEW_PENDING';

export interface AttentionItem {
  readonly kind: AttentionKind;
  readonly title: string;
  readonly detail: string;
  readonly href: string;
  readonly severity: 'INFO' | 'ACTION' | 'URGENT';
  readonly count?: number;
}

export interface DashboardSummary {
  readonly displayName: string;
  readonly verificationLevel: number;
  readonly stats: {
    readonly publishedListings: number;
    readonly draftListings: number;
    readonly pendingRequests: number;
    readonly upcomingCheckIns: number;
    readonly activeStays: number;
    readonly rating: number | null;
    readonly reviewCount: number;
    readonly completedRentals: number;
    readonly unreadMessages: number;
    readonly balanceMinor: string;
  };
  readonly attention: readonly AttentionItem[];
  readonly listings: readonly DashboardListing[];
  readonly upcoming: readonly UpcomingStay[];
}

export interface DashboardListing {
  readonly id: string;
  readonly title: string;
  readonly city: string;
  readonly district: string | null;
  readonly status: string;
  readonly rejectionReason: string | null;
  readonly basePriceMinor: string;
  readonly priceUnit: string;
  readonly coverPhoto: string | null;
  readonly photoCount: number;
  readonly rating: number | null;
  readonly reviewCount: number;
  readonly pendingRequests: number;
  readonly upcomingBookings: number;
  readonly calendarUpdatedAt: string;
  readonly calendarStale: boolean;
}

export interface UpcomingStay {
  readonly bookingId: string;
  readonly reference: string;
  readonly status: string;
  readonly propertyTitle: string;
  readonly tenantName: string;
  readonly from: string;
  readonly to: string;
  readonly nights: number;
  readonly totalExpectedMinor: string;
}

const STALE_CALENDAR_DAYS = 21;

export class DashboardService {
  constructor(private readonly db: Db) {}

  async landlordSummary(userId: string): Promise<DashboardSummary> {
    const [user, listings, upcoming, counts, balance] = await Promise.all([
      this.db.query<Record<string, any>>(
        `SELECT display_name, verification_level, completed_rentals_as_landlord,
                (SELECT round(avg(overall)::numeric,2) FROM review WHERE subject_id=$1 AND status='PUBLISHED') AS rating,
                (SELECT count(*)::int FROM review WHERE subject_id=$1 AND status='PUBLISHED') AS review_count
           FROM app_user WHERE id=$1`,
        [userId],
      ),
      this.db.query<Record<string, any>>(
        `SELECT p.id, p.title, p.city, p.district, p.status, p.rejection_reason,
                p.base_price_minor::text AS base_price_minor, p.price_unit,
                p.calendar_updated_at,
                (SELECT count(*)::int FROM property_photo ph WHERE ph.property_id=p.id) AS photo_count,
                (SELECT storage_key FROM property_photo ph
                  WHERE ph.property_id=p.id ORDER BY is_cover DESC, sort_order LIMIT 1) AS cover_photo,
                (SELECT round(avg(r.overall)::numeric,2) FROM review r
                  WHERE r.property_id=p.id AND r.status='PUBLISHED') AS rating,
                (SELECT count(*)::int FROM review r
                  WHERE r.property_id=p.id AND r.status='PUBLISHED') AS review_count,
                (SELECT count(*)::int FROM booking b
                  WHERE b.property_id=p.id AND b.status='REQUESTED') AS pending_requests,
                (SELECT count(*)::int FROM booking b
                  WHERE b.property_id=p.id AND b.status IN ('CONFIRMED','CHECKED_IN')) AS upcoming_bookings
           FROM property p
          WHERE p.owner_id=$1 AND p.deleted_at IS NULL
          ORDER BY
            CASE p.status WHEN 'PUBLISHED' THEN 0 WHEN 'PENDING_MODERATION' THEN 1
                          WHEN 'REJECTED' THEN 2 WHEN 'DRAFT' THEN 3 ELSE 4 END,
            p.created_at DESC`,
        [userId],
      ),
      this.db.query<Record<string, any>>(
        `SELECT b.id, b.reference, b.status, b.nights,
                lower(b.stay_period)::text AS stay_from, upper(b.stay_period)::text AS stay_to,
                b.total_expected_minor::text AS total_expected_minor,
                p.title AS property_title, u.display_name AS tenant_name
           FROM booking b
           JOIN property p ON p.id=b.property_id
           JOIN app_user u ON u.id=b.tenant_id
          WHERE b.landlord_id=$1
            AND b.status IN ('CONFIRMED','CHECKED_IN','COMPLETION_PENDING')
          ORDER BY lower(b.stay_period)
          LIMIT 10`,
        [userId],
      ),
      this.db.query<Record<string, any>>(
        `SELECT
           (SELECT count(*)::int FROM booking WHERE landlord_id=$1 AND status='REQUESTED') AS pending_requests,
           (SELECT count(*)::int FROM booking
             WHERE landlord_id=$1 AND status='CONFIRMED'
               AND lower(stay_period) BETWEEN CURRENT_DATE AND CURRENT_DATE + 7) AS upcoming_check_ins,
           (SELECT count(*)::int FROM booking
             WHERE landlord_id=$1 AND status IN ('CHECKED_IN','COMPLETION_PENDING')) AS active_stays,
           (SELECT count(*)::int FROM booking
             WHERE landlord_id=$1 AND status='COMPLETION_PENDING'
               AND landlord_completion_answer IS NULL) AS awaiting_completion,
           (SELECT count(*)::int FROM message m
              JOIN conversation c ON c.id=m.conversation_id
             WHERE c.landlord_id=$1 AND m.sender_id IS DISTINCT FROM $1
               AND m.read_at IS NULL AND m.deleted_at IS NULL) AS unread_messages,
           (SELECT count(*)::int FROM booking b
             WHERE b.landlord_id=$1 AND b.status='COMPLETED'
               AND b.review_deadline_at > now()
               AND NOT EXISTS (SELECT 1 FROM review r
                                WHERE r.booking_id=b.id AND r.author_role='LANDLORD')) AS reviews_pending,
           (SELECT count(*)::int FROM service_fee
             WHERE landlord_id=$1 AND status='PAYABLE' AND due_at < now()) AS overdue_fees`,
        [userId],
      ),
      this.db.query<{ balance: string }>(
        `SELECT COALESCE(SUM(amount_minor),0)::text AS balance FROM ledger_entry WHERE landlord_id=$1`,
        [userId],
      ),
    ]);

    const u = user.rows[0] ?? {};
    const c = counts.rows[0] ?? {};
    const balanceMinor = BigInt(balance.rows[0]?.balance ?? '0');

    const mapped: DashboardListing[] = listings.rows.map((r) => ({
      id: r.id,
      title: r.title,
      city: r.city,
      district: r.district,
      status: r.status,
      rejectionReason: r.rejection_reason,
      basePriceMinor: r.base_price_minor,
      priceUnit: r.price_unit,
      coverPhoto: r.cover_photo,
      photoCount: Number(r.photo_count),
      rating: r.rating === null ? null : Number(r.rating),
      reviewCount: Number(r.review_count),
      pendingRequests: Number(r.pending_requests),
      upcomingBookings: Number(r.upcoming_bookings),
      calendarUpdatedAt: r.calendar_updated_at,
      calendarStale:
        (Date.now() - Date.parse(r.calendar_updated_at)) / 86_400_000 > STALE_CALENDAR_DAYS &&
        r.status === 'PUBLISHED',
    }));

    return {
      displayName: u.display_name ?? '',
      verificationLevel: Number(u.verification_level ?? 0),
      stats: {
        publishedListings: mapped.filter((l) => l.status === 'PUBLISHED').length,
        draftListings: mapped.filter((l) => l.status === 'DRAFT' || l.status === 'REJECTED').length,
        pendingRequests: Number(c.pending_requests ?? 0),
        upcomingCheckIns: Number(c.upcoming_check_ins ?? 0),
        activeStays: Number(c.active_stays ?? 0),
        rating: u.rating === null || u.rating === undefined ? null : Number(u.rating),
        reviewCount: Number(u.review_count ?? 0),
        completedRentals: Number(u.completed_rentals_as_landlord ?? 0),
        unreadMessages: Number(c.unread_messages ?? 0),
        balanceMinor: balanceMinor.toString(),
      },
      attention: buildAttention(c, mapped, balanceMinor),
      listings: mapped,
      upcoming: upcoming.rows.map((r) => ({
        bookingId: r.id,
        reference: r.reference,
        status: r.status,
        propertyTitle: r.property_title,
        tenantName: r.tenant_name,
        from: r.stay_from,
        to: r.stay_to,
        nights: Number(r.nights),
        totalExpectedMinor: r.total_expected_minor,
      })),
    };
  }
}

/**
 * "Требует внимания" — ordered by how much it costs the landlord to ignore.
 *
 * A pending request expires and loses them a booking; an unanswered completion
 * is money; a stale calendar quietly sinks their search ranking. Unread
 * messages come last because they are the least irreversible.
 */
function buildAttention(
  c: Record<string, any>,
  listings: readonly DashboardListing[],
  balanceMinor: bigint,
): AttentionItem[] {
  const items: AttentionItem[] = [];

  const pending = Number(c.pending_requests ?? 0);
  if (pending > 0) {
    items.push({
      kind: 'BOOKING_REQUEST',
      title: pending === 1 ? 'Новая заявка на бронирование' : `Новых заявок: ${pending}`,
      detail: 'Заявка ждёт ответа. Если не ответить, она истечёт через 48 часов.',
      href: '/dashboard/bookings?status=REQUESTED',
      severity: 'URGENT',
      count: pending,
    });
  }

  const awaitingCompletion = Number(c.awaiting_completion ?? 0);
  if (awaitingCompletion > 0) {
    items.push({
      kind: 'CONFIRM_COMPLETION',
      title: 'Подтвердите, состоялась ли аренда',
      detail: 'Без подтверждения обеих сторон аренда не закроется и отзывы не откроются.',
      // The tab keys on /dashboard/bookings are COMPLETION and HISTORY. These
      // used to send the landlord to ?status=COMPLETION_PENDING and
      // ?status=COMPLETED, which match no tab, so the page silently fell back
      // to «Новые заявки» — the one screen the notice was not about.
      href: '/dashboard/bookings?status=COMPLETION',
      severity: 'ACTION',
      count: awaitingCompletion,
    });
  }

  if (balanceMinor < 0n) {
    const overdue = Number(c.overdue_fees ?? 0);
    items.push({
      kind: 'OUTSTANDING_DEBT',
      title: 'Задолженность по сервисному сбору',
      detail: overdue > 0
        ? 'Срок оплаты прошёл. Новые объявления и подтверждение новых бронирований временно недоступны.'
        : 'Сбор начислен после завершённой аренды. Активные бронирования не затронуты.',
      href: '/dashboard/finance',
      severity: overdue > 0 ? 'URGENT' : 'INFO',
    });
  }

  const rejected = listings.filter((l) => l.status === 'REJECTED');
  for (const listing of rejected.slice(0, 3)) {
    items.push({
      kind: 'LISTING_REJECTED',
      title: `Объявление отклонено: ${listing.title}`,
      detail: listing.rejectionReason ?? 'Исправьте замечания и отправьте повторно.',
      href: `/dashboard/listings/${listing.id}`,
      severity: 'ACTION',
    });
  }

  const drafts = listings.filter((l) => l.status === 'DRAFT');
  if (drafts.length > 0) {
    items.push({
      kind: 'LISTING_DRAFT',
      title: drafts.length === 1 ? 'Незаконченное объявление' : `Черновиков: ${drafts.length}`,
      detail: 'Черновик не виден арендаторам. Закончите заполнение и отправьте на проверку.',
      href: `/dashboard/listings/${drafts[0]!.id}/edit`,
      severity: 'INFO',
      count: drafts.length,
    });
  }

  const reviewsPending = Number(c.reviews_pending ?? 0);
  if (reviewsPending > 0) {
    items.push({
      kind: 'REVIEW_PENDING',
      title: 'Можно оставить отзыв об арендаторе',
      detail: 'Отзывы обеих сторон публикуются одновременно.',
      href: '/dashboard/bookings?status=HISTORY',
      severity: 'INFO',
      count: reviewsPending,
    });
  }

  const stale = listings.filter((l) => l.calendarStale);
  if (stale.length > 0) {
    items.push({
      kind: 'STALE_CALENDAR',
      title: 'Календарь давно не обновлялся',
      detail: 'Свежие календари показываются в поиске выше. Подтвердите актуальность дат.',
      href: `/dashboard/listings/${stale[0]!.id}/calendar`,
      severity: 'INFO',
      count: stale.length,
    });
  }

  const unread = Number(c.unread_messages ?? 0);
  if (unread > 0) {
    items.push({
      kind: 'UNREAD_MESSAGES',
      title: unread === 1 ? 'Новое сообщение' : `Непрочитанных сообщений: ${unread}`,
      detail: 'Быстрые ответы повышают доверие и рейтинг ответов.',
      href: '/dashboard/chat',
      severity: 'INFO',
      count: unread,
    });
  }

  const order = { URGENT: 0, ACTION: 1, INFO: 2 } as const;
  return items.sort((a, b) => order[a.severity] - order[b.severity]);
}
