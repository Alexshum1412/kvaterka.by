'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { plural } from '@/ui/primitives.tsx';

/**
 * Availability.
 *
 * The same calendar has to describe a two-night stay and an eleven-month
 * tenancy, so it is a plain month grid over the existing availability
 * API rather than anything nightly-specific. A long let simply appears
 * as a long run of booked days.
 *
 * Status is never carried by colour alone: every non-available day also
 * has a glyph and a word in its accessible name, because a landlord
 * deciding whether to block a fortnight cannot be asked to distinguish
 * two pale tints.
 */

type DayStatus = 'AVAILABLE' | 'BOOKED' | 'PENDING' | 'BLOCKED' | 'MAINTENANCE' | 'OWNER_BLOCKED';

interface CalendarDay {
  date: string;
  status: DayStatus;
  bookingId?: string;
  blockId?: string;
}

interface CalendarView {
  days: CalendarDay[];
  minNights: number;
  maxNights: number;
  freshness: 'FRESH' | 'AGEING' | 'STALE';
}

const LEGEND: { status: DayStatus; label: string; icon: 'check' | 'clock' | 'close' | 'alert' }[] = [
  { status: 'AVAILABLE', label: 'Свободно', icon: 'check' },
  { status: 'BOOKED', label: 'Забронировано', icon: 'close' },
  { status: 'PENDING', label: 'Ждёт ответа', icon: 'clock' },
  { status: 'BLOCKED', label: 'Закрыто вами', icon: 'alert' },
];

const STATUS_WORD: Record<DayStatus, string> = {
  AVAILABLE: 'свободно',
  BOOKED: 'забронировано',
  PENDING: 'ждёт вашего ответа',
  BLOCKED: 'закрыто вами',
  MAINTENANCE: 'ремонт',
  OWNER_BLOCKED: 'вы живёте сами',
};

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
/** «1 августа», not «1 Август» — a date in Russian takes the genitive. */
const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

/** Monday-first weekday index, which is how a Belarusian calendar reads. */
const weekdayIndex = (d: Date) => (d.getUTCDay() + 6) % 7;

function formatRange(from: string, to: string): string {
  const f = (s: string) => {
    const [, m, d] = s.split('-');
    return `${Number(d)} ${MONTHS_GENITIVE[Number(m) - 1]}`;
  };
  return from === to ? f(from) : `${f(from)} — ${f(to)}`;
}

export function AvailabilityCalendar({ propertyId }: { propertyId: string }) {
  const today = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }, []);

  const [month, setMonth] = useState(today);
  const [view, setView] = useState<CalendarView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const monthStart = iso(month);
  const monthEnd = iso(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<CalendarView>(
        `/listings/${propertyId}/availability?from=${monthStart}&to=${monthEnd}`,
      );
      setView(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось загрузить календарь');
    } finally {
      setLoading(false);
    }
  }, [propertyId, monthStart, monthEnd]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarDay>();
    for (const d of view?.days ?? []) map.set(d.date, d);
    return map;
  }, [view]);

  /* The provisional selection, from the anchor to whatever is hovered. */
  const selection = useMemo(() => {
    if (!anchor) return null;
    const end = hover ?? anchor;
    return anchor <= end ? { from: anchor, to: end } : { from: end, to: anchor };
  }, [anchor, hover]);

  const inSelection = (date: string) => selection !== null && date >= selection.from && date <= selection.to;

  function pick(date: string) {
    const day = byDate.get(date);
    // A booked night is not the landlord's to reassign from here; that
    // belongs to the booking, which has its own cancellation rules.
    if (day && (day.status === 'BOOKED' || day.status === 'PENDING')) return;
    if (!anchor) {
      setAnchor(date);
      setHover(date);
      return;
    }
    setHover(date);
  }

  async function apply(action: 'block' | 'unblock') {
    if (!selection) return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'block') {
        await api.post(`/listings/${propertyId}/availability/block`, {
          from: selection.from,
          to: selection.to,
        });
      } else {
        // Unblocking a range means removing every block that covers it.
        const ids = new Set<string>();
        for (const [date, day] of byDate) {
          if (date >= selection.from && date <= selection.to && day.blockId) ids.add(day.blockId);
        }
        for (const id of ids) await api.delete(`/availability/blocks/${id}`);
      }
      setAnchor(null);
      setHover(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось изменить календарь');
    } finally {
      setBusy(false);
    }
  }

  const selectionHasBlocks =
    selection !== null &&
    [...byDate.entries()].some(
      ([date, day]) => date >= selection.from && date <= selection.to && Boolean(day.blockId),
    );
  const selectedNights = selection
    ? Math.round((Date.parse(selection.to) - Date.parse(selection.from)) / 86_400_000) + 1
    : 0;

  /* Leading blanks so the 1st lands under the right weekday. */
  const leading = weekdayIndex(month);
  const daysInMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  const isCurrentMonth = iso(month) === iso(today);

  return (
    <div className="cal">
      <header className="cal__head">
        <div className="cal__nav">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setMonth(addMonths(month, -1))}
            disabled={isCurrentMonth}
            aria-label="Предыдущий месяц"
          >
            <Icon name="arrowLeft" size={16} />
          </button>
          <h2 className="cal__month">
            {MONTHS[month.getUTCMonth()]} {month.getUTCFullYear()}
          </h2>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setMonth(addMonths(month, 1))}
            aria-label="Следующий месяц"
          >
            <Icon name="arrowRight" size={16} />
          </button>
        </div>
        {!isCurrentMonth && (
          <button type="button" className="link cal__today" onClick={() => setMonth(today)}>
            Сегодня
          </button>
        )}
      </header>

      <ul className="cal__legend">
        {LEGEND.map((l) => (
          <li key={l.status}>
            <span className={`cal__swatch cal__swatch--${l.status.toLowerCase()}`} aria-hidden="true">
              <Icon name={l.icon} size={12} />
            </span>
            {l.label}
          </li>
        ))}
      </ul>

      <div className="cal__weekdays" aria-hidden="true">
        {WEEKDAYS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>

      {loading && !view ? (
        <div className="skeleton cal__loading" />
      ) : (
        <div className="cal__grid" role="grid" aria-label="Календарь доступности">
          {Array.from({ length: leading }, (_, i) => (
            <span key={`pad-${i}`} className="cal__pad" />
          ))}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const date = iso(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), i + 1)));
            const day = byDate.get(date);
            const status: DayStatus = day?.status ?? 'AVAILABLE';
            const locked = status === 'BOOKED' || status === 'PENDING';
            return (
              <button
                key={date}
                type="button"
                role="gridcell"
                className="cal__day"
                data-status={status.toLowerCase()}
                data-selected={inSelection(date) ? 'true' : 'false'}
                disabled={locked}
                aria-label={`${i + 1} ${MONTHS_GENITIVE[month.getUTCMonth()]}, ${STATUS_WORD[status]}`}
                onClick={() => pick(date)}
                onMouseEnter={() => anchor && setHover(date)}
              >
                <span className="cal__num">{i + 1}</span>
                {status !== 'AVAILABLE' && (
                  <Icon
                    name={status === 'BOOKED' ? 'close' : status === 'PENDING' ? 'clock' : 'alert'}
                    size={11}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      {selection && (
        <div className="cal__confirm" role="group" aria-label="Изменить доступность">
          <p className="cal__confirmText">
            {formatRange(selection.from, selection.to)} · {selectedNights}{' '}
            {plural(selectedNights, 'день', 'дня', 'дней')}
          </p>
          <div className="cal__confirmActions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setAnchor(null);
                setHover(null);
              }}
            >
              Отмена
            </button>
            {selectionHasBlocks ? (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void apply('unblock')}>
                {busy ? 'Открываем…' : 'Открыть даты'}
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void apply('block')}>
                {busy ? 'Закрываем…' : 'Закрыть даты'}
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {view && (
        <p className="hint">
          Сдаётся от {view.minNights} до {view.maxNights}{' '}
          {plural(view.maxNights, 'ночи', 'ночей', 'ночей')}. Забронированные даты нельзя закрыть —
          отмена бронирования происходит в самом бронировании.
        </p>
      )}

      <style>{`
        .cal { display: grid; gap: var(--space-4); }
        .cal__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
        .cal__nav { display: flex; align-items: center; gap: var(--space-3); }
        .cal__month { font-size: var(--text-lg); font-weight: 600; min-width: 10rem; }
        .cal__today { background: none; border: 0; cursor: pointer; font: inherit; font-size: var(--text-sm); font-weight: 600; }

        .cal__legend { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); list-style: none; margin: 0; padding: 0; font-size: var(--text-xs); color: var(--text-secondary); }
        .cal__legend li { display: flex; align-items: center; gap: 0.35rem; }
        .cal__swatch { display: grid; place-items: center; width: 1.15rem; height: 1.15rem; border-radius: var(--radius-sm); }
        .cal__swatch--available { background: var(--surface); border: 1px solid var(--border-strong); color: var(--text-tertiary); }
        .cal__swatch--booked { background: var(--primary-soft); color: var(--primary); }
        .cal__swatch--pending { background: var(--warning-soft); color: var(--warning); }
        .cal__swatch--blocked { background: var(--surface-sunken); color: var(--text-secondary); }

        .cal__weekdays, .cal__grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
        .cal__weekdays { font-size: var(--text-2xs); color: var(--text-tertiary); text-align: center; }
        .cal__loading { height: 16rem; }
        .cal__pad { aspect-ratio: 1; }

        .cal__day {
          position: relative;
          aspect-ratio: 1;
          min-height: 2.5rem;
          display: grid; place-items: center; align-content: center; gap: 1px;
          padding: 0;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          font: inherit; font-size: var(--text-sm); font-variant-numeric: tabular-nums;
          color: var(--text-primary);
          cursor: pointer;
          transition: background-color 120ms ease, border-color 120ms ease;
        }
        .cal__day:hover:not(:disabled) { border-color: var(--primary); }
        .cal__day:disabled { cursor: not-allowed; }
        .cal__day[data-status='booked'] { background: var(--primary-soft); color: var(--primary); border-color: transparent; }
        .cal__day[data-status='pending'] { background: var(--warning-soft); color: var(--warning); border-color: transparent; }
        .cal__day[data-status='blocked'],
        .cal__day[data-status='maintenance'],
        .cal__day[data-status='owner_blocked'] { background: var(--surface-sunken); color: var(--text-tertiary); border-color: transparent; }
        .cal__day[data-selected='true'] { border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); }
        .cal__num { line-height: 1; }

        .cal__confirm {
          position: sticky; bottom: var(--space-4);
          display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
          flex-wrap: wrap;
          padding: var(--space-3) var(--space-4);
          background: var(--surface);
          border-radius: var(--radius-md);
          box-shadow: var(--shadow-raised);
        }
        .cal__confirmText { font-size: var(--text-sm); font-weight: 600; }
        .cal__confirmActions { display: flex; gap: var(--space-2); }
      `}</style>
    </div>
  );
}
