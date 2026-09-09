'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from './icons.tsx';

/**
 * Confirming an email address.
 *
 * Unlike the password-reset confirm screen, there is nothing to type: the
 * token in the URL is the whole submission, and the person already proved
 * intent by clicking the link in their inbox. So the POST fires once on
 * mount, with no button in between.
 *
 * The `sent` ref (not state) guards that single fire against React 18/19
 * Strict Mode's dev-time double-invoke of effects — without it, the second
 * call would hit the token a moment after the first already consumed it and
 * come back as "reused", which is wrong: the token was fine, the effect just
 * ran twice.
 */
export function VerifyEmail({ token }: { token: string }) {
  const [status, setStatus] = useState<'busy' | 'success' | 'error'>('busy');
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;

    (async () => {
      try {
        await api.post('/auth/verify-email', { token });
        setStatus('success');
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Не удалось подтвердить почту. Попробуйте ещё раз позже.');
        setStatus('error');
      }
    })();
  }, [token]);

  if (status === 'busy') {
    return (
      <div className="ve__busy">
        <p>Подтверждаем почту…</p>
        <style>{VE_CSS}</style>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="ve__done">
        <span className="ve__icon ve__icon--success">
          <Icon name="check" size={20} />
        </span>
        <div>
          <h2>Почта подтверждена</h2>
          <p>Адрес привязан к аккаунту.</p>
          <Link href="/login" className="btn btn-primary">
            Войти
          </Link>
        </div>
        <style>{VE_CSS}</style>
      </div>
    );
  }

  return (
    <div className="ve__done">
      <span className="ve__icon ve__icon--error">
        <Icon name="alert" size={20} />
      </span>
      <div>
        <h2>Не получилось подтвердить</h2>
        <p role="alert">{error}</p>
        <Link href="/login" className="link">
          Вернуться ко входу
        </Link>
      </div>
      <style>{VE_CSS}</style>
    </div>
  );
}

const VE_CSS = `
  .ve__busy p { font-size: var(--text-sm); color: var(--text-secondary); }

  .ve__done { display: flex; align-items: flex-start; gap: var(--space-4); }
  .ve__icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 2.75rem; height: 2.75rem; flex: 0 0 auto;
    border-radius: var(--radius-full);
  }
  .ve__icon--success { background: var(--success-soft); color: var(--success); }
  .ve__icon--error { background: var(--error-soft); color: var(--error); }
  .ve__done h2 { font-size: var(--text-base); font-weight: 600; }
  .ve__done p { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin-top: var(--space-2); }
  .ve__done .btn { margin-top: var(--space-3); }
  .ve__done .link { display: inline-block; margin-top: var(--space-3); font-size: var(--text-sm); }
`;
