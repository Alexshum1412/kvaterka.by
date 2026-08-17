import Link from 'next/link';
import { Icon } from '@/ui/icons.tsx';
import {
  BOOKING_STATUS_LABEL,
  Money,
  bookingTone,
  formatNights,
  plural,
} from '@/ui/primitives.tsx';

/**
 * A list of bookings, shared by the tenant's "мои поездки" and the
 * landlord's "заявки".
 *
 * One component because the row is the same object seen from two sides:
 * only the counterparty label and the destination differ, and duplicating
 * it would guarantee the two views drift apart.
 */

export interface BookingListRow {
  id: string;
  reference: string;
  status: string;
  stay_from: string;
  stay_to: string;
  nights: number;
  guests: number;
  total_expected_minor: string;
  created_at: string;
  property_title: string;
  property_city: string;
  cover_photo: string | null;
  counterparty_name: string;
  counterparty_verified: number;
  message_count?: number;
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function range(from: string, to: string): string {
  const f = (iso: string) => {
    const [, m, d] = iso.split('-');
    return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1]}`;
  };
  return `${f(from)} — ${f(to)}`;
}

export function BookingList({
  rows,
  viewerRole,
  emptyTitle,
  emptyHint,
}: {
  rows: readonly BookingListRow[];
  viewerRole: 'TENANT' | 'LANDLORD';
  emptyTitle: string;
  emptyHint?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="bl__empty">
        <Icon name="calendar" size={24} />
        <p className="title-sm">{emptyTitle}</p>
        {emptyHint && <p className="text-sm muted">{emptyHint}</p>}
        <style>{`
          .bl__empty { display: grid; justify-items: center; gap: 0.25rem; padding: var(--space-7) var(--space-4); text-align: center; }
          .bl__empty > svg { color: var(--text-tertiary); margin-bottom: var(--space-2); }
        `}</style>
      </div>
    );
  }

  return (
    <ul className="bl">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/bookings/${r.id}`} className="bl__row">
            <span className="bl__thumb">
              {r.cover_photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/media/${r.cover_photo}`} alt="" loading="lazy" />
              ) : (
                <Icon name="image" size={18} />
              )}
            </span>

            <span className="bl__main">
              <span className="bl__top">
                <span className={`badge badge-${bookingTone(r.status)}`}>
                  {BOOKING_STATUS_LABEL[r.status] ?? r.status}
                </span>
                <strong className="bl__title truncate">{r.property_title}</strong>
              </span>
              <span className="bl__meta">
                {range(r.stay_from, r.stay_to)} · {formatNights(Number(r.nights))} ·{' '}
                {r.guests} {plural(Number(r.guests), 'гость', 'гостя', 'гостей')}
              </span>
              <span className="bl__meta">
                {viewerRole === 'TENANT' ? 'Хозяин' : 'Арендатор'}: {r.counterparty_name}
                {r.counterparty_verified >= 1 && (
                  <span className="bl__ok">
                    <Icon name="checkCircle" size={12} />
                    подтверждён
                  </span>
                )}
                {' · '}
                <span className="numeric">
                  <Money minor={r.total_expected_minor} showCurrency={false} /> BYN
                </span>
              </span>
            </span>

            <Icon name="chevronRight" size={18} />
          </Link>
        </li>
      ))}

      <style>{`
        .bl { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
        .bl__row {
          display: flex; align-items: center; gap: var(--space-3);
          padding: var(--space-3);
          background: var(--surface); border-radius: var(--radius-md);
          transition: box-shadow 160ms ease;
        }
        .bl__row:hover { box-shadow: var(--shadow-raised); }
        .bl__row > svg:last-child { color: var(--text-tertiary); flex: 0 0 auto; }
        .bl__thumb {
          flex: 0 0 auto; display: grid; place-items: center;
          width: 4.5rem; height: 3.25rem; overflow: hidden;
          border-radius: var(--radius-sm); background: var(--surface-sunken); color: var(--text-tertiary);
        }
        .bl__thumb img { width: 100%; height: 100%; object-fit: cover; }
        .bl__main { display: grid; gap: 0.2rem; flex: 1 1 auto; min-width: 0; }
        .bl__top { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; min-width: 0; }
        .bl__title { font-size: var(--text-sm); }
        .bl__meta { font-size: var(--text-xs); color: var(--text-secondary); display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap; }
        .bl__ok { display: inline-flex; align-items: center; gap: 0.2rem; color: var(--success); font-weight: 600; }
        @media (max-width: 520px) { .bl__thumb { display: none; } }
      `}</style>
    </ul>
  );
}
