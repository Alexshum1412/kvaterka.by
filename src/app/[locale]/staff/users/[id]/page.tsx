import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon } from '@/ui/icons.tsx';
import { UserDetail } from '@/ui/user-detail.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('StaffUsers');
  return { title: t('detail.title'), robots: { index: false, follow: false } };
}

/**
 * One user's card.
 *
 * Same shape as the directory: a server-side permission gate and nothing
 * else. `/admin/users/:userId` has no service method at render time either,
 * so the fetch, the profile facts and both action panels live in
 * `UserDetail` (which the page passes `can()` results into, rather than
 * re-deciding permission client-side).
 */
export default async function StaffUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl(`/staff/users/${id}`), locale });
  if (!can(user!.roles, 'user.view')) notFound();

  const t = await getTranslations('StaffUsers');

  return (
    <StaffShell roles={user!.roles} withheldRoles={user!.withheldRoles} current="/staff/users" title={t('detail.title')}>
      <Link href="/staff/users" className="udback">
        <Icon name="arrowLeft" size={15} />
        {t('detail.backToList')}
      </Link>

      <UserDetail
        userId={id}
        canSuspend={can(user!.roles, 'user.suspend')}
        canGrantRoles={can(user!.roles, 'role.grant')}
      />

      <style>{`
        .udback {
          display: inline-flex; align-items: center; gap: 0.35rem;
          min-height: 2.5rem; margin-bottom: var(--space-2);
          font-size: var(--text-sm); color: var(--text-secondary);
        }
        @media (hover: hover) and (pointer: fine) {
          .udback:hover { color: var(--text-primary); }
        }
      `}</style>
    </StaffShell>
  );
}
