'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from './icons.tsx';

/**
 * Confirming an email address from the link in the registration email.
 *
 * The link carries `identifier` and `code` — the same code a person could
 * type by hand on `/login`'s code step. The code alone is not enough to
 * finish: whoever submits an address first picks the password, so the person
 * must also type the one they chose at registration. Nothing is sent until
 * they submit; a victim of someone else's registration has no password to
 * give and stops here.
 *
 * `POST /auth/register/confirm` finishes creating the account and sets the
 * session cookie in the same response, so a success here already leaves the
 * visitor signed in — the follow-up button goes straight to `/dashboard`,
 * not back through `/login`. A wrong password counts toward the same attempt
 * limit as a wrong code, so failures stay on the form with the server's
 * message rather than replacing it.
 */
export function VerifyEmail({ identifier, code }: { identifier: string; code: string }) {
  const t = useTranslations('VerifyEmail');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await api.post('/auth/register/confirm', { identifier, code, password });
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('genericError'));
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="ve__done">
        <span className="ve__icon">
          <Icon name="check" size={20} />
        </span>
        <div>
          <h2>{t('successTitle')}</h2>
          <p>{t('successBody')}</p>
          <Link href="/dashboard" className="btn btn-primary">
            {t('continueButton')}
          </Link>
        </div>
        <style>{VE_CSS}</style>
      </div>
    );
  }

  return (
    <div className="ve__ask">
      <p className="ve__lede">{t('lede', { identifier })}</p>

      <form onSubmit={submit} className="ve__form">
        <div className="field">
          <label className="label" htmlFor="ve-pw">
            {t('passwordLabel')}
          </label>
          <div className="ve__pwWrap">
            <input
              id="ve-pw"
              className="input ve__pwInput"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />
            <button
              type="button"
              className="ve__pwToggle"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t('hidePassword') : t('showPassword')}
              tabIndex={-1}
            >
              <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
            </button>
          </div>
        </div>

        {error && (
          <p className="error-text ve__error" role="alert">
            <Icon name="alert" size={15} />
            {error}
          </p>
        )}

        <button
          type="submit"
          className="btn btn-primary btn-lg btn-block"
          disabled={busy || password.length === 0}
        >
          {busy ? t('busy') : t('submit')}
        </button>
      </form>

      <p className="ve__notYou">{t('notYou')}</p>
      <Link href="/login" className="link ve__back">
        {t('backToLogin')}
      </Link>
      <style>{VE_CSS}</style>
    </div>
  );
}

const VE_CSS = `
  .ve__ask { display: flex; flex-direction: column; gap: var(--space-4); }
  .ve__lede, .ve__notYou { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; overflow-wrap: anywhere; }
  .ve__form { display: flex; flex-direction: column; gap: var(--space-4); }
  .ve__error { display: flex; align-items: flex-start; gap: 0.375rem; line-height: 1.45; }

  .ve__pwWrap { position: relative; }
  .ve__pwInput { padding-right: 2.75rem; width: 100%; }
  .ve__pwToggle {
    position: absolute; top: 0; right: 0; bottom: 0;
    display: inline-flex; align-items: center; justify-content: center;
    width: 2.75rem;
    background: none; border: 0; cursor: pointer;
    color: var(--text-secondary);
  }
  @media (hover: hover) and (pointer: fine) {
    .ve__pwToggle:hover { color: var(--text-primary); }
  }

  .ve__back {
    align-self: center;
    display: inline-flex; align-items: center;
    min-height: 2.75rem;
    font-size: var(--text-sm);
  }

  .ve__done { display: flex; align-items: flex-start; gap: var(--space-4); }
  .ve__icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 2.75rem; height: 2.75rem; flex: 0 0 auto;
    border-radius: var(--radius-full);
    background: var(--success-soft); color: var(--success);
  }
  .ve__done h2 { font-size: var(--text-base); font-weight: 600; }
  .ve__done p { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-top: var(--space-2); }
  .ve__done .btn { margin-top: var(--space-3); }
`;
