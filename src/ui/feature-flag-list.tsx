'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { EmptyState } from '@/ui/primitives.tsx';
import { FeatureFlagRow, type FeatureFlag } from '@/ui/feature-flag-row.tsx';

/**
 * The feature-flag list.
 *
 * Fetched client-side (there is no server-side service method for this route
 * — `/admin/feature-flags` reads the table directly) so the page itself stays
 * a thin permission gate and this component owns loading/error/retry, the
 * same contract `api-client.ts` gives every other admin screen.
 */
export function FeatureFlagList() {
  const t = useTranslations('StaffFeatureFlags');
  const [flags, setFlags] = useState<FeatureFlag[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await api.get<FeatureFlag[]>('/admin/feature-flags');
      setFlags(rows);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleRowChange(next: FeatureFlag) {
    setFlags((prev) => (prev ? prev.map((f) => (f.key === next.key ? next : f)) : prev));
  }

  return (
    <div className="ffl">
      {loading && flags === null && <p className="ffl__loading">{t('loading')}</p>}

      {!loading && error && flags === null && (
        <div className="ffl__error" role="alert">
          <Icon name="alert" size={18} />
          <p>{error}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            {t('retry')}
          </button>
        </div>
      )}

      {flags && flags.length === 0 && <EmptyState title={t('empty')} />}

      {flags && flags.length > 0 && (
        <ul className="ffl__list">
          {flags.map((flag) => (
            <FeatureFlagRow key={flag.key} flag={flag} onChange={handleRowChange} />
          ))}
        </ul>
      )}

      <style>{`
        .ffl__loading { font-size: var(--text-sm); color: var(--text-secondary); padding: var(--space-8) 0; text-align: center; }
        .ffl__error {
          display: grid; justify-items: center; gap: var(--space-2);
          padding: var(--space-8) var(--space-4); text-align: center; color: var(--error);
        }
        .ffl__error > svg { color: var(--error); }
        .ffl__error > p { font-size: var(--text-sm); max-width: 42ch; }

        .ffl__list { display: grid; gap: var(--space-3); list-style: none; margin: 0; padding: 0; }
      `}</style>
    </div>
  );
}
