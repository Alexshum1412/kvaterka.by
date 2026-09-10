'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { ROLES, type Role } from '@/server/auth/rbac.ts';

/**
 * The role checklist.
 *
 * The full desired set is sent on every save — `PUT /admin/users/:id/roles`
 * diffs it against what the account currently holds and grants or revokes
 * accordingly, so this component never has to compute that diff itself or
 * get it wrong.
 *
 * TENANT is rendered checked and disabled rather than simply omitted: it is
 * the floor every account stands on (granted at registration, never removed
 * here), and showing it — inert — says that plainly instead of leaving its
 * absence to be guessed at. The ADMIN warning is plain text next to the
 * checkbox, not a blocking confirm: ADMIN can perform nearly every staff
 * action, and that is a fact worth stating, not a click worth adding friction
 * to for someone who already meant to grant it.
 */

export function UserRoleEditor({
  userId,
  roles,
  onSaved,
}: {
  userId: string;
  roles: readonly Role[];
  onSaved: (roles: Role[]) => void;
}) {
  const t = useTranslations('StaffUsers');
  const [selected, setSelected] = useState<Set<Role>>(new Set(roles));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(role: Role) {
    if (role === 'TENANT') return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.put<{ ok: true; roles: Role[] }>(`/admin/users/${userId}/roles`, {
        roles: [...selected],
        reason: reason.trim(),
      });
      onSaved(result.roles);
      setReason('');
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2.message : t('detail.errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel ure">
      <h2 className="ure__title">{t('detail.rolesPanelTitle')}</h2>
      <p className="hint ure__hint">{t('detail.rolesHint')}</p>

      <form className="ure__form" onSubmit={submit}>
        <fieldset className="ure__roles">
          <legend className="sr-only">{t('detail.rolesPanelTitle')}</legend>
          {ROLES.map((role) => (
            <label key={role} className="ure__role">
              <input
                type="checkbox"
                checked={role === 'TENANT' ? true : selected.has(role)}
                disabled={role === 'TENANT' || busy}
                onChange={() => toggle(role)}
              />
              <span>{t(`roles.${role}`)}</span>
              {role === 'TENANT' && <span className="ure__note">{t('detail.roleTenantNote')}</span>}
            </label>
          ))}
        </fieldset>

        {selected.has('ADMIN') && (
          <p className="ure__warning">
            <Icon name="alert" size={15} />
            {t('detail.roleAdminWarning')}
          </p>
        )}

        <label className="field">
          <span className="label">{t('detail.rolesReasonLabel')}</span>
          <textarea
            className="textarea"
            rows={3}
            minLength={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('detail.rolesReasonPlaceholder')}
          />
        </label>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 3}>
          {busy ? t('common.saving') : t('detail.rolesSubmit')}
        </button>
      </form>

      <style>{`
        .ure__title { font-size: var(--text-sm); font-weight: 600; margin-bottom: 0.3rem; }
        .ure__hint { margin-bottom: var(--space-3); }
        .ure__form { display: grid; gap: var(--space-3); }

        .ure__roles { border: none; padding: 0; margin: 0; display: grid; gap: var(--space-2); }
        .ure__role { display: flex; align-items: baseline; gap: 0.5rem; font-size: var(--text-sm); }
        .ure__role input { width: 1.15rem; height: 1.15rem; accent-color: var(--primary); cursor: pointer; flex: 0 0 auto; }
        .ure__role input:disabled { cursor: not-allowed; opacity: 0.6; }
        .ure__note { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .ure__warning {
          display: flex; align-items: flex-start; gap: 0.4rem;
          padding: var(--space-3); background: var(--warning-soft);
          border-radius: var(--radius-sm);
          font-size: var(--text-xs); line-height: 1.5; color: var(--text-secondary);
        }
        .ure__warning > svg { color: var(--warning); flex: 0 0 auto; margin-top: 0.1rem; }
      `}</style>
    </section>
  );
}
