'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client.ts';
import { Icon } from './icons.tsx';
import { formatNightsGenitive, plural } from './primitives.tsx';

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
  // A final look before committing, with room for a note to the landlord.
  const [confirming, setConfirming] = useState<'REQUEST' | 'INSTANT' | null>(null);
  const [message, setMessage] = useState('');

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
        { propertyId, from, to, guests, instant, ...(message.trim() ? { message: message.trim() } : {}) },
        // A double-tap on a phone must not create two bookings.
        { idempotencyKey: `${propertyId}:${from}:${to}:${guests}:${instant}` },
      );
      setResult(booking);
      setConfirming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить запрос');
    } finally {
      setSubmitting(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  if (result) {
    return (
      <div className="bp bp--done" role="status">
        <span className="bp__doneMark">
          <Icon name={result.status === 'CONFIRMED' ? 'checkCircle' : 'message'} size={24} />
        </span>
        <h3 className="bp__doneTitle">
          {result.status === 'CONFIRMED' ? 'Бронирование подтверждено' : 'Запрос отправлен'}
        </h3>
        <p className="bp__doneText">
          {result.status === 'CONFIRMED'
            ? 'Даты закреплены за вами. Точный адрес и контакты хозяина теперь доступны в вашем бронировании.'
            : 'Хозяин ответит в течение 48 часов. Даты пока не заблокированы — их может занять другой запрос, подтверждённый раньше.'}
        </p>
        <a className="btn btn-primary btn-block" href={`/bookings/${result.id}`}>
          Перейти к бронированию
        </a>
        <PanelStyles />
      </div>
    );
  }

  return (
    <div className="bp">
      <div className="bp__head">
        <p className="bp__price">
          <strong className="numeric">{basePriceFormatted}</strong>
          <span className="bp__unit">{priceUnit === 'MONTH' ? 'в месяц' : 'за ночь'}</span>
        </p>
        <p className="bp__term">
          <Icon name="calendar" size={14} />
          от {formatNightsGenitive(minNights)} до {formatNightsGenitive(maxNights)}
        </p>
      </div>

      <div className="bp__dates">
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
          Этот объект сдаётся на срок от {formatNightsGenitive(minNights)} до{' '}
          {formatNightsGenitive(maxNights)}. Вы выбрали {nights} {plural(nights, 'ночь', 'ночи', 'ночей')}.
        </p>
      )}

      <div aria-live="polite">
        {loading && <div className="skeleton" style={{ height: '6rem' }} />}

        {quote && (
          <div className="bp__quote">
            <p className="bp__quoteHead">
              Расчёт за {quote.nights} {plural(quote.nights, 'ночь', 'ночи', 'ночей')}
            </p>

            {quote.lines
              .filter((l) => l.code !== 'DEPOSIT')
              .map((line) => (
                <div key={line.code} className="bp__line">
                  <span className="bp__lineLabel">{line.label}</span>
                  <span className="numeric bp__lineValue">
                    {/* A variable line shows a dash, never a made-up figure. */}
                    {line.variable ? 'по счётчику' : `${line.amountFormatted} BYN`}
                  </span>
                </div>
              ))}

            <div className="bp__total">
              <span className="bp__totalLabel">Итого к оплате хозяину</span>
              <strong className="numeric bp__totalValue">
                {quote.lines.find((l) => l.code === 'RENT') ? formatTotal(quote.totalExpectedMinor) : '—'} BYN
              </strong>
            </div>

            {quote.depositMinor !== '0' && (
              <p className="hint">
                Дополнительно возвратный залог {formatTotal(quote.depositMinor)} BYN — возвращается при
                выезде.
              </p>
            )}
            {quote.hasVariableCosts && (
              <p className="hint">Коммунальные платежи оплачиваются по счётчику и не входят в сумму выше.</p>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {confirming === null ? (
        <div className="bp__actions">
          {instantAvailable && (
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              disabled={!quote || submitting}
              onClick={() => setConfirming('INSTANT')}
            >
              Забронировать сразу
            </button>
          )}
          <button
            type="button"
            className={instantAvailable ? 'btn btn-secondary btn-block' : 'btn btn-primary btn-lg btn-block'}
            disabled={!quote || submitting}
            onClick={() => setConfirming('REQUEST')}
          >
            Отправить заявку
          </button>
        </div>
      ) : (
        <div className="bp__confirm">
          <p className="bp__confirmLead">
            {confirming === 'INSTANT'
              ? 'Даты будут закреплены сразу после подтверждения.'
              : 'Хозяин ответит на заявку. Даты пока не закрепляются.'}
          </p>

          <label className="field">
            <span className="label">Сообщение хозяину</span>
            <textarea
              className="textarea"
              rows={4}
              maxLength={2000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Здравствуйте! Планирую приехать в Минск на несколько дней…"
            />
            <span className="hint">
              Необязательно. Контакты и ссылки на другие сервисы в переписке скрываются — до
              подтверждённого бронирования общение идёт здесь.
            </span>
          </label>

          <div className="bp__confirmActions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={submitting}
              onClick={() => setConfirming(null)}
            >
              Назад
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={submitting}
              onClick={() => submit(confirming === 'INSTANT')}
            >
              {submitting ? 'Отправляем…' : confirming === 'INSTANT' ? 'Подтвердить бронирование' : 'Отправить заявку'}
            </button>
          </div>
        </div>
      )}

      <p className="hint">
        Оплата аренды происходит напрямую между вами и хозяином. Платформа не принимает арендную плату и
        не является стороной договора.
      </p>

      <PanelStyles />
    </div>
  );
}

function PanelStyles() {
  return (
    <style>{`
      .bp {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        background: var(--surface);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-raised);
        padding: var(--space-5) var(--space-4);
      }
      @media (min-width: 400px) { .bp { padding: var(--space-5); } }

      .bp__head { display: flex; flex-direction: column; gap: 0.2rem; }
      .bp__price { display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap; }
      .bp__price strong {
        font-size: var(--text-2xl);
        font-weight: 700;
        letter-spacing: -0.03em;
        line-height: 1.15;
      }
      .bp__unit { font-size: var(--text-sm); color: var(--text-secondary); }
      /* The rental term is this product's differentiator, so it travels with
         the price rather than sitting in a table further down the page. */
      .bp__term {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }

      .bp__dates { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: var(--space-2); }

      .bp__quote {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        border-top: 1px solid var(--border);
        padding-top: var(--space-3);
      }
      .bp__quoteHead {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-bottom: 0.15rem;
      }
      .bp__line { display: flex; justify-content: space-between; gap: var(--space-4); align-items: baseline; }
      .bp__lineLabel { font-size: var(--text-sm); color: var(--text-secondary); }
      .bp__lineValue { font-size: var(--text-sm); white-space: nowrap; }

      .bp__total {
        display: flex;
        justify-content: space-between;
        gap: var(--space-4);
        align-items: baseline;
        border-top: 1px solid var(--border);
        margin-top: 0.35rem;
        padding-top: 0.6rem;
      }
      .bp__totalLabel { font-size: var(--text-sm); font-weight: 600; }
      .bp__totalValue { font-size: var(--text-lg); font-weight: 700; letter-spacing: -0.02em; white-space: nowrap; }

      .bp__actions { display: flex; flex-direction: column; gap: var(--space-2); }

      .bp--done { text-align: left; }
      .bp__doneMark { color: var(--success); display: flex; }
      .bp__doneTitle { font-size: var(--text-lg); }
      .bp__doneText { font-size: var(--text-sm); color: var(--text-secondary); }
    `}</style>
  );
}

function formatTotal(minor: string): string {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '−' : ''}${whole},${digits.slice(-2)}`;
}
