'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';

/**
 * Restrict or suspend an account.
 *
 * Rendered only when the caller holds `user.suspend` — the page decides
 * that, this component just trusts the prop, the same way every other staff
 * action panel in this codebase works. `SUSPENDED` also revokes every active
 * session server-side, which `restrictSuspendedHint` says up front rather
 * than as a surprise after the fact.
 */

type AccountStatus = 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED';

const STATUSES: AccountStatus[] = ['ACTIVE', 'RESTRICTED', 'SUSPENDED'];

export function UserRestrictPanel({
  userId,
  currentStatus,
  onSaved,
}: {
  userId: string;
  currentStatus: string;
  onSaved: (status: AccountStatus, reason: string) => void;
}) {
  const t = useTranslations('StaffUsers');
  const [status, setStatus] = useState<AccountStatus>(
    STATUSES.includes(currentStatus as AccountStatus) ? (currentStatus as AccountStatus) : 'ACTIVE',
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/users/${userId}/restrict`, { status, reason: reason.trim() });
      onSaved(status, reason.trim());
      setReason('');
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : t('detail.errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel urp">
      <h2 className="urp__title">{t('detail.restrictPanelTitle')}</h2>
      <form className="urp__form" onSubmit={submit}>
        <label className="field">
          <span className="label">{t('detail.restrictStatusLabel')}</span>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as AccountStatus)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </select>
        </label>

        {status === 'SUSPENDED' && <p className="hint">{t('detail.restrictSuspendedHint')}</p>}

        <label className="field">
          <span className="label">{t('detail.restrictReasonLabel')}</span>
          <textarea
            className="textarea"
            rows={3}
            minLength={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('detail.restrictReasonPlaceholder')}
          />
        </label>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 3}>
          {busy ? t('common.saving') : t('detail.restrictSubmit')}
        </button>
      </form>

      <style>{`
        .urp__title { font-size: var(--text-sm); font-weight: 600; margin-bottom: var(--space-3); }
        .urp__form { display: grid; gap: var(--space-3); }
      `}</style>
    </section>
  );
}
