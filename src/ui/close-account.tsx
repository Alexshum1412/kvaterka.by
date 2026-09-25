'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * The closure control.
 *
 * Two deliberate frictions. The action is behind a disclosure, so it cannot be
 * reached by a mis-tap on a page somebody opened to check something else. And
 * confirming means typing ЗАКРЫТЬ — a word, not a checkbox, because a stolen
 * session can tick a box and because the typing is the moment a person reads
 * what they are agreeing to.
 *
 * The button says «Закрыть», never «Удалить». What happens is the end of
 * access, and the copy that leads to this control has already said so.
 */

const PHRASE = 'ЗАКРЫТЬ';

export function CloseAccount() {
  const t = useTranslations('Account');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <section className="panel acc__danger">
        <h2 className="acc__h2">{t('closeAccount.collapsedTitle')}</h2>
        <p className="acc__muted">{t('closeAccount.collapsedBody')}</p>
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
          {t('closeAccount.openButton')}
        </button>
      </section>
    );
  }

  return (
    <section className="panel acc__danger">
      <h2 className="acc__h2">{t('closeAccount.confirmTitle')}</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.post('/me/account/close', {
              confirm: PHRASE,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            });
            // The session is gone; a refresh lands on the signed-out view.
            router.push('/');
            router.refresh();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : t('closeAccount.error'));
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span className="label">{t('closeAccount.confirmLabel', { phrase: PHRASE })}</span>
          <input
            className="input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
            required
          />
        </label>

        <label className="field">
          <span className="label">{t('closeAccount.reasonLabel')}</span>
          <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </label>

        {error && (
          <p className="acc__error" role="alert">
            <Icon name="alert" size={16} />
            {error}
          </p>
        )}

        <div className="acc__actions">
          <button type="submit" className="btn btn-danger" disabled={busy || confirm !== PHRASE}>
            {busy ? t('closeAccount.submittingButton') : t('closeAccount.submitButton')}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
            {t('closeAccount.cancelButton')}
          </button>
        </div>
      </form>
    </section>
  );
}
