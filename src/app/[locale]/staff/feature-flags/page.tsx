import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { FeatureFlagList } from '@/ui/feature-flag-list.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('StaffFeatureFlags');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The feature-flag console.
 *
 * The page itself is only the permission gate and the shell — there is no
 * service method backing `/admin/feature-flags` (the route reads the table
 * directly), so the list, and every toggle on it, live in a client component
 * that talks to the API the same way every other admin screen does.
 */
export default async function StaffFeatureFlagsPage() {
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl('/staff/feature-flags'), locale });
  // 404, not 403 — consistent with every other staff surface.
  if (!can(user!.roles, 'feature_flag.write')) notFound();

  const t = await getTranslations('StaffFeatureFlags');

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/feature-flags"
      title={t('title')}
      subtitle={t('subtitle')}
    >
      <FeatureFlagList />
    </StaffShell>
  );
}
