'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api-client.ts';
import { Icon } from './icons.tsx';

/**
 * The Telegram deep link.
 *
 * Linking cannot work like an OAuth "Connect" button, because the whole point
 * of the mitigation this product adopted for Telegram (DECISIONS.md
 * LEGAL-015) is that the platform never handles a Telegram credential at
 * all. What exists instead is a one-time code: `beginTelegramLink` mints it,
 * this component turns it into a `t.me/<bot>?start=<code>` deep link, and the
 * person confirms it by pressing Start inside Telegram itself. Consent is
 * recorded only when the bot's webhook calls `completeTelegramLink` — never
 * here. This component's whole job is producing a link that leads there.
 *
 * Fetches its own token on mount, the same "owns its own starting state"
 * pattern `ProfileSettings`/`SecuritySettings` use on this same page, so one
 * slow or failing section never blocks the rest of the account page from
 * rendering. Renders nothing while loading and nothing at all when this
 * deployment has no bot username configured — a `t.me/undefined` link would
 * be worse than no link, the same posture `NotificationPreferences` takes
 * toward a channel with no live provider.
 */

type LinkState =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'error' };

export function TelegramLink() {
  const t = useTranslations('Account.notifications');
  const [state, setState] = useState<LinkState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await api.post<{ linkCode: string; botUsername: string | null }>(
          '/notifications/telegram/link',
        );
        if (cancelled) return;
        setState(
          res.botUsername
            ? { status: 'ready', url: `https://t.me/${res.botUsername}?start=${res.linkCode}` }
            : { status: 'unavailable' },
        );
      } catch {
        if (!cancelled) setState({ status: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading' || state.status === 'unavailable') return null;

  return (
    <div className="tgl">
      {state.status === 'ready' ? (
        <a className="tgl__link" href={state.url} target="_blank" rel="noopener noreferrer">
          <Icon name="message" size={16} />
          {t('telegramConnectButton')}
        </a>
      ) : (
        <span className="tgl__error">{t('telegramConnectError')}</span>
      )}
      <span className="tgl__hint">{t('telegramConnectHint')}</span>

      <style>{`
        .tgl { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--border); font-size: var(--text-sm); }
        .tgl__link { display: inline-flex; align-items: center; gap: 0.4rem; font-weight: 600; color: var(--primary); text-decoration: none; }
        .tgl__link:hover { text-decoration: underline; }
        .tgl__hint { color: var(--text-secondary); }
        .tgl__error { color: var(--error); }
      `}</style>
    </div>
  );
}
