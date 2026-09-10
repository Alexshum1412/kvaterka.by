import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { ReviewModerationQueue, type ReportedReview } from '@/ui/review-moderation-queue.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('StaffReviews');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The reported-review queue.
 *
 * Every row here got here because somebody filed a report against an
 * already-visible review — reporting never hides it on its own, so this is
 * the only screen that actually decides. The decision itself (keep / hide /
 * remove, always with a written note) is interactive and lives in a client
 * component; this page only fetches the starting list.
 */
export default async function StaffReviewsPage() {
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl('/staff/reviews'), locale });
  // 404, not 403 — consistent with every other staff surface.
  if (!can(user!.roles, 'review.moderate')) notFound();

  const t = await getTranslations('StaffReviews');
  const services = await readyServices();
  const items = (await services.reviews.moderationQueue()) as unknown as ReportedReview[];

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/reviews"
      title={t('title')}
      subtitle={t('subtitle')}
      badges={[
        { label: t('badgeOpen'), count: items.length, tone: items.length > 0 ? 'warning' : undefined },
      ]}
    >
      <ReviewModerationQueue initialItems={items} />
    </StaffShell>
  );
}
