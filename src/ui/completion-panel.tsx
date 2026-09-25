'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation.ts';
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

/** Value → the `Booking.problem*` message key carrying its label. */
const PROBLEM_CATEGORY_KEYS: { value: string; labelKey: string }[] = [
  { value: 'LISTING_MISMATCH', labelKey: 'problemListingMismatch' },
  { value: 'ACCESS_PROBLEM', labelKey: 'problemAccessProblem' },
  { value: 'CLEANLINESS', labelKey: 'problemCleanliness' },
  { value: 'PROPERTY_DAMAGE', labelKey: 'problemPropertyDamage' },
  { value: 'COMMUNICATION', labelKey: 'problemCommunication' },
  { value: 'NO_SHOW', labelKey: 'problemNoShow' },
  { value: 'PAYMENT_DISAGREEMENT', labelKey: 'problemPaymentDisagreement' },
  { value: 'SUSPECTED_FRAUD', labelKey: 'problemSuspectedFraud' },
  { value: 'OTHER', labelKey: 'problemOther' },
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
  const t = useTranslations('Booking');
  const router = useRouter();
  const [view, setView] = useState<'ASK' | 'PROBLEM' | 'DISPUTE'>('ASK');
  const [category, setCategory] = useState(PROBLEM_CATEGORY_KEYS[0]!.value);
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
      setError(e instanceof ApiError ? e.message : t('completionAnswerError'));
    } finally {
      setBusy(false);
    }
  }

  async function openCase() {
    if (summary.trim().length < 10) {
      setError(t('disputeSummaryTooShort'));
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
      setError(e instanceof ApiError ? e.message : t('disputeSubmitError'));
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
          {myAnswer === 'TOOK_PLACE' ? t('confirmedTookPlace') : t('confirmedDidNotTakePlace')}
        </p>
        <p className="cp__wait">
          {theirAnswer !== null
            ? t('bothAnsweredWait')
            : role === 'TENANT'
              ? deadlineLabel
                ? t('waitingForNamedWithDeadline', { name: counterpartyName, date: deadlineLabel })
                : t('waitingForNamed', { name: counterpartyName })
              : deadlineLabel
                ? t('waitingForTenantWithDeadline', { date: deadlineLabel })
                : t('waitingForTenant')}
        </p>
        <PanelStyles />
      </div>
    );
  }

  if (view === 'DISPUTE') {
    return (
      <div className="cp">
        <h3 className="cp__title">{t('disputeTitle')}</h3>
        <p className="cp__lead">{t('disputeLead')}</p>

        <label className="field cp__field">
          <span className="label">{t('disputeCategoryFieldLabel')}</span>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {PROBLEM_CATEGORY_KEYS.map((c) => (
              <option key={c.value} value={c.value}>
                {t(c.labelKey)}
              </option>
            ))}
          </select>
        </label>

        <label className="field cp__field">
          <span className="label">{t('disputeDetailsLabel')}</span>
          <textarea
            className="textarea"
            rows={4}
            maxLength={2000}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder={t('disputeDetailsPlaceholder')}
          />
          <span className="hint">{t('disputeNoContactHint')}</span>
        </label>

        <div className="cp__row">
          <button type="button" className="btn btn-ghost" onClick={() => setView('PROBLEM')} disabled={busy}>
            {t('backButton')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void openCase()} disabled={busy}>
            {busy ? t('sendingEllipsis') : t('submitDisputeButton')}
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
        <h3 className="cp__title">{t('problemTitle')}</h3>
        <div className="cp__choices">
          <button
            type="button"
            className="cp__choice"
            onClick={() => void answer('DID_NOT_TAKE_PLACE')}
            disabled={busy}
          >
            <strong>{t('noRentalChoice')}</strong>
            <span>{role === 'TENANT' ? t('noRentalTenantText') : t('noRentalLandlordText')}</span>
          </button>
          <button type="button" className="cp__choice" onClick={() => setView('DISPUTE')} disabled={busy}>
            <strong>{t('problemOccurredChoice')}</strong>
            <span>{t('problemOccurredText')}</span>
          </button>
        </div>
        <button type="button" className="btn btn-ghost cp__back" onClick={() => setView('ASK')} disabled={busy}>
          {t('backButton')}
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
      <h3 className="cp__title">{role === 'TENANT' ? t('askTenantTitle') : t('askLandlordTitle')}</h3>
      <p className="cp__stay">
        {propertyTitle} · {stayLabel}
      </p>
      <p className="cp__lead">
        {role === 'TENANT' ? t('askTenantLead') : t('askLandlordLead', { name: counterpartyName })}
      </p>

      <div className="cp__row cp__row--main">
        <button type="button" className="btn btn-primary btn-lg" onClick={() => void answer('TOOK_PLACE')} disabled={busy}>
          {busy ? t('sendingEllipsis') : t('allHappenedButton')}
        </button>
        <button type="button" className="btn btn-secondary btn-lg" onClick={() => setView('PROBLEM')} disabled={busy}>
          {t('problemOccurredButton')}
        </button>
      </div>

      {deadlineLabel && (
        <p className="hint cp__deadline">{t('answerDeadlineHint', { date: deadlineLabel })}</p>
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
      @media (hover: hover) and (pointer: fine) {
        .cp__choice:hover { border-color: var(--border-control); }
      }
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
