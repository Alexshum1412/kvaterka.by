'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import type { AppLocale } from '@/i18n/routing.ts';
import { routing } from '@/i18n/routing.ts';

/**
 * The editable half of `/me/profile`.
 *
 * `locale` here is the person's STORED preference (`app_user.locale`) — not
 * the language this page happens to be open in right now. The hint under the
 * field says so explicitly, because the two look identical (a select with
 * three familiar names) and are easy to conflate.
 *
 * The company name field only appears for `COMPANY` accounts, decided from
 * the profile response itself rather than a prop, so this component stays
 * self-contained: it fetches its own starting state and never asks a parent
 * page to know the shape of a profile.
 */

interface Profile {
  displayName: string;
  accountKind: 'PRIVATE' | 'COMPANY';
  companyName: string | null;
  locale: AppLocale;
}

function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (routing.locales as readonly string[]).includes(value);
}

export function ProfileSettings() {
  const t = useTranslations('Account');
  const localeLabel: Record<AppLocale, string> = {
    ru: t('profile.localeRu'),
    be: t('profile.localeBe'),
    en: t('profile.localeEn'),
  };

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadTick, setLoadTick] = useState(0);

  const [displayName, setDisplayName] = useState('');
  const [locale, setLocale] = useState<AppLocale>('ru');
  const [companyName, setCompanyName] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadError(false);
    api
      .get<Record<string, unknown>>('/me/profile')
      .then((res) => {
        if (!alive) return;
        const next: Profile = {
          displayName: typeof res.displayName === 'string' ? res.displayName : '',
          accountKind: res.accountKind === 'COMPANY' ? 'COMPANY' : 'PRIVATE',
          companyName: typeof res.companyName === 'string' ? res.companyName : null,
          locale: isAppLocale(res.locale) ? res.locale : 'ru',
        };
        setProfile(next);
        setDisplayName(next.displayName);
        setLocale(next.locale);
        setCompanyName(next.companyName ?? '');
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, [loadTick]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const trimmedName = displayName.trim();
    const trimmedCompany = companyName.trim();
    try {
      await api.patch('/me/profile', {
        displayName: trimmedName,
        locale,
        ...(profile?.accountKind === 'COMPANY' ? { companyName: trimmedCompany } : {}),
      });
      setProfile((p) => (p ? { ...p, displayName: trimmedName, locale, companyName: trimmedCompany || null } : p));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('profile.saveError'));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <section className="card ps">
        <h2 className="ps__h2">{t('profile.title')}</h2>
        <p className="ps__error" role="alert">
          <Icon name="alert" size={16} />
          {t('profile.loadError')}
        </p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLoadTick((n) => n + 1)}>
          {t('profile.retryButton')}
        </button>
      </section>
    );
  }

  if (!profile) {
    return (
      <section className="card ps">
        <h2 className="ps__h2">{t('profile.title')}</h2>
        <p className="ps__muted">{t('profile.loading')}</p>
      </section>
    );
  }

  return (
    <section className="card ps">
      <h2 className="ps__h2">{t('profile.title')}</h2>
      <form onSubmit={onSubmit} className="ps__form">
        <label className="field">
          <span className="label">{t('profile.displayNameLabel')}</span>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('profile.displayNamePlaceholder')}
            minLength={2}
            maxLength={80}
            required
          />
        </label>

        <label className="field">
          <span className="label">{t('profile.localeLabel')}</span>
          <select
            className="select"
            value={locale}
            onChange={(e) => setLocale(e.target.value as AppLocale)}
          >
            {routing.locales.map((l) => (
              <option key={l} value={l}>
                {localeLabel[l]}
              </option>
            ))}
          </select>
          <span className="hint">{t('profile.localeHint')}</span>
        </label>

        {profile.accountKind === 'COMPANY' && (
          <label className="field">
            <span className="label">{t('profile.companyNameLabel')}</span>
            <input
              className="input"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder={t('profile.companyNamePlaceholder')}
              maxLength={200}
            />
          </label>
        )}

        {error && (
          <p className="ps__error" role="alert">
            <Icon name="alert" size={16} />
            {error}
          </p>
        )}
        {saved && !error && (
          <p className="ps__saved">
            <Icon name="checkCircle" size={16} />
            {t('profile.savedNotice')}
          </p>
        )}

        <div className="ps__actions">
          <button type="submit" className="btn btn-primary" disabled={busy || displayName.trim().length < 2}>
            {busy ? t('profile.savingButton') : t('profile.saveButton')}
          </button>
        </div>
      </form>

      <style>{`
        .ps__h2 { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }
        .ps__muted { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; }
        .ps__form { display: grid; gap: var(--space-4); max-width: 28rem; }
        .ps__actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-1); }
        .ps__error { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--error); }
        .ps__saved { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--success); }
      `}</style>
    </section>
  );
}
