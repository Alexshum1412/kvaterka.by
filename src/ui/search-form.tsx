'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

/**
 * The primary entry point of the whole product.
 *
 * Three questions and nothing else: where, when, how many. A tenant must not
 * have to pick "short-term" versus "long-term" before they are allowed to
 * search — that is our internal model, not theirs. Duration is inferred from
 * the dates, and the flexible option exists for people who genuinely do not
 * have dates yet (spec §26 of the phase brief).
 */
export function SearchForm({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();

  const [city, setCity] = useState(params.get('city') ?? '');
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [guests, setGuests] = useState(params.get('guests') ?? '');
  const [durationMode, setDurationMode] = useState(params.get('durationMode') ?? '');
  const [error, setError] = useState<string | null>(null);

  const flexible = durationMode !== '';

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!flexible && from && to && to <= from) {
      setError('Дата выезда должна быть позже даты заезда');
      return;
    }

    const query = new URLSearchParams();
    if (city.trim()) query.set('city', city.trim());
    if (guests) query.set('guests', guests);
    if (flexible) {
      query.set('durationMode', durationMode);
    } else {
      if (from) query.set('from', from);
      if (to) query.set('to', to);
    }
    router.push(`/search?${query.toString()}`);
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <form onSubmit={submit} className={compact ? 'search-form search-form--compact' : 'search-form'}>
      <div className="field grow">
        <label className="label" htmlFor="sf-city">
          Город или район
        </label>
        <input
          id="sf-city"
          className="input"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          placeholder="Минск"
          autoComplete="address-level2"
          enterKeyHint="search"
        />
      </div>

      {!flexible && (
        <>
          <div className="field">
            <label className="label" htmlFor="sf-from">
              Заезд
            </label>
            <input
              id="sf-from"
              className="input"
              type="date"
              min={today}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="sf-to">
              Выезд
            </label>
            <input
              id="sf-to"
              className="input"
              type="date"
              min={from || today}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </>
      )}

      {flexible && (
        <div className="field grow">
          <label className="label" htmlFor="sf-duration">
            Примерный срок
          </label>
          <select
            id="sf-duration"
            className="select"
            value={durationMode}
            onChange={(e) => setDurationMode(e.target.value)}
          >
            <option value="SHORT">До месяца</option>
            <option value="MEDIUM">1–6 месяцев</option>
            <option value="LONG">От полугода</option>
          </select>
        </div>
      )}

      <div className="field">
        <label className="label" htmlFor="sf-guests">
          Гостей
        </label>
        <select
          id="sf-guests"
          className="select"
          value={guests}
          onChange={(e) => setGuests(e.target.value)}
          style={{ minWidth: '5.5rem' }}
        >
          <option value="">Любое</option>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n}
              {n === 6 ? '+' : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="search-form__actions">
        <button type="submit" className="btn btn-primary btn-lg btn-block">
          Найти
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setDurationMode(flexible ? '' : 'MEDIUM')}
        >
          {flexible ? 'Указать точные даты' : 'Даты пока не выбраны'}
        </button>
      </div>

      {error && (
        <p className="error-text" role="alert" style={{ gridColumn: '1 / -1' }}>
          {error}
        </p>
      )}

      <style>{`
        .search-form {
          display: grid;
          gap: 0.75rem;
          padding: 1rem;
          background: var(--bg-raised);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-card);
        }
        .search-form__actions { display: grid; gap: 0.375rem; }
        /* Mobile first: one column stack, full-width primary action. */
        @media (min-width: 760px) {
          .search-form {
            grid-template-columns: 2fr 1fr 1fr auto auto;
            align-items: end;
            gap: 0.75rem;
          }
          .search-form__actions {
            grid-auto-flow: column;
            align-items: end;
          }
          .search-form--compact { padding: 0.75rem; }
        }
      `}</style>
    </form>
  );
}
