'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * Booking actions.
 *
 * The buttons are not chosen here. The server sends `availableActions`,
 * computed by the booking FSM from the status and the caller's role, and
 * this component renders exactly those. That is the whole point: there is
 * one state machine, it lives in the domain, and the UI cannot invent a
 * transition it does not allow — a stale tab shows a button that the API
 * then refuses, rather than a button the API would have accepted.
 */

/**
 * FSM event → the endpoint that performs it. Text (label/confirm) is resolved
 * from translations inside the component, keyed off this same event name.
 *
 * THE KEYS MUST BE FSM EVENT NAMES. They were `ACCEPT` and `DECLINE` while the
 * transition table emits `ACCEPT_REQUEST` and `DECLINE_REQUEST`, so every
 * incoming action was filtered out as unknown and a landlord looking at a
 * pending request saw the heading «Что можно сделать» with no buttons under it
 * — the one action the whole booking flow depends on. Nothing in typecheck or
 * the API tests could see it, because both sides were internally consistent.
 *
 * CONFIRM_COMPLETION and OPEN_DISPUTE are deliberately absent: they are not
 * one-tap transitions, and the completion panel owns them.
 */
const ACTIONS: Record<
  string,
  { path: string; labelKey: string; tone: 'primary' | 'secondary' | 'danger'; confirmKey?: string; needsReason?: boolean }
> = {
  ACCEPT_REQUEST: { path: 'accept', labelKey: 'actionAcceptLabel', tone: 'primary' },
  DECLINE_REQUEST: { path: 'decline', labelKey: 'actionDeclineLabel', tone: 'secondary', needsReason: true },
  WITHDRAW: {
    path: 'withdraw',
    labelKey: 'actionWithdrawLabel',
    tone: 'secondary',
    confirmKey: 'actionWithdrawConfirm',
  },
  CANCEL_BY_TENANT: {
    path: 'cancel',
    labelKey: 'actionCancelLabel',
    tone: 'danger',
    confirmKey: 'actionCancelTenantConfirm',
    needsReason: true,
  },
  CANCEL_BY_LANDLORD: {
    path: 'cancel',
    labelKey: 'actionCancelLabel',
    tone: 'danger',
    confirmKey: 'actionCancelLandlordConfirm',
    needsReason: true,
  },
  CHECK_IN: { path: 'check-in', labelKey: 'actionCheckInLabel', tone: 'primary' },
  CHECK_OUT: {
    path: 'check-out',
    labelKey: 'actionCheckOutLabel',
    tone: 'primary',
    confirmKey: 'actionCheckOutConfirm',
  },
};

export function BookingActions({
  bookingId,
  actions,
}: {
  bookingId: string;
  actions: readonly string[];
}) {
  const t = useTranslations('Booking');
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const known = actions.filter((a) => a in ACTIONS);
  if (known.length === 0) return null;

  async function run(event: string) {
    const config = ACTIONS[event]!;
    const confirmText = config.confirmKey ? t(config.confirmKey) : null;
    if (confirmText && !window.confirm(confirmText)) return;
    if (config.needsReason && reasonFor !== event) {
      setReasonFor(event);
      return;
    }

    setBusy(event);
    setError(null);
    try {
      await api.post(
        `/bookings/${bookingId}/${config.path}`,
        config.needsReason && reason.trim() ? { reason: reason.trim() } : {},
        // A double tap must not send two decisions.
        { idempotencyKey: `${bookingId}:${event}` },
      );
      setReasonFor(null);
      setReason('');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('actionFailedError'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ba">
      {reasonFor && (
        <div className="ba__reason">
          <label className="field">
            <span className="label">{t('reasonLabel')}</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonPlaceholder')}
            />
          </label>
          <div className="ba__reasonActions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setReasonFor(null);
                setReason('');
              }}
            >
              {t('cancelButton')}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy !== null}
              onClick={() => void run(reasonFor)}
            >
              {busy ? t('sendingEllipsis') : t('confirmButton')}
            </button>
          </div>
        </div>
      )}

      {!reasonFor && (
        <div className="ba__buttons">
          {known.map((event) => {
            const config = ACTIONS[event]!;
            return (
              <button
                key={event}
                type="button"
                className={`btn btn-${config.tone}`}
                disabled={busy !== null}
                onClick={() => void run(event)}
              >
                {busy === event ? t('sendingEllipsis') : t(config.labelKey)}
              </button>
            );
          })}
        </div>
      )}

      {error && (
        <p className="error-text" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </p>
      )}

      <style>{`
        .ba { display: grid; gap: var(--space-3); }
        .ba__buttons { display: flex; gap: var(--space-2); flex-wrap: wrap; }
        .ba__reason { display: grid; gap: var(--space-3); }
        .ba__reasonActions { display: flex; justify-content: flex-end; gap: var(--space-2); }
        .ba .error-text { display: flex; align-items: center; gap: 0.35rem; }
        @media (max-width: 480px) { .ba__buttons > .btn { flex: 1 1 auto; } }
      `}</style>
    </div>
  );
}
