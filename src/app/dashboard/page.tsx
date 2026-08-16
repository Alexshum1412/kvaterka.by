import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { CornflowerMark } from '@/ui/brand.tsx';
import { Money, plural, PROPERTY_TYPE_LABEL } from '@/ui/primitives.tsx';
import type { AttentionItem, DashboardListing, UpcomingStay } from '@/server/services/dashboard-service.ts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Мои квартиры',
  // Private surface: never indexed, never in a sitemap.
  robots: { index: false, follow: false },
};

const LISTING_STATUS: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: 'Черновик', tone: 'neutral' },
  PENDING_MODERATION: { label: 'На проверке', tone: 'warning' },
  PUBLISHED: { label: 'Опубликовано', tone: 'verified' },
  PAUSED: { label: 'Скрыто', tone: 'neutral' },
  REJECTED: { label: 'Отклонено', tone: 'danger' },
  ARCHIVED: { label: 'В архиве', tone: 'neutral' },
};

function greeting(name: string): string {
  const hour = new Date().getUTCHours() + 3; // Belarus is UTC+3, no DST
  const normalised = ((hour % 24) + 24) % 24;
  const part =
    normalised < 5 ? 'Доброй ночи' : normalised < 12 ? 'Доброе утро' : normalised < 18 ? 'Добрый день' : 'Добрый вечер';
  const firstName = name.trim().split(/\s+/)[0] ?? name;
  return `${part}, ${firstName}`;
}

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/dashboard'));

  const services = await readyServices();
  const summary = await services.dashboard.landlordSummary(user.userId);
  const { stats } = summary;

  return (
    <div className="container" style={{ paddingBlock: '1.5rem' }}>
      <header className="stack" style={{ gap: '0.35rem', marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 'var(--text-2xl)' }}>{greeting(summary.displayName || user.displayName)}</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
          {stats.publishedListings === 0
            ? 'Разместите первое объявление — это бесплатно.'
            : `Опубликовано ${stats.publishedListings} ${plural(stats.publishedListings, 'объявление', 'объявления', 'объявлений')}.`}
        </p>
      </header>

      {/* --- stats ---------------------------------------------------- */}
      <section aria-label="Показатели" className="stat-grid">
        <Stat label="Активные объявления" value={String(stats.publishedListings)} href="/dashboard/listings" />
        <Stat
          label="Новые заявки"
          value={String(stats.pendingRequests)}
          href="/dashboard/bookings?status=REQUESTED"
          emphasis={stats.pendingRequests > 0}
        />
        <Stat label="Ближайшие заезды" value={String(stats.upcomingCheckIns)} href="/dashboard/bookings" />
        <Stat
          label="Рейтинг"
          value={stats.rating === null ? '—' : stats.rating.toFixed(1)}
          sub={stats.reviewCount > 0 ? `${stats.reviewCount} ${plural(stats.reviewCount, 'отзыв', 'отзыва', 'отзывов')}` : 'пока нет отзывов'}
          href="/dashboard/reviews"
        />
      </section>

      {/* --- attention ------------------------------------------------ */}
      {summary.attention.length > 0 && (
        <section aria-labelledby="attention-heading" style={{ marginTop: '2rem' }}>
          <h2 id="attention-heading" className="section-heading">
            Требует внимания
          </h2>
          <ul className="stack attention-list">
            {summary.attention.map((item) => (
              <AttentionRow key={`${item.kind}-${item.href}`} item={item} />
            ))}
          </ul>
        </section>
      )}

      {/* --- upcoming ------------------------------------------------- */}
      {summary.upcoming.length > 0 && (
        <section aria-labelledby="upcoming-heading" style={{ marginTop: '2rem' }}>
          <h2 id="upcoming-heading" className="section-heading">
            Ближайшие заезды
          </h2>
          <ul className="stack" style={{ gap: '0.5rem', listStyle: 'none', padding: 0, margin: 0 }}>
            {summary.upcoming.map((stay) => (
              <UpcomingRow key={stay.bookingId} stay={stay} />
            ))}
          </ul>
        </section>
      )}

      {/* --- listings ------------------------------------------------- */}
      <section aria-labelledby="listings-heading" style={{ marginTop: '2rem' }}>
        <div className="row" style={{ justifyContent: 'space-between', gap: '1rem', marginBottom: '0.75rem' }}>
          <h2 id="listings-heading" className="section-heading" style={{ margin: 0 }}>
            Ваши квартиры
          </h2>
          <Link href="/dashboard/listings/new" className="btn btn-primary btn-sm">
            Добавить объявление
          </Link>
        </div>

        {summary.listings.length === 0 ? (
          <div className="panel stack empty-state">
            <span style={{ color: 'var(--primary)', opacity: 0.5 }}>
              <CornflowerMark size={44} />
            </span>
            <h3 style={{ fontSize: 'var(--text-lg)' }}>Пока здесь пусто</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', maxWidth: '42ch' }}>
              Разместите первую квартиру. Объявление бесплатное, а сервисный сбор 5% платится только после
              состоявшейся аренды.
            </p>
            <Link href="/dashboard/listings/new" className="btn btn-primary">
              Разместить квартиру
            </Link>
          </div>
        ) : (
          <ul className="listing-grid">
            {summary.listings.map((listing) => (
              <ListingRow key={listing.id} listing={listing} />
            ))}
          </ul>
        )}
      </section>

      {/* --- balance -------------------------------------------------- */}
      <section style={{ marginTop: '2rem' }}>
        <div className="panel row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
          <div className="stack grow" style={{ gap: '0.25rem' }}>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              Баланс сервисного сбора
            </span>
            <strong style={{ fontSize: 'var(--text-xl)', color: BigInt(stats.balanceMinor) < 0n ? 'var(--error)' : 'inherit' }}>
              <Money minor={stats.balanceMinor} />
            </strong>
            <span className="hint">
              {BigInt(stats.balanceMinor) < 0n
                ? 'Это задолженность по сбору за завершённые аренды.'
                : 'Задолженности нет.'}
            </span>
          </div>
          <Link href="/dashboard/finance" className="btn btn-secondary">
            Подробнее
          </Link>
        </div>
      </section>

      <style>{`
        .section-heading { font-size: var(--text-lg); margin-bottom: 0.75rem; }
        .stat-grid {
          display: grid;
          gap: 0.75rem;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        @media (min-width: 720px) { .stat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
        .attention-list { gap: 0.5rem; list-style: none; padding: 0; margin: 0; }
        .listing-grid {
          display: grid; gap: 0.75rem; list-style: none; padding: 0; margin: 0;
          grid-template-columns: 1fr;
        }
        @media (min-width: 860px) { .listing-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        .empty-state { align-items: center; text-align: center; gap: 0.75rem; padding: 3rem 1.5rem; }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Stat({
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
    <Link
      href={href}
      className="card stack"
      style={{
        gap: '0.15rem',
        padding: '0.875rem',
        borderColor: emphasis ? 'var(--primary)' : undefined,
      }}
    >
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{label}</span>
      <strong
        className="numeric"
        style={{ fontSize: 'var(--text-2xl)', color: emphasis ? 'var(--primary)' : undefined }}
      >
        {value}
      </strong>
      {sub && <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-tertiary)' }}>{sub}</span>}
    </Link>
  );
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const tone = item.severity === 'URGENT' ? 'danger' : item.severity === 'ACTION' ? 'warning' : 'info';
  return (
    <li>
      <Link href={item.href} className="card row attention-row">
        {/* A colour bar, not a coloured background: severity must not reduce
            the contrast of the text sitting on it. */}
        <span className={`attention-row__bar attention-row__bar--${tone}`} aria-hidden="true" />
        <span className="stack grow" style={{ gap: '0.15rem', padding: '0.75rem 0' }}>
          <strong style={{ fontSize: 'var(--text-sm)' }}>{item.title}</strong>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{item.detail}</span>
        </span>
        <span aria-hidden="true" style={{ color: 'var(--text-tertiary)', paddingRight: '0.875rem' }}>
          →
        </span>
        <style>{`
          .attention-row { gap: 0.75rem; overflow: hidden; }
          .attention-row:hover { background: var(--surface-sunken); }
          .attention-row__bar { width: 4px; align-self: stretch; flex: 0 0 auto; }
          .attention-row__bar--danger { background: var(--error); }
          .attention-row__bar--warning { background: var(--warning); }
          .attention-row__bar--info { background: var(--primary); }
        `}</style>
      </Link>
    </li>
  );
}

function UpcomingRow({ stay }: { stay: UpcomingStay }) {
  return (
    <li>
      <Link href={`/dashboard/bookings/${stay.bookingId}`} className="card row" style={{ gap: '0.75rem', padding: '0.75rem 0.875rem' }}>
        <span className="stack grow" style={{ gap: '0.15rem' }}>
          <strong className="truncate" style={{ fontSize: 'var(--text-sm)' }}>
            {stay.propertyTitle}
          </strong>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            {stay.tenantName} · {formatRange(stay.from, stay.to)} · {stay.nights}{' '}
            {plural(stay.nights, 'ночь', 'ночи', 'ночей')}
          </span>
        </span>
        <strong className="numeric" style={{ fontSize: 'var(--text-sm)', whiteSpace: 'nowrap' }}>
          <Money minor={stay.totalExpectedMinor} showCurrency={false} />
        </strong>
      </Link>
    </li>
  );
}

function ListingRow({ listing }: { listing: DashboardListing }) {
  const status = LISTING_STATUS[listing.status] ?? { label: listing.status, tone: 'neutral' };

  return (
    <li className="card row dash-listing">
      <span className="dash-listing__media" aria-hidden="true">
        {listing.coverPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/media/${listing.coverPhoto}`} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="dash-listing__nophoto">нет фото</span>
        )}
      </span>

      <span className="stack grow" style={{ gap: '0.3rem', padding: '0.75rem 0' }}>
        <span className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
          <span className={`badge badge-${status.tone}`}>{status.label}</span>
          {listing.pendingRequests > 0 && (
            <span className="badge badge-primary">
              {listing.pendingRequests} {plural(listing.pendingRequests, 'заявка', 'заявки', 'заявок')}
            </span>
          )}
          {listing.calendarStale && <span className="badge badge-warning">календарь устарел</span>}
        </span>

        <Link href={`/listing/${listing.id}`} className="truncate" style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>
          {listing.title}
        </Link>

        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
          {listing.district ? `${listing.city}, ${listing.district}` : listing.city} ·{' '}
          <Money minor={listing.basePriceMinor} showCurrency={false} />{' '}
          {listing.priceUnit === 'MONTH' ? 'BYN/мес' : 'BYN/ночь'}
          {listing.rating !== null && ` · ★ ${listing.rating.toFixed(1)}`}
        </span>

        {listing.status === 'REJECTED' && listing.rejectionReason && (
          <span className="error-text">{listing.rejectionReason}</span>
        )}

        <span className="row" style={{ gap: '0.375rem', flexWrap: 'wrap', marginTop: '0.15rem' }}>
          <Link href={`/dashboard/listings/${listing.id}/edit`} className="btn btn-secondary btn-sm">
            Редактировать
          </Link>
          <Link href={`/dashboard/listings/${listing.id}/calendar`} className="btn btn-secondary btn-sm">
            Календарь
          </Link>
        </span>
      </span>

      <style>{`
        .dash-listing { gap: 0.75rem; align-items: stretch; overflow: hidden; }
        .dash-listing__media {
          flex: 0 0 auto; width: 6.5rem; background: var(--surface-sunken);
          display: grid; place-items: center;
        }
        .dash-listing__media img { width: 100%; height: 100%; object-fit: cover; }
        .dash-listing__nophoto { font-size: var(--text-2xs); color: var(--text-tertiary); }
        @media (max-width: 420px) { .dash-listing__media { width: 4.5rem; } }
      `}</style>
    </li>
  );
}

function formatRange(from: string, to: string): string {
  const fmt = (iso: string) => {
    const [, month, day] = iso.split('-');
    return `${Number(day)}.${month}`;
  };
  return `${fmt(from)} — ${fmt(to)}`;
}
