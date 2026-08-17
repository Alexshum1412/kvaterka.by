import Link from 'next/link';
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
  label: string;
  icon: IconName;
  permission: Permission;
  /** Matches this section when the current path starts with one of these. */
  match: string[];
}

const SECTIONS: Section[] = [
  { href: '/staff', label: 'Обзор', icon: 'home', permission: 'case.view', match: ['/staff'] },
  { href: '/staff/disputes', label: 'Обращения', icon: 'alert', permission: 'case.view', match: ['/staff/disputes'] },
  { href: '/moderation', label: 'Модерация', icon: 'checkCircle', permission: 'listing.moderate', match: ['/moderation'] },
];

export function StaffShell({
  roles,
  current,
  title,
  subtitle,
  badges,
  children,
}: {
  roles: readonly Role[];
  /** Pathname of the page being rendered, for the active state. */
  current: string;
  title: string;
  subtitle?: string;
  badges?: { label: string; count: number; tone?: string }[];
  children: React.ReactNode;
}) {
  const visible = SECTIONS.filter((s) => can(roles, s.permission));

  // Longest match wins, so /staff/disputes does not also light up /staff.
  const activeHref = visible
    .flatMap((s) => s.match.map((m) => ({ href: s.href, m })))
    .filter(({ m }) => current === m || current.startsWith(`${m}/`))
    .sort((a, b) => b.m.length - a.m.length)[0]?.href;

  return (
    <div className="container stf">
      <nav className="stf__nav" aria-label="Операции">
        {visible.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="stf__navLink"
            aria-current={s.href === activeHref ? 'page' : undefined}
          >
            <Icon name={s.icon} size={16} />
            {s.label}
          </Link>
        ))}
        <span className="stf__roles" title="Ваши роли">
          {roles.filter((r) => r !== 'TENANT' && r !== 'LANDLORD').join(' · ') || '—'}
        </span>
      </nav>

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
