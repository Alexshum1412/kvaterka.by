import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon } from '@/ui/icons.tsx';
import { plural } from '@/ui/primitives.tsx';
import {
  DISPUTE_CATEGORIES,
  DISPUTE_CATEGORY_LABEL,
  type DisputeCategory,
} from '@/server/domain/dispute.ts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Обращения',
  robots: { index: false, follow: false },
};

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

const TABS = [
  { key: 'ACTIVE', label: 'В работе' },
  { key: 'OPEN', label: 'Новые' },
  { key: 'UNDER_REVIEW', label: 'Разбираем' },
  { key: 'WAITING_FOR_PARTY', label: 'Ждём ответа' },
  { key: 'ESCALATED', label: 'Переданы выше' },
  { key: 'RESOLVED', label: 'Решены' },
  { key: 'CLOSED', label: 'Закрыты' },
  { key: 'ALL', label: 'Все' },
] as const;

const PRIORITY_LABEL: Record<string, { label: string; tone: string }> = {
  URGENT: { label: 'Срочно', tone: 'danger' },
  HIGH: { label: 'Высокий', tone: 'warning' },
  NORMAL: { label: 'Обычный', tone: 'solid-neutral' },
  LOW: { label: 'Низкий', tone: 'neutral' },
};

const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Новое',
  UNDER_REVIEW: 'Разбираем',
  WAITING_FOR_PARTY: 'Ждём ответа',
  ESCALATED: 'Передано выше',
  RESOLVED: 'Решено',
  CLOSED: 'Закрыто',
};

const str = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

function age(hours: number): string {
  if (hours < 1) return 'только что';
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

export default async function DisputeQueuePage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/staff/disputes'));
  if (!can(user.roles, 'case.view')) notFound();

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
    userId: user.userId,
    role: user.roles.includes('ADMIN') ? 'ADMIN' : (user.roles[0] ?? 'STAFF'),
    canView: true,
    canHandle: can(user.roles, 'case.handle'),
    canResolve: can(user.roles, 'case.resolve'),
    canReadMessages: can(user.roles, 'message.review'),
    canViewFinance: can(user.roles, 'debt.view'),
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
      roles={user.roles}
      withheldRoles={user.withheldRoles}
      current="/staff/disputes"
      title="Обращения"
      subtitle="Сверху — то, где кто-то сейчас без жилья или в опасности."
      badges={[
        { label: 'В работе', count: result.counts.ACTIVE ?? 0, tone: 'primary' },
        ...(overdue > 0 ? [{ label: 'Просрочено на странице', count: overdue, tone: 'danger' }] : []),
      ]}
    >
      <nav className="dq__tabs" aria-label="Статус">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={link({ status: t.key === 'ACTIVE' ? '' : t.key, offset: '' })}
            className="dq__tab"
            aria-current={t.key === status ? 'page' : undefined}
          >
            {t.label}
            <span className="dq__tabCount">{result.counts[t.key] ?? 0}</span>
          </Link>
        ))}
      </nav>

      <form className="dq__filters" method="get" action="/staff/disputes">
        {status !== 'ACTIVE' && <input type="hidden" name="status" value={status} />}
        <label className="dq__search">
          <span className="sr-only">Поиск по номеру, тексту или объекту</span>
          <Icon name="search" size={17} />
          <input className="input" type="search" name="q" defaultValue={q ?? ''} placeholder="Номер, текст или объект" />
        </label>
        <label className="field dq__f">
          <span className="sr-only">Приоритет</span>
          <select className="select" name="priority" defaultValue={priority ?? ''}>
            <option value="">Любой приоритет</option>
            {Object.entries(PRIORITY_LABEL).map(([value, p]) => (
              <option key={value} value={value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field dq__f">
          <span className="sr-only">Тема</span>
          <select className="select" name="category" defaultValue={category ?? ''}>
            <option value="">Любая тема</option>
            {DISPUTE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {DISPUTE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        {staff.canHandle && (
          <label className="field dq__f">
            <span className="sr-only">Исполнитель</span>
            <select className="select" name="assigned" defaultValue={assigned ?? ''}>
              <option value="">Любой исполнитель</option>
              <option value="ME">Назначено мне</option>
              <option value="UNASSIGNED">Без исполнителя</option>
            </select>
          </label>
        )}
        <label className="field dq__f dq__f--city">
          <span className="sr-only">Город</span>
          <input className="input" name="city" defaultValue={city ?? ''} placeholder="Город" />
        </label>
        <button type="submit" className="btn btn-primary">
          Применить
        </button>
      </form>

      {items.length === 0 ? (
        <div className="dq__empty">
          <Icon name="checkCircle" size={26} />
          <p className="title-sm">Здесь пусто</p>
          <p className="text-sm muted">
            {status === 'ACTIVE' ? 'Нет обращений в работе.' : 'Под этот фильтр ничего не подходит.'}
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
                        <span className="badge badge-warning">идёт проживание</span>
                      )}
                    </span>
                    <span className="dq__summary truncate">{item.summary}</span>
                    <span className="dq__meta">
                      {item.propertyTitle ? `${item.propertyTitle} · ${item.propertyCity}` : 'Без объекта'}
                      {' · '}
                      {item.openedByName}
                      {item.assigneeName ? ` · на ${item.assigneeName}` : ' · без исполнителя'}
                    </span>
                  </span>

                  <span className="dq__age">
                    <span className={item.overdue ? 'dq__ageValue is-late' : 'dq__ageValue'}>
                      {age(Number(item.ageHours))}
                    </span>
                    {item.overdue && <span className="dq__late">просрочено</span>}
                  </span>

                  <Icon name="chevronRight" size={18} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {(offset > 0 || items.length === limit) && (
        <nav className="dq__pager" aria-label="Страницы">
          {offset > 0 ? (
            <Link className="btn btn-secondary btn-sm" href={link({ offset: String(Math.max(0, offset - limit)) })}>
              <Icon name="arrowLeft" size={15} />
              Назад
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs muted numeric">
            {offset + 1}–{offset + items.length}
          </span>
          {items.length === limit ? (
            <Link className="btn btn-secondary btn-sm" href={link({ offset: String(offset + limit) })}>
              Дальше
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
        .dq__tab:hover { background: var(--surface); color: var(--text-primary); }
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
        .dq__row:hover { box-shadow: var(--shadow-raised); }
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
