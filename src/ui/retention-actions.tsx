'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import {
  HOLD_REASON_CODES,
  HOLD_REASON_LABEL,
  HOLD_TARGET_LABEL,
  HOLD_TARGET_TYPES,
  type HoldReasonCode,
  type HoldTargetType,
} from '@/server/domain/retention.ts';

/**
 * Placing and lifting holds, and running the sweep.
 *
 * The asymmetry between the two hold controls is the point, and it is visible
 * rather than merely enforced: placing takes a reason and a code and is offered
 * to anyone who can reach this page, while lifting asks for a written reason in
 * a field that says who will read it, and is simply absent for anybody who is
 * not an administrator. A greyed-out «снять» would tell a support agent that
 * the control exists and they are not trusted with it.
 *
 * The run button says what it will do BEFORE it does it, including — today —
 * that it will destroy nothing. A button labelled «Запустить» that returns
 * "0 purged" reads as a broken feature; one that says in advance that no
 * retention window is set reads as the product being careful.
 */

function useAction(errorFallback: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : errorFallback);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, run };
}

/* ------------------------------------------------------------------ *
 * Place
 * ------------------------------------------------------------------ */

export function PlaceHold({
  targetType,
  targetId,
  compact,
}: {
  targetType?: HoldTargetType;
  targetId?: string;
  compact?: boolean;
}) {
  const t = useTranslations('Retention');
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<HoldTargetType>(targetType ?? 'user');
  const [id, setId] = useState(targetId ?? '');
  const [code, setCode] = useState<HoldReasonCode>('DISPUTE_OPEN');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction(t('errorGeneric'));

  if (!open) {
    return (
      <button type="button" className={compact ? 'btn btn-ghost btn-sm' : 'btn btn-secondary'} onClick={() => setOpen(true)}>
        <Icon name="shield" size={16} />
        {t('placeHoldButton')}
      </button>
    );
  }

  return (
    <form
      className="ret__form"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run(() =>
          api.post('/admin/legal-holds', { targetType: type, targetId: id.trim(), reasonCode: code, reason: reason.trim() }),
        );
        if (ok) setOpen(false);
      }}
    >
      <p className="ret__formNote">{t('placeHoldFormNote')}</p>

      {!targetType && (
        <label className="field">
          <span className="field__label">{t('placeHoldTargetLabel')}</span>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as HoldTargetType)}>
            {HOLD_TARGET_TYPES.map((tt) => (
              <option key={tt} value={tt}>
                {HOLD_TARGET_LABEL[tt]}
              </option>
            ))}
          </select>
        </label>
      )}

      {!targetId && (
        <label className="field">
          <span className="field__label">{t('placeHoldIdLabel')}</span>
          <input
            className="input"
            value={id}
            onChange={(e) => setId(e.target.value)}
            required
            placeholder={t('placeHoldIdPlaceholder')}
          />
        </label>
      )}

      <label className="field">
        <span className="field__label">{t('placeHoldReasonCodeLabel')}</span>
        <select className="input" value={code} onChange={(e) => setCode(e.target.value as HoldReasonCode)}>
          {HOLD_REASON_CODES.map((c) => (
            <option key={c} value={c}>
              {HOLD_REASON_LABEL[c]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field__label">{t('placeHoldExplanationLabel')}</span>
        <textarea
          className="input"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
          maxLength={2000}
          placeholder={t('placeHoldExplanationPlaceholder')}
        />
      </label>

      {error && <p className="ret__error" role="alert">{error}</p>}

      <div className="ret__formActions">
        <button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 3}>
          {busy ? t('saving') : t('placeButton')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
          {t('cancelButton')}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Release
 * ------------------------------------------------------------------ */

export function ReleaseHold({ holdId }: { holdId: string }) {
  const t = useTranslations('Retention');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction(t('errorGeneric'));

  if (!open) {
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        {t('releaseHoldButton')}
      </button>
    );
  }

  return (
    <form
      className="ret__form ret__form--inline"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run(() => api.post(`/admin/legal-holds/${holdId}/release`, { reason: reason.trim() }));
        if (ok) setOpen(false);
      }}
    >
      <p className="ret__formNote ret__formNote--warn">
        <Icon name="alert" size={16} />
        {t('releaseHoldFormNote')}
      </p>
      <label className="field">
        <span className="field__label">{t('releaseHoldReasonLabel')}</span>
        <textarea
          className="input"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
        />
      </label>
      {error && <p className="ret__error" role="alert">{error}</p>}
      <div className="ret__formActions">
        <button type="submit" className="btn btn-danger btn-sm" disabled={busy || reason.trim().length < 3}>
          {busy ? t('releasing') : t('releaseButton')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)} disabled={busy}>
          {t('cancelButton')}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Run the sweep
 * ------------------------------------------------------------------ */

export function RunRetention({ storageConfigured }: { storageConfigured: boolean }) {
  const t = useTranslations('Retention');
  const [report, setReport] = useState<{ processed: number; skipped: number; failed: number; notes: string[] } | null>(
    null,
  );
  const { busy, error, run } = useAction(t('errorGeneric'));

  return (
    <div className="ret__run">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const r = await api.post<{ processed: number; skipped: number; failed: number; notes: string[] }>(
              '/admin/retention/run',
              {},
            );
            setReport(r);
          })
        }
      >
        <Icon name="clock" size={16} />
        {busy ? t('running') : t('runButton')}
      </button>

      {!storageConfigured && <p className="ret__runNote">{t('runNoteStorageMissing')}</p>}

      {error && <p className="ret__error" role="alert">{error}</p>}

      {report && (
        <div className="ret__report" role="status">
          <p>
            {t('tableProcessed')}: <strong>{report.processed}</strong> · {t('tableSkipped')}:{' '}
            <strong>{report.skipped}</strong> · {t('tableFailed')}: <strong>{report.failed}</strong>
          </p>
          {report.notes.map((n) => (
            <p key={n} className="ret__runNote">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
