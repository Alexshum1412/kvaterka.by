'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from './icons.tsx';

/**
 * Confirming an email address from the link in the registration email.
 *
 * The link carries `identifier` and `code` — the same code a person could
 * type by hand on `/login`'s code step — so clicking it is just a
 * convenience for submitting that code. The POST fires once on mount, with
 * no button in between, since the person already proved intent by clicking
 * the link in their inbox.
 *
 * `POST /auth/register/confirm` finishes creating the account and sets the
 * session cookie in the same response, so a success here already leaves the
 * visitor signed in — the follow-up button goes straight to `/dashboard`,
 * not back through `/login`.
 *
 * The `sent` ref (not state) guards that single fire against React 18/19
 * Strict Mode's dev-time double-invoke of effects — without it, the second
 * call would hit the code a moment after the first already consumed it and
 * come back as "wrong code", which is wrong: the code was fine, the effect
 * just ran twice.
 */
export function VerifyEmail({ identifier, code }: { identifier: string; code: string }) {
  const t = useTranslations('VerifyEmail');
  const [status, setStatus] = useState<'busy' | 'success' | 'error'>('busy');
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;

    (async () => {
      try {
        await api.post('/auth/register/confirm', { identifier, code });
        setStatus('success');
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('genericError'));
        setStatus('error');
      }
    })();
    // Fires the confirmation exactly once on mount (guarded by the `sent`
    // ref above); `identifier`/`code` are the only values the request depends on.
  }, [identifier, code]);

  if (status === 'busy') {
    return (
      <div className="ve__busy">
        <p>{t('busy')}</p>
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
    <div className="ve__done">
      <span className="ve__icon ve__icon--error">
        <Icon name="alert" size={20} />
      </span>
      <div>
        <h2>{t('errorTitle')}</h2>
        <p role="alert">{error}</p>
        <Link href="/login" className="link">
          {t('backToLogin')}
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
