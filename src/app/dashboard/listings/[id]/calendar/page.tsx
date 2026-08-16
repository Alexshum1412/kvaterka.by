import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { AvailabilityCalendar } from '@/ui/availability-calendar.tsx';
import { Icon } from '@/ui/icons.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Календарь',
  robots: { index: false, follow: false },
};

export default async function CalendarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(signInUrl(`/dashboard/listings/${id}/calendar`));

  const services = await readyServices();
  let listing: Record<string, unknown>;
  try {
    listing = await services.listings.getForOwner(id, user.userId);
  } catch {
    notFound();
  }

  return (
    <div className="container calpage">
      <nav className="calpage__back">
        <Link href="/dashboard" className="calpage__backLink">
          <Icon name="arrowLeft" size={16} />
          Кабинет
        </Link>
      </nav>

      <header className="calpage__head">
        <h1 className="title-lg">Календарь</h1>
        <p className="text-sm muted">{String(listing.title ?? 'Черновик без названия')}</p>
      </header>

      <AvailabilityCalendar propertyId={id} />

      <style>{`
        .calpage { padding-block: var(--space-4) var(--space-8); max-width: 44rem; }
        .calpage__back { margin-bottom: var(--space-3); }
        .calpage__backLink { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .calpage__backLink:hover { color: var(--text-primary); }
        .calpage__head { display: grid; gap: 0.2rem; margin-bottom: var(--space-5); }
      `}</style>
    </div>
  );
}
