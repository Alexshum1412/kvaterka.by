'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { ROLES, type Role } from '@/server/auth/rbac.ts';

/**
 * Create a staff-managed account.
 *
 * No password field exists here on purpose: the endpoint mails the address a
 * setup link (the same delivery path a self-service reset uses) and never
 * returns the token to this screen, so there is nothing here that could leak
 * or be typo'd into a password shown on a shared monitor.
 */

const OPTIONAL_ROLES = ROLES.filter((r) => r !== 'TENANT');

export function UserCreateForm() {
  const t = useTranslations('StaffUsers');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roles, setRoles] = useState<Set<Role>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<{ userId: string } | null>(null);

  function toggleRole(role: Role) {
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  function reset() {
    setEmail('');
    setPhone('');
    setDisplayName('');
    setRoles(new Set());
    setReason('');
    setError(null);
    setFieldErrors({});
    setSuccess(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await api.post<{ userId: string; setupEmailQueued: true }>('/admin/users', {
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        displayName: displayName.trim(),
        ...(roles.size > 0 ? { roles: [...roles] } : {}),
        reason: reason.trim(),
      });
      setSuccess({ userId: result.userId });
    } catch (e2) {
      if (e2 instanceof ApiError) {
        setError(e2.message);
        setFieldErrors(e2.fieldErrors);
      } else {
        setError(t('new.errorGeneric'));
      }
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <div className="ucf__success" role="status">
        <Icon name="checkCircle" size={28} />
        <h2 className="title-sm">{t('new.successTitle')}</h2>
        <p className="text-sm">{t('new.successBody')}</p>
        <p className="ucf__successId">
          {t('new.successUserId')}: <code>{success.userId}</code>
        </p>
        <div className="ucf__successActions">
          <Link href={`/staff/users/${success.userId}`} className="btn btn-primary">
            {t('new.openProfile')}
          </Link>
          <button type="button" className="btn btn-secondary" onClick={reset}>
            {t('new.createAnother')}
          </button>
        </div>
      </div>
    );
  }

  const canSubmit =
    (email.trim().length > 0 || phone.trim().length > 0) &&
    displayName.trim().length >= 2 &&
    reason.trim().length >= 3;

  return (
    <form className="ucf" onSubmit={submit}>
      <p className="hint ucf__contactHint">{t('new.contactHint')}</p>

      <div className="ucf__row">
        <label className="field">
          <span className="label">{t('new.fieldEmail')}</span>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? 'ucf-email-error' : undefined}
          />
          {fieldErrors.email && (
            <p className="error-text" id="ucf-email-error" role="alert">
              {fieldErrors.email}
            </p>
          )}
        </label>

        <label className="field">
          <span className="label">{t('new.fieldPhone')}</span>
          <input
            className="input"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+375291234567"
            aria-invalid={Boolean(fieldErrors.phone)}
            aria-describedby={fieldErrors.phone ? 'ucf-phone-error' : undefined}
          />
          {fieldErrors.phone && (
            <p className="error-text" id="ucf-phone-error" role="alert">
              {fieldErrors.phone}
            </p>
          )}
        </label>
      </div>

      <label className="field">
        <span className="label">{t('new.fieldDisplayName')}</span>
        <input
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t('new.fieldDisplayNamePlaceholder')}
          aria-invalid={Boolean(fieldErrors.displayName)}
          aria-describedby={fieldErrors.displayName ? 'ucf-name-error' : undefined}
        />
        {fieldErrors.displayName && (
          <p className="error-text" id="ucf-name-error" role="alert">
            {fieldErrors.displayName}
          </p>
        )}
      </label>

      <fieldset className="ucf__roles">
        <legend className="label">{t('new.rolesLabel')}</legend>
        <p className="hint">{t('new.rolesHint')}</p>
        <div className="ucf__roleGrid">
          {OPTIONAL_ROLES.map((role) => (
            <label key={role} className="ucf__role">
              <input type="checkbox" checked={roles.has(role)} onChange={() => toggleRole(role)} />
              <span>{t(`roles.${role}`)}</span>
            </label>
          ))}
        </div>
        {roles.has('ADMIN') && (
          <p className="ucf__warning">
            <Icon name="alert" size={15} />
            {t('detail.roleAdminWarning')}
          </p>
        )}
      </fieldset>

      <label className="field">
        <span className="label">{t('new.reasonLabel')}</span>
        <textarea
          className="textarea"
          rows={3}
          minLength={3}
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('new.reasonPlaceholder')}
          aria-invalid={Boolean(fieldErrors.reason)}
          aria-describedby={fieldErrors.reason ? 'ucf-reason-error' : undefined}
        />
        {fieldErrors.reason && (
          <p className="error-text" id="ucf-reason-error" role="alert">
            {fieldErrors.reason}
          </p>
        )}
      </label>

      {error && !Object.keys(fieldErrors).length && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={busy || !canSubmit}>
        {busy ? t('common.saving') : t('new.submitButton')}
      </button>

      <style>{`
        .ucf { display: grid; gap: var(--space-4); max-width: 34rem; }
        .ucf__contactHint { margin-top: -0.25rem; }
        .ucf__row { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); }

        .ucf__roles { border: none; padding: 0; margin: 0; display: grid; gap: var(--space-2); }
        .ucf__roleGrid { display: grid; gap: var(--space-2); grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); }
        .ucf__role { display: flex; align-items: center; gap: 0.5rem; font-size: var(--text-sm); }
        .ucf__role input { width: 1.15rem; height: 1.15rem; accent-color: var(--primary); cursor: pointer; flex: 0 0 auto; }

        .ucf__warning {
          display: flex; align-items: flex-start; gap: 0.4rem;
          padding: var(--space-3); background: var(--warning-soft);
          border-radius: var(--radius-sm);
          font-size: var(--text-xs); line-height: 1.5; color: var(--text-secondary);
        }
        .ucf__warning > svg { color: var(--warning); flex: 0 0 auto; margin-top: 0.1rem; }

        .ucf__success {
          display: grid; justify-items: center; gap: 0.5rem; text-align: center;
          max-width: 30rem; padding: var(--space-8) var(--space-4);
        }
        .ucf__success > svg { color: var(--success); margin-bottom: var(--space-2); }
        .ucf__successId { font-size: var(--text-sm); color: var(--text-secondary); }
        .ucf__successId code { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
        .ucf__successActions { display: flex; gap: var(--space-2); flex-wrap: wrap; justify-content: center; margin-top: var(--space-3); }
      `}</style>
    </form>
  );
}
