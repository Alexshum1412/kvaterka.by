'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * What a staff member can do to a case.
 *
 * Nothing is decided here. The server sends `availableActions`, computed by the
 * dispute transition table from the case's status and this caller's
 * permissions, and this component renders exactly those — the same arrangement
 * as the booking actions, for the same reason: one table, in the domain, and a
 * console that cannot invent a move the service refuses.
 *
 * A reason is required where the table says it is, and the button stays
 * disabled until there is one. That is not politeness — the reason IS the
 * record. A case closed with no stated basis is indistinguishable later from a
 * case closed by accident.
 */

const ACTION_LABEL: Record<
  string,
  { label: string; tone: 'primary' | 'secondary' | 'danger' | 'ghost'; hint: string; reasonLabel?: string }
> = {
  TAKE: { label: 'Взять в работу', tone: 'primary', hint: 'Обращение закрепится за вами.' },
  RESUME: { label: 'Вернуть в работу', tone: 'primary', hint: 'Сторона ответила — продолжаем разбор.' },
  REQUEST_INFORMATION: {
    label: 'Запросить информацию',
    tone: 'secondary',
    hint: 'Сторона получит уведомление с вашим текстом.',
    reasonLabel: 'Что нужно уточнить — этот текст увидит сторона',
  },
  ESCALATE: {
    label: 'Передать выше',
    tone: 'secondary',
    hint: 'Решение примет администратор.',
    reasonLabel: 'Почему передаёте',
  },
  RESOLVE: {
    label: 'Принять решение',
    tone: 'primary',
    hint: 'Обращение закрывается с записанным решением.',
    reasonLabel: 'Решение по обращению',
  },
  CLOSE: {
    label: 'Закрыть без решения',
    tone: 'ghost',
    hint: 'Дубликат, отозвано или вне зоны ответственности платформы.',
    reasonLabel: 'Почему закрываете',
  },
  REOPEN: {
    label: 'Открыть заново',
    tone: 'secondary',
    hint: 'История прежнего решения сохранится.',
    reasonLabel: 'Почему открываете заново',
  },
};

export interface AvailableAction {
  action: string;
  to: string;
  requiresReason: boolean;
}

/**
 * FNV-1a, hex. Not a security hash — an ASCII-safe fingerprint of the text so
 * an idempotency key can depend on what was typed without putting what was
 * typed into a header.
 */
function asciiDigest(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function DisputeActions({
  caseId,
  actions,
  canHandle,
  canResolve,
  assignedTo,
  assignableStaff,
  currentUserId,
  bookingId,
  bookingStatus,
}: {
  caseId: string;
  actions: readonly AvailableAction[];
  canHandle: boolean;
  canResolve: boolean;
  assignedTo: string | null;
  assignableStaff: readonly { id: string; displayName: string }[];
  currentUserId: string;
  bookingId: string | null;
  bookingStatus: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'COMPLETED' | 'NOT_TAKEN_PLACE' | 'CANCELLED' | ''>('');

  function done() {
    setOpen(null);
    setReason('');
    setBusy(false);
    router.refresh();
  }

  function fail(e: unknown, fallback: string) {
    setError(e instanceof ApiError ? e.message : fallback);
    setBusy(false);
  }

  async function run(action: string, requiresReason: boolean) {
    if (requiresReason && reason.trim().length < 3) {
      setOpen(action);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/admin/disputes/${caseId}/actions`,
        { action, ...(reason.trim() ? { reason: reason.trim() } : {}) },
        // The key has to distinguish two different requests for information on
        // the same case, so it has to depend on the text — but it goes in an
        // HTTP header, and a header cannot carry Cyrillic. Building it from the
        // raw text made `fetch` throw before the request was ever sent, and the
        // component reported it as a failed action. Digest, not substring.
        { idempotencyKey: `${caseId}:${action}:${asciiDigest(reason.trim())}` },
      );
      done();
    } catch (e) {
      fail(e, 'Не удалось выполнить действие');
    }
  }

  async function saveNote() {
    if (note.trim().length < 2) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/disputes/${caseId}/notes`, { note: note.trim() });
      setNote('');
      setBusy(false);
      router.refresh();
    } catch (e) {
      fail(e, 'Не удалось сохранить заметку');
    }
  }

  async function assign(assigneeId: string | null) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/disputes/${caseId}/assign`, { assigneeId });
      setBusy(false);
      router.refresh();
    } catch (e) {
      fail(e, 'Не удалось назначить исполнителя');
    }
  }

  async function decideBooking() {
    if (!outcome || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/admin/disputes/${caseId}/booking-outcome`,
        { outcome, reason: reason.trim() },
        { idempotencyKey: `${caseId}:outcome:${outcome}` },
      );
      setOutcome('');
      done();
    } catch (e) {
      fail(e, 'Не удалось применить решение к бронированию');
    }
  }

  const pending = open ? ACTION_LABEL[open] : null;

  return (
    <div className="da">
      {open && pending ? (
        <div className="da__form">
          <h3 className="title-sm">{pending.label}</h3>
          <label className="field">
            <span className="label">{pending.reasonLabel ?? 'Причина'}</span>
            <textarea
              className="textarea"
              rows={4}
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                open === 'REQUEST_INFORMATION'
                  ? 'Например: пришлите, пожалуйста, фотографии комнаты на момент заселения.'
                  : 'Что вы установили и на каком основании.'
              }
            />
            <span className="hint">
              {open === 'REQUEST_INFORMATION'
                ? 'Этот текст уходит стороне в уведомлении.'
                : 'Останется во внутренней истории обращения. Стороны видят решение, а не переписку сотрудников.'}
            </span>
          </label>
          <div className="da__row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setOpen(null);
                setReason('');
              }}
              disabled={busy}
            >
              Отмена
            </button>
            <button
              type="button"
              className={`btn btn-${pending.tone === 'ghost' ? 'secondary' : pending.tone}`}
              disabled={busy || reason.trim().length < 3}
              onClick={() => void run(open, false)}
            >
              {busy ? 'Сохраняем…' : pending.label}
            </button>
          </div>
        </div>
      ) : (
        <div className="da__buttons">
          {actions.map((a) => {
            const config = ACTION_LABEL[a.action];
            if (!config) return null;
            return (
              <button
                key={a.action}
                type="button"
                className={`btn btn-${config.tone === 'ghost' ? 'ghost' : config.tone}`}
                disabled={busy}
                title={config.hint}
                onClick={() => void run(a.action, a.requiresReason)}
              >
                {config.label}
              </button>
            );
          })}
          {actions.length === 0 && (
            <p className="text-sm muted">
              {canHandle
                ? 'По этому обращению сейчас нет доступных действий.'
                : 'У вас нет прав на изменение обращений — только просмотр.'}
            </p>
          )}
        </div>
      )}

      {/* The booking outcome. Separate from the case workflow on purpose: closing
          a case is bookkeeping, deciding a booking moves money. */}
      {canResolve && bookingId && bookingStatus === 'DISPUTED' && !open && (
        <div className="da__outcome">
          <h3 className="title-sm">Решение по бронированию</h3>
          <p className="hint">
            Бронирование заморожено, сервисный сбор не начисляется. Выберите, что произошло на самом
            деле — последствия рассчитает домен по замороженным условиям брони. Ввести сумму нельзя.
          </p>
          <div className="da__outcomeChoices">
            {[
              { value: 'COMPLETED' as const, label: 'Аренда состоялась', detail: 'Начислится сервисный сбор, откроются отзывы.' },
              { value: 'NOT_TAKEN_PLACE' as const, label: 'Аренда не состоялась', detail: 'Сбор не начисляется, даты освобождаются.' },
              { value: 'CANCELLED' as const, label: 'Считать отменой', detail: 'Бронирование закрывается как отменённое.' },
            ].map((o) => (
              <button
                key={o.value}
                type="button"
                className="da__choice"
                aria-pressed={outcome === o.value}
                onClick={() => setOutcome(outcome === o.value ? '' : o.value)}
              >
                <strong>{o.label}</strong>
                <span>{o.detail}</span>
              </button>
            ))}
          </div>
          {outcome && (
            <>
              <label className="field">
                <span className="label">Основание решения</span>
                <textarea
                  className="textarea"
                  rows={3}
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Что подтверждает этот вывод."
                />
              </label>
              <div className="da__row">
                <button type="button" className="btn btn-ghost" onClick={() => setOutcome('')} disabled={busy}>
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || reason.trim().length < 3}
                  onClick={() => void decideBooking()}
                >
                  {busy ? 'Применяем…' : 'Применить к бронированию'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {canHandle && !open && (
        <div className="da__assign">
          <label className="field">
            <span className="label">Исполнитель</span>
            <select
              className="select"
              value={assignedTo ?? ''}
              disabled={busy}
              onChange={(e) => void assign(e.target.value || null)}
            >
              <option value="">Без исполнителя</option>
              {assignableStaff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                  {s.id === currentUserId ? ' (вы)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {canHandle && !open && (
        <div className="da__note">
          <label className="field">
            <span className="label">Внутренняя заметка</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={4000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Что вы проверили, что осталось сделать."
            />
            <span className="hint">
              Видна только сотрудникам. Не попадает в переписку сторон и не удаляется — история
              обращения только дополняется.
            </span>
          </label>
          <div className="da__row">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || note.trim().length < 2}
              onClick={() => void saveNote()}
            >
              {busy ? 'Сохраняем…' : 'Добавить заметку'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="error-text" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </p>
      )}

      <style>{`
        .da { display: grid; gap: var(--space-4); }
        .da__buttons { display: flex; gap: var(--space-2); flex-wrap: wrap; }
        .da__form, .da__outcome, .da__assign, .da__note { display: grid; gap: var(--space-3); }
        .da__outcome, .da__assign, .da__note { border-top: 1px solid var(--border); padding-top: var(--space-4); }
        .da__row { display: flex; justify-content: flex-end; gap: var(--space-2); }
        .da .error-text { display: flex; align-items: center; gap: 0.35rem; }

        .da__outcomeChoices { display: grid; gap: var(--space-2); }
        .da__choice {
          display: grid; gap: 0.15rem; text-align: left;
          padding: var(--space-3);
          background: var(--surface); border: 1px solid var(--border);
          border-radius: var(--radius-sm); cursor: pointer;
          min-height: 3rem;
        }
        .da__choice:hover { border-color: var(--border-control); }
        .da__choice[aria-pressed='true'] { border-color: var(--primary); background: var(--primary-soft); }
        .da__choice strong { font-size: var(--text-sm); }
        .da__choice span { font-size: var(--text-2xs); color: var(--text-secondary); }

        @media (max-width: 480px) {
          .da__buttons > .btn, .da__row > .btn { flex: 1 1 auto; }
        }
      `}</style>
    </div>
  );
}
