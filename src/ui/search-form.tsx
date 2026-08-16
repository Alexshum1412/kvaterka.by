'use client';

import type { FormEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/ui/icons.tsx';
import { cx, formatNights, plural } from '@/ui/primitives.tsx';

/**
 * The primary entry point of the whole product.
 *
 * Кватэрка rents by the day, the month and the year, so "заезд / выезд" is the
 * wrong first question: nobody looking for a flat for three months thinks in
 * check-out dates. The tenant picks a length of stay in plain words and, if
 * they know it, a start date; the end date is arithmetic and we do it for them.
 * Someone who has no date yet still gets a search — the length alone narrows
 * the market enough to be worth running.
 */

const PRESETS: readonly { nights: number; label: string }[] = [
  { nights: 1, label: 'Сутки' },
  { nights: 3, label: '3 ночи' },
  { nights: 7, label: 'Неделя' },
  { nights: 30, label: 'Месяц' },
  { nights: 90, label: '3 месяца' },
  { nights: 180, label: 'Полгода' },
  { nights: 365, label: 'Год' },
];

const GUEST_OPTIONS = [1, 2, 3, 4, 5, 6];

type DurationMode = 'SHORT' | 'MEDIUM' | 'LONG';

/** Only reachable when a search was run without a start date. */
const MODE_LABEL: Record<DurationMode, string> = {
  SHORT: 'До месяца',
  MEDIUM: '1–6 месяцев',
  LONG: 'От полугода',
};

function isMode(value: string): value is DurationMode {
  return value === 'SHORT' || value === 'MEDIUM' || value === 'LONG';
}

function modeFor(nights: number): DurationMode {
  if (nights <= 30) return 'SHORT';
  if (nights <= 180) return 'MEDIUM';
  return 'LONG';
}

const DAY_MS = 86_400_000;

// Dates are handled as UTC midnights: a local-time parse shifts a calendar day
// across a timezone boundary and turns "30 nights" into 29.
function dayValue(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

function addNights(iso: string, nights: number): string | null {
  const t = dayValue(iso);
  return t === null ? null : new Date(t + nights * DAY_MS).toISOString().slice(0, 10);
}

function nightsBetween(from: string, to: string): number | null {
  const a = dayValue(from);
  const b = dayValue(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

/** The year is only spelled out when the stay crosses into another one. */
function shortDate(iso: string, relativeTo: string): string {
  const [year, month, day] = iso.split('-');
  return relativeTo.slice(0, 4) === year ? `${day}.${month}` : `${day}.${month}.${year}`;
}

/**
 * The applied query, handed down by the page.
 *
 * This used to be read with `useSearchParams()`, which forces the whole
 * module into a Suspense boundary — and that boundary was resolving to a
 * grey skeleton and never resuming, so the most important control in the
 * product rendered as an empty box. The server already knows the query
 * string; passing it down removes the suspension entirely, puts the real
 * search markup in the server-rendered HTML, and deletes the skeleton
 * flash along with it.
 */
export interface SearchFormInitial {
  city?: string;
  from?: string;
  to?: string;
  durationMode?: string;
  guests?: string;
}

export function SearchForm({
  compact = false,
  initial,
}: {
  compact?: boolean;
  initial?: SearchFormInitial;
}) {
  const router = useRouter();
  const params = {
    get: (key: keyof SearchFormInitial): string | null => initial?.[key] ?? null,
  };
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const queryFrom = params.get('from') ?? '';
  const queryTo = params.get('to') ?? '';
  const queryMode = params.get('durationMode') ?? '';
  const querySpan = queryFrom && queryTo ? nightsBetween(queryFrom, queryTo) : null;
  // A range that happens to be exactly one of our lengths is shown as that
  // length, so the compact module reads back what the results page is showing.
  const queryPreset =
    querySpan !== null && PRESETS.some((p) => p.nights === querySpan) ? querySpan : null;
  const queryCustom = Boolean((queryFrom || queryTo) && queryPreset === null);

  const [city, setCity] = useState(params.get('city') ?? '');
  const [guests, setGuests] = useState(params.get('guests') ?? '');
  const [nights, setNights] = useState<number | null>(queryPreset);
  const [custom, setCustom] = useState(queryCustom);
  const [from, setFrom] = useState(queryFrom);
  const [to, setTo] = useState(queryTo);
  const [mode, setMode] = useState<DurationMode | ''>(
    !queryFrom && !queryTo && isMode(queryMode) ? queryMode : '',
  );
  const [error, setError] = useState<string | null>(null);
  // Shut on arrival. Opening it by default put a dropdown over the city row
  // on desktop and over the whole first screen on a phone, and a panel the
  // visitor did not ask for is not the same as a discoverable one — the
  // trigger already reads «Любой срок», which says the choice exists.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!formRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function closeTray() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function pickPreset(value: number) {
    setError(null);
    setMode('');
    setCustom(false);
    if (nights === value) {
      setNights(null);
      return;
    }
    setNights(value);
    closeTray();
  }

  function pickCustom() {
    setError(null);
    setMode('');
    if (custom) {
      setCustom(false);
      return;
    }
    setNights(null);
    setCustom(true);
    closeTray();
  }

  const preset = nights === null ? null : (PRESETS.find((p) => p.nights === nights) ?? null);
  const chosen = custom || preset !== null || mode !== '';
  const durationLabel = custom
    ? 'Свои даты'
    : preset
      ? preset.label
      : mode
        ? MODE_LABEL[mode]
        : 'Любой срок';

  let note: string | null = null;
  if (custom && from && to) {
    const span = nightsBetween(from, to);
    if (span !== null && span > 0) note = formatNights(span);
  } else if (preset && from) {
    const end = addNights(from, preset.nights);
    if (end) note = `по ${shortDate(end, from)} · ${formatNights(preset.nights)}`;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (custom && from && to && to <= from) {
      setError('Дата выезда должна быть позже даты заезда');
      return;
    }

    const query = new URLSearchParams();
    const trimmed = city.trim();
    if (trimmed) query.set('city', trimmed);
    if (guests) query.set('guests', guests);

    if (custom) {
      if (from) query.set('from', from);
      if (to) query.set('to', to);
    } else if (preset) {
      const end = from ? addNights(from, preset.nights) : null;
      if (from && end) {
        query.set('from', from);
        query.set('to', end);
      } else {
        // No start date is a legitimate answer: the length still tells the
        // search which half of the market to look in.
        query.set('durationMode', modeFor(preset.nights));
      }
    } else if (mode) {
      query.set('durationMode', mode);
    }

    const qs = query.toString();
    router.push(qs ? `/search?${qs}` : '/search');
  }

  const today = new Date().toISOString().slice(0, 10);
  const labelId = `${uid}-duration`;

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) closeTray();
      }}
      className={cx('sf', compact ? 'sf--compact' : 'sf--full')}
      role="search"
      aria-label="Поиск жилья"
    >
      <div className="sf__bar">
        <div className="sf__seg sf__seg--where">
          <label className="sf__label" htmlFor={`${uid}-city`}>
            Где?
          </label>
          <span className="sf__pinned">
            <Icon name="pin" size={18} />
            <input
              id={`${uid}-city`}
              className="input sf__city"
              value={city}
              onChange={(event) => setCity(event.target.value)}
              placeholder="Минск"
              autoComplete="address-level2"
              enterKeyHint="search"
            />
          </span>
        </div>

        <div className="sf__seg sf__seg--duration">
          <span className="sf__label" id={labelId}>
            На какой срок?
          </span>
          <button
            ref={triggerRef}
            type="button"
            className="sf__trigger"
            aria-expanded={open}
            aria-controls={`${uid}-lengths`}
            aria-labelledby={`${labelId} ${labelId}-value`}
            data-empty={!chosen}
            onClick={() => setOpen((value) => !value)}
          >
            <span id={`${labelId}-value`} className="truncate">
              {durationLabel}
            </span>
            <Icon name="chevronDown" size={18} />
          </button>

          <div id={`${uid}-lengths`} className="sf__tray" hidden={!open}>
            <div className="sf__lengths" role="group" aria-labelledby={labelId}>
              {PRESETS.map((item) => (
                <button
                  key={item.nights}
                  type="button"
                  className="chip"
                  aria-pressed={!custom && nights === item.nights}
                  onClick={() => pickPreset(item.nights)}
                >
                  {item.label}
                </button>
              ))}
              <button type="button" className="chip" aria-pressed={custom} onClick={pickCustom}>
                <Icon name="calendar" size={16} />
                Свои даты
              </button>
            </div>
          </div>
        </div>

        {preset && !custom && (
          <div className="sf__seg sf__seg--date">
            <label className="sf__label" htmlFor={`${uid}-start`}>
              Когда?
            </label>
            <input
              id={`${uid}-start`}
              type="date"
              className="input"
              min={today}
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
        )}

        {custom && (
          <>
            <div className="sf__seg sf__seg--date">
              <label className="sf__label" htmlFor={`${uid}-from`}>
                Заезд
              </label>
              <input
                id={`${uid}-from`}
                type="date"
                className="input"
                min={today}
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div className="sf__seg sf__seg--date">
              <label className="sf__label" htmlFor={`${uid}-to`}>
                Выезд
              </label>
              <input
                id={`${uid}-to`}
                type="date"
                className="input"
                min={from || today}
                value={to}
                onChange={(event) => setTo(event.target.value)}
                aria-invalid={error !== null}
                aria-describedby={error ? `${uid}-error` : undefined}
              />
            </div>
          </>
        )}

        <div className="sf__seg sf__seg--guests">
          <label className="sf__label" htmlFor={`${uid}-guests`}>
            Гости
          </label>
          <select
            id={`${uid}-guests`}
            className="select"
            value={guests}
            onChange={(event) => setGuests(event.target.value)}
          >
            <option value="">Не важно</option>
            {GUEST_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n === 6 ? '6+ гостей' : `${n} ${plural(n, 'гость', 'гостя', 'гостей')}`}
              </option>
            ))}
          </select>
        </div>

        <div className="sf__seg sf__seg--action">
          <button type="submit" className="btn btn-primary btn-lg sf__submit">
            <Icon name="search" size={18} />
            Найти
          </button>
        </div>
      </div>

      {(note || error) && (
        <div className="sf__foot">
          {error ? (
            <p className="error-text" id={`${uid}-error`} role="alert">
              {error}
            </p>
          ) : (
            <p className="sf__note numeric">{note}</p>
          )}
        </div>
      )}

      <style>{`
        .sf { position: relative; }

        /* The homepage module is the anchor of the hero, so it takes elevation
           — and therefore neither a border nor a second ground behind it. */
        .sf--full {
          background: var(--surface);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-raised);
          padding: var(--space-4);
        }

        /* Phone: not a shrunken bar. A short stack of ordinary controls, each
           edged well enough to be hit with a thumb. */
        .sf__bar { display: grid; gap: var(--space-3); }
        .sf__seg { display: flex; flex-direction: column; justify-content: center; gap: 0.375rem; min-width: 0; }
        .sf__label { font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary); }

        .sf__pinned { position: relative; display: flex; align-items: center; }
        .sf__pinned svg { position: absolute; left: 0.875rem; color: var(--text-tertiary); pointer-events: none; }
        .sf__city { padding-left: 2.5rem; }

        .sf__trigger {
          display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
          width: 100%;
          min-height: 3rem;
          padding: 0.6875rem 0.875rem;
          background: var(--surface);
          color: var(--text-primary);
          border: 1px solid var(--border-control);
          border-radius: var(--radius-sm);
          font: inherit;
          font-size: max(16px, var(--text-sm));
          font-weight: 500;
          text-align: left;
          cursor: pointer;
          transition: border-color 140ms ease, color 140ms ease;
        }
        .sf__trigger:hover { border-color: var(--text-tertiary); }
        .sf__trigger[data-empty='true'] { color: var(--text-tertiary); font-weight: 400; }
        .sf__trigger svg { color: var(--text-secondary); transition: transform 160ms ease; }
        .sf__trigger[aria-expanded='true'] svg { transform: rotate(180deg); }

        /* The lengths open OVER the page, at every width. Rendered inline on
           a phone they added 225px to the module and pushed every listing off
           the first screen — the opposite of what a marketplace front page is
           for. As an overlay the module stays the same height whether the
           tray is open or shut. */
        .sf__tray {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          z-index: 20;
          margin-top: var(--space-2);
          padding: var(--space-4);
          background: var(--surface);
          border-radius: var(--radius-md);
          box-shadow: var(--shadow-overlay);
        }
        .sf__lengths { display: flex; flex-wrap: wrap; gap: var(--space-2); }

        .sf__foot { padding-top: var(--space-3); }
        .sf__note { font-size: var(--text-xs); color: var(--text-tertiary); }

        .sf__submit { width: 100%; }

        /* Phone: three questions only — where, how long, go. Guest count is a
           narrowing, not an intent, and it is available in the filters on the
           results page; asking for it here cost 87px of the first screen. */
        @media (max-width: 599px) {
          .sf__seg--guests { display: none; }
        }

        /* Tablet: the two narrow answers pair up, the wide ones keep the row. */
        @media (min-width: 600px) {
          .sf__bar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .sf__seg--where, .sf__seg--duration, .sf__seg--action { grid-column: 1 / -1; }
        }

        /* Desktop: one module, hairline-separated. The controls lose their own
           edges here because the module itself is now the control. */
        @media (min-width: 960px) {
          .sf--full { padding: var(--space-2); }
          .sf--compact {
            border: 1px solid var(--border-control);
            border-radius: var(--radius-md);
            padding: var(--space-1) var(--space-2);
          }

          .sf__bar { display: flex; align-items: stretch; gap: 0; grid-template-columns: none; }
          .sf__seg { flex: 0 0 auto; gap: 0.125rem; padding: 0.5rem 1rem; }
          .sf__bar > .sf__seg:not(:first-child):not(.sf__seg--action) { border-left: 1px solid var(--border); }
          .sf--compact .sf__bar > .sf__seg:not(:first-child):not(.sf__seg--action) { border-left-color: var(--border-strong); }
          .sf--compact .sf__seg { padding-block: 0.25rem; }

          .sf__seg--where { flex: 1 1 12rem; min-width: 0; }
          .sf__seg--duration { flex: 0 1 12.5rem; min-width: 0; }
          .sf__seg--date { flex: 0 0 9.5rem; }
          .sf__seg--guests { flex: 0 0 9.5rem; }
          .sf__seg--action { padding-right: 0; }

          .sf__label { font-size: var(--text-xs); color: var(--text-tertiary); }

          .sf .input, .sf .select, .sf__trigger {
            min-height: 2.5rem;
            padding: 0;
            border-color: transparent;
            background-color: transparent;
            font-weight: 500;
          }
          .sf .select { padding-right: 1.5rem; background-position: right 0 center; }
          .sf .input:hover, .sf .select:hover, .sf__trigger:hover { border-color: transparent; }
          .sf .input:focus, .sf .select:focus { outline-offset: 3px; }
          .sf .sf__city { padding-left: 1.625rem; }
          .sf__pinned svg { left: 0; }

          .sf__submit { width: auto; }
          .sf--compact .sf__submit { min-height: 2.75rem; padding-inline: 1.25rem; font-size: var(--text-sm); }

          .sf__foot { padding-top: var(--space-2); padding-left: var(--space-4); }
        }

        @media (min-width: 960px) and (hover: hover) {
          .sf__bar > .sf__seg:not(.sf__seg--action):hover { background: var(--surface-sunken); }
        }

        .sf__tray[hidden] { display: none; }
      `}</style>
    </form>
  );
}
