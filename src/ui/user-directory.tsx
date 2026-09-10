'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { EmptyState } from '@/ui/primitives.tsx';

/**
 * The user directory — search and browse.
 *
 * Fetched client-side: `/admin/users` reads `app_user` directly and has no
 * service method behind it, the same situation `AuditLog` and
 * `FeatureFlagList` are in, so this follows their contract — the page stays a
 * thin permission gate and this component owns loading, error, retry and the
 * search re-query.
 *
 * The list deliberately shows email only, never phone (`noPhoneNote` says so
 * in the UI): `/admin/users` doesn't select phone at all, so a support agent
 * scanning the directory cannot casually read phone numbers off a list —
 * opening a card is a distinct, logged act.
 */

const LIMIT = 50;

interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  account_kind: 'PRIVATE' | 'COMPANY';
  status: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | 'CLOSED';
  verification_level: 0 | 1 | 2;
  created_at: string;
}

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'verified',
  RESTRICTED: 'warning',
  SUSPENDED: 'danger',
  CLOSED: 'solid-neutral',
};

export function UserDirectory({ canCreate }: { canCreate: boolean }) {
  const t = useTranslations('StaffUsers');
  const locale = useLocale();
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  const load = useCallback(
    async (query: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set('q', query.trim());
        params.set('limit', String(LIMIT));
        const rows = await api.get<UserRow[]>(`/admin/users?${params.toString()}`);
        setUsers(rows);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t('list.loadError'));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load('');
    // Only runs on mount — subsequent loads come from the search form.
  }, []);

  return (
    <div className="udir">
      <div className="udir__top">
        <form
          className="udir__search"
          onSubmit={(e) => {
            e.preventDefault();
            void load(q);
          }}
        >
          <label className="udir__searchField">
            <span className="sr-only">{t('list.searchLabel')}</span>
            <Icon name="search" size={17} />
            <input
              className="input"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('list.searchPlaceholder')}
            />
          </label>
          <button type="submit" className="btn btn-primary">
            {t('list.searchButton')}
          </button>
        </form>

        {canCreate && (
          <Link href="/staff/users/new" className="btn btn-secondary udir__create">
            <Icon name="plus" size={16} />
            {t('list.createButton')}
          </Link>
        )}
      </div>

      <p className="hint udir__note">{t('list.noPhoneNote')}</p>

      {loading && users === null && <p className="udir__loading">{t('list.loading')}</p>}

      {!loading && error && users === null && (
        <div className="udir__error" role="alert">
          <Icon name="alert" size={18} />
          <p>{error}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(q)}>
            {t('list.retry')}
          </button>
        </div>
      )}

      {users && users.length === 0 && (
        <EmptyState title={t('list.emptyTitle')} description={t('list.emptyDescription')} />
      )}

      {users && users.length > 0 && (
        <>
          <p className="udir__count numeric">{t('list.resultsHint', { count: users.length })}</p>
          <ul className="udir__list">
            {users.map((u) => {
              const tone = STATUS_TONE[u.status] ?? 'solid-neutral';
              return (
                <li key={u.id}>
                  <Link href={`/staff/users/${u.id}`} className="udir__row">
                    <span className="udir__main">
                      <span className="udir__nameRow">
                        <strong className="udir__name truncate">{u.display_name}</strong>
                        <span className={`badge badge-${tone}`}>{t(`status.${u.status}`)}</span>
                      </span>
                      <span className="udir__meta">
                        {u.email ?? t('list.noEmail')}
                        {' · '}
                        {t(`accountKind.${u.account_kind}`)}
                        {' · '}
                        {t(`level.${u.verification_level}`)}
                      </span>
                    </span>
                    <span className="udir__created">{dateFormat.format(new Date(u.created_at))}</span>
                    <Icon name="chevronRight" size={18} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <style>{`
        .udir__top { display: flex; align-items: flex-start; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-2); }
        .udir__search { display: flex; gap: var(--space-2); flex: 1 1 20rem; min-width: 0; }
        .udir__searchField { position: relative; display: flex; align-items: center; flex: 1 1 auto; min-width: 0; }
        .udir__searchField svg { position: absolute; left: 0.75rem; color: var(--text-tertiary); pointer-events: none; }
        .udir__searchField .input { padding-left: 2.4rem; }
        .udir__create { flex: 0 0 auto; white-space: nowrap; }

        .udir__note { margin-bottom: var(--space-4); }

        .udir__loading { font-size: var(--text-sm); color: var(--text-secondary); padding: var(--space-8) 0; text-align: center; }
        .udir__error {
          display: grid; justify-items: center; gap: var(--space-2);
          padding: var(--space-8) var(--space-4); text-align: center; color: var(--error);
        }
        .udir__error > svg { color: var(--error); }
        .udir__error > p { font-size: var(--text-sm); max-width: 42ch; }

        .udir__count { font-size: var(--text-xs); color: var(--text-tertiary); margin-bottom: var(--space-3); }

        .udir__list { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
        .udir__row {
          display: flex; align-items: center; gap: var(--space-3);
          padding: var(--space-3);
          background: var(--surface); border-radius: var(--radius-md);
          transition: box-shadow 160ms ease;
        }
        .udir__row:hover { box-shadow: var(--shadow-raised); }
        .udir__row > svg:last-child { color: var(--text-tertiary); flex: 0 0 auto; }

        .udir__main { display: grid; gap: 0.2rem; flex: 1 1 auto; min-width: 0; }
        .udir__nameRow { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; min-width: 0; }
        .udir__name { font-size: var(--text-sm); }
        .udir__meta { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .udir__created { flex: 0 0 auto; font-size: var(--text-xs); color: var(--text-secondary); white-space: nowrap; }

        @media (max-width: 640px) {
          .udir__row { flex-wrap: wrap; }
          .udir__created { flex: 1 1 100%; }
          .udir__top > * { flex: 1 1 100%; }
        }
      `}</style>
    </div>
  );
}
