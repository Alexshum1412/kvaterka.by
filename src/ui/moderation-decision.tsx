'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import {
  MODERATION_REASON_CODES,
  MODERATION_REASON_SHORT,
  type ModerationReasonCode,
} from '@/server/domain/moderation.ts';

/**
 * The decision.
 *
 * Rejection is deliberately harder to do carelessly than approval: it
 * needs at least one structured reason before the button enables. That is
 * not friction for its own sake — the codes are what tell the landlord
 * what to fix and which wizard step to open, so a rejection without one
 * is a dead end for the person receiving it.
 *
 * Nothing is computed here. The service decides whether the transition is
 * legal, writes the history row and the audit record in one transaction,
 * and this component only reports what it said.
 */
export function ModerationDecision({
  propertyId,
  status,
}: {
  propertyId: string;
  status: string;
}) {
  const t = useTranslations('Moderation');
  const router = useRouter();
  const [mode, setMode] = useState<'none' | 'reject' | 'pause'>('none');
  const [codes, setCodes] = useState<ModerationReasonCode[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const canApprove = status === 'PENDING_MODERATION' || status === 'PAUSED';
  const canReject = status !== 'REJECTED';
  const canPause = status === 'PUBLISHED';

  async function decide(decision: 'PUBLISHED' | 'REJECTED' | 'PAUSED') {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/moderation/listings/${propertyId}`, {
        decision,
        ...(codes.length > 0 ? { reasonCodes: codes } : {}),
        ...(comment.trim() ? { reason: comment.trim() } : {}),
      });
      setDone(decision);
      // The queue counts and this listing's status both changed.
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('saveError'));
    } finally {
      setBusy(false);
    }
  }

  function toggle(code: ModerationReasonCode) {
    setCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  if (done) {
    return (
      <div className="md__done" role="status">
        <Icon name="checkCircle" size={20} />
        <div>
          <strong>
            {done === 'PUBLISHED' ? t('doneApproved') : done === 'REJECTED' ? t('doneRejected') : t('donePaused')}
          </strong>
          <p className="text-sm muted">{done === 'PUBLISHED' ? t('doneApprovedBody') : t('doneOtherBody')}</p>
        </div>
        <Link href="/moderation" className="btn btn-secondary btn-sm">
          {t('backToQueueLink')}
        </Link>
        <style>{`
          .md__done {
            display: flex; align-items: flex-start; gap: var(--space-3);
            padding: var(--space-4);
            background: var(--success-soft);
            border-radius: var(--radius-md);
          }
          .md__done > svg { color: var(--success); flex: 0 0 auto; margin-top: 0.1rem; }
          .md__done > div { flex: 1 1 auto; display: grid; gap: 0.2rem; }
        `}</style>
      </div>
    );
  }

  return (
    <div className="md">
      {mode === 'none' && (
        <div className="md__actions">
          {canApprove && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide('PUBLISHED')}>
              <Icon name="check" size={17} />
              {busy ? t('saving') : t('approveButton')}
            </button>
          )}
          {canReject && (
            <button type="button" className="btn btn-secondary" onClick={() => setMode('reject')}>
              {t('rejectButton')}
            </button>
          )}
          {canPause && (
            <button type="button" className="btn btn-ghost" onClick={() => setMode('pause')}>
              {t('hideButton')}
            </button>
          )}
        </div>
      )}

      {mode !== 'none' && (
        <div className="md__form">
          <h3 className="title-sm">{mode === 'reject' ? t('whyRejectHeading') : t('whyHideHeading')}</h3>
          <p className="hint">{t('reasonsHint')}</p>

          <div className="md__codes">
            {MODERATION_REASON_CODES.map((code) => (
              <button
                key={code}
                type="button"
                className="chip chip-sm"
                aria-pressed={codes.includes(code)}
                onClick={() => toggle(code)}
              >
                {MODERATION_REASON_SHORT[code]}
              </button>
            ))}
          </div>

          <label className="field">
            <span className="label">{t('commentLabel')}</span>
            <textarea
              className="textarea"
              rows={4}
              maxLength={1000}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t('commentPlaceholder')}
            />
            <span className="hint">{t('commentHint')}</span>
          </label>

          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}

          <div className="md__formActions">
            <button type="button" className="btn btn-ghost" onClick={() => setMode('none')}>
              {t('cancelButton')}
            </button>
            <button
              type="button"
              className={mode === 'reject' ? 'btn btn-danger' : 'btn btn-primary'}
              disabled={busy || codes.length === 0}
              onClick={() => void decide(mode === 'reject' ? 'REJECTED' : 'PAUSED')}
            >
              {busy ? t('saving') : mode === 'reject' ? t('confirmRejectButton') : t('confirmHideButton')}
            </button>
          </div>
        </div>
      )}

      {error && mode === 'none' && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      <style>{`
        .md { display: grid; gap: var(--space-3); }
        .md__actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
        .md__form { display: grid; gap: var(--space-3); }
        .md__codes { display: flex; gap: var(--space-2); flex-wrap: wrap; }
        .md__formActions { display: flex; justify-content: flex-end; gap: var(--space-2); }
        @media (max-width: 480px) {
          .md__actions > .btn, .md__formActions > .btn { flex: 1 1 auto; }
        }
      `}</style>
    </div>
  );
}
