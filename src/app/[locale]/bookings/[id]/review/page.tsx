import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { redirect } from '@/i18n/navigation.ts';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready, readyServices } from '@/server/runtime.ts';
import { ReviewForm } from '@/ui/review-form.tsx';
import { Icon } from '@/ui/icons.tsx';
import { formatNightsLocalized } from '@/ui/primitives.tsx';
import type { AppLocale } from '@/i18n/routing.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Booking');
  return { title: t('reviewMetaTitle'), robots: { index: false, follow: false } };
}

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

/** Keys mirror the `Booking.refusal*` message keys. */
const REFUSAL_KEY: Record<string, { title: string; detail: string }> = {
  RENTAL_NOT_COMPLETED: {
    title: 'refusalRentalNotCompletedTitle',
    detail: 'refusalRentalNotCompletedDetail',
  },
  ALREADY_REVIEWED: {
    title: 'refusalAlreadyReviewedTitle',
    detail: 'refusalAlreadyReviewedDetail',
  },
  WINDOW_CLOSED: {
    title: 'refusalWindowClosedTitle',
    detail: 'refusalWindowClosedDetail',
  },
};

function dateRange(from: string, to: string, months: readonly string[]): string {
  const f = (iso: string) => {
    const [, m, d] = iso.split('-');
    return `${Number(d)} ${months[Number(m) - 1]}`;
  };
  return `${f(from)} — ${f(to)}`;
}

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations('Booking');
  const locale = (await getLocale()) as AppLocale;
  const months = t.raw('months') as string[];
  const user = await currentUser();
  if (!user) redirect({ href: signInUrl(`/bookings/${id}/review`), locale });

  const services = await readyServices();
  const database = await ready();

  let eligibility: Awaited<ReturnType<typeof services.reviews.eligibility>>;
  try {
    eligibility = await services.reviews.eligibility(id, user!.userId);
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

  const propertyTitle = property.rows[0]?.title ?? t('listingFallback');
  const counterpartyName = person.rows[0]?.display_name ?? t('counterpartyGenericFallback');
  const nights = Number(booking.nights);
  const stayLabel = `${dateRange(booking.stay_from, booking.stay_to, months)} · ${formatNightsLocalized(nights, locale)}`;

  if (!eligibility.canReview) {
    const refusalKey = REFUSAL_KEY[eligibility.reason ?? ''] ?? {
      title: 'refusalUnknownTitle',
      detail: 'refusalUnknownDetail',
    };
    return (
      <div className="container rv">
        <Link href={`/bookings/${id}`} className="rv__back">
          <Icon name="arrowLeft" size={16} />
          {t('backToBooking')}
        </Link>
        <div className="rv__refusal">
          <Icon name="info" size={22} />
          <h1 className="title-md">{t(refusalKey.title)}</h1>
          <p className="text-sm muted">{t(refusalKey.detail)}</p>
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
        {t('backToBooking')}
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
        @media (hover: hover) and (pointer: fine) {
          .rv__back:hover { color: var(--text-primary); }
        }
      `}</style>
    </div>
  );
}
