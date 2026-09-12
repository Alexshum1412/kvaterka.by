'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import type { AppLocale } from '@/i18n/routing.ts';
import { routing } from '@/i18n/routing.ts';
import type { Role } from '@/server/auth/rbac.ts';

/**
 * The editable half of `/me/profile`, plus — since this component already
 * fetches the whole response — the read-only half nothing displayed before.
 *
 * `/me/profile` has always returned email, phone, verification state, status
 * and member-since alongside the editable fields; this was the only caller,
 * and it destructured out exactly four of roughly a dozen fields and threw
 * the rest away. The query cost was already being paid on every page load —
 * this makes what it paid for visible.
 *
 * Email and phone are READ-ONLY here on purpose: there is no `PATCH`
 * support for either in this codebase (changing a verified contact method
 * is a re-verification flow, not a text field), and a form that looks
 * editable but silently does nothing on submit is worse than no form.
 *
 * `roles` is the one piece of this screen `/me/profile` cannot answer — it
 * is a session property, not a profile column — so it arrives as a prop
 * from the server component that already called `currentUser()`, rather
 * than this component fetching it a second way.
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
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  verificationLevel: number;
  memberSince: string | null;
  avatarStorageKey: string | null;
}

function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (routing.locales as readonly string[]).includes(value);
}

export function ProfileSettings({ roles }: { roles: readonly Role[] }) {
  const t = useTranslations('Account');
  const uiLocale = useLocale();
  const dateFormat = new Intl.DateTimeFormat(uiLocale, { dateStyle: 'long' });
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

  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

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
          email: typeof res.email === 'string' ? res.email : null,
          phone: typeof res.phone === 'string' ? res.phone : null,
          emailVerified: res.emailVerified === true,
          phoneVerified: res.phoneVerified === true,
          verificationLevel: typeof res.verificationLevel === 'number' ? res.verificationLevel : 0,
          memberSince: typeof res.memberSince === 'string' ? res.memberSince : null,
          avatarStorageKey: typeof res.avatarStorageKey === 'string' ? res.avatarStorageKey : null,
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

  async function onAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared immediately rather than after the upload settles, so picking
    // the same file again (e.g. after fixing it) fires a change event at all.
    e.target.value = '';
    if (!file) return;

    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const body = new FormData();
      body.set('file', file);
      const response = await fetch('/api/uploads/avatar', { method: 'POST', body, credentials: 'same-origin' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setAvatarError(payload?.error?.message ?? t('profile.avatarError'));
        return;
      }
      setProfile((p) => (p ? { ...p, avatarStorageKey: payload.storageKey } : p));
    } catch {
      setAvatarError(t('profile.avatarError'));
    } finally {
      setAvatarBusy(false);
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

  const initial = Array.from(profile.displayName.trim())[0]?.toUpperCase() ?? '';

  return (
    <section className="card ps">
      <h2 className="ps__h2">{t('profile.title')}</h2>

      <div className="ps__identity">
        <span className="ps__avatar" aria-hidden={profile.avatarStorageKey ? undefined : 'true'}>
          {profile.avatarStorageKey ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/media/${profile.avatarStorageKey}`} alt={t('profile.avatarAlt')} />
          ) : (
            initial || <Icon name="users" size={18} />
          )}
        </span>
        <div className="ps__avatarActions">
          <label className="btn btn-secondary btn-sm ps__avatarBtn">
            {avatarBusy ? t('profile.avatarUploading') : t('profile.avatarChangeButton')}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              disabled={avatarBusy}
              onChange={(e) => void onAvatarChange(e)}
            />
          </label>
          {avatarError && (
            <p className="ps__error" role="alert">
              <Icon name="alert" size={16} />
              {avatarError}
            </p>
          )}
        </div>
      </div>

      {/* Read-only: what the platform knows, not what this form can change.
          A wall of individually-boxed fields here would outnumber the two or
          three that are actually editable below it — a compact list reads as
          "for reference" rather than inviting a click that does nothing. */}
      <dl className="ps__info">
        <div className="ps__infoRow">
          <dt>{t('profile.emailLabel')}</dt>
          <dd>{profile.email ?? <span className="ps__muted">{t('profile.notProvided')}</span>}</dd>
        </div>
        <div className="ps__infoRow">
          <dt>{t('profile.phoneLabel')}</dt>
          <dd>
            {profile.phone ? (
              <span className={profile.phoneVerified ? 'ps__badgeYes' : 'ps__badgeNo'}>
                {profile.phoneVerified && <Icon name="checkCircle" size={13} />}
                {profile.phone}
                <em>{profile.phoneVerified ? t('profile.verifiedBadge') : t('profile.unverifiedBadge')}</em>
              </span>
            ) : (
              <span className="ps__muted">{t('profile.notProvided')}</span>
            )}
          </dd>
        </div>
        <div className="ps__infoRow">
          <dt>{t('profile.rolesLabel')}</dt>
          <dd>{roles.map((r) => t(`profile.roles.${r}`)).join(', ')}</dd>
        </div>
        <div className="ps__infoRow">
          <dt>{t('profile.levelLabel')}</dt>
          <dd>{t(`profile.level.${profile.verificationLevel}`)}</dd>
        </div>
        <div className="ps__infoRow">
          <dt>{t('profile.memberSinceLabel')}</dt>
          <dd>{profile.memberSince ? dateFormat.format(new Date(profile.memberSince)) : '—'}</dd>
        </div>
      </dl>

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
        .ps__form { display: grid; gap: var(--space-4); max-width: 28rem; margin-top: var(--space-4); }
        .ps__actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-1); }
        .ps__error { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--error); }
        .ps__saved { display: flex; align-items: center; gap: 0.4rem; font-size: var(--text-sm); color: var(--success); }

        .ps__identity { display: flex; align-items: center; gap: var(--space-3); }
        .ps__avatar {
          display: grid; place-items: center; flex: 0 0 auto; overflow: hidden;
          width: 3.5rem; height: 3.5rem; border-radius: var(--radius-full);
          background: var(--primary-soft); color: var(--primary);
          font-size: var(--text-lg); font-weight: 600;
        }
        .ps__avatar img { width: 100%; height: 100%; object-fit: cover; }
        .ps__avatarActions { display: grid; gap: 0.4rem; }
        .ps__avatarBtn { position: relative; overflow: hidden; cursor: pointer; }

        /* A definition list rather than the same boxed .field the editable
           form below uses — this half of the card cannot be clicked into, and
           looking like it could would be the exact kind of noise this pass
           was asked to remove. (No backticks in this block: it lives inside
           a template literal.) */
        .ps__info { display: grid; gap: var(--space-2); margin: var(--space-4) 0 0; padding: var(--space-3) var(--space-4); background: var(--surface-sunken); border-radius: var(--radius-sm); }
        .ps__infoRow { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-3); font-size: var(--text-sm); }
        .ps__infoRow dt { color: var(--text-secondary); flex: 0 0 auto; }
        .ps__infoRow dd { text-align: right; font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
        .ps__badgeYes, .ps__badgeNo { display: inline-flex; align-items: center; gap: 0.3rem; }
        .ps__badgeYes { color: var(--text-primary); }
        .ps__badgeYes svg { color: var(--success); flex: 0 0 auto; }
        .ps__badgeYes em, .ps__badgeNo em { font-style: normal; font-size: var(--text-2xs); font-weight: 400; color: var(--text-tertiary); }
        .ps__badgeYes em { color: var(--success); }
      `}</style>
    </section>
  );
}
