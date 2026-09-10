'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * Password change and the session list.
 *
 * Two independent forms sharing one component because they both belong to
 * "security" and both fetch nothing the page needs before first paint — the
 * page itself doesn't gate on either.
 *
 * There is no "current device" flag in `GET /auth/sessions` (see the route in
 * `auth.ts`: id, userAgent, createdAt, lastSeenAt, expiresAt — nothing that
 * identifies the caller's own session to the client). So the list cannot mark
 * "this device", and «Выйти на всех остальных» is offered only when there is
 * more than one row — with exactly one, it would either do nothing or, if
 * mis-clicked against the wrong row's expectation, be confusing rather than
 * useless.
 *
 * Changing the password is known server-side to revoke every other session
 * (`otherSessionsRevoked: true`), so that confirmation is unconditional —
 * it is not a guess based on the session list.
 */

interface SessionRow {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export function SecuritySettings() {
  const t = useTranslations('Account');
  const locale = useLocale();
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  /* --- password --- */
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(false);

    if (newPassword !== confirmPassword) {
      setPwError(t('security.passwordMismatch'));
      return;
    }

    setPwBusy(true);
    try {
      await api.post<{ ok: boolean; otherSessionsRevoked: boolean }>('/auth/password', {
        currentPassword,
        newPassword,
      });
      setPwSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : t('security.changeError'));
    } finally {
      setPwBusy(false);
    }
  }

  /* --- sessions --- */
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionsError, setSessionsError] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeCount, setRevokeCount] = useState<number | null>(null);

  async function loadSessions(): Promise<void> {
    try {
      const rows = await api.get<SessionRow[]>('/auth/sessions');
      setSessions(rows);
      setSessionsError(false);
    } catch {
      setSessionsError(true);
    }
  }

  useEffect(() => {
    void loadSessions();
    // Fetched once on mount; `revokeOthers` refreshes the list itself after
    // it changes the data, so this effect never needs to re-run.
  }, []);

  async function revokeOthers(): Promise<void> {
    setRevokeBusy(true);
    setRevokeError(null);
    setRevokeCount(null);
    try {
      const res = await api.delete<{ revoked: number }>('/auth/sessions');
      setRevokeCount(res.revoked);
      await loadSessions();
    } catch (err) {
      setRevokeError(err instanceof ApiError ? err.message : t('security.signOutOthersError'));
    } finally {
      setRevokeBusy(false);
    }
  }

  return (
    <>
      <section className="card ss">
        <h2 className="ss__h2">{t('security.passwordTitle')}</h2>
        <form onSubmit={changePassword} className="ss__form">
          <label className="field">
            <span className="label">{t('security.currentPasswordLabel')}</span>
            <input
              type="password"
              className="input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          <label className="field">
            <span className="label">{t('security.newPasswordLabel')}</span>
            <input
              type="password"
              className="input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={10}
              maxLength={256}
              required
            />
            <span className="hint">{t('security.newPasswordHint')}</span>
          </label>

          <label className="field">
            <span className="label">{t('security.confirmPasswordLabel')}</span>
            <input
              type="password"
              className="input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>

          {pwError && (
            <p className="ss__error" role="alert">
              <Icon name="alert" size={16} />
              {pwError}
            </p>
          )}
          {pwSuccess && !pwError && (
            <p className="ss__saved">
              <Icon name="checkCircle" size={16} />
              {t('security.changeSuccess')}
            </p>
          )}

          <div className="ss__actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pwBusy || currentPassword.length === 0 || newPassword.length < 10 || confirmPassword.length === 0}
            >
              {pwBusy ? t('security.changingButton') : t('security.changeButton')}
            </button>
          </div>
        </form>
      </section>

      <section className="card ss">
        <h2 className="ss__h2">{t('security.sessionsTitle')}</h2>
        <p className="ss__muted">{t('security.sessionsHint')}</p>

        {sessionsError && (
          <p className="ss__error" role="alert">
            <Icon name="alert" size={16} />
            {t('security.sessionsLoadError')}
          </p>
        )}

        {!sessionsError && sessions === null && <p className="ss__muted">{t('security.sessionsLoading')}</p>}

        {sessions !== null && sessions.length === 0 && <p className="ss__muted">{t('security.sessionsEmpty')}</p>}

        {sessions !== null && sessions.length > 0 && (
          <ul className="ss__sessions">
            {sessions.map((s) => (
              <li key={s.id} className="ss__session">
                <Icon name="phone" size={16} />
                <div>
                  <p className="ss__sessionDevice">{s.userAgent?.trim() || t('security.sessionUnknownDevice')}</p>
                  <p className="ss__sessionMeta">
                    {t('security.sessionLastSeen', { date: dateFormat.format(new Date(s.lastSeenAt)) })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {revokeError && (
          <p className="ss__error" role="alert">
            <Icon name="alert" size={16} />
            {revokeError}
          </p>
        )}
        {revokeCount !== null && !revokeError && (
          <p className="ss__saved">
            <Icon name="checkCircle" size={16} />
            {t('security.signOutOthersSuccess', { count: revokeCount })}
          </p>
        )}

        {sessions !== null && sessions.length > 1 && (
          <div className="ss__actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={revokeBusy}
              onClick={() => {
                if (window.confirm(t('security.signOutOthersConfirm'))) void revokeOthers();
              }}
            >
              <Icon name="logOut" size={16} />
              {revokeBusy ? t('security.signOutOthersBusy') : t('security.signOutOthersButton')}
            </button>
          </div>
        )}
      </section>

      <style>{`
        .ss__h2 { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }
        .ss__muted { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-bottom: var(--space-3); }
        .ss__form { display: grid; gap: var(--space-4); max-width: 28rem; }
        .ss__actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-3); }
        .ss__error { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--error); }
        .ss__saved { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--success); margin-top: var(--space-2); }

        .ss__sessions { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
        .ss__session {
          display: flex; align-items: flex-start; gap: var(--space-3);
          padding: var(--space-3); border-radius: var(--radius-sm); background: var(--surface-sunken);
        }
        .ss__session > svg { flex: 0 0 auto; margin-top: 0.15rem; color: var(--text-tertiary); }
        .ss__sessionDevice { font-size: var(--text-sm); font-weight: 500; overflow-wrap: anywhere; }
        .ss__sessionMeta { font-size: var(--text-xs); color: var(--text-tertiary); margin-top: 0.15rem; }
      `}</style>
    </>
  );
}
