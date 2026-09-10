'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation.ts';
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

const ACTION_TONE: Record<string, 'primary' | 'secondary' | 'danger' | 'ghost'> = {
  TAKE: 'primary',
  REQUEST_INFO: 'secondary',
  APPROVE: 'primary',
  REJECT: 'danger',
  EXPIRE: 'ghost',
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
  const t = useTranslations('StaffVerification');
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
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('decision.errorSaveFailed'));
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
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('decision.errorAssignFailed'));
      setBusy(false);
    }
  }

  function toggle(code: VerificationReasonCode) {
    setCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  const pending = open
    ? { tone: ACTION_TONE[open]!, label: t(`decision.action.${open}.label`), hint: t(`decision.action.${open}.hint`) }
    : null;
  const needsCodes = open === 'REJECT';

  return (
    <div className="vd">
      {open && pending ? (
        <div className="vd__form">
          <h3 className="title-sm">{pending.label}</h3>

          <fieldset className="vd__codes">
            <legend className="label">
              {needsCodes ? t('decision.reasonsLegendRequired') : t('decision.reasonsLegendOptional')}
            </legend>
            <p className="hint">{t('decision.reasonsHint')}</p>
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
            <span className="label">{t('decision.applicantMessageLabel')}</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={2000}
              value={applicantMessage}
              onChange={(e) => setApplicantMessage(e.target.value)}
              placeholder={t('decision.applicantMessagePlaceholder')}
            />
            <span className="hint">{t('decision.applicantMessageHint')}</span>
          </label>

          <label className="field">
            <span className="label">{t('decision.internalNoteLabel')}</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={4000}
              value={internalNote}
              onChange={(e) => setInternalNote(e.target.value)}
              placeholder={t('decision.internalNotePlaceholder')}
            />
            <span className="hint">{t('decision.internalNoteHint')}</span>
          </label>

          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}

          <div className="vd__row">
            <button type="button" className="btn btn-ghost" onClick={reset} disabled={busy}>
              {t('decision.cancel')}
            </button>
            <button
              type="button"
              className={`btn btn-${pending.tone === 'ghost' ? 'secondary' : pending.tone}`}
              disabled={busy || (needsCodes && codes.length === 0)}
              onClick={() => void run(open, false)}
            >
              {busy ? t('decision.saving') : pending.label}
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
              const tone = ACTION_TONE[a.action];
              if (!tone) return null;
              const label = t(`decision.action.${a.action}.label`);
              const hint = t(`decision.action.${a.action}.hint`);
              const blocked = a.action === 'APPROVE' && !evidence.sufficient;
              return (
                <button
                  key={a.action}
                  type="button"
                  className={`btn btn-${tone === 'ghost' ? 'ghost' : tone}`}
                  disabled={busy || blocked}
                  title={blocked ? evidence.explanation : hint}
                  onClick={() => void run(a.action, a.requiresReason)}
                >
                  {label}
                </button>
              );
            })}
            {actions.length === 0 && (
              <p className="text-sm muted">
                {canReadDocuments ? t('decision.noActionsWithAccess') : t('decision.noActionsNoAccess')}
              </p>
            )}
          </div>

          <div className="vd__assign">
            <label className="field">
              <span className="label">{t('decision.assigneeLabel')}</span>
              <select
                className="select"
                value={assignedTo ?? ''}
                disabled={busy}
                onChange={(e) => void assign(e.target.value || null)}
              >
                <option value="">{t('decision.unassignedOption')}</option>
                {assignableStaff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                    {s.id === currentUserId ? t('decision.youSuffix') : ''}
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
