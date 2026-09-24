'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

/**
 * The conversation.
 *
 * Deliberately plain: a list of messages and one input. No presence, no
 * typing indicators, no read receipts beyond what the server already
 * tracks — this is two people arranging a flat, not a support console.
 *
 * The contact filter is NOT reimplemented here, and must never be. The
 * server decides, on every message, before storing anything; a client
 * copy would be decoration that anyone can bypass by calling the API. All
 * this component does is show the sender the notice the server returned
 * when their own text was altered, and show everyone the stored body.
 */

interface Message {
  id: string;
  senderId: string | null;
  body: string;
  moderationState: string;
  createdAt: string;
  mine: boolean;
  filterNotice?: string;
}

function clock(value: string): string {
  return new Date(value).toISOString().slice(11, 16);
}

function dayLabel(value: string, todayLabel: string, months: string[]): string {
  const iso = new Date(value).toISOString();
  const [y, m, d] = iso.slice(0, 10).split('-');
  const today = new Date().toISOString().slice(0, 10);
  if (iso.slice(0, 10) === today) return todayLabel;
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

export function ChatThread({
  conversationId,
  initial,
  canWrite,
}: {
  conversationId: string;
  initial: Message[];
  canWrite: boolean;
}) {
  const t = useTranslations('Chat');
  const [messages, setMessages] = useState<Message[]>(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const months = t.raw('months') as string[];
  // Messages present on mount never animate — only ones appended afterward
  // (via `send`) get `.ct__msg--enter`, and only for their one real mount.
  const initialCount = useRef(initial.length);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;

    setBusy(true);
    setError(null);
    try {
      // The endpoint's field is `text`; the stored message comes back as `body`.
      const sent = await api.post<Message>(`/chat/conversations/${conversationId}/messages`, {
        text: body,
      });
      // The server's version, not the typed one: if the filter changed the
      // text, what is shown is what was actually stored.
      setMessages((prev) => [...prev, sent]);
      setText('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('sendError'));
    } finally {
      setBusy(false);
    }
  }

  let lastDay = '';

  return (
    <div className="ct">
      <div className="ct__scroll">
        {messages.length === 0 && <p className="ct__empty">{t('emptyThread')}</p>}

        {messages.map((m, index) => {
          const day = dayLabel(m.createdAt, t('today'), months);
          const showDay = day !== lastDay;
          lastDay = day;
          // Only a message appended after mount plays the entrance — the
          // ones the thread loaded with must appear already in place.
          const isNew = index >= initialCount.current;
          const msgClass = ['ct__msg', m.mine && 'ct__msg--mine', isNew && 'ct__msg--enter']
            .filter(Boolean)
            .join(' ');
          return (
            <div key={m.id}>
              {showDay && <p className="ct__day">{day}</p>}
              <div className={msgClass}>
                <p className="ct__body">{m.body}</p>
                <span className="ct__time numeric">{clock(m.createdAt)}</span>
              </div>
              {/* Only the sender sees this, and only for their own message. */}
              {m.mine && m.filterNotice && (
                <p className="ct__notice">
                  <Icon name="info" size={14} />
                  {m.filterNotice}
                </p>
              )}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {canWrite ? (
        <form className="ct__composer" onSubmit={send}>
          <label className="sr-only" htmlFor="chat-input">
            {t('messageLabel')}
          </label>
          <textarea
            id="chat-input"
            className="textarea ct__input"
            rows={1}
            maxLength={4000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(e);
              }
            }}
            placeholder={t('messagePlaceholder')}
          />
          <button type="submit" className="btn btn-primary ct__send" disabled={busy || !text.trim()}>
            <Icon name="arrowRight" size={18} />
            <span className="sr-only">{t('send')}</span>
          </button>
        </form>
      ) : (
        <p className="ct__frozen">
          <Icon name="info" size={15} />
          {t('frozen')}
        </p>
      )}

      {error && (
        <p className="error-text ct__error" role="alert">
          {error}
        </p>
      )}

      <style>{`
        .ct { display: grid; grid-template-rows: 1fr auto; gap: var(--space-3); min-height: 0; }
        .ct__scroll {
          display: grid; gap: var(--space-2); align-content: start;
          max-height: min(60vh, 34rem); overflow-y: auto;
          padding-right: 0.25rem;
        }
        .ct__empty { font-size: var(--text-sm); color: var(--text-secondary); padding: var(--space-5) 0; }
        .ct__day { text-align: center; font-size: var(--text-2xs); color: var(--text-tertiary); margin-block: var(--space-3) var(--space-2); }

        .ct__msg {
          display: flex; align-items: baseline; gap: var(--space-3);
          max-width: min(85%, 32rem);
          padding: var(--space-3);
          background: var(--surface);
          border-radius: var(--radius-md);
          margin-right: auto;
        }
        /* The tenant's own words on the soft brand ground: enough to tell the
           two sides apart without turning the thread into two colours. */
        .ct__msg--mine { background: var(--primary-soft); margin-right: 0; margin-left: auto; }
        /* Only a freshly-appended message gets this class, so it fires
           once on that one real mount — never on the initial thread load,
           and never replays for messages already in the list. */
        .ct__msg--enter { transition: opacity 180ms ease-out, transform 180ms ease-out; }
        @starting-style {
          .ct__msg--enter { opacity: 0; transform: translateY(6px); }
        }
        .ct__body { font-size: var(--text-sm); line-height: 1.5; white-space: pre-wrap; word-break: break-word; flex: 1 1 auto; min-width: 0; }
        .ct__time { font-size: var(--text-2xs); color: var(--text-tertiary); flex: 0 0 auto; }

        .ct__notice {
          display: flex; align-items: center; gap: 0.35rem;
          margin-top: 0.25rem; margin-left: auto;
          max-width: min(85%, 32rem);
          font-size: var(--text-2xs); color: var(--warning);
        }

        .ct__composer { display: flex; align-items: flex-end; gap: var(--space-2); }
        .ct__input { min-height: 3rem; max-height: 8rem; resize: none; }
        .ct__send { flex: 0 0 auto; width: 3rem; padding: 0; }
        .ct__frozen { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .ct__error { margin-top: var(--space-2); }
      `}</style>
    </div>
  );
}
