'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * The user's own half of the ticket "chat" — the reply box under the thread
 * on their own ticket page. Posts to `/me/tickets/:id/reply`, which is also
 * what silently moves a `WAITING_ON_USER` ticket back to `IN_PROGRESS`; this
 * component does not know or care about that, it just refreshes the page so
 * the server-rendered thread and status badge pick up the new state.
 */
export function TicketReplyForm({ ticketId }: { ticketId: string }) {
  const t = useTranslations('SupportTickets');
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (text.length < 2 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/me/tickets/${ticketId}/reply`, { message: text });
      setMessage('');
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('replyError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="trf" onSubmit={submit}>
      <label className="field">
        <span className="label">{t('replyLabel')}</span>
        <textarea
          className="textarea"
          rows={3}
          maxLength={4000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('replyPlaceholder')}
        />
      </label>

      {error && (
        <p className="error-text" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || message.trim().length < 2}>
        {busy ? t('replySending') : t('replySend')}
      </button>

      <style>{`
        .trf { display: grid; gap: var(--space-3); }
        .trf .error-text { display: flex; align-items: center; gap: 0.35rem; }
        .trf > .btn { justify-self: start; }
        @media (max-width: 480px) { .trf > .btn { width: 100%; } }
      `}</style>
    </form>
  );
}
