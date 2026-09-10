import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation.ts';
import { can, type Permission, type Role } from '@/server/auth/rbac.ts';
import { Icon, type IconName } from '@/ui/icons.tsx';

/**
 * The staff console frame.
 *
 * One navigation for everything operational, so moderation and disputes stop
 * being two products that happen to share a database. The existing
 * `/moderation` URLs are unchanged — they gain this nav rather than moving,
 * because a bookmark a moderator already has should keep working.
 *
 * A section a caller cannot use is not rendered at all, not rendered disabled.
 * A greyed-out «Верификация» tab tells a support agent that a verification
 * console exists and that they are not trusted with it; both halves of that are
 * information they have no need for, and the second invites them to ask why.
 *
 * Denser than the marketplace, and the same design system: same tokens, same
 * type, same light ground. Somebody spending their working day here has not
 * been sent to a worse product.
 */

interface Section {
  href: string;
  labelKey: string;
  icon: IconName;
  permission: Permission;
  /** Matches this section when the current path starts with one of these. */
  match: string[];
}

const SECTIONS: Section[] = [
  { href: '/staff', labelKey: 'overview', icon: 'home', permission: 'case.view', match: ['/staff'] },
  { href: '/staff/disputes', labelKey: 'disputes', icon: 'alert', permission: 'case.view', match: ['/staff/disputes'] },
  { href: '/moderation', labelKey: 'moderation', icon: 'checkCircle', permission: 'listing.moderate', match: ['/moderation'] },
  // VERIFIER's only section. Until now a verifier had no way into the console
  // at all: they hold neither `case.view` nor `listing.moderate`, so every
  // existing entry was invisible to them and the header link showed nothing.
  { href: '/staff/verification', labelKey: 'verification', icon: 'shieldCheck', permission: 'verification.review', match: ['/staff/verification'] },
  // Held by SUPPORT, MODERATOR and ADMIN, and deliberately not by VERIFIER:
  // whoever can open a passport must not also decide whether it is kept.
  { href: '/staff/retention', labelKey: 'retention', icon: 'clock', permission: 'retention.hold', match: ['/staff/retention'] },
  { href: '/staff/reports', labelKey: 'reports', icon: 'info', permission: 'case.view', match: ['/staff/reports'] },
  { href: '/staff/reviews', labelKey: 'reviews', icon: 'star', permission: 'review.moderate', match: ['/staff/reviews'] },
  { href: '/staff/messages', labelKey: 'messages', icon: 'message', permission: 'message.review', match: ['/staff/messages'] },
  { href: '/staff/users', labelKey: 'users', icon: 'users', permission: 'user.view', match: ['/staff/users'] },
  { href: '/staff/metrics', labelKey: 'metrics', icon: 'gauge', permission: 'analytics.view', match: ['/staff/metrics'] },
  { href: '/staff/feature-flags', labelKey: 'featureFlags', icon: 'sliders', permission: 'feature_flag.write', match: ['/staff/feature-flags'] },
  { href: '/staff/audit', labelKey: 'auditLog', icon: 'list', permission: 'audit.read', match: ['/staff/audit'] },
];

/**
 * The one entry that is NOT permission-gated.
 *
 * A staff member whose roles are withheld can reach no other section, and this
 * is the page that resolves that state — gating it on a permission they cannot
 * currently exercise would lock them out of the only way back in.
 */
const SECURITY_SECTION = {
  href: '/staff/security',
  labelKey: 'security',
  icon: 'shield' as const,
  match: ['/staff/security'],
};

export async function StaffShell({
  roles,
  withheldRoles,
  current,
  title,
  subtitle,
  badges,
  children,
}: {
  roles: readonly Role[];
  /** Held but not exercisable until a second factor is confirmed. */
  withheldRoles?: readonly Role[];
  /** Pathname of the page being rendered, for the active state. */
  current: string;
  title: string;
  subtitle?: string;
  badges?: { label: string; count: number; tone?: string }[];
  children: React.ReactNode;
}) {
  const t = await getTranslations('StaffNav');
  const visible = SECTIONS.filter((s) => can(roles, s.permission));
  /* A staff member whose roles are withheld sees an empty nav and would
     reasonably conclude the product is broken. One line saying what happened
     and where to go is the difference between a control and a dead end. */
  const withheld = withheldRoles ?? [];

  // Longest match wins, so /staff/disputes does not also light up /staff.
  const activeHref = visible
    .flatMap((s) => s.match.map((m) => ({ href: s.href, m })))
    .filter(({ m }) => current === m || current.startsWith(`${m}/`))
    .sort((a, b) => b.m.length - a.m.length)[0]?.href;

  return (
    <div className="container stf">
      <nav className="stf__nav" aria-label={t('navAria')}>
        {visible.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="stf__navLink"
            aria-current={s.href === activeHref ? 'page' : undefined}
          >
            <Icon name={s.icon} size={16} />
            {t(s.labelKey)}
          </Link>
        ))}
        <Link
          href={SECURITY_SECTION.href}
          className="stf__navLink"
          aria-current={current.startsWith(SECURITY_SECTION.href) ? 'page' : undefined}
        >
          <Icon name={SECURITY_SECTION.icon} size={16} />
          {t(SECURITY_SECTION.labelKey)}
        </Link>
        <span className="stf__roles" title={t('yourRoles')}>
          {roles.filter((r) => r !== 'TENANT' && r !== 'LANDLORD').join(' · ') || '—'}
        </span>
      </nav>

      {withheld.length > 0 && (
        <div className="stf__withheld" role="status">
          <Icon name="shield" size={16} />
          <span>{t('withheldNotice', { roles: withheld.join(' · ') })}</span>
          <Link href="/staff/security" className="btn btn-secondary btn-sm">
            {t('confirm')}
          </Link>
        </div>
      )}

      <header className="stf__head">
        <div className="stf__headMain">
          <h1 className="stf__title">{title}</h1>
          {subtitle && <p className="text-sm muted">{subtitle}</p>}
        </div>
        {badges && badges.length > 0 && (
          <div className="stf__badges">
            {badges.map((b) => (
              <span key={b.label} className={`badge badge-${b.tone ?? 'solid-neutral'}`}>
                {b.label}: <span className="numeric">{b.count}</span>
              </span>
            ))}
          </div>
        )}
      </header>

      {children}

      <style>{`
        .stf__withheld {
          display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;
          padding: var(--space-3); margin-bottom: var(--space-4);
          background: var(--warning-soft); border-radius: var(--radius-sm);
          font-size: var(--text-sm); line-height: 1.5;
        }
        .stf__withheld > svg { color: var(--warning); flex: 0 0 auto; }
        .stf__withheld > span { min-width: 0; }

        .stf { padding-block: var(--space-4) var(--space-8); max-width: 76rem; }

        .stf__nav {
          display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap;
          padding-bottom: var(--space-3); margin-bottom: var(--space-4);
          border-bottom: 1px solid var(--border);
        }
        .stf__navLink {
          display: inline-flex; align-items: center; gap: 0.4rem;
          min-height: 2.5rem; padding: 0.4rem 0.8rem;
          border-radius: var(--radius-sm);
          font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary);
        }
        .stf__navLink:hover { background: var(--surface); color: var(--text-primary); }
        .stf__navLink[aria-current='page'] { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
        .stf__navLink > svg { flex: 0 0 auto; }
        .stf__roles {
          margin-left: auto; font-size: var(--text-2xs); letter-spacing: 0.04em;
          color: var(--text-tertiary); text-transform: uppercase;
        }

        .stf__head {
          display: flex; align-items: flex-start; justify-content: space-between;
          gap: var(--space-4); flex-wrap: wrap; margin-bottom: var(--space-5);
        }
        .stf__headMain { display: grid; gap: 0.15rem; min-width: 0; }
        .stf__title { font-size: var(--text-xl); font-weight: 650; letter-spacing: -0.018em; }
        .stf__badges { display: flex; gap: var(--space-2); flex-wrap: wrap; }

        @media (max-width: 560px) {
          .stf__roles { margin-left: 0; width: 100%; }
        }
      `}</style>
    </div>
  );
}
