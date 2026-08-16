'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { CornflowerMark } from '@/ui/brand.tsx';

type Mode = 'LOGIN' | 'REGISTER';

/**
 * `next` arrives as a prop rather than through `useSearchParams()`, which
 * would suspend the form and leave the sign-in screen showing a skeleton
 * that never resolves.
 */
export function LoginForm({ next = '/dashboard' }: { next?: string }) {

  const [mode, setMode] = useState<Mode>('LOGIN');
  const [identifier, setIdentifier] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      if (mode === 'REGISTER') {
        await api.post('/auth/register', { email: identifier.trim(), password, displayName: displayName.trim() });
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
        setError('Не удалось соединиться с сервером. Проверьте интернет и попробуйте снова.');
      }
      setBusy(false);
    }
  }

  return (
    <div className="lf">
      <header className="lf__head">
        <span className="lf__mark">
          <CornflowerMark size={44} />
        </span>
        <h1 className="lf__title">{mode === 'LOGIN' ? 'Вход в Кватэрку' : 'Регистрация'}</h1>
        <p className="lf__lede">
          {mode === 'LOGIN'
            ? 'Войдите, чтобы бронировать жильё или управлять своими квартирами.'
            : 'Аккаунт нужен, чтобы бронировать, переписываться и оставлять отзывы.'}
        </p>
      </header>

      <div className="lf__card">
        <form onSubmit={submit} className="lf__form">
          {mode === 'REGISTER' && (
            <div className="field">
              <label className="label" htmlFor="lf-name">
                Как вас зовут
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
              Email {mode === 'LOGIN' && 'или телефон'}
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
              Пароль
            </label>
            <input
              id="lf-pw"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'REGISTER' ? 'new-password' : 'current-password'}
              required
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={
                fieldErrors.password ? 'lf-pw-error' : mode === 'REGISTER' ? 'lf-pw-hint' : undefined
              }
            />
            {mode === 'REGISTER' && !fieldErrors.password && (
              <p className="hint" id="lf-pw-hint">
                Не короче 10 символов. Длинная фраза надёжнее короткого пароля со спецсимволами.
              </p>
            )}
            {fieldErrors.password && (
              <p className="error-text" id="lf-pw-error" role="alert">
                {fieldErrors.password}
              </p>
            )}
          </div>

          {/* The message comes from the API and is deliberately the same
              whether or not the address is registered. */}
          {error && (
            <p className="error-text lf__error" role="alert">
              <Icon name="alert" size={15} />
              {error}
            </p>
          )}

          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? 'Подождите…' : mode === 'LOGIN' ? 'Войти' : 'Создать аккаунт'}
          </button>
        </form>

        {mode === 'LOGIN' && (
          <Link href="/password-reset" className="link lf__reset">
            Забыли пароль?
          </Link>
        )}
      </div>

      <p className="lf__switch">
        <span>{mode === 'LOGIN' ? 'Ещё нет аккаунта?' : 'Уже есть аккаунт?'}</span>
        <button
          type="button"
          className="link lf__switchBtn"
          onClick={() => {
            setMode(mode === 'LOGIN' ? 'REGISTER' : 'LOGIN');
            setError(null);
            setFieldErrors({});
          }}
        >
          {mode === 'LOGIN' ? 'Создать аккаунт' : 'Войти'}
        </button>
      </p>

      <style>{`
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
      `}</style>
    </div>
  );
}
