import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon } from '@/ui/icons.tsx';
import { plural } from '@/ui/primitives.tsx';
import { LEVEL_LABEL, STATUS_LABEL } from '@/server/domain/verification.ts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Верификация',
  robots: { index: false, follow: false },
};

/**
 * The verification queue.
 *
 * Ordering leads on who is being kept waiting worst, and the signal that
 * matters is a live listing: somebody whose flat is already bookable is being
 * chosen by tenants right now on a Level 0 profile, so making them wait a week
 * is a worse outcome than making somebody wait who has published nothing.
 *
 * The row shows that documents EXIST and how many. It never shows a key —
 * opening one is a separate act on the case page, behind `document.read`, and
 * every open is logged.
 */

type Params = Record<string, string | string[] | undefined>;

const TABS = [
  { key: 'ACTIVE', label: 'В работе' },
  { key: 'SUBMITTED', label: 'Новые' },
  { key: 'IN_REVIEW', label: 'Проверяем' },
  { key: 'NEEDS_INFO', label: 'Ждём уточнений' },
  { key: 'APPROVED', label: 'Подтверждены' },
  { key: 'REJECTED', label: 'Отклонены' },
  { key: 'ALL', label: 'Все' },
] as const;

const SORTS = [
  { value: 'PRIORITY', label: 'Сначала важные' },
  { value: 'WAITING_LONGEST', label: 'Дольше всех ждут' },
  { value: 'OLDEST', label: 'Сначала старые' },
  { value: 'NEWEST', label: 'Сначала новые' },
] as const;

const PRIORITY_TONE: Record<string, { label: string; tone: string }> = {
  HIGH: { label: 'Высокий', tone: 'warning' },
  NORMAL: { label: 'Обычный', tone: 'solid-neutral' },
  LOW: { label: 'Низкий', tone: 'neutral' },
};

const str = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

function waited(hours: number): string {
  if (hours < 1) return 'только что';
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

export default async function VerificationQueuePage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/staff/verification'));
  // 404, not 403: the existence of a verification console is not something an
  // ordinary account needs confirmed.
  if (!can(user.roles, 'verification.review')) notFound();

  const params = await searchParams;
  const status = str(params.status) ?? 'ACTIVE';
  const kind = str(params.kind);
  const level = str(params.level);
  const city = str(params.city);
  const priority = str(params.priority);
  const assigned = str(params.assigned);
  const q = str(params.q);
  const sort = (str(params.sort) ?? 'PRIORITY') as 'PRIORITY' | 'OLDEST' | 'NEWEST' | 'WAITING_LONGEST';
  const limit = 25;
  const offset = Math.max(0, Number(str(params.offset) ?? 0) || 0);

  const services = await readyServices();
  const staff = {
    userId: user.userId,
    role: user.roles.includes('VERIFIER') ? 'VERIFIER' : 'ADMIN',
    canReview: true,
    canDecide: can(user.roles, 'verification.decide'),
    canReadDocuments: can(user.roles, 'document.read'),
  };

  const result = await services.verification.queue(
    {
      status,
      kind,
      ...(level ? { level: Number(level) } : {}),
      city,
      priority,
      assigned,
      q,
      sort,
      limit,
      offset,
    },
    staff,
  );
  const items = result.items as Record<string, any>[];

  const link = (patch: Record<string, string>) => {
    const next = new URLSearchParams();
    if (status !== 'ACTIVE') next.set('status', status);
    if (sort !== 'PRIORITY') next.set('sort', sort);
    for (const [k, v] of Object.entries({ kind, level, city, priority, assigned, q })) {
      if (v) next.set(k, v);
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    return qs ? `/staff/verification?${qs}` : '/staff/verification';
  };

  const overdue = items.filter((i) => i.overdue).length;

  return (
    <StaffShell
      roles={user.roles}
      withheldRoles={user.withheldRoles}
      current="/staff/verification"
      title="Заявки на проверку"
      subtitle="Сверху — те, у кого объявление уже сдаётся, а профиль ещё не подтверждён."
      badges={[
        { label: 'В работе', count: result.counts.ACTIVE ?? 0, tone: 'primary' },
        ...(overdue > 0 ? [{ label: 'Просрочено на странице', count: overdue, tone: 'danger' }] : []),
      ]}
    >
      {!staff.canReadDocuments && (
        <p className="vq__notice">
          <Icon name="shield" size={16} />
          У вас нет права <code>document.read</code>: заявки видны, документы — нет, и подтвердить
          уровень нельзя. Подтверждение требует, чтобы решение принимал тот, кто мог посмотреть
          документы.
        </p>
      )}

      <nav className="vq__tabs" aria-label="Статус">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={link({ status: t.key === 'ACTIVE' ? '' : t.key, offset: '' })}
            className="vq__tab"
            aria-current={t.key === status ? 'page' : undefined}
          >
            {t.label}
            <span className="vq__tabCount">{result.counts[t.key] ?? 0}</span>
          </Link>
        ))}
      </nav>

      <form className="vq__filters" method="get" action="/staff/verification">
        {status !== 'ACTIVE' && <input type="hidden" name="status" value={status} />}
        <label className="vq__search">
          <span className="sr-only">Поиск по имени, объявлению или городу</span>
          <Icon name="search" size={17} />
          <input className="input" type="search" name="q" defaultValue={q ?? ''} placeholder="Имя, объявление или город" />
        </label>
        <label className="field vq__f">
          <span className="sr-only">Уровень</span>
          <select className="select" name="level" defaultValue={level ?? ''}>
            <option value="">Любой уровень</option>
            <option value="1">Уровень 1 — личность</option>
            <option value="2">Уровень 2 — право сдачи</option>
          </select>
        </label>
        <label className="field vq__f">
          <span className="sr-only">Приоритет</span>
          <select className="select" name="priority" defaultValue={priority ?? ''}>
            <option value="">Любой приоритет</option>
            {Object.entries(PRIORITY_TONE).map(([value, p]) => (
              <option key={value} value={value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field vq__f">
          <span className="sr-only">Исполнитель</span>
          <select className="select" name="assigned" defaultValue={assigned ?? ''}>
            <option value="">Любой исполнитель</option>
            <option value="ME">Назначено мне</option>
            <option value="UNASSIGNED">Без исполнителя</option>
          </select>
        </label>
        <label className="field vq__f vq__f--city">
          <span className="sr-only">Город</span>
          <input className="input" name="city" defaultValue={city ?? ''} placeholder="Город" />
        </label>
        <label className="field vq__f">
          <span className="sr-only">Сортировка</span>
          <select className="select" name="sort" defaultValue={sort}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-primary">
          Применить
        </button>
      </form>

      {items.length === 0 ? (
        <div className="vq__empty">
          <Icon name="checkCircle" size={26} />
          <p className="title-sm">Здесь пусто</p>
          <p className="text-sm muted">
            {status === 'ACTIVE' ? 'Заявок в работе нет.' : 'Под этот фильтр ничего не подходит.'}
          </p>
        </div>
      ) : (
        <ul className="vq__list">
          {items.map((item) => {
            const p = PRIORITY_TONE[item.priority] ?? PRIORITY_TONE.NORMAL!;
            return (
              <li key={item.id}>
                <Link
                  href={`/staff/verification/${item.id}`}
                  className={item.overdue ? 'vq__row is-overdue' : 'vq__row'}
                >
                  <span className="vq__lead">
                    <span className={`badge badge-${p.tone}`}>{p.label}</span>
                    <span className="vq__level numeric">Ур. {item.targetLevel}</span>
                  </span>

                  <span className="vq__main">
                    <span className="vq__titleRow">
                      <strong className="vq__name truncate">{item.applicant.displayName}</strong>
                      <span className="badge badge-solid-neutral">
                        {STATUS_LABEL[item.status as keyof typeof STATUS_LABEL] ?? item.status}
                      </span>
                      {item.hasPublishedListing && (
                        <span className="badge badge-warning">объявление сдаётся</span>
                      )}
                    </span>
                    <span className="vq__meta">
                      {item.kind === 'IDENTITY'
                        ? 'Личность'
                        : `Право сдачи · ${item.property?.title ?? 'объект'}`}
                      {item.property?.city ? ` · ${item.property.city}` : ''}
                      {' · сейчас '}
                      {LEVEL_LABEL[item.applicant.level as 0 | 1 | 2] ?? item.applicant.level}
                    </span>
                    <span className="vq__meta">
                      {item.documentCount}{' '}
                      {plural(Number(item.documentCount), 'документ', 'документа', 'документов')}
                      {item.assigneeName ? ` · на ${item.assigneeName}` : ' · без исполнителя'}
                    </span>
                  </span>

                  <span className="vq__age">
                    <span className={item.overdue ? 'vq__ageValue is-late' : 'vq__ageValue'}>
                      {waited(Number(item.ageHours))}
                    </span>
                    {item.overdue && <span className="vq__late">просрочено</span>}
                  </span>

                  <Icon name="chevronRight" size={18} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {(offset > 0 || items.length === limit) && (
        <nav className="vq__pager" aria-label="Страницы">
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
        .vq__notice {
          display: flex; align-items: flex-start; gap: 0.45rem;
          padding: var(--space-3) var(--space-4); margin-bottom: var(--space-4);
          background: var(--surface-sunken); border-radius: var(--radius-sm);
          font-size: var(--text-xs); line-height: 1.5; color: var(--text-secondary);
        }
        .vq__notice > svg { color: var(--text-tertiary); flex: 0 0 auto; margin-top: 0.1rem; }
        .vq__notice code { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }

        .vq__tabs { display: flex; gap: var(--space-1); flex-wrap: wrap; margin-bottom: var(--space-3); }
        .vq__tab {
          display: inline-flex; align-items: center; gap: 0.35rem;
          min-height: 2.375rem; padding: 0.35rem 0.7rem;
          border-radius: var(--radius-sm);
          font-size: var(--text-xs); font-weight: 500; color: var(--text-secondary);
        }
        .vq__tab:hover { background: var(--surface); color: var(--text-primary); }
        .vq__tab[aria-current='page'] { background: var(--surface); color: var(--text-primary); font-weight: 600; }
        .vq__tabCount {
          font-size: var(--text-2xs); font-weight: 700;
          padding: 0.05rem 0.3rem; border-radius: var(--radius-full);
          background: var(--surface-sunken); color: var(--text-secondary);
        }
        .vq__tab[aria-current='page'] .vq__tabCount { background: var(--primary-soft); color: var(--primary); }

        .vq__filters { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-4); }
        .vq__search { position: relative; display: flex; align-items: center; flex: 1 1 14rem; min-width: 0; }
        .vq__search svg { position: absolute; left: 0.75rem; color: var(--text-tertiary); pointer-events: none; }
        .vq__search .input { padding-left: 2.4rem; }
        .vq__f { flex: 0 1 10.5rem; }
        .vq__f--city { flex: 0 1 8rem; }

        .vq__list { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
        .vq__row {
          display: flex; align-items: center; gap: var(--space-3);
          padding: var(--space-3);
          background: var(--surface); border-radius: var(--radius-md);
          transition: box-shadow 160ms ease;
        }
        .vq__row:hover { box-shadow: var(--shadow-raised); }
        /* A rule, not only a hue: an overdue row reads without colour. */
        .vq__row.is-overdue { box-shadow: inset 3px 0 0 var(--error); }
        .vq__row > svg:last-child { color: var(--text-tertiary); flex: 0 0 auto; }

        .vq__lead { display: grid; gap: 0.2rem; justify-items: start; flex: 0 0 6.5rem; }
        .vq__level { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .vq__main { display: grid; gap: 0.2rem; flex: 1 1 auto; min-width: 0; }
        .vq__titleRow { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; min-width: 0; }
        .vq__name { font-size: var(--text-sm); }
        .vq__meta { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .vq__age { display: grid; gap: 0.1rem; justify-items: end; flex: 0 0 auto; text-align: right; }
        .vq__ageValue { font-size: var(--text-xs); color: var(--text-secondary); }
        .vq__ageValue.is-late { color: var(--error); font-weight: 600; }
        .vq__late { font-size: var(--text-2xs); color: var(--error); }

        .vq__empty { display: grid; justify-items: center; gap: 0.3rem; padding: var(--space-8) var(--space-4); text-align: center; }
        .vq__empty > svg { color: var(--success); margin-bottom: var(--space-2); }
        .vq__pager { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-top: var(--space-4); }

        @media (max-width: 760px) {
          .vq__row { flex-wrap: wrap; }
          .vq__lead { flex: 1 1 100%; display: flex; align-items: center; gap: var(--space-2); }
          .vq__filters > * { flex: 1 1 100%; }
        }
      `}</style>
    </StaffShell>
  );
}
