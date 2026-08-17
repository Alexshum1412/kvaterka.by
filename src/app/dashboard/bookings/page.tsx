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
  title: 'Заявки и бронирования',
  robots: { index: false, follow: false },
};

/**
 * The landlord's side.
 *
 * `?status=REQUESTED` is honoured because the dashboard's «Требует
 * внимания» links straight here with it — that link existed before this
 * page did, which is exactly the dead end this closes.
 */

type Params = Record<string, string | string[] | undefined>;

const TABS = [
  { key: 'REQUESTED', label: 'Новые заявки', statuses: ['REQUESTED', 'OFFER_PENDING', 'INQUIRY'] },
  { key: 'CONFIRMED', label: 'Предстоящие', statuses: ['CONFIRMED'] },
  { key: 'ACTIVE', label: 'Проживают', statuses: ['CHECKED_IN'] },
  { key: 'COMPLETION', label: 'Ждут подтверждения', statuses: ['COMPLETION_PENDING', 'DISPUTED'] },
  {
    key: 'HISTORY',
    label: 'История',
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

export default async function LandlordBookingsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/dashboard/bookings'));

  const params = await searchParams;
  const requested = typeof params.status === 'string' ? params.status : 'REQUESTED';
  const active = TABS.find((t) => t.key === requested) ?? TABS[0];

  const database = await ready();
  // The same invitation the tenant sees, from the other side. `pending()`
  // returns rows for whichever role the caller played, so this list is the
  // landlord's own outstanding reviews and nobody else's.
  const awaitingReview = await (await readyServices()).reviews.pending(user.userId, 3);

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
       JOIN app_user u ON u.id = b.tenant_id
      WHERE b.landlord_id = $1
      ORDER BY b.created_at DESC`,
    [user.userId],
  );

  const counts = new Map<string, number>();
  for (const tab of TABS) {
    counts.set(tab.key, rows.filter((r) => (tab.statuses as readonly string[]).includes(r.status)).length);
  }
  const visible = rows.filter((r) => (active.statuses as readonly string[]).includes(r.status));

  return (
    <div className="container lb">
      <nav className="lb__back">
        <Link href="/dashboard" className="lb__backLink">
          <Icon name="arrowLeft" size={16} />
          Кабинет
        </Link>
      </nav>

      <header className="lb__head">
        <h1 className="title-lg">Заявки и бронирования</h1>
        <p className="text-sm muted">
          {counts.get('REQUESTED')! > 0
            ? `${counts.get('REQUESTED')} ${plural(counts.get('REQUESTED')!, 'заявка ждёт', 'заявки ждут', 'заявок ждут')} ответа`
            : 'Новых заявок нет.'}
        </p>
      </header>

      <nav className="lb__tabs" aria-label="Статус">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === 'REQUESTED' ? '/dashboard/bookings' : `/dashboard/bookings?status=${t.key}`}
            className="lb__tab"
            aria-current={t.key === active.key ? 'page' : undefined}
          >
            {t.label}
            <span className="lb__tabCount">{counts.get(t.key)}</span>
          </Link>
        ))}
      </nav>

      {awaitingReview.length > 0 && (
        <section className="lb__invite" aria-label="Отзывы">
          <h2 className="lb__inviteTitle">Можно оставить отзыв об арендаторе</h2>
          <p className="lb__inviteText">
            Отзывы обеих сторон публикуются одновременно — арендатор не увидит вашу оценку, пока не
            напишет свою.
          </p>
          <ul className="lb__inviteList">
            {awaitingReview.map((raw) => {
              const item = raw as Record<string, any>;
              return (
                <li key={String(item.bookingId)} className="lb__inviteItem">
                  <span className="truncate">
                    {item.counterpartyName} · {item.propertyTitle}
                  </span>
                  <Link href={`/bookings/${item.bookingId}/review`} className="btn btn-soft btn-sm">
                    Оставить отзыв
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <BookingList
        rows={visible}
        viewerRole="LANDLORD"
        emptyTitle="Здесь пока пусто"
        emptyHint={
          active.key === 'REQUESTED'
            ? 'Новые заявки от арендаторов появятся здесь.'
            : undefined
        }
      />

      <style>{`
        .lb { padding-block: var(--space-4) var(--space-8); max-width: 56rem; }
        .lb__back { margin-bottom: var(--space-3); }
        .lb__backLink { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .lb__backLink:hover { color: var(--text-primary); }
        .lb__head { display: grid; gap: 0.2rem; margin-bottom: var(--space-4); }
        .lb__tabs { display: flex; gap: var(--space-1); flex-wrap: wrap; margin-bottom: var(--space-4); }
        .lb__tab {
          display: inline-flex; align-items: center; gap: 0.4rem;
          min-height: 2.5rem; padding: 0.4rem 0.85rem;
          border-radius: var(--radius-sm);
          font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary);
        }
        .lb__tab:hover { background: var(--surface); color: var(--text-primary); }
        .lb__tab[aria-current='page'] { background: var(--surface); color: var(--text-primary); font-weight: 600; }
        .lb__tabCount {
          font-size: var(--text-2xs); font-weight: 700;
          padding: 0.05rem 0.35rem; border-radius: var(--radius-full);
          background: var(--surface-sunken); color: var(--text-secondary);
        }
        .lb__tab[aria-current='page'] .lb__tabCount { background: var(--primary-soft); color: var(--primary); }

        .lb__invite {
          display: grid; gap: var(--space-2);
          padding: var(--space-4) var(--space-5); margin-bottom: var(--space-4);
          background: var(--primary-soft); border-radius: var(--radius-md);
        }
        .lb__inviteTitle { font-size: var(--text-base); font-weight: 650; }
        .lb__inviteText { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; max-width: 54ch; }
        .lb__inviteList { display: grid; gap: var(--space-2); margin: var(--space-1) 0 0; padding: 0; list-style: none; }
        .lb__inviteItem { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-width: 0; font-size: var(--text-sm); }
        @media (max-width: 480px) {
          .lb__inviteItem { flex-direction: column; align-items: stretch; }
          .lb__inviteItem > .btn { width: 100%; }
        }
      `}</style>
    </div>
  );
}
