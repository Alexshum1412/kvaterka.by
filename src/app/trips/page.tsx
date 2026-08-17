import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready, readyServices } from '@/server/runtime.ts';
import { BookingList, type BookingListRow } from '@/ui/booking-list.tsx';
import { Icon } from '@/ui/icons.tsx';
import { plural } from '@/ui/primitives.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Мои поездки',
  robots: { index: false, follow: false },
};

/**
 * The tenant's side of the product.
 *
 * Ordered by what needs attention rather than by date: a request waiting
 * on a landlord and a stay that ended and needs confirming are the two
 * things a tenant actually has to act on, so they come first and the
 * history comes last.
 *
 * The grouping is by FSM state, not by an invented status field — the
 * booking states are the source of truth (src/server/domain/booking/states.ts).
 */

const GROUPS = [
  {
    key: 'action',
    title: 'Требует внимания',
    hint: 'Проживание закончилось — подтвердите, что аренда состоялась.',
    statuses: ['COMPLETION_PENDING', 'DISPUTED'],
  },
  {
    key: 'waiting',
    title: 'Ждут ответа хозяина',
    hint: 'Даты пока не закреплены: их может занять запрос, подтверждённый раньше.',
    statuses: ['REQUESTED', 'OFFER_PENDING', 'INQUIRY'],
  },
  {
    key: 'upcoming',
    title: 'Предстоящие',
    hint: null,
    statuses: ['CONFIRMED'],
  },
  {
    key: 'active',
    title: 'Сейчас проживаю',
    hint: null,
    statuses: ['CHECKED_IN'],
  },
  {
    key: 'history',
    title: 'История',
    hint: null,
    statuses: [
      'COMPLETED',
      'NOT_TAKEN_PLACE',
      'DECLINED',
      'WITHDRAWN',
      'EXPIRED',
      'CANCELLED_BY_TENANT',
      'CANCELLED_BY_LANDLORD',
    ],
  },
] as const;

export default async function TripsPage() {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/trips'));

  const database = await ready();
  const services = await readyServices();
  // Completed rentals still open for a review. An invitation, not a form:
  // «оставьте отзыв» belongs in front of the trip list, the seven-question
  // screen belongs behind a tap.
  const awaitingReview = await services.reviews.pending(user.userId, 3);

  const { rows } = await database.query<BookingListRow>(
    `SELECT b.id, b.reference, b.status,
            lower(b.stay_period)::text AS stay_from, upper(b.stay_period)::text AS stay_to,
            b.nights, b.guests,
            b.total_expected_minor::text AS total_expected_minor,
            b.created_at,
            p.title AS property_title, p.city AS property_city,
            (SELECT storage_key FROM property_photo ph
              WHERE ph.property_id = p.id ORDER BY is_cover DESC, sort_order LIMIT 1) AS cover_photo,
            u.display_name AS counterparty_name,
            u.verification_level AS counterparty_verified
       FROM booking b
       JOIN property p ON p.id = b.property_id
       JOIN app_user u ON u.id = b.landlord_id
      WHERE b.tenant_id = $1
      ORDER BY lower(b.stay_period) DESC`,
    [user.userId],
  );

  const byGroup = GROUPS.map((g) => ({
    ...g,
    rows: rows.filter((r) => (g.statuses as readonly string[]).includes(r.status)),
  }));
  const needsAction = byGroup[0]!.rows.length;
  const total = rows.length;

  return (
    <div className="container tp">
      <header className="tp__head">
        <h1 className="title-lg">Мои поездки</h1>
        <p className="text-sm muted">
          {total === 0
            ? 'Здесь появятся ваши заявки и бронирования.'
            : `${total} ${plural(total, 'бронирование', 'бронирования', 'бронирований')}${
                needsAction > 0 ? ` · ${needsAction} требует внимания` : ''
              }`}
        </p>
      </header>

      <nav className="tp__links" aria-label="Разделы">
        <Link href="/favorites" className="tp__link">
          <Icon name="heart" size={16} />
          Избранное
        </Link>
        <Link href="/dashboard/chat" className="tp__link">
          <Icon name="message" size={16} />
          Сообщения
        </Link>
        <Link href="/search" className="tp__link">
          <Icon name="search" size={16} />
          Найти жильё
        </Link>
      </nav>

      {awaitingReview.length > 0 && (
        <section className="tp__invite" aria-label="Отзывы">
          <h2 className="tp__inviteTitle">Как прошла аренда?</h2>
          <p className="tp__inviteText">
            Ваша оценка помогает другим людям выбирать жильё и владельцев. Отзывы обеих сторон
            публикуются одновременно.
          </p>
          <ul className="tp__inviteList">
            {awaitingReview.map((raw) => {
              const item = raw as Record<string, any>;
              return (
                <li key={String(item.bookingId)} className="tp__inviteItem">
                  <span className="tp__inviteWhat truncate">{item.propertyTitle}</span>
                  <Link
                    href={`/bookings/${item.bookingId}/review`}
                    className="btn btn-soft btn-sm"
                  >
                    Оставить отзыв
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {total === 0 ? (
        <div className="tp__empty">
          <Icon name="calendar" size={26} />
          <p className="title-sm">Поездок пока нет</p>
          <p className="text-sm muted">
            Найдите жильё и отправьте заявку — она появится здесь вместе со статусом.
          </p>
          <Link href="/search" className="btn btn-primary">
            Смотреть квартиры
          </Link>
        </div>
      ) : (
        byGroup
          .filter((g) => g.rows.length > 0)
          .map((g) => (
            <section key={g.key} className="tp__section">
              <h2 className="tp__h2">
                {g.title}
                <span className="tp__count">{g.rows.length}</span>
              </h2>
              {g.hint && <p className="hint tp__hint">{g.hint}</p>}
              <BookingList rows={g.rows} viewerRole="TENANT" emptyTitle="" />
            </section>
          ))
      )}

      <style>{`
        .tp { padding-block: var(--space-5) var(--space-8); max-width: 56rem; }
        .tp__head { display: grid; gap: 0.2rem; margin-bottom: var(--space-4); }
        .tp__links { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-5); }
        .tp__link {
          display: inline-flex; align-items: center; gap: 0.4rem;
          min-height: 2.5rem; padding: 0.4rem 0.85rem;
          background: var(--surface); border-radius: var(--radius-sm);
          font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary);
        }
        .tp__link:hover { color: var(--text-primary); box-shadow: var(--shadow-subtle); }
        .tp__link > svg { color: var(--primary); }

        .tp__invite {
          display: grid; gap: var(--space-2);
          padding: var(--space-4) var(--space-5);
          margin-bottom: var(--space-6);
          background: var(--primary-soft); border-radius: var(--radius-md);
        }
        .tp__inviteTitle { font-size: var(--text-lg); font-weight: 650; letter-spacing: -0.015em; }
        .tp__inviteText { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; max-width: 52ch; }
        .tp__inviteList { display: grid; gap: var(--space-2); margin: var(--space-1) 0 0; padding: 0; list-style: none; }
        .tp__inviteItem { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-width: 0; }
        .tp__inviteWhat { font-size: var(--text-sm); font-weight: 500; }
        @media (max-width: 480px) {
          .tp__inviteItem { align-items: stretch; flex-direction: column; }
          .tp__inviteItem > .btn { width: 100%; }
        }

        .tp__section { margin-bottom: var(--space-6); }
        .tp__h2 { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-lg); font-weight: 600; margin-bottom: var(--space-3); }
        .tp__count {
          font-size: var(--text-2xs); font-weight: 700;
          padding: 0.05rem 0.4rem; border-radius: var(--radius-full);
          background: var(--primary-soft); color: var(--primary);
        }
        .tp__hint { margin-top: calc(var(--space-3) * -1 + 0.1rem); margin-bottom: var(--space-3); }

        .tp__empty { display: grid; justify-items: center; gap: 0.3rem; padding: var(--space-8) var(--space-4); text-align: center; }
        .tp__empty > svg { color: var(--text-tertiary); margin-bottom: var(--space-2); }
        .tp__empty > .btn { margin-top: var(--space-3); }
      `}</style>
    </div>
  );
}
