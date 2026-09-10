import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon } from '@/ui/icons.tsx';
import { UserCreateForm } from '@/ui/user-create-form.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('StaffUsers');
  return { title: t('new.title'), robots: { index: false, follow: false } };
}

/**
 * Create a staff-managed account.
 *
 * Gated on `user.create` rather than `user.view`: creating an account is a
 * distinct, more consequential act than browsing the directory, and holding
 * one permission must not silently unlock the other.
 */
export default async function StaffUserCreatePage() {
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl('/staff/users/new'), locale });
  if (!can(user!.roles, 'user.create')) notFound();

  const t = await getTranslations('StaffUsers');

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/users"
      title={t('new.title')}
      subtitle={t('new.subtitle')}
    >
      <Link href="/staff/users" className="unback">
        <Icon name="arrowLeft" size={15} />
        {t('detail.backToList')}
      </Link>

      <UserCreateForm />

      <style>{`
        .unback {
          display: inline-flex; align-items: center; gap: 0.35rem;
          min-height: 2.5rem; margin-bottom: var(--space-4);
          font-size: var(--text-sm); color: var(--text-secondary);
        }
        .unback:hover { color: var(--text-primary); }
      `}</style>
    </StaffShell>
  );
}
