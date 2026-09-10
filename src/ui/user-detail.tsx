'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import type { Role } from '@/server/auth/rbac.ts';
import { UserRestrictPanel } from '@/ui/user-restrict-panel.tsx';
import { UserRoleEditor } from '@/ui/user-role-editor.tsx';

/**
 * One user's card.
 *
 * Fetched client-side, same reasoning as `UserDirectory`: `/admin/users/:id`
 * reads `app_user` directly (plus `AuthService.listRoles`) and has no
 * dedicated service method, so the server page stays a permission gate and
 * this component owns the fetch.
 *
 * The two action panels are further client components, each rendered only
 * when the page told this component the viewer holds the matching
 * permission (`canSuspend`, `canGrantRoles`) — the gate is already decided
 * server-side by `can()`; this component just respects it, the same as
 * every route it calls respects it again, independently, for real.
 */

interface UserDetailData {
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  account_kind: 'PRIVATE' | 'COMPANY';
  company_name: string | null;
  locale: string;
  status: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED' | 'CLOSED';
  suspended_reason: string | null;
  verification_level: 0 | 1 | 2;
  email_verified_at: string | null;
  phone_verified_at: string | null;
  completed_rentals_as_tenant: number;
  completed_rentals_as_landlord: number;
  created_at: string;
  roles: Role[];
}

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'verified',
  RESTRICTED: 'warning',
  SUSPENDED: 'danger',
  CLOSED: 'solid-neutral',
};

const LOCALE_NAME: Record<string, string> = { ru: 'Русский', be: 'Беларуская', en: 'English' };

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="udet__fact">
      <span className="udet__factLabel">{label}</span>
      <span className="udet__factValue">{value}</span>
    </div>
  );
}

export function UserDetail({
  userId,
  canSuspend,
  canGrantRoles,
}: {
  userId: string;
  canSuspend: boolean;
  canGrantRoles: boolean;
}) {
  const t = useTranslations('StaffUsers');
  const locale = useLocale();
  const [detail, setDetail] = useState<UserDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const yesNo = (v: boolean) => (v ? t('common.yes') : t('common.no'));
  const dash = t('common.dash');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<UserDetailData>(`/admin/users/${userId}`);
      setDetail(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('detail.loadError'));
    } finally {
      setLoading(false);
    }
  }, [userId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !detail) {
    return <p className="udet__loading">{t('detail.loading')}</p>;
  }

  if (error && !detail) {
    return (
      <div className="udet__error" role="alert">
        <Icon name="alert" size={18} />
        <p>{error}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
          {t('detail.retry')}
        </button>
      </div>
    );
  }

  if (!detail) return null;

  const tone = STATUS_TONE[detail.status] ?? 'solid-neutral';

  return (
    <div className="udet">
      <div className="udet__banner">
        <h2 className="udet__name">{detail.display_name}</h2>
        <span className={`badge badge-${tone}`}>{t(`status.${detail.status}`)}</span>
      </div>

      <div className="udet__layout">
        <div className="udet__main">
          <section className="udet__section">
            <h3 className="udet__h3">{t('detail.sectionProfile')}</h3>
            <div className="udet__facts">
              <Fact label={t('detail.fieldEmail')} value={detail.email ?? dash} />
              <Fact label={t('detail.fieldEmailVerified')} value={yesNo(Boolean(detail.email_verified_at))} />
              <Fact label={t('detail.fieldPhone')} value={detail.phone ?? dash} />
              <Fact label={t('detail.fieldPhoneVerified')} value={yesNo(Boolean(detail.phone_verified_at))} />
              <Fact label={t('detail.fieldAccountKind')} value={t(`accountKind.${detail.account_kind}`)} />
              {detail.account_kind === 'COMPANY' && (
                <Fact label={t('detail.fieldCompanyName')} value={detail.company_name ?? dash} />
              )}
              <Fact label={t('detail.fieldLocale')} value={LOCALE_NAME[detail.locale] ?? detail.locale} />
              <Fact label={t('detail.fieldLevel')} value={t(`level.${detail.verification_level}`)} />
              <Fact label={t('detail.fieldCreated')} value={dateFormat.format(new Date(detail.created_at))} />
            </div>
            {detail.status !== 'ACTIVE' && detail.suspended_reason && (
              <p className="udet__suspended">
                <strong>{t('detail.fieldSuspendedReason')}:</strong> {detail.suspended_reason}
              </p>
            )}
            <p className="udet__rolesLine">
              <span className="udet__factLabel">{t('detail.fieldRoles')}</span>
              <span className="udet__roleBadges">
                {detail.roles.map((r) => (
                  <span key={r} className="badge badge-solid-neutral">
                    {t(`roles.${r}`)}
                  </span>
                ))}
              </span>
            </p>
            <Link href={`/profiles/${detail.id}`} className="link text-sm">
              {t('detail.publicProfile')}
            </Link>
          </section>

          <section className="udet__section">
            <h3 className="udet__h3">{t('detail.sectionActivity')}</h3>
            <div className="udet__facts">
              <Fact
                label={t('detail.fieldTenantCompletions')}
                value={String(detail.completed_rentals_as_tenant)}
              />
              <Fact
                label={t('detail.fieldLandlordCompletions')}
                value={String(detail.completed_rentals_as_landlord)}
              />
            </div>
          </section>
        </div>

        <aside className="udet__aside">
          {canSuspend && (
            <UserRestrictPanel
              userId={detail.id}
              currentStatus={detail.status}
              onSaved={(status, reason) =>
                setDetail((prev) => (prev ? { ...prev, status, suspended_reason: status === 'ACTIVE' ? null : reason } : prev))
              }
            />
          )}

          {canGrantRoles && (
            <UserRoleEditor
              userId={detail.id}
              roles={detail.roles}
              onSaved={(roles) => setDetail((prev) => (prev ? { ...prev, roles } : prev))}
            />
          )}
        </aside>
      </div>

      <style>{`
        .udet__loading { font-size: var(--text-sm); color: var(--text-secondary); padding: var(--space-8) 0; text-align: center; }
        .udet__error {
          display: grid; justify-items: center; gap: var(--space-2);
          padding: var(--space-8) var(--space-4); text-align: center; color: var(--error);
        }
        .udet__error > svg { color: var(--error); }
        .udet__error > p { font-size: var(--text-sm); max-width: 42ch; }

        .udet__banner { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-5); }
        .udet__name { font-size: var(--text-lg); font-weight: 650; letter-spacing: -0.015em; }

        .udet__layout { display: grid; gap: var(--space-6); }
        @media (min-width: 960px) {
          .udet__layout { grid-template-columns: minmax(0, 1fr) 21rem; align-items: start; }
          .udet__aside { position: sticky; top: calc(var(--header-height) + 0.75rem); }
        }
        .udet__main { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; align-content: start; }
        .udet__aside { display: grid; gap: var(--space-3); min-width: 0; }

        .udet__section { padding-block: var(--space-5); }
        .udet__section:first-child { padding-top: 0; }
        .udet__section + .udet__section { border-top: 1px solid var(--border); }
        .udet__h3 { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }

        .udet__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: var(--space-3); margin-bottom: var(--space-3); }
        .udet__fact { display: grid; gap: 0.1rem; }
        .udet__factLabel { font-size: var(--text-2xs); color: var(--text-tertiary); }
        .udet__factValue { font-size: var(--text-sm); font-weight: 500; overflow-wrap: anywhere; }

        .udet__suspended {
          padding: var(--space-3); margin-bottom: var(--space-3);
          background: var(--warning-soft); border-radius: var(--radius-sm);
          font-size: var(--text-sm); line-height: 1.5; color: var(--text-secondary);
        }

        .udet__rolesLine { display: grid; gap: 0.3rem; margin-bottom: var(--space-3); }
        .udet__roleBadges { display: flex; gap: 0.35rem; flex-wrap: wrap; }
      `}</style>
    </div>
  );
}
