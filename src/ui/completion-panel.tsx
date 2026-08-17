'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * The completion question.
 *
 * This is the one screen in the product where the answer decides money, so it
 * is worth being explicit about what it does and does not do:
 *
 *   - It sends an ANSWER, not a verdict. `POST /bookings/:id/completion` records
 *     one side's statement; `resolveCompletion()` in the domain decides the
 *     outcome from both statements plus what the platform itself observed. The
 *     component cannot complete a booking, and does not know the rules.
 *   - «Возникла проблема» is never a dead end and never forces a lie. It offers
 *     the two honest exits: the rental did not happen, or it happened and
 *     something went wrong. The second opens a case and freezes the fee rather
 *     than deciding anything.
 *   - The answer is final once sent, so the UI says so before sending. The
 *     server refuses a changed answer anyway.
 */

type Answer = 'TOOK_PLACE' | 'DID_NOT_TAKE_PLACE';

const PROBLEM_CATEGORIES: { value: string; label: string }[] = [
  { value: 'LISTING_MISMATCH', label: 'Жильё не соответствовало объявлению' },
  { value: 'ACCESS_PROBLEM', label: 'Не смог(ла) попасть в квартиру' },
  { value: 'CLEANLINESS', label: 'Чистота' },
  { value: 'PROPERTY_DAMAGE', label: 'Повреждения имущества' },
  { value: 'COMMUNICATION', label: 'Проблемы со связью и договорённостями' },
  { value: 'NO_SHOW', label: 'Другая сторона не пришла' },
  { value: 'PAYMENT_DISAGREEMENT', label: 'Разногласия по оплате' },
  { value: 'SUSPECTED_FRAUD', label: 'Подозрение на мошенничество' },
  { value: 'OTHER', label: 'Другое' },
];

export function CompletionPanel({
  bookingId,
  role,
  myAnswer,
  theirAnswer,
  deadlineLabel,
  stayLabel,
  propertyTitle,
  counterpartyName,
}: {
  bookingId: string;
  role: 'TENANT' | 'LANDLORD';
  myAnswer: Answer | null;
  theirAnswer: Answer | null;
  deadlineLabel: string | null;
  stayLabel: string;
  propertyTitle: string;
  counterpartyName: string;
}) {
  const router = useRouter();
  const [view, setView] = useState<'ASK' | 'PROBLEM' | 'DISPUTE'>('ASK');
  const [category, setCategory] = useState(PROBLEM_CATEGORIES[0]!.value);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(value: Answer) {
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/bookings/${bookingId}/completion`,
        { answer: value },
        { idempotencyKey: `${bookingId}:completion:${value}` },
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось отправить ответ');
    } finally {
      setBusy(false);
    }
  }

  async function openCase() {
    if (summary.trim().length < 10) {
      setError('Опишите, что произошло — хотя бы одно предложение.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/bookings/${bookingId}/dispute`,
        { category, summary: summary.trim() },
        { idempotencyKey: `${bookingId}:dispute` },
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось отправить обращение');
    } finally {
      setBusy(false);
    }
  }

  /* Already answered: nothing to ask, so say plainly what happens next. */
  if (myAnswer !== null) {
    return (
      <div className="cp cp--done">
        <p className="cp__mine">
          <Icon name="checkCircle" size={18} />
          {myAnswer === 'TOOK_PLACE' ? 'Вы подтвердили, что аренда состоялась.' : 'Вы указали, что аренда не состоялась.'}
        </p>
        <p className="cp__wait">
          {theirAnswer !== null
            ? 'Обе стороны ответили. Итог появится здесь в течение нескольких минут.'
            : role === 'TENANT'
              ? `Ждём ответа от ${counterpartyName}.${deadlineLabel ? ` Если ответа не будет до ${deadlineLabel}, решение примет платформа по имеющимся данным.` : ''}`
              : `Ждём ответа арендатора.${deadlineLabel ? ` Срок — до ${deadlineLabel}.` : ''}`}
        </p>
        <PanelStyles />
      </div>
    );
  }

  if (view === 'DISPUTE') {
    return (
      <div className="cp">
        <h3 className="cp__title">Расскажите, что произошло</h3>
        <p className="cp__lead">
          Обращение увидит поддержка Кватэрка.by. Пока идёт разбор, сервисный сбор по этой аренде не
          начисляется.
        </p>

        <label className="field cp__field">
          <span className="label">Что случилось</span>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {PROBLEM_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field cp__field">
          <span className="label">Подробности</span>
          <textarea
            className="textarea"
            rows={4}
            maxLength={2000}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Что произошло, когда, и что вы уже пробовали сделать."
          />
          <span className="hint">Не указывайте телефоны и email — переписку ведём здесь.</span>
        </label>

        <div className="cp__row">
          <button type="button" className="btn btn-ghost" onClick={() => setView('PROBLEM')} disabled={busy}>
            Назад
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void openCase()} disabled={busy}>
            {busy ? 'Отправляем…' : 'Отправить обращение'}
          </button>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <PanelStyles />
      </div>
    );
  }

  if (view === 'PROBLEM') {
    return (
      <div className="cp">
        <h3 className="cp__title">Что именно пошло не так?</h3>
        <div className="cp__choices">
          <button
            type="button"
            className="cp__choice"
            onClick={() => void answer('DID_NOT_TAKE_PLACE')}
            disabled={busy}
          >
            <strong>Аренды не было</strong>
            <span>
              {role === 'TENANT'
                ? 'Я не заселялся и не проживал по этому бронированию.'
                : 'Арендатор не приехал, жильё не сдавалось.'}
            </span>
          </button>
          <button type="button" className="cp__choice" onClick={() => setView('DISPUTE')} disabled={busy}>
            <strong>Аренда была, но возникла проблема</strong>
            <span>Опишем ситуацию, и её посмотрит поддержка.</span>
          </button>
        </div>
        <button type="button" className="btn btn-ghost cp__back" onClick={() => setView('ASK')} disabled={busy}>
          Назад
        </button>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <PanelStyles />
      </div>
    );
  }

  return (
    <div className="cp">
      <h3 className="cp__title">{role === 'TENANT' ? 'Проживание завершено?' : 'Аренда завершена?'}</h3>
      <p className="cp__stay">
        {propertyTitle} · {stayLabel}
      </p>
      <p className="cp__lead">
        {role === 'TENANT'
          ? 'Подтвердите, что вы действительно проживали. После этого можно оставить отзыв.'
          : `Подтвердите, что аренда с ${counterpartyName} состоялась. После этого откроются отзывы.`}
      </p>

      <div className="cp__row cp__row--main">
        <button type="button" className="btn btn-primary btn-lg" onClick={() => void answer('TOOK_PLACE')} disabled={busy}>
          {busy ? 'Отправляем…' : 'Да, всё состоялось'}
        </button>
        <button type="button" className="btn btn-secondary btn-lg" onClick={() => setView('PROBLEM')} disabled={busy}>
          Возникла проблема
        </button>
      </div>

      {deadlineLabel && (
        <p className="hint cp__deadline">
          Ответить можно до {deadlineLabel}. Ответ нельзя изменить.
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <PanelStyles />
    </div>
  );
}

function PanelStyles() {
  return (
    <style>{`
      .cp { display: grid; gap: var(--space-3); }
      .cp__title { font-size: var(--text-lg); font-weight: 650; letter-spacing: -0.015em; }
      .cp__stay { font-size: var(--text-sm); color: var(--text-secondary); }
      .cp__lead { font-size: var(--text-sm); line-height: 1.55; color: var(--text-secondary); max-width: 52ch; }
      .cp__field { margin-top: var(--space-1); }
      .cp__row { display: flex; gap: var(--space-2); flex-wrap: wrap; justify-content: flex-end; }
      .cp__row--main { justify-content: flex-start; margin-top: var(--space-2); }
      .cp__deadline { margin-top: calc(var(--space-2) * -1); }
      .cp__back { justify-self: start; }

      .cp__choices { display: grid; gap: var(--space-2); }
      .cp__choice {
        display: grid; gap: 0.15rem; text-align: left;
        padding: var(--space-3) var(--space-4);
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius-md); cursor: pointer;
        min-height: 3.25rem;
      }
      .cp__choice:hover { border-color: var(--border-control); }
      .cp__choice strong { font-size: var(--text-sm); }
      .cp__choice span { font-size: var(--text-xs); color: var(--text-secondary); }

      .cp--done { gap: var(--space-2); }
      .cp__mine { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); font-weight: 600; color: var(--success); }
      .cp__wait { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.55; max-width: 56ch; }

      @media (max-width: 480px) {
        .cp__row--main { display: grid; }
        .cp__row--main > .btn { width: 100%; }
      }
    `}</style>
  );
}
