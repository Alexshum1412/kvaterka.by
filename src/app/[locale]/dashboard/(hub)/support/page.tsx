import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { Icon } from '@/ui/icons.tsx';
import type { AppLocale } from '@/i18n/routing.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SupportTickets');
  return { title: t('myTitle'), robots: { index: false, follow: false } };
}

/**
 * "My tickets" — the cabinet-side half of DEC-073.
 *
 * Same list-then-detail shape as `dashboard/(hub)/bookings`, deliberately
 * without that page's tabs: a ticket has five statuses, not the dozen a
 * booking does, and most people have one or two tickets ever, not a history
 * worth filtering.
 */

const STATUS_TONE: Record<string, string> = {
  OPEN: 'warning',
  IN_PROGRESS: 'primary',
  WAITING_ON_USER: 'warning',
  RESOLVED: 'verified',
  CLOSED: 'solid-neutral',
};

export default async function MyTicketsPage() {
  const locale = (await getLocale()) as AppLocale;
  const user = await currentUser();
  if (!user) redirect({ href: signInUrl('/dashboard/support'), locale });

  const t = await getTranslations('SupportTickets');
  const services = await readyServices();
  const tickets = (await services.tickets.myTickets(user!.userId)) as Record<string, any>[];

  const dateFormat = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmt = (value: string | null) => (value ? dateFormat.format(new Date(value)) : '');

  return (
    <div className="container mt">
      <header className="mt__head">
        <h1 className="title-lg">{t('myTitle')}</h1>
        <p className="text-sm muted">{t('mySubtitle')}</p>
      </header>

      <p className="mt__back">
        <Link href="/support" className="link text-sm">
          {t('myBackToSupport')}
        </Link>
      </p>

      {tickets.length === 0 ? (
        <div className="mt__empty">
          <Icon name="checkCircle" size={26} />
          <p className="title-sm">{t('myEmptyTitle')}</p>
          <p className="text-sm muted">{t('myEmptyBody')}</p>
          <Link href="/support" className="btn btn-primary btn-sm">
            {t('myEmptyLink')}
          </Link>
        </div>
      ) : (
        <ul className="mt__list">
          {tickets.map((tk) => (
            <li key={tk.id}>
              <Link href={`/dashboard/support/${tk.id}`} className="mt__row">
                <span className="mt__lead">
                  <span className={`badge badge-${STATUS_TONE[tk.status] ?? 'solid-neutral'}`}>
                    {t(`status_${tk.status}`)}
                  </span>
                  <span className="mt__ref numeric">{tk.reference}</span>
                </span>
                <span className="mt__main">
                  <strong className="mt__summary truncate">{tk.summary}</strong>
                  <span className="mt__meta">
                    {tk.propertyTitle ? t('myRowProperty', { title: tk.propertyTitle }) : t('myRowNoProperty')}
                    {' · '}
                    {t('myRowUpdated', { date: fmt(tk.updatedAt) })}
                  </span>
                </span>
                <Icon name="chevronRight" size={18} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <style>{`
        .mt { padding-block: var(--space-4) var(--space-8); max-width: 48rem; }
        .mt__head { display: grid; gap: 0.2rem; margin-bottom: var(--space-2); }
        .mt__back { margin-bottom: var(--space-4); }

        .mt__list { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
        .mt__row {
          display: flex; align-items: center; gap: var(--space-3);
          padding: var(--space-3); background: var(--surface); border-radius: var(--radius-md);
          transition: box-shadow 160ms ease;
        }
        @media (hover: hover) and (pointer: fine) {
          .mt__row:hover { box-shadow: var(--shadow-raised); }
        }
        .mt__row > svg:last-child { color: var(--text-tertiary); flex: 0 0 auto; }

        .mt__lead { display: grid; gap: 0.2rem; justify-items: start; flex: 0 0 8rem; }
        .mt__ref { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .mt__main { display: grid; gap: 0.2rem; flex: 1 1 auto; min-width: 0; }
        .mt__summary { font-size: var(--text-sm); }
        .mt__meta { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .mt__empty { display: grid; justify-items: center; gap: 0.4rem; padding: var(--space-8) var(--space-4); text-align: center; }
        .mt__empty > svg { color: var(--success); margin-bottom: var(--space-2); }

        @media (max-width: 480px) {
          .mt__row { flex-wrap: wrap; }
          .mt__lead { flex: 1 1 100%; display: flex; align-items: center; gap: var(--space-2); }
        }
      `}</style>
    </div>
  );
}
