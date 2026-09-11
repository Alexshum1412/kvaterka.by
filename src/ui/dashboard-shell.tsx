'use client';

import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation.ts';
import { Icon, type IconName } from '@/ui/icons.tsx';

/**
 * The landlord/tenant cabinet frame (0019).
 *
 * Before this, `/dashboard`, `/dashboard/bookings`, `/dashboard/finance`,
 * `/dashboard/chat`, `/dashboard/account` and `/dashboard/verification` were
 * six separate screens stitched together only by ad-hoc links from one page
 * to the next — there was no single place that said "here is your whole
 * cabinet, here is where you are in it". This is that place, the same job
 * `StaffShell` does for the operations console, adapted for an audience that
 * is not staff: no permission gating (every signed-in person sees every
 * section — there is no role split inside a personal cabinet the way there
 * is inside a shared operations one), and a warmer, plainer label set.
 *
 * A client component, not a server one: the active section is derived from
 * `usePathname()` rather than a `current` prop threaded through every page
 * (`StaffShell`'s approach) — one nav definition, wired into
 * `dashboard/layout.tsx` once, and every page under it highlights correctly
 * with zero per-page wiring. The cost is real (this subtree hydrates), but
 * it is a handful of links, not a data-heavy screen.
 *
 * Deliberately NOT wired around the listing wizard (`/dashboard/listings/new`,
 * `/dashboard/listings/[id]/edit`) or the availability calendar
 * (`/dashboard/listings/[id]/calendar`) — see `dashboard/(hub)/layout.tsx`'s
 * comment for why those stay outside the route group this renders in.
 */

interface Section {
  href: string;
  labelKey: string;
  icon: IconName;
  /** Matches this section when the current path starts with one of these. */
  match: string[];
}

const SECTIONS: Section[] = [
  { href: '/dashboard', labelKey: 'overview', icon: 'home', match: ['/dashboard'] },
  { href: '/dashboard/bookings', labelKey: 'bookings', icon: 'calendar', match: ['/dashboard/bookings'] },
  { href: '/dashboard/finance', labelKey: 'finance', icon: 'wallet', match: ['/dashboard/finance'] },
  { href: '/dashboard/chat', labelKey: 'messages', icon: 'message', match: ['/dashboard/chat'] },
  { href: '/dashboard/verification', labelKey: 'verification', icon: 'shieldCheck', match: ['/dashboard/verification'] },
  { href: '/dashboard/account', labelKey: 'account', icon: 'user', match: ['/dashboard/account'] },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations('DashboardNav');
  const pathname = usePathname();

  // Longest match wins, so /dashboard/bookings does not also light up
  // /dashboard — the same rule StaffShell uses for the same reason.
  const activeHref = SECTIONS
    .flatMap((s) => s.match.map((m) => ({ href: s.href, m })))
    .filter(({ m }) => pathname === m || pathname.startsWith(`${m}/`))
    .sort((a, b) => b.m.length - a.m.length)[0]?.href;

  return (
    <>
      <nav className="dsh__nav container" aria-label={t('navAria')}>
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="dsh__navLink"
            aria-current={s.href === activeHref ? 'page' : undefined}
          >
            <Icon name={s.icon} size={17} />
            {t(s.labelKey)}
          </Link>
        ))}
      </nav>

      {children}

      <style>{`
        .dsh__nav {
          display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap;
          padding-block: var(--space-3);
          border-bottom: 1px solid var(--border);
        }
        .dsh__navLink {
          display: inline-flex; align-items: center; gap: 0.4rem;
          min-height: 2.5rem; padding: 0.4rem 0.8rem;
          border-radius: var(--radius-sm);
          font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary);
        }
        .dsh__navLink:hover { background: var(--surface); color: var(--text-primary); }
        .dsh__navLink[aria-current='page'] { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
        .dsh__navLink > svg { flex: 0 0 auto; }

        @media (max-width: 480px) {
          .dsh__navLink { padding-inline: 0.6rem; font-size: var(--text-xs); }
        }
      `}</style>
    </>
  );
}
