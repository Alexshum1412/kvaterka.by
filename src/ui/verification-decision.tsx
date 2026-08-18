'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import {
  REASON_SHORT,
  VERIFICATION_REASON_CODES,
  type VerificationReasonCode,
} from '@/server/domain/verification.ts';

/**
 * The verification decision.
 *
 * Three things this component deliberately does not do.
 *
 * It does not choose the buttons: the server sends `availableActions`, computed
 * by the transition table from the status and this caller's permissions, so
 * APPROVE is simply absent for somebody without `document.read` rather than
 * present and rejected.
 *
 * It does not decide whether there is enough evidence. `evidence.sufficient`
 * comes from the domain, and when it is false the approve button is disabled
 * with the reason shown — today that reason is the legal stop on document
 * collection, and saying so is more useful than a button that fails.
 *
 * It does not blur the two audiences. The internal note and the applicant's
 * message are separate fields with separate labels, because a verifier writing
 * "third attempt from this device, photo looks edited" needs somewhere to put
 * it that has no path to the person they are writing about.
 */

export interface AvailableAction {
  action: string;
  to: string;
  requiresReason: boolean;
}

const ACTION_META: Record<
  string,
  { label: string; tone: 'primary' | 'secondary' | 'danger' | 'ghost'; hint: string }
> = {
  TAKE: { label: 'Взять в работу', tone: 'primary', hint: 'Заявка закрепится за вами.' },
  REQUEST_INFO: {
    label: 'Запросить уточнения',
    tone: 'secondary',
    hint: 'Заявитель увидит причины и сможет дополнить заявку, не заполняя всё заново.',
  },
  APPROVE: { label: 'Подтвердить', tone: 'primary', hint: 'Уровень доверия будет выдан.' },
  REJECT: { label: 'Отклонить', tone: 'danger', hint: 'Нужна хотя бы одна причина.' },
  EXPIRE: { label: 'Закрыть как истёкшую', tone: 'ghost', hint: 'Заявитель не отвечает.' },
};

export function VerificationDecision({
  requestId,
  actions,
  evidence,
  assignedTo,
  assignableStaff,
  currentUserId,
  canReadDocuments,
}: {
  requestId: string;
  actions: readonly AvailableAction[];
  evidence: { sufficient: boolean; explanation: string; collectionEnabled: boolean };
  assignedTo: string | null;
  assignableStaff: readonly { id: string; displayName: string }[];
  currentUserId: string;
  canReadDocuments: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [codes, setCodes] = useState<VerificationReasonCode[]>([]);
  const [applicantMessage, setApplicantMessage] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setOpen(null);
    setCodes([]);
    setApplicantMessage('');
    setInternalNote('');
    setBusy(false);
  }

  async function run(action: string, needsReason: boolean) {
    if ((needsReason || action === 'REJECT') && open !== action) {
      setOpen(action);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/admin/verification/requests/${requestId}/actions`,
        {
          action,
          ...(codes.length > 0 ? { reasonCodes: codes } : {}),
          ...(applicantMessage.trim() ? { applicantMessage: applicantMessage.trim() } : {}),
          ...(internalNote.trim() ? { internalNote: internalNote.trim() } : {}),
        },
        // ASCII only: an idempotency key travels in an HTTP header, and a
        // header cannot carry Cyrillic.
        { idempotencyKey: `${requestId}:${action}:${codes.slice().sort().join('.')}` },
      );
      reset();
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось сохранить решение');
      setBusy(false);
    }
  }

  async function assign(assigneeId: string | null) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/verification/requests/${requestId}/assign`, { assigneeId });
      setBusy(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось назначить исполнителя');
      setBusy(false);
    }
  }

  function toggle(code: VerificationReasonCode) {
    setCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  const pending = open ? ACTION_META[open] : null;
  const needsCodes = open === 'REJECT';

  return (
    <div className="vd">
      {open && pending ? (
        <div className="vd__form">
          <h3 className="title-sm">{pending.label}</h3>

          <fieldset className="vd__codes">
            <legend className="label">
              Причины{needsCodes ? '' : ' — по желанию'}
            </legend>
            <p className="hint">
              Код определяет, что увидит заявитель и на какой шаг его отправить. Выберите точнее —
              это разница между «исправьте фото» и «непонятно, что не так».
            </p>
            <div className="vd__chips">
              {VERIFICATION_REASON_CODES.map((code) => (
                <button
                  key={code}
                  type="button"
                  className="chip chip-sm"
                  aria-pressed={codes.includes(code)}
                  onClick={() => toggle(code)}
                >
                  {REASON_SHORT[code]}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="field">
            <span className="label">Сообщение заявителю</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={2000}
              value={applicantMessage}
              onChange={(e) => setApplicantMessage(e.target.value)}
              placeholder="Что человеку сделать. Этот текст он увидит."
            />
            <span className="hint">
              К выбранным причинам платформа сама добавит понятные пояснения — здесь только то, что
              нужно добавить своими словами.
            </span>
          </label>

          <label className="field">
            <span className="label">Внутренняя заметка</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={4000}
              value={internalNote}
              onChange={(e) => setInternalNote(e.target.value)}
              placeholder="Что вы заметили. Заявитель этого не увидит."
            />
            <span className="hint">
              Видна только сотрудникам и не удаляется — история заявки только дополняется.
            </span>
          </label>

          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}

          <div className="vd__row">
            <button type="button" className="btn btn-ghost" onClick={reset} disabled={busy}>
              Отмена
            </button>
            <button
              type="button"
              className={`btn btn-${pending.tone === 'ghost' ? 'secondary' : pending.tone}`}
              disabled={busy || (needsCodes && codes.length === 0)}
              onClick={() => void run(open, false)}
            >
              {busy ? 'Сохраняем…' : pending.label}
            </button>
          </div>
        </div>
      ) : (
        <>
          {!evidence.sufficient && (
            <p className="vd__blocked">
              <Icon name="alert" size={16} />
              {evidence.explanation}
            </p>
          )}

          <div className="vd__buttons">
            {actions.map((a) => {
              const meta = ACTION_META[a.action];
              if (!meta) return null;
              const blocked = a.action === 'APPROVE' && !evidence.sufficient;
              return (
                <button
                  key={a.action}
                  type="button"
                  className={`btn btn-${meta.tone === 'ghost' ? 'ghost' : meta.tone}`}
                  disabled={busy || blocked}
                  title={blocked ? evidence.explanation : meta.hint}
                  onClick={() => void run(a.action, a.requiresReason)}
                >
                  {meta.label}
                </button>
              );
            })}
            {actions.length === 0 && (
              <p className="text-sm muted">
                {canReadDocuments
                  ? 'По этой заявке сейчас нет доступных действий.'
                  : 'Без права на документы можно только смотреть очередь.'}
              </p>
            )}
          </div>

          <div className="vd__assign">
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

          {error && (
            <p className="error-text" role="alert">
              <Icon name="alert" size={15} />
              {error}
            </p>
          )}
        </>
      )}

      <style>{`
        .vd { display: grid; gap: var(--space-3); }
        .vd__buttons { display: flex; gap: var(--space-2); flex-wrap: wrap; }
        .vd__form { display: grid; gap: var(--space-3); }
        .vd__row { display: flex; justify-content: flex-end; gap: var(--space-2); }
        .vd__codes { border: none; padding: 0; margin: 0; display: grid; gap: var(--space-2); }
        .vd__chips { display: flex; gap: var(--space-2); flex-wrap: wrap; }
        .vd__assign { border-top: 1px solid var(--border); padding-top: var(--space-3); }
        .vd__blocked {
          display: flex; align-items: flex-start; gap: 0.45rem;
          padding: var(--space-3); background: var(--warning-soft);
          border-radius: var(--radius-sm);
          font-size: var(--text-xs); line-height: 1.5; color: var(--text-secondary);
        }
        .vd__blocked > svg { color: var(--warning); flex: 0 0 auto; margin-top: 0.1rem; }
        .vd .error-text { display: flex; align-items: center; gap: 0.35rem; }
        @media (max-width: 480px) {
          .vd__buttons > .btn, .vd__row > .btn { flex: 1 1 auto; }
        }
      `}</style>
    </div>
  );
}
