import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { CornflowerMark } from '@/ui/brand.tsx';
import { Icon } from '@/ui/icons.tsx';
import type { IconName } from '@/ui/icons.tsx';
import { Money, cx, formatNights, plural } from '@/ui/primitives.tsx';
import type {
  AttentionItem,
  AttentionKind,
  DashboardListing,
  UpcomingStay,
} from '@/server/services/dashboard-service.ts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Мои квартиры',
  // Private surface: never indexed, never in a sitemap.
  robots: { index: false, follow: false },
};

const LISTING_STATUS: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: 'Черновик', tone: 'solid-neutral' },
  PENDING_MODERATION: { label: 'На проверке', tone: 'warning' },
  PUBLISHED: { label: 'Опубликовано', tone: 'verified' },
  PAUSED: { label: 'Скрыто', tone: 'solid-neutral' },
  REJECTED: { label: 'Отклонено', tone: 'danger' },
  ARCHIVED: { label: 'В архиве', tone: 'solid-neutral' },
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

const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'] as const;

function greeting(name: string): string {
  const hour = new Date().getUTCHours() + 3; // Belarus is UTC+3, no DST
  const normalised = ((hour % 24) + 24) % 24;
  const part =
    normalised < 5 ? 'Доброй ночи' : normalised < 12 ? 'Доброе утро' : normalised < 18 ? 'Добрый день' : 'Добрый вечер';
  const firstName = name.trim().split(/\s+/)[0] ?? name;
  return `${part}, ${firstName}`;
}

/**
 * The verb has to agree with the count, and «заявок ждёт» is wrong in a way a
 * landlord notices immediately.
 */
function requestsPhrase(n: number): string {
  const singular = n % 10 === 1 && n % 100 !== 11;
  return `${n} ${plural(n, 'заявка', 'заявки', 'заявок')} ${singular ? 'ждёт' : 'ждут'} ответа`;
}

function accountSentence(listingCount: number, published: number, pending: number): string {
  if (listingCount === 0) return 'Разместите первую квартиру — размещение бесплатное.';
  const head =
    published === 0
      ? 'Пока ни одно объявление не опубликовано'
      : `Опубликовано ${published} ${plural(published, 'объявление', 'объявления', 'объявлений')}`;
  return pending > 0 ? `${head}, ${requestsPhrase(pending)}.` : `${head}.`;
}

/** Russian writes 4,8 — not 4.8. */
function decimal(value: number): string {
  return value.toFixed(1).replace('.', ',');
}

function dayOf(iso: string): string {
  return String(Number(iso.split('-')[2] ?? '1'));
}

function monthOf(iso: string): string {
  return MONTH_SHORT[Number(iso.split('-')[1] ?? '1') - 1] ?? '';
}

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/dashboard'));

  const services = await readyServices();
  const summary = await services.dashboard.landlordSummary(user.userId);
  const { stats } = summary;

  const hasListings = summary.listings.length > 0;
  const inDebt = BigInt(stats.balanceMinor) < 0n;

  return (
    <div className="container dash">
      <header className="dash-head">
        <p className="dash-head__eyebrow">Кабинет владельца</p>
        <h1 className="display">{greeting(summary.displayName || user.displayName)}</h1>
        <p className="dash-head__line">
          {accountSentence(summary.listings.length, stats.publishedListings, stats.pendingRequests)}
        </p>
      </header>

      {summary.attention.length > 0 ? (
        <section className="dash-section" aria-labelledby="attention-heading">
          <div className="dash-section__head">
            <h2 id="attention-heading" className="title-md">
              Требует внимания
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
          Сейчас ничего не требует внимания.
        </p>
      ) : null}

      <section id="listings" className="dash-section" aria-labelledby="listings-heading">
        <div className="dash-section__head">
          <h2 id="listings-heading" className="title-md">
            Ваши квартиры
          </h2>
          {hasListings && (
            <Link href="/dashboard/listings/new" className="btn btn-primary">
              <Icon name="plus" size={18} />
              Добавить<span className="dash-add__tail"> объявление</span>
            </Link>
          )}
        </div>

        {hasListings ? (
          <ul className="dash-grid">
            {summary.listings.map((listing) => (
              <PropertyCard key={listing.id} listing={listing} />
            ))}
          </ul>
        ) : (
          <div className="card dash-empty">
            <span className="dash-empty__mark" aria-hidden="true">
              <CornflowerMark size={64} />
            </span>
            <h3 className="title-md">Пока здесь пусто</h3>
            <p className="dash-empty__text">
              Разместите первую квартиру. Объявление бесплатное, а сервисный сбор 5% платится только после
              состоявшейся аренды.
            </p>
            <Link href="/dashboard/listings/new" className="btn btn-primary">
              Разместить квартиру
            </Link>
          </div>
        )}
      </section>

      {summary.upcoming.length > 0 && (
        <section className="dash-section" aria-labelledby="upcoming-heading">
          <div className="dash-section__head">
            <h2 id="upcoming-heading" className="title-md">
              Ближайшие заезды
            </h2>
            <Link href="/dashboard/bookings" className="link">
              Все бронирования
              <Icon name="chevronRight" size={16} />
            </Link>
          </div>
          <ul className="dash-stay">
            {summary.upcoming.map((stay) => (
              <UpcomingRow key={stay.bookingId} stay={stay} />
            ))}
          </ul>
        </section>
      )}

      <section className="dash-section dash-figures" aria-label="Показатели">
        {/* Every href here must resolve. `/dashboard/listings` and
            `/dashboard/reviews` did not exist: the listings live in the section
            above on this same page, and a landlord's reviews live on their
            public profile, which is also what a tenant sees. */}
        <Figure label="Активные объявления" value={String(stats.publishedListings)} href="#listings" />
        <Figure
          label="Новые заявки"
          value={String(stats.pendingRequests)}
          href="/dashboard/bookings?status=REQUESTED"
          emphasis={stats.pendingRequests > 0}
        />
        <Figure label="Ближайшие заезды" value={String(stats.upcomingCheckIns)} href="/dashboard/bookings" />
        <Figure
          label="Рейтинг"
          value={stats.rating === null ? '—' : decimal(stats.rating)}
          sub={
            stats.reviewCount > 0
              ? `${stats.reviewCount} ${plural(stats.reviewCount, 'отзыв', 'отзыва', 'отзывов')}`
              : 'пока нет отзывов'
          }
          href={`/profiles/${user.userId}`}
        />
      </section>

      <section className="dash-section dash-balance" aria-labelledby="balance-heading">
        <div className="stack grow" style={{ gap: '0.2rem' }}>
          <h2 id="balance-heading" className="dash-balance__label">
            Баланс сервисного сбора
          </h2>
          <strong className={cx('dash-balance__value', inDebt && 'is-debt')}>
            <Money minor={stats.balanceMinor} />
          </strong>
          <p className="hint dash-balance__hint">
            {inDebt
              ? 'Это задолженность по сбору за завершённые аренды.'
              : 'Задолженности нет. Сбор 5% начисляется после завершённой аренды.'}
          </p>
        </div>
        <Link href="/dashboard/finance" className="btn btn-secondary">
          Подробнее
        </Link>
      </section>

      <style>{`
        .dash { padding-block: var(--space-5) var(--space-8); }
        @media (min-width: 768px) { .dash { padding-block: var(--space-6) var(--space-8); } }

        .dash-head { display: flex; flex-direction: column; gap: 0.4rem; }
        .dash-head__eyebrow { font-size: var(--text-xs); font-weight: 500; color: var(--text-tertiary); }
        .dash-head__line { color: var(--text-secondary); max-width: 54ch; }

        .dash-section { margin-top: var(--space-6); }
        @media (min-width: 768px) { .dash-section { margin-top: var(--space-7); } }
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
        .dash-att__row:hover { background: var(--surface-sunken); }
        /* The card clips its corners, so the ring is drawn inside it. */
        .dash-att__row:focus-visible { outline-offset: -3px; }
        .dash-att__row--urgent { border-left-color: var(--error); }
        .dash-att__row--action { border-left-color: var(--warning); }
        .dash-att__row--info { border-left-color: var(--primary); }
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
        .dash-pc__title a:hover { color: var(--primary); }
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
        .dash-stay__row:hover { background: var(--surface); }
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
        .dash-fig:hover .dash-fig__value { color: var(--primary); }
        .dash-fig__sub { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .dash-balance {
          display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap;
          border-top: 1px solid var(--border);
          padding-top: var(--space-5);
        }
        .dash-balance__label {
          font-size: var(--text-sm); font-weight: 500;
          letter-spacing: 0; color: var(--text-secondary);
        }
        .dash-balance__value { font-size: var(--text-2xl); font-weight: 650; letter-spacing: -0.025em; }
        .dash-balance__value.is-debt { color: var(--error); }
        .dash-balance__hint { max-width: 48ch; }
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

function PropertyCard({ listing }: { listing: DashboardListing }) {
  const status = LISTING_STATUS[listing.status] ?? { label: listing.status, tone: 'solid-neutral' };
  const place = listing.district ? `${listing.city}, ${listing.district}` : listing.city;

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
            Нет фото
          </span>
        )}
      </Link>

      <div className="dash-pc__body">
        <div className="dash-pc__top">
          <span className={`badge badge-${status.tone}`}>{status.label}</span>
          {listing.rating !== null && (
            <span
              className="dash-pc__rating numeric"
              aria-label={`Рейтинг ${decimal(listing.rating)} из 5`}
            >
              <Icon name="star" size={13} solid />
              {decimal(listing.rating)}
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
            {listing.title || 'Черновик без названия'}
          </Link>
        </h3>

        <p className="dash-pc__place">{place || 'Город не указан'}</p>

        <p className="dash-pc__price">
          {listing.basePriceMinor ? (
            <>
              <strong>
                <Money minor={listing.basePriceMinor} showCurrency={false} />
              </strong>{' '}
              <span className="dash-pc__unit">
                {listing.priceUnit === 'MONTH' ? 'BYN в месяц' : 'BYN за ночь'}
              </span>
            </>
          ) : (
            <span className="dash-pc__unit">Цена не указана</span>
          )}
        </p>

        {(listing.pendingRequests > 0 ||
          listing.calendarStale ||
          (listing.status === 'REJECTED' && listing.rejectionReason)) && (
          <div className="dash-pc__notes">
            {listing.pendingRequests > 0 && (
              <span className="dash-pc__note dash-pc__note--primary">
                <Icon name="bell" size={15} />
                {requestsPhrase(listing.pendingRequests)}
              </span>
            )}
            {listing.calendarStale && (
              <span className="dash-pc__note dash-pc__note--warning">
                <Icon name="clock" size={15} />
                Календарь давно не обновлялся
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
            Редактировать
          </Link>
          <Link href={`/dashboard/listings/${listing.id}/calendar`} className="btn btn-secondary">
            Календарь
          </Link>
        </div>
      </div>
    </li>
  );
}

function UpcomingRow({ stay }: { stay: UpcomingStay }) {
  return (
    <li className="dash-stay__item">
      {/* /bookings/:id — the booking detail page is shared by both sides.
          This pointed at /dashboard/bookings/:id, which has never existed, so
          every upcoming stay on the dashboard led to a 404. */}
      <Link href={`/bookings/${stay.bookingId}`} className="dash-stay__row">
        <span className="dash-stay__date">
          <span className="sr-only">Заезд </span>
          <span className="dash-stay__day numeric">{dayOf(stay.from)}</span>
          <span className="dash-stay__month">{monthOf(stay.from)}</span>
        </span>
        <span className="stack grow" style={{ gap: '0.15rem' }}>
          <strong className="dash-stay__title truncate">{stay.propertyTitle}</strong>
          <span className="dash-stay__meta">
            {stay.tenantName} · {formatNights(stay.nights)} · выезд {dayOf(stay.to)} {monthOf(stay.to)}
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
