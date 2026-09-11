import { DashboardShell } from '@/ui/dashboard-shell.tsx';

/**
 * The route group that gets the cabinet nav (0019).
 *
 * A route group (`(hub)`) rather than a change to every page: it adds this
 * layout to a subset of `/dashboard/*` without moving a single URL — every
 * link and bookmark that already pointed at `/dashboard/bookings` etc. still
 * resolves exactly the same way, since `(hub)` contributes no path segment.
 *
 * NOT every `/dashboard/*` page lives in this group. The listing wizard
 * (`/dashboard/listings/new`, `/dashboard/listings/[id]/edit`) is a focused,
 * full-bleed flow with its own top bar (save-and-exit, a step progress bar)
 * — a second nav bar stacked above that would compete with it rather than
 * help, the same reason a checkout flow drops the site's own chrome. The
 * availability calendar (`/dashboard/listings/[id]/calendar`) is the same
 * kind of single-purpose sub-screen and already carries its own "back to
 * dashboard" link. Both stay siblings of this group, directly under
 * `src/app/[locale]/dashboard/`, so they keep only the phone-verification
 * gate from `dashboard/layout.tsx` and none of this chrome.
 */
export default function DashboardHubLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
