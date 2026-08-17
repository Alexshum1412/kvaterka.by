'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * Writing a review.
 *
 * Shape of the screen (spec §15): a rating, then the structured questions, then
 * the things that can be confirmed, and text last and optional. A blank
 * textarea as the primary experience produces «всё хорошо, спасибо», which
 * tells the next tenant nothing.
 *
 * Two rules are the server's and are NOT duplicated here as validation:
 *   - the stay length comes from the booking, so it is displayed, never asked;
 *   - a rating of 1–2 needs an explanation. The server enforces it; this form
 *     asks for it up front so nobody types a review and then loses it to a 422.
 *
 * Publication timing is also the server's: reviews go live when both sides have
 * written or when the window closes, so neither side can see the other's first.
 * The form says so, because a person who does not know that assumes the worst.
 */

type Role = 'TENANT' | 'LANDLORD';

interface Dimension {
  key: string;
  label: string;
  help: string;
  required: boolean;
}

const TENANT_DIMENSIONS: Dimension[] = [
  { key: 'accuracy', label: 'Соответствие описанию', help: 'Совпало ли жильё с фотографиями и текстом', required: true },
  { key: 'cleanliness', label: 'Чистота', help: 'Каким вы застали жильё', required: true },
  { key: 'communication', label: 'Общение с хозяином', help: 'Отвечал ли понятно и вовремя', required: true },
  { key: 'checkIn', label: 'Заселение', help: 'Насколько просто было попасть внутрь', required: false },
  { key: 'location', label: 'Расположение', help: 'Район, транспорт, что рядом', required: false },
  { key: 'value', label: 'Цена и качество', help: 'Оправдала ли квартира свою цену', required: false },
  { key: 'rulesClarity', label: 'Понятность правил', help: 'Было ли заранее ясно, что можно', required: false },
];

const LANDLORD_DIMENSIONS: Dimension[] = [
  { key: 'ruleCompliance', label: 'Соблюдение правил', help: 'Гости, тишина, курение, животные', required: true },
  { key: 'propertyCondition', label: 'Аккуратность', help: 'В каком состоянии оставили жильё', required: true },
  { key: 'communication', label: 'Общение', help: 'Отвечал ли понятно и вовремя', required: true },
  { key: 'timeliness', label: 'Соблюдение сроков', help: 'Заселение и выезд в договорённое время', required: false },
];

const OVERALL_WORDS = ['', 'Плохо', 'Так себе', 'Нормально', 'Хорошо', 'Отлично'];

const MIN_TEXT_FOR_LOW_RATING = 20;

export function ReviewForm({
  bookingId,
  role,
  propertyTitle,
  counterpartyName,
  stayLabel,
  facts,
}: {
  bookingId: string;
  role: Role;
  propertyTitle: string;
  counterpartyName: string;
  /** Derived from the booking. Shown, never asked. */
  stayLabel: string;
  /** Amenities the listing claims, for the guest to confirm or contradict. */
  facts: readonly { code: string; label: string }[];
}) {
  const router = useRouter();
  const dimensions = role === 'TENANT' ? TENANT_DIMENSIONS : LANDLORD_DIMENSIONS;

  const [overall, setOverall] = useState(0);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [body, setBody] = useState('');
  const [wouldRentAgain, setWouldRentAgain] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});

  const needsExplanation = overall > 0 && overall <= 2;
  const missingRequired = dimensions.filter((d) => d.required && !scores[d.key]).map((d) => d.key);
  const canSubmit =
    overall > 0 &&
    missingRequired.length === 0 &&
    (!needsExplanation || body.trim().length >= MIN_TEXT_FOR_LOW_RATING);

  function cycleFact(code: string) {
    setConfirmed((prev) => {
      const next = { ...prev };
      if (!(code in next)) next[code] = true;
      else if (next[code]) next[code] = false;
      else delete next[code];
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;

    setBusy(true);
    setError(null);
    setFieldError({});

    const payload: Record<string, unknown> = { role, overall };
    for (const d of dimensions) if (scores[d.key]) payload[d.key] = scores[d.key];
    if (body.trim()) payload.body = body.trim();
    if (wouldRentAgain !== null) payload.wouldRentAgain = wouldRentAgain;
    if (role === 'TENANT' && Object.keys(confirmed).length > 0) payload.confirmedFacts = confirmed;

    try {
      const result = await api.post<{ published: boolean }>(
        `/bookings/${bookingId}/reviews`,
        payload,
        { idempotencyKey: `${bookingId}:review:${role}` },
      );
      router.replace(`/bookings/${bookingId}?review=${result.published ? 'published' : 'saved'}`);
      router.refresh();
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setFieldError(e.fieldErrors);
      } else {
        setError('Не удалось отправить отзыв');
      }
      setBusy(false);
    }
  }

  return (
    <form className="rf" onSubmit={submit}>
      <header className="rf__head">
        <h1 className="rf__title">{role === 'TENANT' ? 'Как прошла аренда?' : 'Каким был арендатор?'}</h1>
        <p className="rf__about">
          {role === 'TENANT' ? propertyTitle : counterpartyName} · {stayLabel}
        </p>
        <p className="rf__note">
          <Icon name="info" size={15} />
          Отзывы обеих сторон публикуются одновременно — вы не увидите оценку другой стороны, пока не
          отправите свою.
        </p>
      </header>

      <section className="rf__block">
        <h2 className="rf__h2">Общая оценка</h2>
        <Stars value={overall} onChange={setOverall} size="lg" label="Общая оценка" />
        {overall > 0 && <p className="rf__word">{OVERALL_WORDS[overall]}</p>}
      </section>

      <section className="rf__block">
        <h2 className="rf__h2">Подробнее</h2>
        <ul className="rf__dims">
          {dimensions.map((d) => (
            <li key={d.key} className="rf__dim">
              <span className="rf__dimText">
                <span className="rf__dimLabel">
                  {d.label}
                  {!d.required && <span className="rf__optional"> — если важно</span>}
                </span>
                <span className="rf__dimHelp">{d.help}</span>
              </span>
              <Stars
                value={scores[d.key] ?? 0}
                onChange={(v) => setScores((prev) => ({ ...prev, [d.key]: v }))}
                label={d.label}
              />
            </li>
          ))}
        </ul>
        {missingRequired.length > 0 && overall > 0 && (
          <p className="hint">Оцените обязательные пункты, чтобы отправить отзыв.</p>
        )}
      </section>

      {role === 'TENANT' && facts.length > 0 && (
        <section className="rf__block">
          <h2 className="rf__h2">Что подтвердилось</h2>
          <p className="hint rf__factsHint">
            Нажмите один раз — «было на месте», второй — «не было». Это то, что видят следующие
            гости рядом с описанием хозяина.
          </p>
          <div className="rf__facts">
            {facts.map((f) => {
              const state = f.code in confirmed ? (confirmed[f.code] ? 'yes' : 'no') : 'unset';
              return (
                <button
                  key={f.code}
                  type="button"
                  className="rf__fact"
                  data-state={state}
                  onClick={() => cycleFact(f.code)}
                  aria-label={`${f.label}: ${state === 'yes' ? 'было на месте' : state === 'no' ? 'не было' : 'не отмечено'}`}
                >
                  {state === 'yes' && <Icon name="check" size={13} />}
                  {state === 'no' && <Icon name="close" size={13} />}
                  {f.label}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="rf__block">
        <h2 className="rf__h2">
          Комментарий{' '}
          <span className="rf__optional">{needsExplanation ? '— обязательно' : '— по желанию'}</span>
        </h2>
        <textarea
          className="textarea"
          rows={4}
          maxLength={4000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-invalid={fieldError.body ? 'true' : undefined}
          placeholder={
            role === 'TENANT'
              ? 'Что стоит знать следующему гостю: что понравилось, что удивило.'
              : 'Что стоит знать другим хозяевам об этом арендаторе.'
          }
        />
        {needsExplanation && body.trim().length < MIN_TEXT_FOR_LOW_RATING && (
          <p className="hint">
            Низкая оценка публикуется только с пояснением — осталось{' '}
            {MIN_TEXT_FOR_LOW_RATING - body.trim().length} символов.
          </p>
        )}
        {fieldError.body && <p className="error-text">{fieldError.body}</p>}
      </section>

      <section className="rf__block">
        <h2 className="rf__h2">
          {role === 'TENANT' ? 'Снимете это жильё снова?' : 'Пустите этого арендатора снова?'}
        </h2>
        <div className="rf__yesno">
          {[
            { value: true, label: 'Да' },
            { value: false, label: 'Нет' },
          ].map((o) => (
            <button
              key={String(o.value)}
              type="button"
              className="chip"
              aria-pressed={wouldRentAgain === o.value}
              onClick={() => setWouldRentAgain(wouldRentAgain === o.value ? null : o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </section>

      {error && (
        <p className="error-text rf__error" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </p>
      )}

      <div className="rf__submit">
        <button type="submit" className="btn btn-primary btn-lg" disabled={!canSubmit || busy}>
          {busy ? 'Отправляем…' : 'Отправить отзыв'}
        </button>
        <p className="hint">Опубликованный отзыв нельзя изменить — он часть истории обеих сторон.</p>
      </div>

      <style>{`
        .rf { display: grid; gap: var(--space-6); max-width: 40rem; }
        .rf__head { display: grid; gap: var(--space-2); }
        .rf__title { font-size: var(--text-2xl); font-weight: 650; letter-spacing: -0.022em; }
        .rf__about { font-size: var(--text-sm); color: var(--text-secondary); }
        .rf__note {
          display: flex; align-items: flex-start; gap: 0.45rem;
          margin-top: var(--space-1); padding: var(--space-3);
          background: var(--primary-soft); border-radius: var(--radius-sm);
          font-size: var(--text-xs); line-height: 1.5; color: var(--text-secondary);
        }
        .rf__note > svg { color: var(--primary); flex: 0 0 auto; margin-top: 0.05rem; }

        .rf__block { display: grid; gap: var(--space-3); }
        .rf__block + .rf__block { border-top: 1px solid var(--border); padding-top: var(--space-5); }
        .rf__h2 { font-size: var(--text-base); font-weight: 600; }
        .rf__optional { font-weight: 400; color: var(--text-tertiary); font-size: var(--text-xs); }
        .rf__word { font-size: var(--text-sm); font-weight: 600; color: var(--primary); }

        .rf__dims { display: grid; gap: var(--space-4); margin: 0; padding: 0; list-style: none; }
        .rf__dim { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
        .rf__dimText { display: grid; gap: 0.1rem; min-width: 0; }
        .rf__dimLabel { font-size: var(--text-sm); }
        .rf__dimHelp { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .rf__factsHint { max-width: 52ch; }
        .rf__facts { display: flex; flex-wrap: wrap; gap: var(--space-2); }
        .rf__fact {
          display: inline-flex; align-items: center; gap: 0.3rem;
          min-height: 2.375rem; padding: 0.4rem 0.8rem;
          background: var(--surface); border: 1px solid var(--border);
          border-radius: var(--radius-full);
          font-size: var(--text-xs); font-weight: 500; color: var(--text-secondary);
          cursor: pointer;
        }
        .rf__fact:hover { border-color: var(--border-control); }
        .rf__fact[data-state='yes'] { background: var(--success-soft); border-color: var(--success); color: var(--success); }
        .rf__fact[data-state='no'] { background: var(--surface-sunken); border-color: var(--border-strong); color: var(--text-primary); text-decoration: line-through; }

        .rf__yesno { display: flex; gap: var(--space-2); }
        .rf__error { display: flex; align-items: center; gap: 0.35rem; }
        .rf__submit { display: grid; gap: var(--space-2); justify-items: start; }

        @media (max-width: 480px) {
          .rf__dim { align-items: flex-start; }
          .rf__submit > .btn { width: 100%; }
        }
      `}</style>
    </form>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Five stars, as five real radio-ish buttons.
 *
 * No rating library: this is five buttons and a filled/unfilled icon. Each has
 * its own accessible name, so it works from the keyboard and reads correctly to
 * a screen reader — which a div-with-onClick star widget does not.
 */
function Stars({
  value,
  onChange,
  label,
  size = 'md',
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  size?: 'md' | 'lg';
}) {
  return (
    <span className="st" data-size={size} role="group" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className="st__btn"
          data-on={n <= value}
          aria-pressed={n === value}
          aria-label={`${label}: ${n} из 5`}
          onClick={() => onChange(n)}
        >
          <Icon name="star" size={size === 'lg' ? 28 : 20} solid={n <= value} />
        </button>
      ))}
      <style>{`
        .st { display: inline-flex; gap: 0.1rem; }
        .st__btn {
          display: grid; place-items: center;
          width: 2.25rem; height: 2.25rem; padding: 0;
          background: none; border: none; border-radius: var(--radius-sm);
          color: var(--border-strong); cursor: pointer;
        }
        .st[data-size='lg'] .st__btn { width: 2.75rem; height: 2.75rem; }
        .st__btn[data-on='true'] { color: var(--warning); }
        .st__btn:hover { background: var(--surface-sunken); }
      `}</style>
    </span>
  );
}
