'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from './icons.tsx';

/**
 * Forgetting a password.
 *
 * Both endpoints have existed since the auth slice and neither had a screen.
 * The login form has linked to `/password-reset` all along, and that link led
 * to a 404 — so the single most common account-recovery path in any product
 * ended in nothing, and a person locked out of their account had no way back
 * in at all.
 *
 * TWO THINGS THIS SCREEN IS CAREFUL ABOUT.
 *
 * It never says whether an address is registered. The endpoint already
 * returns the same response either way; a screen that said "no such account"
 * would hand that back and turn the form into an address oracle. So the
 * confirmation is deliberately written in the conditional: IF such an account
 * exists, a message has been sent.
 *
 * And it is honest that a message may not arrive. This deployment has no email
 * transport, so the reset code cannot currently be delivered to anybody. The
 * page says so plainly rather than leaving a person refreshing an inbox — the
 * same posture the delivery provider takes when it refuses to report a success
 * it did not achieve.
 */

export function PasswordResetRequest({ deliverable }: { deliverable: boolean }) {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password-reset/request', { identifier: identifier.trim() });
      setSent(true);
    } catch (e) {
      // Only a rate limit or a malformed address can land here; a missing
      // account cannot, by design.
      setError(e instanceof ApiError ? e.message : 'Не удалось отправить запрос');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="pr__done">
        <Icon name="check" size={20} />
        <div>
          <h2>Запрос принят</h2>
          <p>
            Если такая учётная запись существует, мы отправили на её адрес ссылку для смены пароля.
            Мы не сообщаем, зарегистрирован ли адрес — иначе эту форму можно было бы использовать,
            чтобы узнавать чужие адреса.
          </p>
          {!deliverable && (
            <p className="pr__warn">
              <Icon name="alert" size={16} />
              <span>
                Отправка писем в этой установке пока не настроена, поэтому письмо не придёт. Если вы
                не можете войти — обратитесь в поддержку.
              </span>
            </p>
          )}
          <p className="pr__links">
            <Link href="/login" className="link">
              Вернуться ко входу
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <form className="pr__form" onSubmit={submit} noValidate>
      <label className="field">
        <span className="label">Почта или телефон</span>
        <input
          type="text"
          className="input"
          autoComplete="username"
          inputMode="email"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
      </label>

      {error && (
        <p className="pr__error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={busy || identifier.trim().length < 3}>
        {busy ? 'Отправляем…' : 'Прислать ссылку'}
      </button>

      <p className="pr__links">
        <Link href="/login" className="link">
          Вспомнили пароль? Войти
        </Link>
      </p>

      <style>{FORM_CSS}</style>
    </form>
  );
}

export function PasswordResetConfirm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password-reset/confirm', { token, password });
      setDone(true);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Не удалось сменить пароль. Возможно, ссылка устарела — запросите новую.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="pr__done">
        <Icon name="check" size={20} />
        <div>
          <h2>Пароль изменён</h2>
          {/* The server revokes every session on reset, which is the point: a
              password is reset precisely when somebody else may be holding
              one. Saying so turns an inconvenience into a reassurance. */}
          <p>Все открытые сеансы завершены — на всех устройствах нужно войти заново.</p>
          <button type="button" className="btn btn-primary" onClick={() => router.push('/login')}>
            Войти
          </button>
        </div>
        <style>{FORM_CSS}</style>
      </div>
    );
  }

  return (
    <form className="pr__form" onSubmit={submit} noValidate>
      <label className="field">
        <span className="label">Новый пароль</span>
        <input
          type="password"
          className="input"
          autoComplete="new-password"
          minLength={10}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span className="hint">Не короче 10 символов.</span>
      </label>

      {error && (
        <p className="pr__error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={busy || password.length < 10}>
        {busy ? 'Сохраняем…' : 'Сохранить пароль'}
      </button>

      <style>{FORM_CSS}</style>
    </form>
  );
}

const FORM_CSS = `
  .pr__form { display: grid; gap: var(--space-4); justify-items: stretch; }
  .pr__form .btn { justify-self: start; }
  .pr__error { font-size: var(--text-sm); color: var(--error); }
  .pr__links { font-size: var(--text-sm); }

  .pr__done { display: flex; align-items: flex-start; gap: var(--space-3); }
  .pr__done > svg { color: var(--success); flex: 0 0 auto; margin-top: 0.15rem; }
  .pr__done h2 { font-size: var(--text-base); font-weight: 600; }
  .pr__done p { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-top: var(--space-2); }
  .pr__done .btn { margin-top: var(--space-3); }

  .pr__warn { display: flex; align-items: flex-start; gap: 0.45rem; padding: var(--space-3); background: var(--warning-soft); border-radius: var(--radius-sm); margin-top: var(--space-3); }
  .pr__warn > svg { flex: 0 0 auto; margin-top: 0.15rem; color: var(--warning); }
`;
