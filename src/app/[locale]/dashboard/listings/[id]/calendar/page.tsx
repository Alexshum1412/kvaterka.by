import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Link, redirect } from '@/i18n/navigation.ts';
import { getLocale, getTranslations } from 'next-intl/server';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { AvailabilityCalendar } from '@/ui/availability-calendar.tsx';
import { Icon } from '@/ui/icons.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Calendar');
  return { title: t('pageTitle'), robots: { index: false, follow: false } };
}

export default async function CalendarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl(`/dashboard/listings/${id}/calendar`), locale });

  const t = await getTranslations('Calendar');

  const services = await readyServices();
  let listing: Record<string, unknown>;
  try {
    // `redirect` above never returns, but next-intl's generic typing for it
    // doesn't narrow `user` for the type checker the way `next/navigation`'s
    // does.
    listing = await services.listings.getForOwner(id, user!.userId);
  } catch {
    notFound();
  }

  return (
    <div className="container calpage">
      <nav className="calpage__back">
        <Link href="/dashboard" className="calpage__backLink">
          <Icon name="arrowLeft" size={16} />
          {t('backToDashboard')}
        </Link>
      </nav>

      <header className="calpage__head">
        <h1 className="title-lg">{t('pageTitle')}</h1>
        <p className="text-sm muted">{String(listing.title ?? t('untitledDraft'))}</p>
      </header>

      <AvailabilityCalendar propertyId={id} />

      <style>{`
        .calpage { padding-block: var(--space-4) var(--space-8); max-width: 44rem; }
        .calpage__back { margin-bottom: var(--space-3); }
        .calpage__backLink { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; font-size: var(--text-sm); color: var(--text-secondary); }
        @media (hover: hover) and (pointer: fine) {
          .calpage__backLink:hover { color: var(--text-primary); }
        }
        .calpage__head { display: grid; gap: 0.2rem; margin-bottom: var(--space-5); }
      `}</style>
    </div>
  );
}
