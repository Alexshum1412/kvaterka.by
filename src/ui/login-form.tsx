'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api-client.ts';
import { CornflowerMark } from './brand.tsx';

type Mode = 'LOGIN' | 'REGISTER';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/dashboard';

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
    <div className="panel stack" style={{ gap: '1.25rem' }}>
      <div className="stack" style={{ gap: '0.5rem', alignItems: 'center', textAlign: 'center' }}>
        <span style={{ color: 'var(--primary)' }}>
          <CornflowerMark size={40} />
        </span>
        <h1 style={{ fontSize: 'var(--text-xl)' }}>
          {mode === 'LOGIN' ? 'Вход в Кватэрку' : 'Регистрация'}
        </h1>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          {mode === 'LOGIN'
            ? 'Войдите, чтобы бронировать жильё или управлять своими квартирами.'
            : 'Аккаунт нужен, чтобы бронировать, переписываться и оставлять отзывы.'}
        </p>
      </div>

      <form onSubmit={submit} className="stack" style={{ gap: '0.875rem' }}>
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
              <p className="error-text" id="lf-name-error">
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
            <p className="error-text" id="lf-id-error">
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
            aria-describedby={fieldErrors.password ? 'lf-pw-error' : 'lf-pw-hint'}
          />
          {mode === 'REGISTER' && !fieldErrors.password && (
            <p className="hint" id="lf-pw-hint">
              Не короче 10 символов. Длинная фраза надёжнее короткого пароля со спецсимволами.
            </p>
          )}
          {fieldErrors.password && (
            <p className="error-text" id="lf-pw-error">
              {fieldErrors.password}
            </p>
          )}
        </div>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}

        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? 'Подождите…' : mode === 'LOGIN' ? 'Войти' : 'Создать аккаунт'}
        </button>
      </form>

      <div className="row" style={{ justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setMode(mode === 'LOGIN' ? 'REGISTER' : 'LOGIN');
            setError(null);
            setFieldErrors({});
          }}
        >
          {mode === 'LOGIN' ? 'Создать аккаунт' : 'У меня уже есть аккаунт'}
        </button>
        {mode === 'LOGIN' && (
          <Link href="/password-reset" className="btn btn-ghost btn-sm">
            Забыли пароль?
          </Link>
        )}
      </div>
    </div>
  );
}
