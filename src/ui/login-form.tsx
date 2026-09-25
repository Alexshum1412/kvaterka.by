'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { CornflowerMark } from '@/ui/brand.tsx';

type Mode = 'LOGIN' | 'REGISTER' | 'CODE';

const GOOGLE_ERROR_CODES = [
  'google_unconfigured',
  'google_cancelled',
  'google_state_mismatch',
  'google_token_exchange_failed',
  'google_token_invalid',
  'google_denied',
  'google_error',
] as const;

function GoogleMark() {
  // Google's own four-color "G" — a brand mark, not part of this app's
  // single-color icon family, so it keeps its own fixed colors on purpose.
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true" focusable="false" style={{ flex: '0 0 auto' }}>
      <path
        fill="#4285F4"
        d="M17.6 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.56 2.66-3.87 2.66-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path fill="#FBBC05" d="M3.95 10.7a5.4 5.4 0 0 1 0-3.4V4.97H.96a9 9 0 0 0 0 8.06l2.99-2.33Z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.99 11.43.18 9 .18a9 9 0 0 0-8.04 4.8l2.99 2.32C4.66 5.17 6.65 3.58 9 3.58Z"
      />
    </svg>
  );
}

/**
 * `next` arrives as a prop rather than through `useSearchParams()`, which
 * would suspend the form and leave the sign-in screen showing a skeleton
 * that never resolves. `googleError` is the `?error=` code the Google
 * callback route redirects back with on failure — also read server-side by
 * the page and passed down, for the same reason.
 */
export function LoginForm({ next = '/dashboard', googleError }: { next?: string; googleError?: string }) {
  const t = useTranslations('Login');

  const [mode, setMode] = useState<Mode>('LOGIN');
  const [identifier, setIdentifier] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    googleError
      ? t(
          `googleError.${
            (GOOGLE_ERROR_CODES as readonly string[]).includes(googleError) ? googleError : 'google_error'
          }`,
        )
      : null,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [pendingIdentifier, setPendingIdentifier] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [resendStatus, setResendStatus] = useState<'idle' | 'busy' | 'sent'>('idle');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    if (mode === 'REGISTER' && password !== confirmPassword) {
      setFieldErrors({ confirmPassword: t('passwordMismatch') });
      return;
    }

    setBusy(true);
    try {
      if (mode === 'REGISTER') {
        const result = await api.post<{ identifier: string }>('/auth/register', {
          email: identifier.trim(),
          password,
          displayName: displayName.trim(),
        });
        setPendingIdentifier(result.identifier);
        setMode('CODE');
        setBusy(false);
        return;
      }

      await api.post('/auth/login', { identifier: identifier.trim(), password });
      // Full navigation, not client routing: the session cookie was just set
      // and every server component needs to re-read it.
      window.location.assign(next);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setFieldErrors(e.fieldErrors);
      } else {
        setError(t('networkError'));
      }
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (!pendingIdentifier) return;
    setError(null);
    setBusy(true);
    try {
      await api.post('/auth/register/confirm', { identifier: pendingIdentifier, code: code.trim() });
      window.location.assign(next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('networkError'));
      setBusy(false);
    }
  }

  async function resendCode() {
    if (!pendingIdentifier || resendStatus === 'busy') return;
    setResendStatus('busy');
    try {
      await api.post('/auth/register/resend', { identifier: pendingIdentifier });
      setResendStatus('sent');
    } catch {
      setResendStatus('idle');
    }
  }

  const googleHref = `/api/auth/google/start?next=${encodeURIComponent(next)}`;

  if (mode === 'CODE') {
    return (
      <div className="lf">
        <header className="lf__head">
          <span className="lf__mark">
            <CornflowerMark size={44} />
          </span>
          <h1 className="lf__title">{t('code.title')}</h1>
          <p className="lf__lede">{t('code.lede', { identifier: pendingIdentifier ?? '' })}</p>
        </header>

        <div className="lf__card">
          <form onSubmit={submitCode} className="lf__form">
            <div className="field">
              <label className="label" htmlFor="lf-code">
                {t('code.label')}
              </label>
              <input
                id="lf-code"
                className="input lf__code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                autoFocus
              />
            </div>

            {error && (
              <p className="error-text lf__error" role="alert">
                <Icon name="alert" size={15} />
                {error}
              </p>
            )}

            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || code.length < 6}>
              {busy ? t('submitBusy') : t('code.submit')}
            </button>
          </form>

          <button type="button" className="link lf__resend" onClick={resendCode} disabled={resendStatus === 'busy'}>
            {resendStatus === 'sent' ? t('code.resent') : t('code.resend')}
          </button>
        </div>

        <p className="lf__switch">
          <button
            type="button"
            className="link lf__switchBtn"
            onClick={() => {
              setMode('REGISTER');
              setCode('');
              setError(null);
            }}
          >
            {t('code.back')}
          </button>
        </p>

        <style>{FORM_CSS}</style>
      </div>
    );
  }

  return (
    <div className="lf">
      <header className="lf__head">
        <span className="lf__mark">
          <CornflowerMark size={44} />
        </span>
        <h1 className="lf__title">{mode === 'LOGIN' ? t('title.login') : t('title.register')}</h1>
        <p className="lf__lede">{mode === 'LOGIN' ? t('lede.login') : t('lede.register')}</p>
      </header>

      <div className="lf__card">
        <form onSubmit={submit} className="lf__form">
          {mode === 'REGISTER' && (
            <div className="field">
              <label className="label" htmlFor="lf-name">
                {t('nameLabel')}
              </label>
              <input
                id="lf-name"
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                required
                aria-invalid={Boolean(fieldErrors.displayName)}
                aria-describedby={fieldErrors.displayName ? 'lf-name-error' : undefined}
              />
              {fieldErrors.displayName && (
                <p className="error-text" id="lf-name-error" role="alert">
                  {fieldErrors.displayName}
                </p>
              )}
            </div>
          )}

          <div className="field">
            <label className="label" htmlFor="lf-id">
              {mode === 'LOGIN' ? t('identifierLabel.login') : t('identifierLabel.register')}
            </label>
            <input
              id="lf-id"
              className="input"
              type={mode === 'REGISTER' ? 'email' : 'text'}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete={mode === 'REGISTER' ? 'email' : 'username'}
              required
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'lf-id-error' : undefined}
            />
            {fieldErrors.email && (
              <p className="error-text" id="lf-id-error" role="alert">
                {fieldErrors.email}
              </p>
            )}
          </div>

          <div className="field">
            <label className="label" htmlFor="lf-pw">
              {t('passwordLabel')}
            </label>
            <div className="lf__pwWrap">
              <input
                id="lf-pw"
                className="input lf__pwInput"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'REGISTER' ? 'new-password' : 'current-password'}
                required
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={
                  fieldErrors.password ? 'lf-pw-error' : mode === 'REGISTER' ? 'lf-pw-hint' : undefined
                }
              />
              <button
                type="button"
                className="lf__pwToggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                tabIndex={-1}
              >
                <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
              </button>
            </div>
            {mode === 'REGISTER' && !fieldErrors.password && (
              <p className="hint" id="lf-pw-hint">
                {t('passwordHint')}
              </p>
            )}
            {fieldErrors.password && (
              <p className="error-text" id="lf-pw-error" role="alert">
                {fieldErrors.password}
              </p>
            )}
          </div>

          {mode === 'REGISTER' && (
            <div className="field">
              <label className="label" htmlFor="lf-pw2">
                {t('confirmPasswordLabel')}
              </label>
              <div className="lf__pwWrap">
                <input
                  id="lf-pw2"
                  className="input lf__pwInput"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  aria-invalid={Boolean(fieldErrors.confirmPassword)}
                  aria-describedby={fieldErrors.confirmPassword ? 'lf-pw2-error' : undefined}
                />
                <button
                  type="button"
                  className="lf__pwToggle"
                  onClick={() => setShowConfirmPassword((v) => !v)}
                  aria-label={showConfirmPassword ? t('hidePassword') : t('showPassword')}
                  tabIndex={-1}
                >
                  <Icon name={showConfirmPassword ? 'eyeOff' : 'eye'} size={18} />
                </button>
              </div>
              {fieldErrors.confirmPassword && (
                <p className="error-text" id="lf-pw2-error" role="alert">
                  {fieldErrors.confirmPassword}
                </p>
              )}
            </div>
          )}

          {/* The message comes from the API and is deliberately the same
              whether or not the address is registered. */}
          {error && (
            <p className="error-text lf__error" role="alert">
              <Icon name="alert" size={15} />
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? t('submitBusy') : mode === 'LOGIN' ? t('submitLogin') : t('submitRegister')}
          </button>
        </form>

        <div className="lf__divider">
          <span>{t('orDivider')}</span>
        </div>
        <a href={googleHref} className="btn btn-secondary btn-lg btn-block lf__google">
          <GoogleMark />
          {t('googleButton')}
        </a>

        {mode === 'LOGIN' && (
          <Link href="/password-reset" className="link lf__reset">
            {t('forgotPassword')}
          </Link>
        )}
      </div>

      <p className="lf__switch">
        <span>{mode === 'LOGIN' ? t('switchPromptLogin') : t('switchPromptRegister')}</span>
        <button
          type="button"
          className="link lf__switchBtn"
          onClick={() => {
            setMode(mode === 'LOGIN' ? 'REGISTER' : 'LOGIN');
            setError(null);
            setFieldErrors({});
          }}
        >
          {mode === 'LOGIN' ? t('switchActionLogin') : t('switchActionRegister')}
        </button>
      </p>

      <style>{FORM_CSS}</style>
    </div>
  );
}

const FORM_CSS = `
  .lf { display: flex; flex-direction: column; gap: var(--space-5); }

  .lf__head {
    display: flex; flex-direction: column; align-items: center;
    gap: 0.5rem; text-align: center;
  }
  .lf__mark { display: inline-flex; color: var(--primary); }
  .lf__title { font-size: var(--text-2xl); }
  .lf__lede { font-size: var(--text-sm); color: var(--text-secondary); max-width: 32ch; }

  /* The only drawn surface on the screen: elevation, no border. */
  .lf__card {
    display: flex; flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5);
    background: var(--surface);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-raised);
  }
  @media (min-width: 480px) { .lf__card { padding: var(--space-6); } }

  .lf__form { display: flex; flex-direction: column; gap: var(--space-4); }
  .lf__error { display: flex; align-items: flex-start; gap: 0.375rem; line-height: 1.45; }

  .lf__pwWrap { position: relative; }
  .lf__pwInput { padding-right: 2.75rem; width: 100%; }
  .lf__pwToggle {
    position: absolute; top: 0; right: 0; bottom: 0;
    display: inline-flex; align-items: center; justify-content: center;
    width: 2.75rem;
    background: none; border: 0; cursor: pointer;
    color: var(--text-secondary);
  }
  @media (hover: hover) and (pointer: fine) {
    .lf__pwToggle:hover { color: var(--text-primary); }
  }

  .lf__code {
    text-align: center;
    font-size: var(--text-xl);
    letter-spacing: 0.5em;
    font-variant-numeric: tabular-nums;
  }

  .lf__resend {
    align-self: center;
    min-height: 2.75rem;
    font-size: var(--text-sm);
  }

  .lf__divider {
    display: flex; align-items: center; gap: var(--space-3);
    font-size: var(--text-xs); color: var(--text-secondary); text-transform: uppercase;
  }
  .lf__divider::before, .lf__divider::after {
    content: ''; flex: 1 1 auto; height: 1px; background: var(--border);
  }

  .lf__google { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); }

  .lf__reset {
    align-self: center;
    min-height: 2.75rem;
    font-size: var(--text-sm);
  }

  .lf__switch {
    display: flex; align-items: center; justify-content: center;
    flex-wrap: wrap; gap: 0.375rem;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .lf__switchBtn {
    min-height: 2.75rem;
    padding: 0 0.125rem;
    background: none;
    border: 0;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
`;
