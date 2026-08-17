'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
 * FSM event → the endpoint that performs it and how it reads to a human.
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
  { path: string; label: string; tone: 'primary' | 'secondary' | 'danger'; confirm?: string; needsReason?: boolean }
> = {
  ACCEPT_REQUEST: { path: 'accept', label: 'Принять заявку', tone: 'primary' },
  DECLINE_REQUEST: { path: 'decline', label: 'Отклонить', tone: 'secondary', needsReason: true },
  WITHDRAW: {
    path: 'withdraw',
    label: 'Отозвать заявку',
    tone: 'secondary',
    confirm: 'Отозвать заявку? Хозяин больше не увидит её в списке.',
  },
  CANCEL_BY_TENANT: {
    path: 'cancel',
    label: 'Отменить бронирование',
    tone: 'danger',
    confirm: 'Отменить подтверждённое бронирование?',
    needsReason: true,
  },
  CANCEL_BY_LANDLORD: {
    path: 'cancel',
    label: 'Отменить бронирование',
    tone: 'danger',
    confirm: 'Отменить подтверждённое бронирование? Арендатор уже рассчитывает на эти даты.',
    needsReason: true,
  },
  CHECK_IN: { path: 'check-in', label: 'Подтвердить заселение', tone: 'primary' },
  CHECK_OUT: {
    path: 'check-out',
    label: 'Проживание закончилось',
    tone: 'primary',
    confirm:
      'Отметить, что проживание закончилось? После этого обе стороны подтверждают, состоялась ли аренда.',
  },
};

export function BookingActions({
  bookingId,
  actions,
}: {
  bookingId: string;
  actions: readonly string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const known = actions.filter((a) => a in ACTIONS);
  if (known.length === 0) return null;

  async function run(event: string) {
    const config = ACTIONS[event]!;
    if (config.confirm && !window.confirm(config.confirm)) return;
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
      setError(e instanceof ApiError ? e.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ba">
      {reasonFor && (
        <div className="ba__reason">
          <label className="field">
            <span className="label">Причина</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Коротко объясните — это увидит другая сторона."
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
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy !== null}
              onClick={() => void run(reasonFor)}
            >
              {busy ? 'Отправляем…' : 'Подтвердить'}
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
                {busy === event ? 'Отправляем…' : config.label}
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
