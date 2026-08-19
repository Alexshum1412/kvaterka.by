'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from './icons.tsx';

/**
 * What the platform is allowed to tell you, and where.
 *
 * The API for this has existed since the notification slice — per category,
 * per channel, with a server-side refusal for the ones that cannot be silenced
 * — and nothing called it. So the consent model was real and unreachable: a
 * person could neither see what they had agreed to nor change it.
 *
 * THREE THINGS THIS SCREEN REFUSES TO DO.
 *
 * It does not offer a switch that does nothing. A channel with no transport in
 * this deployment is shown as unavailable with the reason, rather than as a
 * toggle that quietly changes a row nobody will ever read.
 *
 * It does not pretend the mandatory categories are a choice. Security, debt
 * and moderation cannot be turned off in-app; the control is disabled and says
 * why, instead of being absent (which reads as an oversight) or present and
 * then rejected by the server (which reads as a bug).
 *
 * It does not batch. Each toggle is one request, applied immediately and
 * reverted on failure, because a settings screen with a Save button loses the
 * change when the tab closes and nobody notices for a month.
 */

export interface PreferenceRow {
  readonly category: string;
  readonly title: string;
  /** In-app cannot be silenced for these; the server refuses it too. */
  readonly mandatoryInApp: boolean;
  readonly channels: Readonly<Record<string, boolean>>;
}

export interface ChannelInfo {
  readonly channel: 'IN_APP' | 'EMAIL' | 'TELEGRAM';
  readonly label: string;
  /** False when this deployment has no transport for the channel. */
  readonly available: boolean;
  /** Why not, in words a person can act on. */
  readonly note: string;
}

export function NotificationPreferences({
  rows,
  channels,
}: {
  rows: readonly PreferenceRow[];
  channels: readonly ChannelInfo[];
}) {
  const [state, setState] = useState<Record<string, Record<string, boolean>>>(() =>
    Object.fromEntries(rows.map((r) => [r.category, { ...r.channels }])),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function toggle(category: string, channel: string, next: boolean): Promise<void> {
    const key = `${category}:${channel}`;
    setPending(key);
    setError(null);
    setState((s) => ({ ...s, [category]: { ...s[category], [channel]: next } }));

    try {
      await api.put('/notifications/preferences', { category, channel, enabled: next });
    } catch (e) {
      // Put it back. A settings row that shows a state the server rejected is
      // worse than one that visibly bounced.
      setState((s) => ({ ...s, [category]: { ...s[category], [channel]: !next } }));
      setError(e instanceof ApiError ? e.message : 'Не удалось сохранить настройку');
    } finally {
      setPending(null);
    }
  }

  const unavailable = channels.filter((c) => !c.available);

  return (
    <section className="np">
      <h2 className="np__h2">Что присылать</h2>
      <p className="np__lede">
        Уведомления о безопасности, задолженности и решениях модерации отключить нельзя — они
        касаются вашего аккаунта и денег.
      </p>

      {unavailable.length > 0 && (
        <p className="np__notice">
          <Icon name="info" size={16} />
          <span>
            {unavailable.map((c) => `${c.label}: ${c.note}`).join('. ')}. Пока это так, письма и
            сообщения не отправляются — всё приходит в раздел «Уведомления».
          </span>
        </p>
      )}

      {error && (
        <p className="np__error" role="alert">
          {error}
        </p>
      )}

      <div className="np__scroll">
        <table className="np__table">
          <thead>
            <tr>
              <th scope="col">Событие</th>
              {channels.map((c) => (
                <th key={c.channel} scope="col" className="np__ch">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.category}>
                <th scope="row" className="np__label">
                  {row.title}
                </th>
                {channels.map((c) => {
                  const locked = c.channel === 'IN_APP' && row.mandatoryInApp;
                  const disabled = locked || !c.available || pending === `${row.category}:${c.channel}`;
                  const checked = locked ? true : (state[row.category]?.[c.channel] ?? false);

                  return (
                    <td key={c.channel} className="np__cell">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        aria-label={`${row.title} — ${c.label}${locked ? ' (отключить нельзя)' : ''}`}
                        onChange={(e) => void toggle(row.category, c.channel, e.target.checked)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <style>{`
        .np { margin-top: var(--space-6); }
        .np__h2 { font-size: var(--text-base); font-weight: 600; }
        .np__lede { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; margin: var(--space-2) 0 var(--space-3); }
        .np__notice { display: flex; align-items: flex-start; gap: 0.45rem; padding: var(--space-3); background: var(--surface-sunken); border-radius: var(--radius-sm); font-size: var(--text-sm); line-height: 1.55; margin-bottom: var(--space-3); }
        .np__notice > svg { flex: 0 0 auto; margin-top: 0.15rem; color: var(--text-secondary); }
        .np__error { font-size: var(--text-sm); color: var(--error); margin-bottom: var(--space-2); }

        /* A three-column matrix is the clearest shape for this and the one most
           likely to overflow a phone. It scrolls inside its own box rather
           than widening the page. */
        .np__scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
        .np__table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
        .np__table th, .np__table td { padding: var(--space-2) var(--space-3); text-align: left; }
        .np__table thead th { font-weight: 600; font-size: var(--text-xs); color: var(--text-secondary); border-bottom: 1px solid var(--border); white-space: nowrap; }
        .np__table tbody tr + tr th, .np__table tbody tr + tr td { border-top: 1px solid var(--border); }
        .np__label { font-weight: 500; min-width: 12rem; }
        .np__ch, .np__cell { text-align: center; width: 5.5rem; }
        .np__cell input { width: 1.15rem; height: 1.15rem; accent-color: var(--primary); cursor: pointer; }
        .np__cell input:disabled { cursor: not-allowed; opacity: 0.45; }
      `}</style>
    </section>
  );
}
