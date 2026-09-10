import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { AuditLog } from '@/ui/audit-log.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('StaffAudit');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The audit log console.
 *
 * Same shape as the feature-flag page: a server-side permission gate and
 * nothing else. `/admin/audit` has no service method to call at render
 * time and its filters are meant to re-query live, so the fetch, the filter
 * form and the diff rendering all live in the client component.
 */
export default async function StaffAuditPage() {
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl('/staff/audit'), locale });
  // 404, not 403 — consistent with every other staff surface.
  if (!can(user!.roles, 'audit.read')) notFound();

  const t = await getTranslations('StaffAudit');

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/audit"
      title={t('title')}
      subtitle={t('subtitle')}
    >
      <AuditLog />
    </StaffShell>
  );
}
