import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import type { AppLocale } from '@/i18n/routing.ts';

export const dynamic = 'force-dynamic';

/**
 * The phone gate (0018), for the one place every signed-in visit actually
 * lands: the dashboard. `/auth/me`-driven redirects live client-side inside
 * `PhoneVerify` for the case where verification completes while somebody is
 * already sitting on `/verify-phone`; this layout is the other direction —
 * catching every attempt to reach the dashboard before it renders, the same
 * way the API dispatcher catches every `auth: 'required'` route (see
 * router.ts's phone gate, which this mirrors: staff exempt, and no gate at
 * all when this deployment has no verification channel configured yet).
 *
 * The cabinet nav (0019) is wired in one level down, at
 * `dashboard/(hub)/layout.tsx`, not here — see that file for why a few
 * `/dashboard/*` routes (the listing wizard, the availability calendar)
 * deliberately sit outside that group and so never get it. Nesting it below
 * this layout rather than merging the two means the redirect above always
 * runs first: Next.js renders parent layouts before their children, so a
 * phone-gate redirect fires before the shell (or anything else) would render,
 * exactly as it did before this layout had a child layout at all.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  const locale = (await getLocale()) as AppLocale;
  if (!user) redirect({ href: signInUrl('/dashboard'), locale });

  const isStaff = user!.roles.some((r) => r !== 'TENANT' && r !== 'LANDLORD');
  const anyChannelConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN);

  if (!user!.phoneVerified && !isStaff && user!.withheldRoles.length === 0 && anyChannelConfigured) {
    redirect({ href: `/verify-phone?next=${encodeURIComponent('/dashboard')}`, locale });
  }

  return children;
}
