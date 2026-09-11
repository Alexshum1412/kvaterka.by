'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import type { AppLocale } from '@/i18n/routing.ts';

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

const LEGEND_META: { status: DayStatus; labelKey: 'available' | 'booked' | 'pending' | 'blocked'; icon: 'check' | 'clock' | 'close' | 'alert' }[] = [
  { status: 'AVAILABLE', labelKey: 'available', icon: 'check' },
  { status: 'BOOKED', labelKey: 'booked', icon: 'close' },
  { status: 'PENDING', labelKey: 'pending', icon: 'clock' },
  { status: 'BLOCKED', labelKey: 'blocked', icon: 'alert' },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

/** Monday-first weekday index, which is how a Belarusian calendar reads. */
const weekdayIndex = (d: Date) => (d.getUTCDay() + 6) % 7;

/** «1 августа», not «1 Август» — a date in Russian and Belarusian takes the
 * genitive; English reorders to "August 1" instead. */
function formatRange(from: string, to: string, monthsGenitive: readonly string[], locale: AppLocale): string {
  const f = (s: string) => {
    const [, m, d] = s.split('-');
    const day = Number(d);
    const month = monthsGenitive[Number(m) - 1];
    return locale === 'en' ? `${month} ${day}` : `${day} ${month}`;
  };
  return from === to ? f(from) : `${f(from)} — ${f(to)}`;
}

export function AvailabilityCalendar({ propertyId }: { propertyId: string }) {
  const t = useTranslations('Calendar');
  const locale = useLocale() as AppLocale;
  const months = t.raw('months') as string[];
  const monthsGenitive = t.raw('monthsGenitive') as string[];
  const weekdays = t.raw('weekdays') as string[];
  const statusWord = t.raw('statusWord') as Record<DayStatus, string>;

  const today = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }, []);
  /** The actual calendar date, not `today`'s month-start — used to block
   * picking a day that has already passed, which `today` above cannot do
   * since it only ever holds the 1st of a month. */
  const todayIso = useMemo(() => iso(new Date()), []);

  const [month, setMonth] = useState(today);
  const [view, setView] = useState<CalendarView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  /** The confirmed second endpoint — despite the name, no longer touched by
   * mouse movement (see `pick` below). Kept as `hover` rather than renamed
   * to `endDate` only to keep this diff small; it is not a hover state. */
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
      setError(e instanceof ApiError ? e.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [propertyId, monthStart, monthEnd, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarDay>();
    for (const d of view?.days ?? []) map.set(d.date, d);
    return map;
  }, [view]);

  /* The provisional selection, from the anchor to the confirmed second point. */
  const selection = useMemo(() => {
    if (!anchor) return null;
    const end = hover ?? anchor;
    return anchor <= end ? { from: anchor, to: end } : { from: end, to: anchor };
  }, [anchor, hover]);

  const inSelection = (date: string) => selection !== null && date >= selection.from && date <= selection.to;

  /**
   * A plain two-click range picker: click a start day, click an end day.
   *
   * This used to update on `onMouseEnter` as well as `onClick`, which meant
   * the "to" date was whatever cell the cursor last passed over — including
   * cells crossed on the way to the confirm button below the grid, which
   * sits close enough to the last row that reaching it routinely dragged
   * the endpoint past whatever middle date was actually intended. Clicking
   * a date now does exactly what it looks like it does, and nothing else
   * changes the selection.
   */
  function pick(date: string) {
    // A day that has already passed cannot be blocked, unblocked or booked —
    // there is nothing left to decide about it.
    if (date < todayIso) return;
    const day = byDate.get(date);
    // A booked night is not the landlord's to reassign from here; that
    // belongs to the booking, which has its own cancellation rules.
    if (day && (day.status === 'BOOKED' || day.status === 'PENDING')) return;
    // No start yet, or a complete range is already showing — begin a fresh
    // selection rather than extending the old one.
    if (!anchor || (hover && hover !== anchor)) {
      setAnchor(date);
      setHover(null);
      return;
    }
    // Start is set, this click supplies the end (in either order).
    setHover(date);
  }

  /** Manual entry — typing exact dates rather than clicking every day of a
   * long range. Accepts either order; `selection` already sorts from/to. */
  function pickManual(which: 'from' | 'to', value: string) {
    if (value === '') {
      if (which === 'from') { setAnchor(null); setHover(null); }
      else setHover(null);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    // The `min` attribute on these inputs already stops most browsers from
    // producing a past date, but that is a UI affordance, not enforcement —
    // this is the actual guard.
    if (value < todayIso) return;
    if (which === 'from') {
      setAnchor(value);
      if (!hover) setHover(value);
    } else {
      if (!anchor) setAnchor(value);
      setHover(value);
    }
    const monthOfEntry = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, 1));
    if (iso(monthOfEntry) !== monthStart) setMonth(monthOfEntry);
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
      setError(e instanceof ApiError ? e.message : t('updateFailed'));
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
            aria-label={t('prevMonth')}
          >
            <Icon name="arrowLeft" size={16} />
          </button>
          <h2 className="cal__month">
            {months[month.getUTCMonth()]} {month.getUTCFullYear()}
          </h2>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setMonth(addMonths(month, 1))}
            aria-label={t('nextMonth')}
          >
            <Icon name="arrowRight" size={16} />
          </button>
        </div>
        {!isCurrentMonth && (
          <button type="button" className="link cal__today" onClick={() => setMonth(today)}>
            {t('today')}
          </button>
        )}
      </header>

      <ul className="cal__legend">
        {LEGEND_META.map((l) => (
          <li key={l.status}>
            <span className={`cal__swatch cal__swatch--${l.status.toLowerCase()}`} aria-hidden="true">
              <Icon name={l.icon} size={12} />
            </span>
            {t(`legend.${l.labelKey}`)}
          </li>
        ))}
      </ul>

      {/* Typing exact dates is faster and more precise than clicking through
          a long range one day at a time, and it's the same anchor/hover
          state the grid below uses — the two stay in sync either way. */}
      <div className="cal__manual">
        <label className="cal__manualField">
          <span>{t('manualFrom')}</span>
          <input
            type="date"
            className="input"
            value={anchor ?? ''}
            min={todayIso}
            onChange={(e) => pickManual('from', e.target.value)}
          />
        </label>
        <label className="cal__manualField">
          <span>{t('manualTo')}</span>
          <input
            type="date"
            className="input"
            value={hover ?? ''}
            min={anchor ?? todayIso}
            onChange={(e) => pickManual('to', e.target.value)}
          />
        </label>
      </div>

      <div className="cal__weekdays" aria-hidden="true">
        {weekdays.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>

      {loading && !view ? (
        <div className="skeleton cal__loading" />
      ) : (
        <div className="cal__grid" role="grid" aria-label={t('gridAria')}>
          {Array.from({ length: leading }, (_, i) => (
            <span key={`pad-${i}`} className="cal__pad" />
          ))}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const date = iso(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), i + 1)));
            const day = byDate.get(date);
            const isPast = date < todayIso;
            const status: DayStatus = day?.status ?? 'AVAILABLE';
            const locked = status === 'BOOKED' || status === 'PENDING' || isPast;
            return (
              <button
                key={date}
                type="button"
                role="gridcell"
                className="cal__day"
                data-status={isPast ? 'past' : status.toLowerCase()}
                data-selected={inSelection(date) ? 'true' : 'false'}
                disabled={locked}
                aria-label={
                  isPast
                    ? t('dayAriaLabelPast', { day: i + 1, month: monthsGenitive[month.getUTCMonth()] ?? '' })
                    : t('dayAriaLabel', { day: i + 1, month: monthsGenitive[month.getUTCMonth()] ?? '', status: statusWord[status] })
                }
                onClick={() => pick(date)}
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
        <div className="cal__confirm" role="group" aria-label={t('confirmGroupAria')}>
          <p className="cal__confirmText">
            {t('confirmText', {
              range: formatRange(selection.from, selection.to, monthsGenitive, locale),
              count: selectedNights,
            })}
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
              {t('cancel')}
            </button>
            {selectionHasBlocks ? (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void apply('unblock')}>
                {busy ? t('opening') : t('openDates')}
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void apply('block')}>
                {busy ? t('closing') : t('closeDates')}
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
          {t('footerHint', { min: view.minNights, max: view.maxNights })}
        </p>
      )}

      <style>{`
        .cal { display: grid; gap: var(--space-4); }
        .cal__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
        .cal__nav { display: flex; align-items: center; gap: var(--space-3); }
        .cal__month { font-size: var(--text-lg); font-weight: 600; min-width: 10rem; }
        .cal__today { background: none; border: 0; cursor: pointer; font: inherit; font-size: var(--text-sm); font-weight: 600; }

        .cal__legend { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); list-style: none; margin: 0; padding: 0; font-size: var(--text-xs); color: var(--text-secondary); }

        .cal__manual { display: flex; flex-wrap: wrap; gap: var(--space-3); }
        .cal__manualField { display: flex; align-items: center; gap: 0.5rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .cal__manualField input { max-width: 10rem; }
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
        /* Past days: visibly inert rather than just unclickable — nothing
           left to decide about a date that has already happened. */
        .cal__day[data-status='past'] { background: transparent; color: var(--text-tertiary); border-color: transparent; opacity: 0.45; }
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
