import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon } from '@/ui/icons.tsx';
import { Money, plural } from '@/ui/primitives.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Модерация',
  robots: { index: false, follow: false },
};

/**
 * The moderation queue.
 *
 * A staff surface, so it is denser than the marketplace — but it is the
 * same design system, on the same light ground, with the same type. A
 * moderator spending their day here should not feel they have been sent
 * to a different, worse product.
 *
 * Someone without `listing.moderate` gets a 404 rather than a 403: the
 * existence of a moderation console is not something an ordinary account
 * needs confirmed.
 */

type Params = Record<string, string | string[] | undefined>;

const TABS = [
  { status: 'PENDING_MODERATION', label: 'Ждут проверки' },
  { status: 'PUBLISHED', label: 'Опубликованы' },
  { status: 'REJECTED', label: 'Отклонены' },
  { status: 'PAUSED', label: 'Скрыты' },
  { status: 'ALL', label: 'Все' },
] as const;

const SORTS = [
  { value: 'WAITING_LONGEST', label: 'Дольше всех ждут' },
  { value: 'WAITING_SHORTEST', label: 'Недавно отправлены' },
  { value: 'CITY', label: 'По городу' },
  { value: 'RECENTLY_DECIDED', label: 'Недавно изменены' },
] as const;

const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  PENDING_MODERATION: { label: 'Ждёт проверки', tone: 'warning' },
  PUBLISHED: { label: 'Опубликовано', tone: 'verified' },
  REJECTED: { label: 'Отклонено', tone: 'danger' },
  PAUSED: { label: 'Скрыто', tone: 'solid-neutral' },
};

const str = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

function waitedFor(iso: string | null): string {
  if (!iso) return '—';
  const hours = Math.floor((Date.now() - Date.parse(iso)) / 3_600_000);
  if (hours < 1) return 'меньше часа';
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

export default async function ModerationQueuePage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/moderation'));
  if (!can(user.roles, 'listing.moderate')) notFound();

  const params = await searchParams;
  const status = str(params.status) ?? 'PENDING_MODERATION';
  const sort = str(params.sort) ?? 'WAITING_LONGEST';
  const city = str(params.city) ?? '';
  const q = str(params.q) ?? '';
  const limit = 25;
  const offset = Math.max(0, Number(str(params.offset) ?? 0) || 0);

  const database = await ready();

  const where: string[] = ['p.deleted_at IS NULL'];
  const values: unknown[] = [];
  const push = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  if (status === 'ALL') {
    where.push(`p.status IN ('PENDING_MODERATION','PUBLISHED','REJECTED','PAUSED')`);
  } else {
    where.push(`p.status = ${push(status)}`);
  }
  if (city) where.push(`lower(p.city) = lower(${push(city)})`);
  if (q) {
    const like = `%${q}%`;
    where.push(`(p.title ILIKE ${push(like)} OR u.display_name ILIKE ${push(like)} OR p.city ILIKE ${push(like)})`);
  }
  const order =
    {
      WAITING_LONGEST: 'COALESCE(p.submitted_at, p.created_at) ASC',
      WAITING_SHORTEST: 'COALESCE(p.submitted_at, p.created_at) DESC',
      CITY: 'p.city ASC, COALESCE(p.submitted_at, p.created_at) ASC',
      RECENTLY_DECIDED: 'p.updated_at DESC',
    }[sort] ?? 'COALESCE(p.submitted_at, p.created_at) ASC';

  const [rows, counts] = await Promise.all([
    database.query<Record<string, any>>(
      `SELECT p.id, p.title, p.city, p.district, p.status, p.submitted_at, p.created_at,
              p.base_price_minor::text AS base_price_minor, p.price_unit,
              u.display_name AS owner_name, u.verification_level AS owner_verification,
              (SELECT count(*)::int FROM property_photo ph WHERE ph.property_id = p.id) AS photo_count,
              (SELECT storage_key FROM property_photo ph
                WHERE ph.property_id = p.id ORDER BY is_cover DESC, sort_order LIMIT 1) AS cover_photo,
              (SELECT count(*)::int FROM listing_moderation_review r WHERE r.property_id = p.id) AS review_count
         FROM property p JOIN app_user u ON u.id = p.owner_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${order}
        LIMIT ${push(limit)} OFFSET ${push(offset)}`,
      values,
    ),
    database.query<{ status: string; total: string }>(
      `SELECT status, count(*)::text AS total FROM property
        WHERE deleted_at IS NULL AND status IN ('PENDING_MODERATION','PUBLISHED','REJECTED','PAUSED')
        GROUP BY status`,
    ),
  ]);

  const countFor = new Map(counts.rows.map((r) => [r.status, Number(r.total)]));
  const total = [...countFor.values()].reduce((a, b) => a + b, 0);
  const items = rows.rows;

  const link = (patch: Record<string, string>) => {
    const next = new URLSearchParams();
    if (status !== 'PENDING_MODERATION') next.set('status', status);
    if (sort !== 'WAITING_LONGEST') next.set('sort', sort);
    if (city) next.set('city', city);
    if (q) next.set('q', q);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    return qs ? `/moderation?${qs}` : '/moderation';
  };

  return (
    // The same shell as the dispute console: moderation and disputes are two
    // views of one operations job, not two products (§17).
    <StaffShell
      roles={user.roles}
      current="/moderation"
      title="Модерация объявлений"
      subtitle={`${countFor.get('PENDING_MODERATION') ?? 0} в очереди · ${total} всего`}
    >
      <nav className="mq__tabs" aria-label="Статус">
        {TABS.map((t) => {
          const active = t.status === status;
          const count = t.status === 'ALL' ? total : (countFor.get(t.status) ?? 0);
          return (
            <Link
              key={t.status}
              href={link({ status: t.status === 'PENDING_MODERATION' ? '' : t.status, offset: '' })}
              className="mq__tab"
              aria-current={active ? 'page' : undefined}
            >
              {t.label}
              <span className="mq__tabCount">{count}</span>
            </Link>
          );
        })}
      </nav>

      {/* GET form: the filter state stays in the URL, so a moderator can
          bookmark or share a queue view. */}
      <form className="mq__filters" method="get" action="/moderation">
        {status !== 'PENDING_MODERATION' && <input type="hidden" name="status" value={status} />}
        <label className="mq__search">
          <span className="sr-only">Поиск по названию, городу или владельцу</span>
          <Icon name="search" size={17} />
          <input className="input" type="search" name="q" defaultValue={q} placeholder="Название, город или владелец" />
        </label>
        <label className="field mq__city">
          <span className="sr-only">Город</span>
          <input className="input" name="city" defaultValue={city} placeholder="Город" />
        </label>
        <label className="field mq__sort">
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
        <div className="mq__empty">
          <Icon name="checkCircle" size={26} />
          <p className="title-sm">Очередь пуста</p>
          <p className="text-sm muted">Здесь появятся объявления, отправленные на проверку.</p>
        </div>
      ) : (
        <ul className="mq__list">
          {items.map((item) => {
            const badge = STATUS_LABEL[item.status] ?? { label: item.status, tone: 'solid-neutral' };
            return (
              <li key={item.id}>
                <Link href={`/moderation/${item.id}`} className="mq__row">
                  <span className="mq__thumb">
                    {item.cover_photo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/media/${item.cover_photo}`} alt="" loading="lazy" />
                    ) : (
                      <Icon name="image" size={18} />
                    )}
                  </span>

                  <span className="mq__main">
                    <span className="mq__titleRow">
                      <strong className="mq__title truncate">{item.title || 'Без названия'}</strong>
                      <span className={`badge badge-${badge.tone}`}>{badge.label}</span>
                      {item.review_count > 1 && (
                        <span className="badge badge-solid-neutral">
                          повторно · {item.review_count}
                        </span>
                      )}
                    </span>
                    <span className="mq__meta">
                      {item.district ? `${item.city} · ${item.district}` : item.city} · {item.owner_name}
                      {item.owner_verification >= 1 && (
                        <span className="mq__verified">
                          <Icon name="checkCircle" size={12} />
                          личность
                        </span>
                      )}
                    </span>
                    <span className="mq__meta">
                      {item.photo_count} {plural(item.photo_count, 'фото', 'фото', 'фото')}
                      {item.base_price_minor && (
                        <>
                          {' · '}
                          <Money minor={item.base_price_minor} showCurrency={false} /> BYN
                          {item.price_unit === 'MONTH' ? '/мес' : '/ночь'}
                        </>
                      )}
                      {item.status === 'PENDING_MODERATION' && ` · ждёт ${waitedFor(item.submitted_at)}`}
                    </span>
                  </span>

                  <Icon name="chevronRight" size={18} />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {(offset > 0 || items.length === limit) && (
        <nav className="mq__pager" aria-label="Страницы">
          {offset > 0 ? (
            <Link className="btn btn-secondary btn-sm" href={link({ offset: String(Math.max(0, offset - limit)) })}>
              <Icon name="arrowLeft" size={15} />
              Назад
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs dim">
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
        .mq__tabs { display: flex; gap: var(--space-1); flex-wrap: wrap; margin-bottom: var(--space-4); }
        .mq__tab {
          display: inline-flex; align-items: center; gap: 0.4rem;
          min-height: 2.5rem; padding: 0.4rem 0.85rem;
          border-radius: var(--radius-sm);
          font-size: var(--text-sm); font-weight: 500;
          color: var(--text-secondary);
        }
        .mq__tab:hover { background: var(--surface); color: var(--text-primary); }
        .mq__tab[aria-current='page'] { background: var(--surface); color: var(--text-primary); font-weight: 600; }
        .mq__tabCount {
          font-size: var(--text-2xs); font-weight: 700;
          padding: 0.05rem 0.35rem; border-radius: var(--radius-full);
          background: var(--surface-sunken); color: var(--text-secondary);
        }
        .mq__tab[aria-current='page'] .mq__tabCount { background: var(--primary-soft); color: var(--primary); }

        .mq__filters { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-4); }
        .mq__search { position: relative; display: flex; align-items: center; flex: 1 1 16rem; min-width: 0; }
        .mq__search svg { position: absolute; left: 0.75rem; color: var(--text-tertiary); pointer-events: none; }
        .mq__search .input { padding-left: 2.4rem; }
        .mq__city { flex: 0 1 9rem; }
        .mq__sort { flex: 0 1 13rem; }

        .mq__list { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
        .mq__row {
          display: flex; align-items: center; gap: var(--space-3);
          padding: var(--space-3);
          background: var(--surface);
          border-radius: var(--radius-md);
          transition: box-shadow 160ms ease;
        }
        .mq__row:hover { box-shadow: var(--shadow-raised); }
        .mq__row > svg:last-child { color: var(--text-tertiary); flex: 0 0 auto; }
        .mq__thumb {
          flex: 0 0 auto; display: grid; place-items: center;
          width: 4.5rem; height: 3.25rem; overflow: hidden;
          border-radius: var(--radius-sm);
          background: var(--surface-sunken); color: var(--text-tertiary);
        }
        .mq__thumb img { width: 100%; height: 100%; object-fit: cover; }
        .mq__main { display: grid; gap: 0.2rem; flex: 1 1 auto; min-width: 0; }
        .mq__titleRow { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; min-width: 0; }
        .mq__title { font-size: var(--text-sm); }
        .mq__meta { font-size: var(--text-xs); color: var(--text-secondary); display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; }
        .mq__verified { display: inline-flex; align-items: center; gap: 0.2rem; color: var(--success); font-weight: 600; }

        .mq__empty {
          display: grid; justify-items: center; gap: 0.3rem;
          padding: var(--space-8) var(--space-4); text-align: center;
        }
        .mq__empty > svg { color: var(--success); margin-bottom: var(--space-2); }

        .mq__pager { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-top: var(--space-4); }

        @media (max-width: 560px) {
          .mq__thumb { display: none; }
          .mq__filters > * { flex: 1 1 100%; }
        }
      `}</style>
    </StaffShell>
  );
}
