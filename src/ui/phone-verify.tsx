'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';

interface BeginResponse {
  readonly token: string;
  readonly expiresInSeconds: number;
  readonly telegram: { readonly botUsername: string | null } | null;
  readonly vk: { readonly groupId: string | null } | null;
  readonly whatsapp: { readonly businessNumber: string | null } | null;
}

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: BeginResponse }
  | { readonly status: 'none-configured' }
  | { readonly status: 'error' };

/**
 * Phone verification via a linked messenger account (0018).
 *
 * One token, three doors: whichever of Telegram, VK or WhatsApp the person
 * completes first verifies them — see the long comment on
 * `NotificationService`'s phone-verification methods for what each channel
 * actually proves. The code is also shown as plain text, not only baked into
 * the deep links, because a deep link that fails to pre-fill the message (a
 * real possibility on some VK/WhatsApp client versions) must still leave the
 * person something they can paste by hand.
 *
 * Polls `/auth/me` — the one route that stays reachable through the phone
 * gate itself — so the moment any channel's webhook confirms the phone, this
 * screen notices without the person needing to click anything.
 */
export function PhoneVerify({ next = '/dashboard' }: { next?: string }) {
  const t = useTranslations('VerifyPhone');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function checkNow(manual: boolean) {
    if (manual) setChecking(true);
    try {
      const me = await api.get<{ phoneVerified: boolean }>('/auth/me');
      if (me.phoneVerified) window.location.assign(next);
    } catch {
      // A transient failure here just means the next check tries again —
      // nothing to show the person over a single missed check.
    } finally {
      if (manual) setChecking(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const data = await api.post<BeginResponse>('/verification/phone/begin');
        if (cancelled) return;
        setState(data.telegram || data.vk || data.whatsapp ? { status: 'ready', data } : { status: 'none-configured' });
      } catch {
        if (!cancelled) setState({ status: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.status !== 'ready') return;
    pollRef.current = setInterval(() => void checkNow(false), 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [state.status]);

  if (state.status === 'loading') {
    return (
      <div className="pv__busy">
        <p>{t('busy')}</p>
        <style>{PV_CSS}</style>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="pv__error">
        <Icon name="alert" size={18} />
        <p>{t('genericError')}</p>
        <style>{PV_CSS}</style>
      </div>
    );
  }

  if (state.status === 'none-configured') {
    return (
      <div className="pv__error">
        <Icon name="info" size={18} />
        <p>{t('unavailable')}</p>
        <style>{PV_CSS}</style>
      </div>
    );
  }

  const { token, telegram, vk, whatsapp } = state.data;
  const encoded = encodeURIComponent(token);

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the code is already shown as text,
      // so there's nothing further to do here.
    }
  }

  return (
    <div className="pv">
      <p className="pv__lede">{t('lede')}</p>

      <div className="pv__code">
        <span className="pv__codeValue numeric">{token}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyToken()}>
          {copied ? t('copied') : t('copy')}
        </button>
      </div>
      <p className="pv__hint">{t('codeHint')}</p>

      <div className="pv__channels">
        {telegram && (
          <a
            className="pv__channel"
            href={telegram.botUsername ? `https://t.me/${telegram.botUsername}?start=${encoded}` : undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!telegram.botUsername}
          >
            <Icon name="message" size={18} />
            {t('channelTelegram')}
          </a>
        )}
        {vk && (
          <a
            className="pv__channel"
            href={vk.groupId ? `https://vk.me/im?sel=-${vk.groupId}&text=${encoded}` : undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!vk.groupId}
          >
            <Icon name="message" size={18} />
            {t('channelVk')}
          </a>
        )}
        {whatsapp && (
          <a
            className="pv__channel"
            href={whatsapp.businessNumber ? `https://wa.me/${whatsapp.businessNumber}?text=${encoded}` : undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!whatsapp.businessNumber}
          >
            <Icon name="message" size={18} />
            {t('channelWhatsapp')}
          </a>
        )}
      </div>

      <p className="pv__waiting">
        <Icon name="clock" size={14} />
        {t('waiting')}
      </p>
      <button type="button" className="link pv__check" onClick={() => void checkNow(true)} disabled={checking}>
        {checking ? t('checkingNow') : t('checkNow')}
      </button>

      <style>{PV_CSS}</style>
    </div>
  );
}

const PV_CSS = `
  .pv__busy p, .pv__error p { font-size: var(--text-sm); color: var(--text-secondary); }
  .pv__error { display: flex; align-items: flex-start; gap: 0.5rem; }
  .pv__error svg { flex: 0 0 auto; margin-top: 0.1rem; color: var(--warning); }

  .pv { display: flex; flex-direction: column; gap: var(--space-4); }
  .pv__lede { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; }

  .pv__code {
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--surface-sunken);
    border-radius: var(--radius-md);
  }
  .pv__codeValue { font-size: var(--text-lg); font-weight: 700; letter-spacing: 0.15em; }
  .pv__hint { font-size: var(--text-xs); color: var(--text-tertiary); }

  .pv__channels { display: flex; flex-direction: column; gap: var(--space-2); }
  .pv__channel {
    display: flex; align-items: center; gap: 0.5rem;
    min-height: 2.75rem;
    padding: 0 var(--space-4);
    border-radius: var(--radius-md);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    font-weight: 600;
    text-decoration: none;
    color: var(--text-primary);
  }
  .pv__channel:hover { border-color: var(--primary); color: var(--primary); }
  .pv__channel[aria-disabled='true'] { pointer-events: none; opacity: 0.5; }

  .pv__waiting {
    display: flex; align-items: center; gap: 0.4rem;
    font-size: var(--text-xs); color: var(--text-tertiary);
    justify-content: center;
  }
  .pv__check {
    align-self: center;
    min-height: 2.75rem;
    font-size: var(--text-sm);
  }
`;
