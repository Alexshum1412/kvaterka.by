import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon } from '@/ui/icons.tsx';
import { TICKET_CATEGORIES, TICKET_CATEGORY_LABEL, type TicketCategory } from '@/server/domain/support-ticket.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SupportTickets');
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

/**
 * The ticket queue — a sibling of `/staff/disputes`, deliberately simpler:
 * no priority column (a ticket has no "is a stay active right now" signal to
 * derive one from — see DEC-073), so ordering is plain FIFO among open
 * tickets with terminal ones pushed to the bottom, same as the dispute
 * queue's own fallback rule for cases sharing a priority.
 */

type Params = Record<string, string | string[] | undefined>;

const TAB_KEYS = ['ACTIVE', 'OPEN', 'IN_PROGRESS', 'WAITING_ON_USER', 'RESOLVED', 'CLOSED', 'ALL'] as const;
const STATUS_TONE: Record<string, string> = {
  OPEN: 'warning',
  IN_PROGRESS: 'primary',
  WAITING_ON_USER: 'warning',
  RESOLVED: 'verified',
  CLOSED: 'solid-neutral',
};

const str = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

export default async function TicketQueuePage({ searchParams }: { searchParams: Promise<Params> }) {
  const t = await getTranslations('SupportTickets');
  const locale = await getLocale();
  const user = await currentUser();
  if (!user) redirect({ href: signInUrl('/staff/tickets'), locale });
  if (!can(user!.roles, 'case.view')) notFound();

  const TABS = TAB_KEYS.map((key) => ({ key, label: t(`tab_${key}`) }));

  function age(hours: number): string {
    if (hours < 1) return t('justNow');
    if (hours < 24) return t('hoursAgo', { hours });
    const days = Math.floor(hours / 24);
    return t('daysAgo', { days });
  }

  const params = await searchParams;
  const status = str(params.status) ?? 'ACTIVE';
  const category = str(params.category);
  const assigned = str(params.assigned);
  const q = str(params.q);
  const limit = 25;
  const offset = Math.max(0, Number(str(params.offset) ?? 0) || 0);

  const services = await readyServices();
  const staff = {
    userId: user!.userId,
    role: user!.roles.includes('ADMIN') ? 'ADMIN' : (user!.roles[0] ?? 'STAFF'),
    canView: true,
    canHandle: can(user!.roles, 'case.handle'),
    canResolve: can(user!.roles, 'case.resolve'),
  };

  const result = await services.tickets.queue({ status, category, assigned, q, limit, offset }, staff);
  const items = result.items as Record<string, any>[];

  const link = (patch: Record<string, string>) => {
    const next = new URLSearchParams();
    if (status !== 'ACTIVE') next.set('status', status);
    for (const [k, v] of Object.entries({ category, assigned, q })) {
      if (v) next.set(k, v);
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    return qs ? `/staff/tickets?${qs}` : '/staff/tickets';
  };

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/tickets"
      title={t('queueTitle')}
      subtitle={t('queueSubtitle')}
      badges={[{ label: t('tab_ACTIVE'), count: result.counts.ACTIVE ?? 0, tone: 'primary' }]}
    >
      <nav className="tq__tabs" aria-label={t('tabsAriaLabel')}>
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={link({ status: tab.key === 'ACTIVE' ? '' : tab.key, offset: '' })}
            className="tq__tab"
            aria-current={tab.key === status ? 'page' : undefined}
          >
            {tab.label}
            <span className="tq__tabCount">{result.counts[tab.key] ?? 0}</span>
          </Link>
        ))}
      </nav>

      <form className="tq__filters" method="get" action="/staff/tickets">
        {status !== 'ACTIVE' && <input type="hidden" name="status" value={status} />}
        <label className="tq__search">
          <span className="sr-only">{t('searchSrLabel')}</span>
          <Icon name="search" size={17} />
          <input className="input" type="search" name="q" defaultValue={q ?? ''} placeholder={t('searchPlaceholder')} />
        </label>
        <label className="field tq__f">
          <span className="sr-only">{t('categorySrLabel')}</span>
          <select className="select" name="category" defaultValue={category ?? ''}>
            <option value="">{t('categoryAny')}</option>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {TICKET_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        {staff.canHandle && (
          <label className="field tq__f">
            <span className="sr-only">{t('assignedSrLabel')}</span>
            <select className="select" name="assigned" defaultValue={assigned ?? ''}>
              <option value="">{t('assignedAny')}</option>
              <option value="ME">{t('assignedMe')}</option>
              <option value="UNASSIGNED">{t('assignedUnassigned')}</option>
            </select>
          </label>
        )}
        <button type="submit" className="btn btn-primary">
          {t('applyButton')}
        </button>
      </form>

      {items.length === 0 ? (
        <div className="tq__empty">
          <Icon name="checkCircle" size={26} />
          <p className="title-sm">{t('emptyTitle')}</p>
          <p className="text-sm muted">{status === 'ACTIVE' ? t('emptyActiveBody') : t('emptyFilteredBody')}</p>
        </div>
      ) : (
        <ul className="tq__list">
          {items.map((item) => (
            <li key={item.id}>
              <Link href={`/staff/tickets/${item.id}`} className="tq__row">
                <span className="tq__lead">
                  <span className={`badge badge-${STATUS_TONE[item.status] ?? 'solid-neutral'}`}>
                    {t(`status_${item.status}`)}
                  </span>
                  <span className="tq__ref numeric">{item.reference}</span>
                </span>

                <span className="tq__main">
                  <span className="tq__titleRow">
                    <strong className="tq__title truncate">
                      {TICKET_CATEGORY_LABEL[item.category as TicketCategory] ?? item.category}
                    </strong>
                  </span>
                  <span className="tq__summary truncate">{item.summary}</span>
                  <span className="tq__meta">
                    {item.propertyTitle ? `${item.propertyTitle}` : t('noProperty')}
                    {' · '}
                    {item.openedByName}
                    {item.assigneeName ? t('assignedToName', { name: item.assigneeName }) : t('noAssignee')}
                  </span>
                </span>

                <span className="tq__age">
                  <span className="tq__ageValue">{age(Number(item.ageHours))}</span>
                </span>

                <Icon name="chevronRight" size={18} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {(offset > 0 || items.length === limit) && (
        <nav className="tq__pager" aria-label={t('pagerAriaLabel')}>
          {offset > 0 ? (
            <Link className="btn btn-secondary btn-sm" href={link({ offset: String(Math.max(0, offset - limit)) })}>
              <Icon name="arrowLeft" size={15} />
              {t('backButton')}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs muted numeric">
            {offset + 1}–{offset + items.length}
          </span>
          {items.length === limit ? (
            <Link className="btn btn-secondary btn-sm" href={link({ offset: String(offset + limit) })}>
              {t('nextButton')}
              <Icon name="arrowRight" size={15} />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}

      <style>{`
        .tq__tabs { display: flex; gap: var(--space-1); flex-wrap: wrap; margin-bottom: var(--space-3); }
        .tq__tab {
          display: inline-flex; align-items: center; gap: 0.35rem;
          min-height: 2.375rem; padding: 0.35rem 0.7rem;
          border-radius: var(--radius-sm);
          font-size: var(--text-xs); font-weight: 500; color: var(--text-secondary);
        }
        .tq__tab:hover { background: var(--surface); color: var(--text-primary); }
        .tq__tab[aria-current='page'] { background: var(--surface); color: var(--text-primary); font-weight: 600; }
        .tq__tabCount {
          font-size: var(--text-2xs); font-weight: 700;
          padding: 0.05rem 0.3rem; border-radius: var(--radius-full);
          background: var(--surface-sunken); color: var(--text-secondary);
        }
        .tq__tab[aria-current='page'] .tq__tabCount { background: var(--primary-soft); color: var(--primary); }

        .tq__filters { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-4); }
        .tq__search { position: relative; display: flex; align-items: center; flex: 1 1 15rem; min-width: 0; }
        .tq__search svg { position: absolute; left: 0.75rem; color: var(--text-tertiary); pointer-events: none; }
        .tq__search .input { padding-left: 2.4rem; }
        .tq__f { flex: 0 1 11rem; }

        .tq__list { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
        .tq__row {
          display: flex; align-items: center; gap: var(--space-3);
          padding: var(--space-3);
          background: var(--surface); border-radius: var(--radius-md);
          transition: box-shadow 160ms ease;
        }
        .tq__row:hover { box-shadow: var(--shadow-raised); }
        .tq__row > svg:last-child { color: var(--text-tertiary); flex: 0 0 auto; }

        .tq__lead { display: grid; gap: 0.2rem; justify-items: start; flex: 0 0 7.5rem; }
        .tq__ref { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .tq__main { display: grid; gap: 0.2rem; flex: 1 1 auto; min-width: 0; }
        .tq__titleRow { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; min-width: 0; }
        .tq__title { font-size: var(--text-sm); }
        .tq__summary { font-size: var(--text-xs); color: var(--text-secondary); max-width: 60ch; }
        .tq__meta { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .tq__age { display: grid; gap: 0.1rem; justify-items: end; flex: 0 0 auto; text-align: right; }
        .tq__ageValue { font-size: var(--text-xs); color: var(--text-secondary); }

        .tq__empty { display: grid; justify-items: center; gap: 0.3rem; padding: var(--space-8) var(--space-4); text-align: center; }
        .tq__empty > svg { color: var(--success); margin-bottom: var(--space-2); }
        .tq__pager { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-top: var(--space-4); }

        @media (max-width: 760px) {
          .tq__row { flex-wrap: wrap; }
          .tq__lead { flex: 1 1 100%; display: flex; align-items: center; gap: var(--space-2); }
          .tq__age { flex: 0 0 auto; }
          .tq__filters > * { flex: 1 1 100%; }
        }
      `}</style>
    </StaffShell>
  );
}
