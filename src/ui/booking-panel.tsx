'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client.ts';

interface QuoteLine {
  code: string;
  label: string;
  amountMinor: string;
  amountFormatted: string;
  variable: boolean;
}

interface Quote {
  nights: number;
  lines: QuoteLine[];
  totalExpectedMinor: string;
  depositMinor: string;
  hasVariableCosts: boolean;
}

/**
 * Booking panel.
 *
 * The price breakdown is fetched from the server and shown BEFORE the tenant
 * commits (spec §8). Nothing is computed in the browser: the same quote code
 * that produces this number produces the frozen terms on the booking, so what
 * is shown here is what gets recorded.
 */
export function BookingPanel({
  propertyId,
  minNights,
  maxNights,
  bookingMode,
  basePriceFormatted,
  priceUnit,
}: {
  propertyId: string;
  minNights: number;
  maxNights: number;
  bookingMode: string;
  basePriceFormatted: string;
  priceUnit: string;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [guests, setGuests] = useState(1);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ id: string; status: string } | null>(null);

  const instantAvailable = bookingMode === 'INSTANT' || bookingMode === 'INSTANT_AND_REQUEST';
  const nights =
    from && to ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) : 0;

  const durationValid = nights >= minNights && nights <= maxNights;

  useEffect(() => {
    if (!from || !to || nights <= 0 || !durationValid) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .get<Quote>(`/listings/${propertyId}/quote?from=${from}&to=${to}`)
      .then((data) => {
        if (!cancelled) setQuote(data);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [propertyId, from, to, nights, durationValid]);

  async function submit(instant: boolean) {
    setSubmitting(true);
    setError(null);
    try {
      const booking = await api.post<{ id: string; status: string }>(
        '/bookings',
        { propertyId, from, to, guests, instant },
        // A double-tap on a phone must not create two bookings.
        { idempotencyKey: `${propertyId}:${from}:${to}:${guests}:${instant}` },
      );
      setResult(booking);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить запрос');
    } finally {
      setSubmitting(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  if (result) {
    return (
      <div className="panel stack" style={{ gap: '0.75rem' }} role="status">
        <h3 style={{ fontSize: 'var(--text-lg)' }}>
          {result.status === 'CONFIRMED' ? 'Бронирование подтверждено' : 'Запрос отправлен'}
        </h3>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          {result.status === 'CONFIRMED'
            ? 'Даты закреплены за вами. Точный адрес и контакты хозяина теперь доступны в вашем бронировании.'
            : 'Хозяин ответит в течение 48 часов. Даты пока не заблокированы — их может занять другой запрос, подтверждённый раньше.'}
        </p>
        <a className="btn btn-primary" href={`/bookings/${result.id}`}>
          Перейти к бронированию
        </a>
      </div>
    );
  }

  return (
    <div className="panel stack booking-panel" style={{ gap: '0.875rem' }}>
      <div className="row" style={{ gap: '0.4rem', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 'var(--text-xl)' }}>{basePriceFormatted}</strong>
        <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
          {priceUnit === 'MONTH' ? 'в месяц' : 'за ночь'}
        </span>
      </div>

      <div className="booking-panel__dates">
        <div className="field">
          <label className="label" htmlFor="bp-from">
            Заезд
          </label>
          <input
            id="bp-from"
            className="input"
            type="date"
            min={today}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="bp-to">
            Выезд
          </label>
          <input
            id="bp-to"
            className="input"
            type="date"
            min={from || today}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor="bp-guests">
          Гостей
        </label>
        <input
          id="bp-guests"
          className="input"
          type="number"
          min={1}
          max={50}
          value={guests}
          onChange={(e) => setGuests(Math.max(1, Number(e.target.value) || 1))}
        />
      </div>

      {from && to && nights > 0 && !durationValid && (
        <p className="error-text" role="alert">
          Этот объект сдаётся на срок от {minNights} до {maxNights} ночей. Вы выбрали {nights}.
        </p>
      )}

      {loading && <div className="skeleton" style={{ height: '5rem' }} />}

      {quote && (
        <div className="stack" style={{ gap: '0.4rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
          {quote.lines
            .filter((l) => l.code !== 'DEPOSIT')
            .map((line) => (
              <div key={line.code} className="row" style={{ justifyContent: 'space-between', gap: '1rem' }}>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{line.label}</span>
                <span className="numeric" style={{ fontSize: 'var(--text-sm)' }}>
                  {/* A variable line shows a dash, never a made-up figure. */}
                  {line.variable ? 'по счётчику' : `${line.amountFormatted} BYN`}
                </span>
              </div>
            ))}

          <div
            className="row"
            style={{
              justifyContent: 'space-between',
              gap: '1rem',
              borderTop: '1px solid var(--border)',
              paddingTop: '0.5rem',
              marginTop: '0.25rem',
            }}
          >
            <strong>Итого к оплате хозяину</strong>
            <strong className="numeric">
              {quote.lines.find((l) => l.code === 'RENT') ? formatTotal(quote.totalExpectedMinor) : '—'} BYN
            </strong>
          </div>

          {quote.depositMinor !== '0' && (
            <p className="hint">
              Дополнительно возвратный залог {formatTotal(quote.depositMinor)} BYN — возвращается при выезде.
            </p>
          )}
          {quote.hasVariableCosts && (
            <p className="hint">
              Коммунальные платежи оплачиваются по счётчику и не входят в сумму выше.
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      <div className="stack" style={{ gap: '0.5rem' }}>
        {instantAvailable && (
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            disabled={!quote || submitting}
            onClick={() => submit(true)}
          >
            {submitting ? 'Отправляем…' : 'Забронировать сразу'}
          </button>
        )}
        <button
          type="button"
          className={instantAvailable ? 'btn btn-secondary btn-block' : 'btn btn-primary btn-lg btn-block'}
          disabled={!quote || submitting}
          onClick={() => submit(false)}
        >
          {submitting ? 'Отправляем…' : 'Отправить запрос хозяину'}
        </button>
      </div>

      <p className="hint">
        Оплата аренды происходит напрямую между вами и хозяином. Платформа не принимает арендную
        плату и не является стороной договора.
      </p>

      <style>{`
        .booking-panel__dates { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
      `}</style>
    </div>
  );
}

function formatTotal(minor: string): string {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '−' : ''}${whole},${digits.slice(-2)}`;
}
