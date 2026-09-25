import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { CornflowerMark } from '@/ui/brand.tsx';
import { Icon } from '@/ui/icons.tsx';
import type { IconName } from '@/ui/icons.tsx';
import { Money, cx, formatNightsLocalized } from '@/ui/primitives.tsx';
import { ListingStatusActions } from '@/ui/listing-status-actions.tsx';
import { LEVEL_LABEL } from '@/server/domain/verification.ts';
import type { AppLocale } from '@/i18n/routing.ts';
import type {
  AttentionItem,
  AttentionKind,
  DashboardListing,
  UpcomingStay,
} from '@/server/services/dashboard-service.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Dashboard');
  return {
    title: t('meta.title'),
    // Private surface: never indexed, never in a sitemap.
    robots: { index: false, follow: false },
  };
}

/** A plain call signature is enough for every `t()` call this page makes —
 * the real translator carries more (`.rich`, `.raw`…), and a variable with
 * extra members is assignable wherever only the call signature is used. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

const LISTING_STATUS_TONE: Record<string, string> = {
  DRAFT: 'solid-neutral',
  PENDING_MODERATION: 'warning',
  PUBLISHED: 'verified',
  PAUSED: 'solid-neutral',
  REJECTED: 'danger',
  ARCHIVED: 'solid-neutral',
};

const ATTENTION_ICON: Record<AttentionKind, IconName> = {
  BOOKING_REQUEST: 'calendar',
  AWAITING_CHECK_IN: 'key',
  CONFIRM_COMPLETION: 'checkCircle',
  LISTING_REJECTED: 'alert',
  LISTING_DRAFT: 'edit',
  UNREAD_MESSAGES: 'message',
  OUTSTANDING_DEBT: 'alert',
  STALE_CALENDAR: 'clock',
  REVIEW_PENDING: 'star',
};

function greeting(t: Translate, name: string): string {
  const hour = new Date().getUTCHours() + 3; // Belarus is UTC+3, no DST
  const normalised = ((hour % 24) + 24) % 24;
  const key =
    normalised < 5 ? 'greetingNight' : normalised < 12 ? 'greetingMorning' : normalised < 18 ? 'greetingDay' : 'greetingEvening';
  const firstName = name.trim().split(/\s+/)[0] ?? name;
  return t(key, { name: firstName });
}

function accountSentence(t: Translate, listingCount: number, published: number, pending: number): string {
  if (listingCount === 0) return t('accountEmpty');
  const head = published === 0 ? t('accountNonePublished') : t('accountPublished', { count: published });
  return pending > 0 ? `${head}, ${t('requestsPhrase', { count: pending })}.` : `${head}.`;
}

function dayOf(iso: string): string {
  return String(Number(iso.split('-')[2] ?? '1'));
}

function monthOf(iso: string, months: readonly string[]): string {
  return months[Number(iso.split('-')[1] ?? '1') - 1] ?? '';
}

export default async function DashboardPage() {
  const user = await currentUser();
  const locale = (await getLocale()) as AppLocale;
  if (!user) redirect({ href: signInUrl('/dashboard'), locale });

  const t = await getTranslations('Dashboard');
  const monthsShort = t.raw('monthsShort') as string[];

  const services = await readyServices();
  // `redirect` above never returns, but next-intl's generic typing for it
  // doesn't narrow `user` for the type checker the way `next/navigation`'s
  // does.
  const summary = await services.dashboard.landlordSummary(user!.userId);
  const { stats } = summary;

  const hasListings = summary.listings.length > 0;
  const inDebt = BigInt(stats.balanceMinor) < 0n;
  const hasEarned = BigInt(stats.totalEarnedMinor) > 0n;

  return (
    <div className="container dash">
      <header className="dash-head">
        <p className="dash-head__eyebrow">{t('eyebrow')}</p>
        <h1 className="display">{greeting(t, summary.displayName || user!.displayName)}</h1>
        <p className="dash-head__line">
          {accountSentence(t, summary.listings.length, stats.publishedListings, stats.pendingRequests)}
        </p>
      </header>

      {/* Balance and earnings, right under the greeting — always visible
          without scrolling past the listings below, which is the actual
          primary content of this page. Two different figures on purpose:
          the balance is what the platform's service fee ledger says (can be
          a debt); earned is what tenants have actually paid the landlord
          for completed stays (never a debt, never styled as one). */}
      <section className="dash-section dash-summary" aria-label={t('summaryAriaLabel')}>
        <div className={cx('card dash-summary__card', inDebt && 'is-debt')}>
          <span className="dash-summary__icon" aria-hidden="true">
            <Icon name="wallet" size={20} />
          </span>
          <div className="stack grow" style={{ gap: '0.2rem', minWidth: 0 }}>
            <h2 className="dash-summary__label">{t('balanceHeading')}</h2>
            <strong className={cx('dash-summary__value', inDebt && 'is-debt')}>
              <Money minor={stats.balanceMinor} />
            </strong>
            <p className="hint dash-summary__hint">{inDebt ? t('balanceDebtHint') : t('balanceOkHint')}</p>
          </div>
          <Link href="/dashboard/finance" className="btn btn-secondary btn-sm dash-summary__cta">
            {t('balanceMore')}
          </Link>
        </div>

        <div className="card dash-summary__card">
          <span className="dash-summary__icon dash-summary__icon--positive" aria-hidden="true">
            <Icon name="checkCircle" size={20} />
          </span>
          <div className="stack grow" style={{ gap: '0.2rem', minWidth: 0 }}>
            <h2 className="dash-summary__label">{t('earnedHeading')}</h2>
            <strong className="dash-summary__value dash-summary__value--positive">
              <Money minor={stats.totalEarnedMinor} />
            </strong>
            <p className="hint dash-summary__hint">
              {hasEarned ? t('earnedSub', { count: stats.completedRentals }) : t('earnedHint')}
            </p>
          </div>
        </div>
      </section>

      {summary.attention.length > 0 ? (
        <section className="dash-section" aria-labelledby="attention-heading">
          <div className="dash-section__head">
            <h2 id="attention-heading" className="title-md">
              {t('attentionHeading')}
            </h2>
          </div>
          <ul className="card dash-att">
            {summary.attention.map((item) => (
              <AttentionRow key={`${item.kind}-${item.href}`} item={item} />
            ))}
          </ul>
        </section>
      ) : hasListings ? (
        <p className="dash-section dash-calm">
          <Icon name="checkCircle" size={18} style={{ color: 'var(--success)' }} />
          {t('calmMessage')}
        </p>
      ) : null}

      <section id="listings" className="dash-section" aria-labelledby="listings-heading">
        <div className="dash-section__head">
          <h2 id="listings-heading" className="title-md">
            {t('listingsHeading')}
          </h2>
          {hasListings && (
            <Link href="/dashboard/listings/new" className="btn btn-primary">
              <Icon name="plus" size={18} />
              {t('addListing')}
              <span className="dash-add__tail"> {t('addListingTail')}</span>
            </Link>
          )}
        </div>

        {hasListings ? (
          <ul className="dash-grid">
            {summary.listings.map((listing) => (
              <PropertyCard key={listing.id} listing={listing} t={t} />
            ))}
          </ul>
        ) : (
          <div className="card dash-empty">
            <span className="dash-empty__mark" aria-hidden="true">
              <CornflowerMark size={64} />
            </span>
            <h3 className="title-md">{t('emptyTitle')}</h3>
            <p className="dash-empty__text">{t('emptyText')}</p>
            <Link href="/dashboard/listings/new" className="btn btn-primary">
              {t('emptyCta')}
            </Link>
          </div>
        )}
      </section>

      {summary.upcoming.length > 0 && (
        <section className="dash-section" aria-labelledby="upcoming-heading">
          <div className="dash-section__head">
            <h2 id="upcoming-heading" className="title-md">
              {t('upcomingHeading')}
            </h2>
            <Link href="/dashboard/bookings" className="link">
              {t('allBookings')}
              <Icon name="chevronRight" size={16} />
            </Link>
          </div>
          <ul className="dash-stay">
            {summary.upcoming.map((stay) => (
              <UpcomingRow key={stay.bookingId} stay={stay} t={t} locale={locale} monthsShort={monthsShort} />
            ))}
          </ul>
        </section>
      )}

      <section className="dash-section dash-figures" aria-label={t('figuresAriaLabel')}>
        {/* Every href here must resolve. `/dashboard/listings` and
            `/dashboard/reviews` did not exist: the listings live in the section
            above on this same page, and a landlord's reviews live on their
            public profile, which is also what a tenant sees. */}
        <Figure label={t('figActiveListings')} value={String(stats.publishedListings)} href="#listings" />
        <Figure
          label={t('figNewRequests')}
          value={String(stats.pendingRequests)}
          href="/dashboard/bookings?status=REQUESTED"
          emphasis={stats.pendingRequests > 0}
        />
        <Figure label={t('figUpcomingCheckins')} value={String(stats.upcomingCheckIns)} href="/dashboard/bookings" />
        {/* The verification level, and the way in to raise it. Without this the
            applicant side of verification would exist and be unreachable. */}
        <Figure
          label={t('figProfile')}
          value={LEVEL_LABEL[Math.min(summary.verificationLevel, 2) as 0 | 1 | 2]}
          sub={summary.verificationLevel >= 2 ? t('figProfileSubDone') : t('figProfileSubPending')}
          href="/dashboard/verification"
          emphasis={summary.verificationLevel === 0}
        />
        <Figure
          label={t('figRating')}
          value={stats.rating === null ? '—' : stats.rating.toFixed(1)}
          sub={stats.reviewCount > 0 ? t('figRatingSub', { count: stats.reviewCount }) : t('figRatingSubNone')}
          href={`/profiles/${user!.userId}`}
        />
      </section>

      {/* The account screen was reachable only by typing its address: nothing
          in the product linked to it, so the one place a person can see what
          happens to their data and close their account was, in practice,
          invisible. */}
      <nav className="dash-settings" aria-label={t('settingsAriaLabel')}>
        <Link href="/notifications" className="link">
          {t('notificationsLink')}
        </Link>
        <Link href="/dashboard/account" className="link">
          {t('accountLink')}
        </Link>
      </nav>

      <style>{`
        .dash-settings {
          display: flex;
          flex-wrap: wrap;
          gap: var(--space-4);
          margin-top: var(--space-5);
          padding-top: var(--space-4);
          border-top: 1px solid var(--border);
          font-size: var(--text-sm);
        }
        .dash { padding-block: var(--space-5) var(--space-8); }
        @media (min-width: 768px) { .dash { padding-block: var(--space-6) var(--space-8); } }

        .dash-head { display: flex; flex-direction: column; gap: 0.4rem; }
        .dash-head__eyebrow { font-size: var(--text-xs); font-weight: 500; color: var(--text-tertiary); }
        .dash-head__line { color: var(--text-secondary); max-width: 54ch; }

        .dash-section { margin-top: var(--space-6); }
        @media (min-width: 768px) { .dash-section { margin-top: var(--space-7); } }

        /* --- баланс и доход ------------------------------------------- *
         * The one section deliberately placed right under the greeting
         * rather than after the listings: a landlord who owes a fee, or
         * wants to see what a rental brought in, should never have to
         * scroll to find out. Two cards, not one — a debt and an income
         * figure read as opposite things and must never share a tone. */
        .dash-summary {
          display: grid; gap: var(--space-3);
          grid-template-columns: 1fr;
          margin-top: var(--space-5);
        }
        @media (min-width: 640px) { .dash-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        .dash-summary__card {
          display: flex; align-items: flex-start; gap: var(--space-3);
          flex-wrap: wrap;
        }
        .dash-summary__icon {
          display: inline-flex; align-items: center; justify-content: center;
          flex: 0 0 auto; width: 2.5rem; height: 2.5rem;
          border-radius: var(--radius-full);
          background: var(--surface-sunken); color: var(--text-secondary);
        }
        .dash-summary__card.is-debt .dash-summary__icon { background: var(--error-soft); color: var(--error); }
        .dash-summary__icon--positive { background: var(--success-soft); color: var(--success); }
        .dash-summary__label {
          font-size: var(--text-sm); font-weight: 500;
          letter-spacing: 0; color: var(--text-secondary);
        }
        .dash-summary__value { font-size: var(--text-2xl); font-weight: 650; letter-spacing: -0.025em; }
        .dash-summary__value.is-debt { color: var(--error); }
        .dash-summary__value--positive { color: var(--success); }
        .dash-summary__hint { max-width: 40ch; }
        .dash-summary__cta { flex: 0 0 auto; margin-left: auto; }
        @media (max-width: 400px) { .dash-summary__cta { margin-left: 0; width: 100%; justify-content: center; } }
        .dash-section__head {
          display: flex; align-items: center; justify-content: space-between;
          gap: var(--space-3); flex-wrap: wrap;
          margin-bottom: var(--space-4);
        }
        @media (max-width: 400px) { .dash-add__tail { display: none; } }

        .dash-calm {
          display: flex; align-items: center; gap: 0.5rem;
          font-size: var(--text-sm); color: var(--text-secondary);
        }

        /* --- требует внимания ---------------------------------------- *
         * One white surface holding hairline-separated rows, rather than
         * a stack of separate cards: the block reads as a single list of
         * decisions instead of six competing boxes. Severity is a 3px
         * rule and a tinted glyph — never a wash behind the text. */
        .dash-att { list-style: none; margin: 0; padding: 0; overflow: hidden; }
        .dash-att__item + .dash-att__item { border-top: 1px solid var(--border); }
        .dash-att__row {
          display: flex; align-items: flex-start; gap: var(--space-3);
          padding: var(--space-4);
          border-left: 3px solid var(--border-strong);
          transition: background-color 140ms ease;
        }
        @media (hover: hover) and (pointer: fine) {
          .dash-att__row:hover { background: var(--surface-sunken); }
        }
        /* The card clips its corners, so the ring is drawn inside it. */
        .dash-att__row:focus-visible { outline-offset: -3px; }
        .dash-att__row--urgent .dash-att__icon { color: var(--error); }
        .dash-att__row--action .dash-att__icon { color: var(--warning); }
        .dash-att__row--info .dash-att__icon { color: var(--primary); }
        .dash-att__icon { margin-top: 0.1rem; }
        .dash-att__title { font-size: var(--text-base); font-weight: 600; line-height: 1.35; }
        .dash-att__detail { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; }
        .dash-att__chev { color: var(--text-tertiary); align-self: center; }

        /* --- ваши квартиры ------------------------------------------- */
        .dash-grid {
          display: grid; gap: var(--space-4);
          grid-template-columns: 1fr;
          list-style: none; margin: 0; padding: 0;
        }
        @media (min-width: 640px) { .dash-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @media (min-width: 1080px) { .dash-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }

        .dash-pc { display: flex; flex-direction: column; overflow: hidden; }
        /* Housing is judged visually even by the person who owns it: the
           photograph is how a landlord finds the right row. */
        .dash-pc__media { position: relative; display: block; aspect-ratio: 3 / 2; background: var(--surface-sunken); }
        .dash-pc__media img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .dash-pc__nophoto {
          position: absolute; inset: 0;
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.3rem;
          color: var(--text-tertiary); font-size: var(--text-xs);
        }
        .dash-pc__body { display: flex; flex-direction: column; gap: 0.35rem; padding: var(--space-4); flex: 1 1 auto; }
        .dash-pc__top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
        .dash-pc__rating {
          display: inline-flex; align-items: center; gap: 0.2rem;
          font-size: var(--text-sm); font-weight: 600; flex: 0 0 auto;
        }
        .dash-pc__title { font-size: var(--text-base); font-weight: 600; line-height: 1.35; }
        @media (hover: hover) and (pointer: fine) {
          .dash-pc__title a:hover { color: var(--primary); }
        }
        .dash-pc__place { font-size: var(--text-sm); color: var(--text-secondary); }
        .dash-pc__price { font-size: var(--text-sm); }
        .dash-pc__price strong { font-weight: 600; }
        .dash-pc__unit { color: var(--text-secondary); }
        .dash-pc__notes { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.3rem; }
        .dash-pc__note {
          display: flex; align-items: flex-start; gap: 0.4rem;
          font-size: var(--text-xs); font-weight: 500; line-height: 1.45;
        }
        .dash-pc__note svg { margin-top: 0.05rem; }
        .dash-pc__note--primary { color: var(--primary); }
        .dash-pc__note--warning { color: var(--warning); }
        .dash-pc__note--error { color: var(--error); }
        .dash-pc__actions {
          display: flex; gap: var(--space-2); flex-wrap: wrap;
          margin-top: auto; padding-top: var(--space-4);
        }

        .dash-empty {
          display: flex; flex-direction: column; align-items: center; text-align: center;
          gap: var(--space-3); padding: var(--space-7) var(--space-4);
        }
        .dash-empty__mark { color: var(--accent); opacity: 0.7; }
        .dash-empty__text { color: var(--text-secondary); font-size: var(--text-sm); max-width: 46ch; }
        .dash-empty .btn { margin-top: var(--space-2); }

        /* --- ближайшие заезды ---------------------------------------- *
         * Rows on the page ground, not another card: two stacked white
         * boxes in a row would turn the page back into an admin panel. */
        .dash-stay { list-style: none; margin: 0; padding: 0; }
        .dash-stay__item + .dash-stay__item { border-top: 1px solid var(--border); }
        .dash-stay__row {
          display: flex; align-items: center; gap: var(--space-3);
          min-height: 3.5rem;
          padding: var(--space-3) var(--space-2);
          border-radius: var(--radius-sm);
          transition: background-color 140ms ease;
        }
        @media (hover: hover) and (pointer: fine) {
          .dash-stay__row:hover { background: var(--surface); }
        }
        .dash-stay__date {
          flex: 0 0 auto; width: 2.5rem;
          display: flex; flex-direction: column; align-items: center; line-height: 1.05;
        }
        .dash-stay__day { font-size: var(--text-xl); font-weight: 600; letter-spacing: -0.02em; }
        .dash-stay__month { font-size: var(--text-2xs); color: var(--text-tertiary); }
        .dash-stay__title { font-size: var(--text-sm); font-weight: 600; }
        .dash-stay__meta { font-size: var(--text-xs); color: var(--text-secondary); }
        .dash-stay__sum { font-size: var(--text-sm); font-weight: 600; white-space: nowrap; flex: 0 0 auto; }

        /* --- показатели ----------------------------------------------- *
         * Deliberately below the work. Four figures a landlord glances at
         * once a week must not outrank the six they act on daily. */
        .dash-figures {
          display: grid; gap: var(--space-4);
          grid-template-columns: repeat(2, minmax(0, 1fr));
          border-top: 1px solid var(--border);
          padding-top: var(--space-5);
        }
        @media (min-width: 640px) { .dash-figures { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
        .dash-fig { display: flex; flex-direction: column; gap: 0.1rem; padding-block: 0.2rem; }
        .dash-fig__label { font-size: var(--text-xs); color: var(--text-secondary); }
        .dash-fig__value { font-size: var(--text-xl); font-weight: 600; letter-spacing: -0.02em; line-height: 1.25; }
        .dash-fig__value.is-emphasis { color: var(--primary); }
        @media (hover: hover) and (pointer: fine) {
          .dash-fig:hover .dash-fig__value { color: var(--primary); }
        }
        .dash-fig__sub { font-size: var(--text-2xs); color: var(--text-tertiary); }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AttentionRow({ item }: { item: AttentionItem }) {
  const tone = item.severity === 'URGENT' ? 'urgent' : item.severity === 'ACTION' ? 'action' : 'info';

  return (
    <li className="dash-att__item">
      <Link href={item.href} className={`dash-att__row dash-att__row--${tone}`}>
        <Icon name={ATTENTION_ICON[item.kind]} size={20} className="dash-att__icon" />
        <span className="stack grow" style={{ gap: '0.2rem' }}>
          <strong className="dash-att__title">{item.title}</strong>
          <span className="dash-att__detail">{item.detail}</span>
        </span>
        <Icon name="chevronRight" size={18} className="dash-att__chev" />
      </Link>
    </li>
  );
}

function PropertyCard({ listing, t }: { listing: DashboardListing; t: Translate }) {
  const tone = LISTING_STATUS_TONE[listing.status] ?? 'solid-neutral';
  const statusLabel = t(`status.${listing.status}`);
  const place = listing.district ? `${listing.city}, ${listing.district}` : listing.city;
  const rating = listing.rating !== null ? listing.rating.toFixed(1) : null;

  return (
    <li className="card dash-pc">
      {/* The title link below carries this destination for keyboard and
          screen-reader users, so the photograph is a mouse shortcut only. */}
      <Link href={`/listing/${listing.id}`} className="dash-pc__media" tabIndex={-1} aria-hidden="true">
        {listing.coverPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/media/${listing.coverPhoto}`} alt="" loading="lazy" decoding="async" width={640} height={427} />
        ) : (
          <span className="dash-pc__nophoto">
            <Icon name="image" size={22} />
            {t('noPhoto')}
          </span>
        )}
      </Link>

      <div className="dash-pc__body">
        <div className="dash-pc__top">
          <span className={`badge badge-${tone}`}>{statusLabel}</span>
          {rating !== null && (
            <span className="dash-pc__rating numeric" aria-label={t('ratingAriaLabel', { value: rating })}>
              <Icon name="star" size={13} solid />
              {rating}
            </span>
          )}
        </div>

        <h3 className="dash-pc__title">
          {/* An unfinished listing has no public page yet, so its title
              leads back into the wizard rather than to a 404. */}
          <Link
            href={listing.status === 'PUBLISHED' ? `/listing/${listing.id}` : `/dashboard/listings/${listing.id}/edit`}
            className="clamp-2"
          >
            {listing.title || t('untitledDraft')}
          </Link>
        </h3>

        <p className="dash-pc__place">{place || t('cityUnspecified')}</p>

        <p className="dash-pc__price">
          {listing.basePriceMinor ? (
            <>
              <strong>
                <Money minor={listing.basePriceMinor} showCurrency={false} />
              </strong>{' '}
              <span className="dash-pc__unit">{listing.priceUnit === 'MONTH' ? t('perMonth') : t('perNight')}</span>
            </>
          ) : (
            <span className="dash-pc__unit">{t('priceUnspecified')}</span>
          )}
        </p>

        {(listing.pendingRequests > 0 ||
          listing.calendarStale ||
          (listing.status === 'REJECTED' && listing.rejectionReason)) && (
          <div className="dash-pc__notes">
            {listing.pendingRequests > 0 && (
              <span className="dash-pc__note dash-pc__note--primary">
                <Icon name="bell" size={15} />
                {t('requestsPhrase', { count: listing.pendingRequests })}
              </span>
            )}
            {listing.calendarStale && (
              <span className="dash-pc__note dash-pc__note--warning">
                <Icon name="clock" size={15} />
                {t('calendarStale')}
              </span>
            )}
            {listing.status === 'REJECTED' && listing.rejectionReason && (
              <span className="dash-pc__note dash-pc__note--error">
                <Icon name="alert" size={15} />
                {listing.rejectionReason}
              </span>
            )}
          </div>
        )}

        <div className="dash-pc__actions">
          <Link href={`/dashboard/listings/${listing.id}/edit`} className="btn btn-secondary">
            {t('edit')}
          </Link>
          {listing.status !== 'ARCHIVED' && (
            <Link href={`/dashboard/listings/${listing.id}/calendar`} className="btn btn-secondary">
              {t('calendarLink')}
            </Link>
          )}
          <ListingStatusActions id={listing.id} status={listing.status} />
        </div>
      </div>
    </li>
  );
}

function UpcomingRow({
  stay,
  t,
  locale,
  monthsShort,
}: {
  stay: UpcomingStay;
  t: Translate;
  locale: AppLocale;
  monthsShort: readonly string[];
}) {
  return (
    <li className="dash-stay__item">
      {/* /bookings/:id — the booking detail page is shared by both sides.
          This pointed at /dashboard/bookings/:id, which has never existed, so
          every upcoming stay on the dashboard led to a 404. */}
      <Link href={`/bookings/${stay.bookingId}`} className="dash-stay__row">
        <span className="dash-stay__date">
          <span className="sr-only">{t('checkInSr')} </span>
          <span className="dash-stay__day numeric">{dayOf(stay.from)}</span>
          <span className="dash-stay__month">{monthOf(stay.from, monthsShort)}</span>
        </span>
        <span className="stack grow" style={{ gap: '0.15rem' }}>
          <strong className="dash-stay__title truncate">{stay.propertyTitle}</strong>
          <span className="dash-stay__meta">
            {stay.tenantName} · {formatNightsLocalized(stay.nights, locale)} · {t('checkoutLabel')} {dayOf(stay.to)}{' '}
            {monthOf(stay.to, monthsShort)}
          </span>
        </span>
        <span className="dash-stay__sum numeric">
          <Money minor={stay.totalExpectedMinor} showCurrency={false} />
        </span>
      </Link>
    </li>
  );
}

function Figure({
  label,
  value,
  sub,
  href,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  href: string;
  emphasis?: boolean;
}) {
  return (
    <Link href={href} className="dash-fig">
      <span className="dash-fig__label">{label}</span>
      <span className={cx('dash-fig__value', 'numeric', emphasis && 'is-emphasis')}>{value}</span>
      {sub && <span className="dash-fig__sub">{sub}</span>}
    </Link>
  );
}
