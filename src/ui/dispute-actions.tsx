'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation.ts';
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

const ACTION_TONE: Record<string, 'primary' | 'secondary' | 'danger' | 'ghost'> = {
  TAKE: 'primary',
  RESUME: 'primary',
  REQUEST_INFORMATION: 'secondary',
  ESCALATE: 'secondary',
  RESOLVE: 'primary',
  CLOSE: 'ghost',
  REOPEN: 'secondary',
};

const ACTION_KEYS: Record<string, { label: string; hint: string; reasonLabel?: string }> = {
  TAKE: { label: 'actionTakeLabel', hint: 'actionTakeHint' },
  RESUME: { label: 'actionResumeLabel', hint: 'actionResumeHint' },
  REQUEST_INFORMATION: {
    label: 'actionRequestInfoLabel',
    hint: 'actionRequestInfoHint',
    reasonLabel: 'actionRequestInfoReasonLabel',
  },
  ESCALATE: {
    label: 'actionEscalateLabel',
    hint: 'actionEscalateHint',
    reasonLabel: 'actionEscalateReasonLabel',
  },
  RESOLVE: {
    label: 'actionResolveLabel',
    hint: 'actionResolveHint',
    reasonLabel: 'actionResolveReasonLabel',
  },
  CLOSE: {
    label: 'actionCloseLabel',
    hint: 'actionCloseHint',
    reasonLabel: 'actionCloseReasonLabel',
  },
  REOPEN: {
    label: 'actionReopenLabel',
    hint: 'actionReopenHint',
    reasonLabel: 'actionReopenReasonLabel',
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
  const t = useTranslations('Disputes');
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'COMPLETED' | 'NOT_TAKEN_PLACE' | 'CANCELLED' | ''>('');

  const ACTION_LABEL: Record<
    string,
    { label: string; tone: 'primary' | 'secondary' | 'danger' | 'ghost'; hint: string; reasonLabel?: string }
  > = Object.fromEntries(
    Object.entries(ACTION_KEYS).map(([action, k]) => [
      action,
      {
        label: t(k.label),
        tone: ACTION_TONE[action]!,
        hint: t(k.hint),
        reasonLabel: k.reasonLabel ? t(k.reasonLabel) : undefined,
      },
    ]),
  );

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
      fail(e, t('errorActionFailed'));
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
      fail(e, t('errorNoteFailed'));
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
      fail(e, t('errorAssignFailed'));
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
      fail(e, t('errorOutcomeFailed'));
    }
  }

  const pending = open ? ACTION_LABEL[open] : null;

  const OUTCOME_CHOICES = [
    { value: 'COMPLETED' as const, label: t('outcomeCompletedLabel'), detail: t('outcomeCompletedDetail') },
    { value: 'NOT_TAKEN_PLACE' as const, label: t('outcomeNotTakenLabel'), detail: t('outcomeNotTakenDetail') },
    { value: 'CANCELLED' as const, label: t('outcomeCancelledLabel'), detail: t('outcomeCancelledDetail') },
  ];

  return (
    <div className="da">
      {open && pending ? (
        <div className="da__form">
          <h3 className="title-sm">{pending.label}</h3>
          <label className="field">
            <span className="label">{pending.reasonLabel ?? t('defaultReasonLabel')}</span>
            <textarea
              className="textarea"
              rows={4}
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                open === 'REQUEST_INFORMATION'
                  ? t('reasonPlaceholderRequestInfo')
                  : t('reasonPlaceholderDefault')
              }
            />
            <span className="hint">
              {open === 'REQUEST_INFORMATION' ? t('reasonHintRequestInfo') : t('reasonHintDefault')}
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
              {t('cancelButton')}
            </button>
            <button
              type="button"
              className={`btn btn-${pending.tone === 'ghost' ? 'secondary' : pending.tone}`}
              disabled={busy || reason.trim().length < 3}
              onClick={() => void run(open, false)}
            >
              {busy ? t('savingButton') : pending.label}
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
              {canHandle ? t('noActionsHandle') : t('noActionsView')}
            </p>
          )}
        </div>
      )}

      {/* The booking outcome. Separate from the case workflow on purpose: closing
          a case is bookkeeping, deciding a booking moves money. */}
      {canResolve && bookingId && bookingStatus === 'DISPUTED' && !open && (
        <div className="da__outcome">
          <h3 className="title-sm">{t('outcomeTitle')}</h3>
          <p className="hint">{t('outcomeHint')}</p>
          <div className="da__outcomeChoices">
            {OUTCOME_CHOICES.map((o) => (
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
                <span className="label">{t('outcomeReasonLabel')}</span>
                <textarea
                  className="textarea"
                  rows={3}
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t('outcomeReasonPlaceholder')}
                />
              </label>
              <div className="da__row">
                <button type="button" className="btn btn-ghost" onClick={() => setOutcome('')} disabled={busy}>
                  {t('cancelButton')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || reason.trim().length < 3}
                  onClick={() => void decideBooking()}
                >
                  {busy ? t('outcomeApplying') : t('outcomeApplyButton')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {canHandle && !open && (
        <div className="da__assign">
          <label className="field">
            <span className="label">{t('assignLabel')}</span>
            <select
              className="select"
              value={assignedTo ?? ''}
              disabled={busy}
              onChange={(e) => void assign(e.target.value || null)}
            >
              <option value="">{t('assignNone')}</option>
              {assignableStaff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                  {s.id === currentUserId ? t('assignYouSuffix') : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {canHandle && !open && (
        <div className="da__note">
          <label className="field">
            <span className="label">{t('noteLabel')}</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={4000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('notePlaceholder')}
            />
            <span className="hint">{t('noteHint')}</span>
          </label>
          <div className="da__row">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || note.trim().length < 2}
              onClick={() => void saveNote()}
            >
              {busy ? t('noteSaving') : t('noteSaveButton')}
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
