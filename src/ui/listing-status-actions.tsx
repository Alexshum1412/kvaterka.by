'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * Pause/resume/delete for one listing card.
 *
 * `POST /listings/:id/status` has existed since the lifecycle was built —
 * nothing here is new backend, only the first UI that calls it. Delete is
 * really "archive": the row and its history (past bookings, reviews) stay,
 * the same soft-delete convention the rest of the product uses for an
 * account closure. A second click is required before it fires — this is
 * the one action on this card that cannot be undone from the dashboard.
 */
export function ListingStatusActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const t = useTranslations('Dashboard');
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setStatus(next: 'PAUSED' | 'PUBLISHED' | 'ARCHIVED') {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/listings/${id}/status`, { status: next });
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('statusChangeError'));
      setBusy(false);
      setConfirmingDelete(false);
    }
  }

  if (status === 'ARCHIVED') return null;

  const canPause = status === 'PUBLISHED';
  const canResume = status === 'PAUSED';
  // Every other state (DRAFT, PENDING_MODERATION, REJECTED, PUBLISHED, PAUSED)
  // can be archived by its owner — see OWNER_TRANSITIONS in listing-service.ts.
  const canDelete = true;

  return (
    <div className="lsa">
      {canPause && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void setStatus('PAUSED')}>
          <Icon name="eye" size={15} />
          {t('hide')}
        </button>
      )}
      {canResume && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void setStatus('PUBLISHED')}>
          <Icon name="checkCircle" size={15} />
          {t('republish')}
        </button>
      )}
      {canDelete &&
        (confirmingDelete ? (
          <span className="lsa__confirm">
            <span className="lsa__confirmText">
              {status === 'PENDING_MODERATION'
                ? t('confirmWithdrawDelete')
                : status === 'PUBLISHED'
                  ? t('confirmDeletePublished')
                  : t('confirmDelete')}
            </span>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy}
              onClick={() => void setStatus('ARCHIVED')}
            >
              {busy ? t('deleting') : t('confirmYes')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => setConfirmingDelete(false)}
            >
              {t('cancel')}
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-ghost lsa__delete"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
            aria-label={t('deleteAriaLabel')}
          >
            <Icon name="close" size={15} />
            {t('delete')}
          </button>
        ))}
      {error && (
        <span className="error-text lsa__error" role="alert">
          {error}
        </span>
      )}

      <style>{`
        .lsa { display: contents; }
        .lsa__delete { color: var(--error); }
        .lsa__delete:hover:not(:disabled) { background: var(--error-soft, var(--surface-sunken)); }
        .lsa__confirm { display: inline-flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
        .lsa__confirmText { font-size: var(--text-xs); color: var(--text-secondary); }
        .lsa__error { flex-basis: 100%; font-size: var(--text-xs); }
      `}</style>
    </div>
  );
}
