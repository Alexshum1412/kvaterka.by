import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { UserDirectory } from '@/ui/user-directory.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('StaffUsers');
  return { title: t('list.title'), robots: { index: false, follow: false } };
}

/**
 * The user directory.
 *
 * The page itself is only the permission gate and the shell — there is no
 * service method backing `/admin/users` (the route reads `app_user`
 * directly), so the search and the table live in a client component that
 * talks to the API the same way `AuditLog` and `FeatureFlagList` do.
 */
export default async function StaffUsersPage() {
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl('/staff/users'), locale });
  // 404, not 403 — consistent with every other staff surface.
  if (!can(user!.roles, 'user.view')) notFound();

  const t = await getTranslations('StaffUsers');

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/users"
      title={t('list.title')}
      subtitle={t('list.subtitle')}
    >
      <UserDirectory canCreate={can(user!.roles, 'user.create')} />
    </StaffShell>
  );
}
