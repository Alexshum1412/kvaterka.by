import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready, readyServices } from '@/server/runtime.ts';
import { ReviewForm } from '@/ui/review-form.tsx';
import { Icon } from '@/ui/icons.tsx';
import { formatNights } from '@/ui/primitives.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Отзыв об аренде',
  robots: { index: false, follow: false },
};

/**
 * Writing the review.
 *
 * Eligibility is decided by `ReviewService.eligibility`, which is the same
 * authority the POST endpoint uses — this page cannot show a form for a review
 * the API would refuse, and cannot hide one it would accept.
 *
 * A stranger gets 404, not 403, exactly as on the booking page: whether a
 * booking exists is itself information.
 */

const REFUSAL: Record<string, { title: string; detail: string }> = {
  RENTAL_NOT_COMPLETED: {
    title: 'Отзыв пока недоступен',
    detail:
      'Оставить отзыв можно только после завершённой аренды — когда обе стороны подтвердят, что проживание состоялось.',
  },
  ALREADY_REVIEWED: {
    title: 'Отзыв уже оставлен',
    detail:
      'По одной аренде каждая сторона оставляет один отзыв. Он появится, когда отзывы обеих сторон будут опубликованы.',
  },
  WINDOW_CLOSED: {
    title: 'Срок для отзыва истёк',
    detail: 'Отзыв можно оставить в течение двух недель после завершения аренды.',
  },
};

function dateRange(from: string, to: string): string {
  const MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  const f = (iso: string) => {
    const [, m, d] = iso.split('-');
    return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
  };
  return `${f(from)} — ${f(to)}`;
}

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(signInUrl(`/bookings/${id}/review`));

  const services = await readyServices();
  const database = await ready();

  let eligibility: Awaited<ReturnType<typeof services.reviews.eligibility>>;
  try {
    eligibility = await services.reviews.eligibility(id, user.userId);
  } catch {
    notFound();
  }
  if (eligibility.role === null) notFound();

  const booking = await services.bookings.get(id);
  const counterpartyId = eligibility.role === 'TENANT' ? booking.landlord_id : booking.tenant_id;

  const [property, person, amenities] = await Promise.all([
    database.query<{ title: string }>(`SELECT title FROM property WHERE id=$1`, [booking.property_id]),
    database.query<{ display_name: string }>(`SELECT display_name FROM app_user WHERE id=$1`, [counterpartyId]),
    // Only what this listing actually claims. Asking a guest to confirm a
    // feature the landlord never advertised would produce noise, not evidence.
    database.query<{ code: string; name_ru: string }>(
      `SELECT a.code, a.name_ru FROM property_amenity pa
         JOIN amenity a ON a.code = pa.amenity_code
        WHERE pa.property_id = $1
        ORDER BY a.sort_order
        LIMIT 10`,
      [booking.property_id],
    ),
  ]);

  const propertyTitle = property.rows[0]?.title ?? 'Объявление';
  const counterpartyName = person.rows[0]?.display_name ?? 'Партнёр по аренде';
  const nights = Number(booking.nights);
  const stayLabel = `${dateRange(booking.stay_from, booking.stay_to)} · ${formatNights(nights)}`;

  if (!eligibility.canReview) {
    const refusal = REFUSAL[eligibility.reason ?? ''] ?? {
      title: 'Отзыв недоступен',
      detail: 'Проверьте статус аренды в бронировании.',
    };
    return (
      <div className="container rv">
        <Link href={`/bookings/${id}`} className="rv__back">
          <Icon name="arrowLeft" size={16} />
          К бронированию
        </Link>
        <div className="rv__refusal">
          <Icon name="info" size={22} />
          <h1 className="title-md">{refusal.title}</h1>
          <p className="text-sm muted">{refusal.detail}</p>
        </div>
        <style>{`
          .rv { padding-block: var(--space-4) var(--space-8); max-width: 44rem; }
          .rv__back { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; font-size: var(--text-sm); color: var(--text-secondary); }
          .rv__refusal { display: grid; justify-items: center; gap: 0.4rem; padding: var(--space-8) var(--space-4); text-align: center; }
          .rv__refusal > svg { color: var(--primary); margin-bottom: var(--space-2); }
          .rv__refusal p { max-width: 46ch; }
        `}</style>
      </div>
    );
  }

  return (
    <div className="container rv">
      <Link href={`/bookings/${id}`} className="rv__back">
        <Icon name="arrowLeft" size={16} />
        К бронированию
      </Link>
      <ReviewForm
        bookingId={id}
        role={eligibility.role}
        propertyTitle={propertyTitle}
        counterpartyName={counterpartyName}
        stayLabel={stayLabel}
        facts={amenities.rows.map((a) => ({ code: a.code, label: a.name_ru }))}
      />
      <style>{`
        .rv { padding-block: var(--space-4) var(--space-8); max-width: 44rem; }
        .rv__back { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; margin-bottom: var(--space-3); font-size: var(--text-sm); color: var(--text-secondary); }
        .rv__back:hover { color: var(--text-primary); }
      `}</style>
    </div>
  );
}
