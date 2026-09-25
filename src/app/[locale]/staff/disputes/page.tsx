import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon } from '@/ui/icons.tsx';
import {
  DISPUTE_CATEGORIES,
  DISPUTE_CATEGORY_LABEL,
  type DisputeCategory,
} from '@/server/domain/dispute.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Disputes');
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

/**
 * The dispute queue.
 *
 * ORDERING IS THE PRODUCT. A case from somebody currently locked out of a flat
 * they paid for must not sit below a month-old complaint about a slow reply,
 * and «newest first» puts it there. The order comes from the domain's priority
 * rule, computed in SQL so that ordering and pagination happen in the database
 * rather than by fetching every case and sorting in the browser.
 *
 * Filters live in the URL, so a queue view can be bookmarked, shared in a
 * handover, or linked to from the overview.
 */

type Params = Record<string, string | string[] | undefined>;

const TAB_KEYS = ['ACTIVE', 'OPEN', 'UNDER_REVIEW', 'WAITING_FOR_PARTY', 'ESCALATED', 'RESOLVED', 'CLOSED', 'ALL'] as const;

const PRIORITY_TONE: Record<string, string> = {
  URGENT: 'danger',
  HIGH: 'warning',
  NORMAL: 'solid-neutral',
  LOW: 'neutral',
};

const STATUS_KEYS = ['OPEN', 'UNDER_REVIEW', 'WAITING_FOR_PARTY', 'ESCALATED', 'RESOLVED', 'CLOSED'] as const;

const str = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

export default async function DisputeQueuePage({ searchParams }: { searchParams: Promise<Params> }) {
  const t = await getTranslations('Disputes');
  const locale = await getLocale();
  const user = await currentUser();
  // `redirect` above never returns, but next-intl's generic typing for it
  // doesn't narrow `user` for the type checker the way `next/navigation`'s
  // does.
  if (!user) redirect({ href: signInUrl('/staff/disputes'), locale });
  if (!can(user!.roles, 'case.view')) notFound();

  const TABS = TAB_KEYS.map((key) => ({ key, label: t(`tab_${key}`) }));
  const PRIORITY_LABEL: Record<string, { label: string; tone: string }> = Object.fromEntries(
    Object.entries(PRIORITY_TONE).map(([key, tone]) => [key, { label: t(`priority_${key}`), tone }]),
  );
  const STATUS_LABEL: Record<string, string> = Object.fromEntries(
    STATUS_KEYS.map((key) => [key, t(`rowStatus_${key}`)]),
  );

  function age(hours: number): string {
    if (hours < 1) return t('justNow');
    if (hours < 24) return t('hoursAgo', { hours });
    const days = Math.floor(hours / 24);
    return t('daysAgo', { days });
  }

  const params = await searchParams;
  const status = str(params.status) ?? 'ACTIVE';
  const priority = str(params.priority);
  const category = str(params.category);
  const city = str(params.city);
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
    canReadMessages: can(user!.roles, 'message.review'),
    canViewFinance: can(user!.roles, 'debt.view'),
  };

  const result = await services.disputes.queue(
    { status, priority, category, city, assigned, q, limit, offset },
    staff,
  );
  const items = result.items as Record<string, any>[];

  const link = (patch: Record<string, string>) => {
    const next = new URLSearchParams();
    if (status !== 'ACTIVE') next.set('status', status);
    for (const [k, v] of Object.entries({ priority, category, city, assigned, q })) {
      if (v) next.set(k, v);
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    return qs ? `/staff/disputes?${qs}` : '/staff/disputes';
  };

  const overdue = items.filter((i) => i.overdue).length;

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/disputes"
      title={t('title')}
      subtitle={t('subtitle')}
      badges={[
        { label: t('badgeActive'), count: result.counts.ACTIVE ?? 0, tone: 'primary' },
        ...(overdue > 0 ? [{ label: t('badgeOverduePage'), count: overdue, tone: 'danger' }] : []),
      ]}
    >
      <nav className="dq__tabs" aria-label={t('tabsAriaLabel')}>
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={link({ status: tab.key === 'ACTIVE' ? '' : tab.key, offset: '' })}
            className="dq__tab"
            aria-current={tab.key === status ? 'page' : undefined}
          >
            {tab.label}
            <span className="dq__tabCount">{result.counts[tab.key] ?? 0}</span>
          </Link>
        ))}
      </nav>

      <form className="dq__filters" method="get" action="/staff/disputes">
        {status !== 'ACTIVE' && <input type="hidden" name="status" value={status} />}
        <label className="dq__search">
          <span className="sr-only">{t('searchSrLabel')}</span>
          <Icon name="search" size={17} />
          <input className="input" type="search" name="q" defaultValue={q ?? ''} placeholder={t('searchPlaceholder')} />
        </label>
        <label className="field dq__f">
          <span className="sr-only">{t('prioritySrLabel')}</span>
          <select className="select" name="priority" defaultValue={priority ?? ''}>
            <option value="">{t('priorityAny')}</option>
            {Object.entries(PRIORITY_LABEL).map(([value, p]) => (
              <option key={value} value={value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field dq__f">
          <span className="sr-only">{t('categorySrLabel')}</span>
          <select className="select" name="category" defaultValue={category ?? ''}>
            <option value="">{t('categoryAny')}</option>
            {DISPUTE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {DISPUTE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        {staff.canHandle && (
          <label className="field dq__f">
            <span className="sr-only">{t('assignedSrLabel')}</span>
            <select className="select" name="assigned" defaultValue={assigned ?? ''}>
              <option value="">{t('assignedAny')}</option>
              <option value="ME">{t('assignedMe')}</option>
              <option value="UNASSIGNED">{t('assignedUnassigned')}</option>
            </select>
          </label>
        )}
        <label className="field dq__f dq__f--city">
          <span className="sr-only">{t('citySrLabel')}</span>
          <input className="input" name="city" defaultValue={city ?? ''} placeholder={t('cityPlaceholder')} />
        </label>
        <button type="submit" className="btn btn-primary">
          {t('applyButton')}
        </button>
      </form>

      {items.length === 0 ? (
        <div className="dq__empty">
          <Icon name="checkCircle" size={26} />
          <p className="title-sm">{t('emptyTitle')}</p>
          <p className="text-sm muted">
            {status === 'ACTIVE' ? t('emptyActiveBody') : t('emptyFilteredBody')}
          </p>
        </div>
      ) : (
        <ul className="dq__list">
          {items.map((item) => {
            const p = PRIORITY_LABEL[item.priority] ?? PRIORITY_LABEL.NORMAL!;
            return (
              <li key={item.id}>
                <Link href={`/staff/disputes/${item.id}`} className={item.overdue ? 'dq__row is-overdue' : 'dq__row'}>
                  <span className="dq__lead">
                    <span className={`badge badge-${p.tone}`}>{p.label}</span>
                    <span className="dq__ref numeric">{item.reference}</span>
                  </span>

                  <span className="dq__main">
                    <span className="dq__titleRow">
                      <strong className="dq__title truncate">
                        {DISPUTE_CATEGORY_LABEL[item.category as DisputeCategory] ?? item.category}
                      </strong>
                      <span className="badge badge-solid-neutral">{STATUS_LABEL[item.status] ?? item.status}</span>
                      {item.bookingStatus && ['CONFIRMED', 'CHECKED_IN'].includes(item.bookingStatus) && (
                        <span className="badge badge-warning">{t('liveStayBadge')}</span>
                      )}
                    </span>
                    <span className="dq__summary truncate">{item.summary}</span>
                    <span className="dq__meta">
                      {item.propertyTitle ? `${item.propertyTitle} · ${item.propertyCity}` : t('noProperty')}
                      {' · '}
                      {item.openedByName}
                      {item.assigneeName ? t('assignedToName', { name: item.assigneeName }) : t('noAssignee')}
                    </span>
                  </span>

                  <span className="dq__age">
                    <span className={item.overdue ? 'dq__ageValue is-late' : 'dq__ageValue'}>
                      {age(Number(item.ageHours))}
                    </span>
                    {item.overdue && <span className="dq__late">{t('overdueBadge')}</span>}
                  </span>

                  <Icon name="chevronRight" size={18} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {(offset > 0 || items.length === limit) && (
        <nav className="dq__pager" aria-label={t('pagerAriaLabel')}>
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
        .dq__tabs { display: flex; gap: var(--space-1); flex-wrap: wrap; margin-bottom: var(--space-3); }
        .dq__tab {
          display: inline-flex; align-items: center; gap: 0.35rem;
          min-height: 2.375rem; padding: 0.35rem 0.7rem;
          border-radius: var(--radius-sm);
          font-size: var(--text-xs); font-weight: 500; color: var(--text-secondary);
        }
        @media (hover: hover) and (pointer: fine) {
          .dq__tab:hover { background: var(--surface); color: var(--text-primary); }
        }
        .dq__tab[aria-current='page'] { background: var(--surface); color: var(--text-primary); font-weight: 600; }
        .dq__tabCount {
          font-size: var(--text-2xs); font-weight: 700;
          padding: 0.05rem 0.3rem; border-radius: var(--radius-full);
          background: var(--surface-sunken); color: var(--text-secondary);
        }
        .dq__tab[aria-current='page'] .dq__tabCount { background: var(--primary-soft); color: var(--primary); }

        .dq__filters { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-4); }
        .dq__search { position: relative; display: flex; align-items: center; flex: 1 1 15rem; min-width: 0; }
        .dq__search svg { position: absolute; left: 0.75rem; color: var(--text-tertiary); pointer-events: none; }
        .dq__search .input { padding-left: 2.4rem; }
        .dq__f { flex: 0 1 11rem; }
        .dq__f--city { flex: 0 1 8rem; }

        .dq__list { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
        .dq__row {
          display: flex; align-items: center; gap: var(--space-3);
          padding: var(--space-3);
          background: var(--surface); border-radius: var(--radius-md);
          transition: box-shadow 160ms ease;
        }
        @media (hover: hover) and (pointer: fine) {
          .dq__row:hover { box-shadow: var(--shadow-raised); }
        }
        /* A rule, not just a colour: an overdue row is legible without hue. */
        .dq__row.is-overdue { box-shadow: inset 3px 0 0 var(--error); }
        .dq__row > svg:last-child { color: var(--text-tertiary); flex: 0 0 auto; }

        .dq__lead { display: grid; gap: 0.2rem; justify-items: start; flex: 0 0 7.5rem; }
        .dq__ref { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .dq__main { display: grid; gap: 0.2rem; flex: 1 1 auto; min-width: 0; }
        .dq__titleRow { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; min-width: 0; }
        .dq__title { font-size: var(--text-sm); }
        .dq__summary { font-size: var(--text-xs); color: var(--text-secondary); max-width: 60ch; }
        .dq__meta { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .dq__age { display: grid; gap: 0.1rem; justify-items: end; flex: 0 0 auto; text-align: right; }
        .dq__ageValue { font-size: var(--text-xs); color: var(--text-secondary); }
        .dq__ageValue.is-late { color: var(--error); font-weight: 600; }
        .dq__late { font-size: var(--text-2xs); color: var(--error); }

        .dq__empty { display: grid; justify-items: center; gap: 0.3rem; padding: var(--space-8) var(--space-4); text-align: center; }
        .dq__empty > svg { color: var(--success); margin-bottom: var(--space-2); }
        .dq__pager { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-top: var(--space-4); }

        @media (max-width: 760px) {
          .dq__row { flex-wrap: wrap; }
          .dq__lead { flex: 1 1 100%; display: flex; align-items: center; gap: var(--space-2); }
          .dq__age { flex: 0 0 auto; }
          .dq__filters > * { flex: 1 1 100%; }
        }
      `}</style>
    </StaffShell>
  );
}
