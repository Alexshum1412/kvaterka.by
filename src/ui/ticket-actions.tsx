'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * What a staff member can do to a ticket.
 *
 * The simpler sibling of `DisputeActions`: same discipline (the server sends
 * `availableActions` from the transition table, this component renders
 * exactly those and nothing it invents), no booking-outcome section — a
 * ticket never has a booking to decide.
 *
 * `RESOLVE`/`CLOSE` write into `resolution` (the ticket's own decision
 * record, later shown to its author); every other action writes into `note`
 * (`REQUEST_INFO`'s note being the one the author actually reads). The two
 * fields are never sent together.
 */

const ACTION_TONE: Record<string, 'primary' | 'secondary' | 'danger' | 'ghost'> = {
  TAKE: 'primary',
  RESUME: 'primary',
  REQUEST_INFO: 'secondary',
  RESOLVE: 'primary',
  CLOSE: 'ghost',
  REOPEN: 'secondary',
};

const ACTION_KEYS: Record<string, { label: string; hint: string; reasonLabel?: string; terminal: boolean }> = {
  TAKE: { label: 'actionTakeLabel', hint: 'actionTakeHint', terminal: false },
  RESUME: { label: 'actionResumeLabel', hint: 'actionResumeHint', terminal: false },
  REQUEST_INFO: {
    label: 'actionRequestInfoLabel',
    hint: 'actionRequestInfoHint',
    reasonLabel: 'actionRequestInfoReasonLabel',
    terminal: false,
  },
  RESOLVE: {
    label: 'actionResolveLabel',
    hint: 'actionResolveHint',
    reasonLabel: 'actionResolveReasonLabel',
    terminal: true,
  },
  CLOSE: {
    label: 'actionCloseLabel',
    hint: 'actionCloseHint',
    reasonLabel: 'actionCloseReasonLabel',
    terminal: true,
  },
  REOPEN: {
    label: 'actionReopenLabel',
    hint: 'actionReopenHint',
    reasonLabel: 'actionReopenReasonLabel',
    terminal: false,
  },
};

export interface AvailableTicketAction {
  action: string;
  to: string;
  requiresReason: boolean;
}

export function TicketActions({
  ticketId,
  actions,
  canHandle,
  assignedTo,
  assignableStaff,
  currentUserId,
}: {
  ticketId: string;
  actions: readonly AvailableTicketAction[];
  canHandle: boolean;
  assignedTo: string | null;
  assignableStaff: readonly { id: string; displayName: string }[];
  currentUserId: string;
}) {
  const t = useTranslations('SupportTickets');
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ACTION_LABEL: Record<
    string,
    { label: string; tone: 'primary' | 'secondary' | 'danger' | 'ghost'; hint: string; reasonLabel?: string; terminal: boolean }
  > = Object.fromEntries(
    Object.entries(ACTION_KEYS).map(([action, k]) => [
      action,
      {
        label: t(k.label),
        tone: ACTION_TONE[action]!,
        hint: t(k.hint),
        reasonLabel: k.reasonLabel ? t(k.reasonLabel) : undefined,
        terminal: k.terminal,
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

  async function run(action: string, requiresReason: boolean, terminal: boolean) {
    if (requiresReason && reason.trim().length < 3) {
      setOpen(action);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const text = reason.trim();
      await api.post(
        `/admin/tickets/${ticketId}/actions`,
        { action, ...(text ? (terminal ? { resolution: text } : { note: text }) : {}) },
        { idempotencyKey: `${ticketId}:${action}:${text.length}` },
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
      await api.post(`/admin/tickets/${ticketId}/notes`, { note: note.trim() });
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
      await api.post(`/admin/tickets/${ticketId}/assign`, { assigneeId });
      setBusy(false);
      router.refresh();
    } catch (e) {
      fail(e, t('errorAssignFailed'));
    }
  }

  const pending = open ? ACTION_LABEL[open] : null;

  return (
    <div className="ta">
      {open && pending ? (
        <div className="ta__form">
          <h3 className="title-sm">{pending.label}</h3>
          <label className="field">
            <span className="label">{pending.reasonLabel ?? t('defaultReasonLabel')}</span>
            <textarea
              className="textarea"
              rows={4}
              maxLength={pending.terminal ? 4000 : 2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={open === 'REQUEST_INFO' ? t('reasonPlaceholderRequestInfo') : t('reasonPlaceholderDefault')}
            />
            <span className="hint">
              {open === 'REQUEST_INFO' || pending.terminal ? t('reasonHintRequestInfo') : t('reasonHintDefault')}
            </span>
          </label>
          <div className="ta__row">
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
              onClick={() => void run(open, false, pending.terminal)}
            >
              {busy ? t('savingButton') : pending.label}
            </button>
          </div>
        </div>
      ) : (
        <div className="ta__buttons">
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
                onClick={() => void run(a.action, a.requiresReason, config.terminal)}
              >
                {config.label}
              </button>
            );
          })}
          {actions.length === 0 && (
            <p className="text-sm muted">{canHandle ? t('noActionsHandle') : t('noActionsView')}</p>
          )}
        </div>
      )}

      {canHandle && !open && (
        <div className="ta__assign">
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
        <div className="ta__note">
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
          <div className="ta__row">
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
        .ta { display: grid; gap: var(--space-4); }
        .ta__buttons { display: flex; gap: var(--space-2); flex-wrap: wrap; }
        .ta__form, .ta__assign, .ta__note { display: grid; gap: var(--space-3); }
        .ta__assign, .ta__note { border-top: 1px solid var(--border); padding-top: var(--space-4); }
        .ta__row { display: flex; justify-content: flex-end; gap: var(--space-2); }
        .ta .error-text { display: flex; align-items: center; gap: 0.35rem; }

        @media (max-width: 480px) {
          .ta__buttons > .btn, .ta__row > .btn { flex: 1 1 auto; }
        }
      `}</style>
    </div>
  );
}
