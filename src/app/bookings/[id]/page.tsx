import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready, readyServices } from '@/server/runtime.ts';
import { BookingActions } from '@/ui/booking-actions.tsx';
import { BookingStages } from '@/ui/booking-stages.tsx';
import { CompletionPanel } from '@/ui/completion-panel.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';
import { Money, formatNights, plural } from '@/ui/primitives.tsx';
import { BOOKING_STATUS_LABEL, bookingTone } from '@/ui/primitives.tsx';
import { availableEvents, type BookingState } from '@/server/domain/booking/states.ts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Бронирование',
  robots: { index: false, follow: false },
};

/** What each state means for the person reading it, in their own role. */
const EXPLAIN: Record<string, { tenant: string; landlord: string }> = {
  REQUESTED: {
    tenant:
      'Заявка отправлена. Даты пока не закреплены — их может занять другой запрос, подтверждённый раньше.',
    landlord: 'Арендатор ждёт вашего решения. Пока вы не ответили, даты свободны для других запросов.',
  },
  CONFIRMED: {
    tenant: 'Даты закреплены за вами. Точный адрес и контакты хозяина доступны в переписке.',
    landlord: 'Даты закреплены. Календарь занят на этот период.',
  },
  DECLINED: { tenant: 'Хозяин отклонил заявку.', landlord: 'Вы отклонили эту заявку.' },
  WITHDRAWN: { tenant: 'Вы отозвали заявку.', landlord: 'Арендатор отозвал заявку.' },
  EXPIRED: {
    tenant: 'Никто не ответил в срок, заявка истекла.',
    landlord: 'Заявка истекла без ответа.',
  },
  CHECKED_IN: {
    tenant: 'Заселение подтверждено. Хорошего проживания.',
    landlord: 'Арендатор подтвердил заселение.',
  },
  NOT_TAKEN_PLACE: {
    tenant: 'Аренда не состоялась. Сервисный сбор не начислялся.',
    landlord: 'Аренда не состоялась. Сервисный сбор не начислялся.',
  },
  CANCELLED_BY_TENANT: {
    tenant: 'Вы отменили бронирование.',
    landlord: 'Арендатор отменил бронирование.',
  },
  CANCELLED_BY_LANDLORD: {
    tenant: 'Хозяин отменил бронирование.',
    landlord: 'Вы отменили это бронирование.',
  },
  DISPUTED: {
    tenant: 'Обращение передано в поддержку. Пока идёт разбор, сервисный сбор не начисляется.',
    landlord: 'Обращение передано в поддержку. Пока идёт разбор, сервисный сбор не начисляется.',
  },
};

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

function formatDay(value: string | null): string | null {
  if (!value) return null;
  const iso = new Date(value).toISOString();
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

const DISPUTE_CATEGORY_LABEL: Record<string, string> = {
  LISTING_MISMATCH: 'Несоответствие объявлению',
  ACCESS_PROBLEM: 'Проблема с доступом',
  CLEANLINESS: 'Чистота',
  PROPERTY_DAMAGE: 'Повреждения имущества',
  PAYMENT_DISAGREEMENT: 'Разногласия по оплате',
  COMMUNICATION: 'Общение',
  SUSPECTED_FRAUD: 'Подозрение на мошенничество',
  CANCELLATION: 'Отмена',
  NO_SHOW: 'Сторона не пришла',
  OTHER: 'Другое',
};

export default async function BookingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const user = await currentUser();
  if (!user) redirect(signInUrl(`/bookings/${id}`));

  const services = await readyServices();
  const database = await ready();

  let booking: Awaited<ReturnType<typeof services.bookings.get>>;
  try {
    booking = await services.bookings.get(id);
  } catch {
    notFound();
  }

  // Whether a booking exists is itself information: a stranger gets the
  // same answer as for an id that never existed.
  const isTenant = booking.tenant_id === user.userId;
  const isLandlord = booking.landlord_id === user.userId;
  if (!isTenant && !isLandlord) notFound();

  const role: 'TENANT' | 'LANDLORD' = isTenant ? 'TENANT' : 'LANDLORD';
  const counterpartyId = isTenant ? booking.landlord_id : booking.tenant_id;
  const status = String(booking.status) as BookingState;

  const [property, person, conversation, fee, disputeCase, reviews, eligibility] = await Promise.all([
    database.query<Record<string, any>>(
      `SELECT p.id, p.title, p.city, p.district, p.price_unit,
              (SELECT storage_key FROM property_photo ph
                WHERE ph.property_id = p.id ORDER BY is_cover DESC, sort_order LIMIT 1) AS cover_photo
         FROM property p WHERE p.id = $1`,
      [booking.property_id],
    ),
    // Public trust facts only — no email, no phone, nothing from the
    // verification documents.
    database.query<Record<string, any>>(
      `SELECT u.id, u.display_name, u.account_kind, u.company_name, u.verification_level,
              u.created_at, u.completed_rentals_as_tenant, u.completed_rentals_as_landlord,
              (SELECT round(avg(r.overall)::numeric,2) FROM review r
                WHERE r.subject_id = u.id AND r.status = 'PUBLISHED') AS rating
         FROM app_user u WHERE u.id = $1`,
      [counterpartyId],
    ),
    database.query<{ id: string }>(
      `SELECT id FROM conversation WHERE property_id = $1 AND tenant_id = $2`,
      [booking.property_id, booking.tenant_id],
    ),
    // The fee as the domain computed it. Never recomputed here: one arithmetic,
    // in one place, on the server.
    database.query<Record<string, any>>(
      `SELECT base_minor::text AS base_minor, bps, fee_minor::text AS fee_minor,
              status, due_at, accrued_at
         FROM service_fee WHERE booking_id = $1`,
      [id],
    ),
    database.query<Record<string, any>>(
      `SELECT reference, category, status, created_at FROM dispute_case
        WHERE booking_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id],
    ),
    database.query<{ author_role: string; status: string }>(
      `SELECT author_role, status FROM review WHERE booking_id = $1`,
      [id],
    ),
    services.reviews.eligibility(id, user.userId).catch(() => null),
  ]);

  const listing = property.rows[0];
  const other = person.rows[0];
  const chatId = conversation.rows[0]?.id ?? null;
  const serviceFee = fee.rows[0] ?? null;
  const openCase = disputeCase.rows[0] ?? null;
  const nights = Number(booking.nights);

  const myReview = reviews.rows.find((r) => r.author_role === role);
  const bothReviewsIn = reviews.rows.length === 2;
  const reviewsPublished = reviews.rows.some((r) => r.status === 'PUBLISHED');
  const canReview = eligibility?.canReview === true;

  // Actions the panel owns are removed here so the same decision is not
  // offered twice in two different shapes.
  const actions = availableEvents(status, role).filter(
    (e) => e !== 'CONFIRM_COMPLETION' && e !== 'OPEN_DISPUTE' && e !== 'COUNTER_OFFER',
  );
  const explain = EXPLAIN[status]?.[isTenant ? 'tenant' : 'landlord'] ?? null;

  const facts: { icon: IconName; label: string; value: string }[] = [
    { icon: 'calendar', label: 'Заезд', value: formatDate(String(booking.stay_from)) },
    { icon: 'calendar', label: 'Выезд', value: formatDate(String(booking.stay_to)) },
    { icon: 'clock', label: 'Длительность', value: formatNights(nights) },
    { icon: 'users', label: 'Гостей', value: String(booking.guests) },
  ];

  const justReviewed = query.review === 'published' || query.review === 'saved';

  return (
    <div className="container bk">
      <nav className="bk__back">
        <Link href={isTenant ? '/trips' : '/dashboard/bookings'} className="bk__backLink">
          <Icon name="arrowLeft" size={16} />
          {isTenant ? 'Мои поездки' : 'Заявки и бронирования'}
        </Link>
      </nav>

      <header className="bk__head">
        <div className="bk__headMain">
          <span className={`badge badge-${bookingTone(status)}`}>
            {BOOKING_STATUS_LABEL[status] ?? status}
          </span>
          <h1 className="bk__title">{listing?.title ?? 'Объявление'}</h1>
          <p className="bk__meta">
            <Icon name="pin" size={15} />
            {listing?.district ? `${listing.city} · ${listing.district}` : (listing?.city ?? '')}
            {' · '}
            <span className="numeric">№ {booking.reference}</span>
          </p>
        </div>
        {listing?.cover_photo && (
          <span className="bk__thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/media/${listing.cover_photo}`} alt="" />
          </span>
        )}
      </header>

      <BookingStages status={status} />

      {justReviewed && (
        <p className="bk__flash">
          <Icon name="checkCircle" size={17} />
          {query.review === 'published'
            ? 'Спасибо. Обе стороны написали отзывы — они опубликованы.'
            : 'Спасибо. Отзыв сохранён и будет опубликован вместе с отзывом другой стороны.'}
        </p>
      )}

      {explain && (
        <p className="bk__explain">
          <Icon name="info" size={17} />
          {explain}
        </p>
      )}

      <div className="bk__layout">
        <div className="bk__main">
          {/* NEXT ACTION FIRST.
              On a phone the thing a person came here to do must not be below
              a price breakdown they already agreed to. */}
          {status === 'COMPLETION_PENDING' && (
            <section className="bk__section bk__section--act">
              <CompletionPanel
                bookingId={id}
                role={role}
                myAnswer={
                  (isTenant ? booking.tenant_completion_answer : booking.landlord_completion_answer) ?? null
                }
                theirAnswer={
                  (isTenant ? booking.landlord_completion_answer : booking.tenant_completion_answer) ?? null
                }
                deadlineLabel={formatDay(booking.completion_deadline_at)}
                stayLabel={`${formatDate(String(booking.stay_from))} — ${formatDate(String(booking.stay_to))}`}
                propertyTitle={listing?.title ?? 'Объявление'}
                counterpartyName={String(other?.display_name ?? 'другая сторона')}
              />
            </section>
          )}

          {status === 'COMPLETED' && (
            <section className="bk__section bk__section--act">
              {canReview ? (
                <div className="bk__invite">
                  <h2 className="bk__inviteTitle">
                    {isTenant ? 'Как прошла аренда?' : 'Каким был арендатор?'}
                  </h2>
                  <p className="bk__inviteText">
                    Ваша оценка помогает другим людям выбирать жильё и владельцев. Это займёт меньше
                    минуты.
                  </p>
                  <div className="bk__inviteRow">
                    <Link href={`/bookings/${id}/review`} className="btn btn-primary">
                      Оставить отзыв
                    </Link>
                    <Link href={isTenant ? '/trips' : '/dashboard/bookings'} className="btn btn-ghost">
                      Позже
                    </Link>
                  </div>
                  {booking.review_deadline_at && (
                    <p className="hint">
                      Отзыв можно оставить до {formatDay(booking.review_deadline_at)}.
                    </p>
                  )}
                </div>
              ) : (
                <div className="bk__invite">
                  <h2 className="bk__inviteTitle">Аренда завершена</h2>
                  <p className="bk__inviteText">
                    {myReview
                      ? bothReviewsIn && reviewsPublished
                        ? 'Отзывы обеих сторон опубликованы.'
                        : 'Ваш отзыв сохранён. Он будет опубликован вместе с отзывом другой стороны или после окончания срока.'
                      : eligibility?.reason === 'WINDOW_CLOSED'
                        ? 'Срок для отзыва истёк.'
                        : 'Отзыв недоступен.'}
                  </p>
                </div>
              )}
            </section>
          )}

          {actions.length > 0 && (
            <section className="bk__section">
              <h2 className="bk__h2">Что можно сделать</h2>
              <BookingActions bookingId={id} actions={actions} />
            </section>
          )}

          <section className="bk__section">
            <h2 className="bk__h2">Условия</h2>
            <div className="bk__facts">
              {facts.map((f) => (
                <div key={f.label} className="bk__fact">
                  <Icon name={f.icon} size={18} />
                  <span className="bk__factValue">{f.value}</span>
                  <span className="bk__factLabel">{f.label}</span>
                </div>
              ))}
            </div>

            {/* The terms frozen on the booking, not a live recalculation:
                what was agreed is what is shown. */}
            <dl className="bk__rows">
              <div className="bk__row">
                <dt>Аренда за {formatNights(nights)}</dt>
                <dd>
                  <Money minor={String(booking.rent_minor)} />
                </dd>
              </div>
              <div className="bk__row bk__row--total">
                <dt>Итого хозяину</dt>
                <dd>
                  <strong>
                    <Money minor={String(booking.total_expected_minor)} />
                  </strong>
                </dd>
              </div>
            </dl>
            <p className="hint">
              Оплата аренды происходит напрямую между вами и хозяином. Платформа не принимает
              арендную плату и не является стороной договора.
            </p>
          </section>

          {/* The fee is the landlord's business only: a tenant has no debt here
              and showing them somebody else's balance would be a leak. */}
          {isLandlord && serviceFee && (
            <section className="bk__section">
              <h2 className="bk__h2">Сервисный сбор</h2>
              <dl className="bk__rows">
                <div className="bk__row">
                  <dt>База для расчёта</dt>
                  <dd>
                    <Money minor={String(serviceFee.base_minor)} />
                  </dd>
                </div>
                <div className="bk__row">
                  <dt>Ставка</dt>
                  <dd className="numeric">{Number(serviceFee.bps) / 100}%</dd>
                </div>
                <div className="bk__row bk__row--total">
                  <dt>{serviceFee.status === 'PAYABLE' ? 'Задолженность' : 'Начислено'}</dt>
                  <dd>
                    <strong>
                      <Money minor={String(serviceFee.fee_minor)} />
                    </strong>
                  </dd>
                </div>
              </dl>
              <p className="hint">
                {serviceFee.status === 'PAYABLE'
                  ? `Учтено в балансе кабинета${formatDay(serviceFee.due_at) ? `, срок — до ${formatDay(serviceFee.due_at)}` : ''}. Платформа не списывает деньги автоматически.`
                  : serviceFee.status === 'WAIVED'
                    ? 'Сбор списан платформой.'
                    : 'Сбор закрыт.'}
              </p>
              <Link href="/dashboard/finance" className="link bk__ledgerLink">
                Баланс и все начисления
                <Icon name="arrowRight" size={14} />
              </Link>
            </section>
          )}

          {openCase && (
            <section className="bk__section">
              <h2 className="bk__h2">Обращение в поддержку</h2>
              <p className="bk__caseLine">
                <span className="badge badge-warning">
                  {openCase.status === 'RESOLVED' || openCase.status === 'CLOSED' ? 'Закрыто' : 'В работе'}
                </span>
                <span className="numeric">№ {openCase.reference}</span>
              </p>
              <p className="text-sm muted bk__caseText">
                Тема: {DISPUTE_CATEGORY_LABEL[openCase.category] ?? openCase.category}. Поддержка
                свяжется с обеими сторонами в переписке по этому бронированию. Автоматических решений
                по обращениям нет — решение принимает человек.
              </p>
            </section>
          )}
        </div>

        <aside className="bk__aside">
          <section className="panel">
            <h2 className="bk__asideH2">{isTenant ? 'Хозяин' : 'Арендатор'}</h2>
            {other ? (
              <>
                <div className="bk__person">
                  <span className="bk__avatar" aria-hidden="true">
                    {String(other.display_name).trim().charAt(0).toUpperCase()}
                  </span>
                  <div>
                    <strong className="bk__personName">
                      {other.account_kind === 'COMPANY' && other.company_name
                        ? other.company_name
                        : other.display_name}
                    </strong>
                    <p className="text-xs muted">
                      {other.account_kind === 'COMPANY' ? 'Компания' : 'Частное лицо'}
                    </p>
                  </div>
                </div>
                <ul className="bk__trust">
                  <li>
                    {other.verification_level >= 1 ? (
                      <span className="bk__ok">
                        <Icon name="checkCircle" size={14} />
                        Личность подтверждена
                      </span>
                    ) : (
                      <span className="muted">Личность не подтверждена</span>
                    )}
                  </li>
                  {other.rating !== null && (
                    <li className="numeric">
                      <Icon name="star" size={14} solid />
                      {Number(other.rating).toFixed(1)}
                    </li>
                  )}
                  <li className="muted">
                    {isTenant
                      ? `${other.completed_rentals_as_landlord} ${plural(Number(other.completed_rentals_as_landlord), 'завершённая сделка', 'завершённые сделки', 'завершённых сделок')}`
                      : `${other.completed_rentals_as_tenant} ${plural(Number(other.completed_rentals_as_tenant), 'завершённая аренда', 'завершённые аренды', 'завершённых аренд')}`}
                  </li>
                </ul>
                <Link href={`/profiles/${other.id}`} className="btn btn-secondary btn-sm btn-block">
                  Открыть профиль
                </Link>
              </>
            ) : (
              <p className="text-sm muted">Профиль недоступен.</p>
            )}
          </section>

          <section className="panel">
            <h2 className="bk__asideH2">Переписка</h2>
            <p className="text-sm muted bk__chatNote">
              Обсуждайте детали здесь — история переписки остаётся у обеих сторон, если возникнет
              спор.
            </p>
            {chatId ? (
              <Link href={`/dashboard/chat/${chatId}`} className="btn btn-primary btn-block">
                <Icon name="message" size={16} />
                Открыть чат
              </Link>
            ) : (
              <Link
                href={`/dashboard/chat?property=${booking.property_id}`}
                className="btn btn-secondary btn-block"
              >
                <Icon name="message" size={16} />
                Написать
              </Link>
            )}
          </section>
        </aside>
      </div>

      {/* Last, deliberately: the log is for checking what happened, not for
          deciding what to do next. */}
      <section className="bk__history">
        <h2 className="bk__h2">История</h2>
        <Timeline bookingId={id} />
      </section>

      <style>{`
        .bk { padding-block: var(--space-4) var(--space-8); max-width: 62rem; }
        .bk__back { margin-bottom: var(--space-3); }
        .bk__backLink { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .bk__backLink:hover { color: var(--text-primary); }

        .bk__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
        .bk__headMain { display: grid; gap: var(--space-2); justify-items: start; min-width: 0; }
        .bk__title { font-size: var(--text-2xl); font-weight: 650; letter-spacing: -0.022em; }
        .bk__meta { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; font-size: var(--text-sm); color: var(--text-secondary); }
        .bk__thumb { flex: 0 0 auto; width: 7rem; border-radius: var(--radius-md); overflow: hidden; background: var(--surface-sunken); }
        .bk__thumb img { width: 100%; aspect-ratio: 3 / 2; object-fit: cover; display: block; }

        .bk__explain, .bk__flash {
          display: flex; align-items: flex-start; gap: 0.5rem;
          padding: var(--space-3) var(--space-4);
          border-radius: var(--radius-md);
          font-size: var(--text-sm); margin-bottom: var(--space-5);
        }
        .bk__explain { background: var(--primary-soft); }
        .bk__explain > svg { color: var(--primary); flex: 0 0 auto; margin-top: 0.1rem; }
        .bk__flash { background: var(--success-soft); color: var(--success); font-weight: 500; }
        .bk__flash > svg { flex: 0 0 auto; margin-top: 0.1rem; }

        .bk__layout { display: grid; gap: var(--space-6); }
        @media (min-width: 900px) {
          .bk__layout { grid-template-columns: minmax(0, 1fr) 19rem; align-items: start; }
          .bk__aside { position: sticky; top: calc(var(--header-height) + 0.75rem); }
        }
        .bk__main { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; align-content: start; }
        .bk__aside { display: grid; gap: var(--space-3); min-width: 0; align-content: start; }

        .bk__section { padding-block: var(--space-5); }
        .bk__section:first-child { padding-top: 0; }
        .bk__section + .bk__section { border-top: 1px solid var(--border); }
        /* The action block earns space rather than a box: it is the first thing
           on the page and nothing competes with it. */
        .bk__section--act { padding-bottom: var(--space-6); }
        .bk__h2 { font-size: var(--text-lg); font-weight: 600; margin-bottom: var(--space-4); }
        .bk__asideH2 { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }

        .bk__invite { display: grid; gap: var(--space-2); justify-items: start; }
        .bk__inviteTitle { font-size: var(--text-lg); font-weight: 650; letter-spacing: -0.015em; }
        .bk__inviteText { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.55; max-width: 52ch; }
        .bk__inviteRow { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-1); }

        .bk__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr)); gap: var(--space-4); margin-bottom: var(--space-5); }
        .bk__fact { display: grid; gap: 0.1rem; }
        .bk__fact > svg { color: var(--text-tertiary); margin-bottom: 0.15rem; }
        .bk__factValue { font-size: var(--text-base); font-weight: 600; }
        .bk__factLabel { font-size: var(--text-xs); color: var(--text-tertiary); }

        .bk__rows { display: grid; margin: 0 0 var(--space-3); }
        .bk__row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-4); padding-block: 0.4rem; font-size: var(--text-sm); }
        .bk__row dt { color: var(--text-secondary); }
        .bk__row dd { margin: 0; }
        .bk__row--total { border-top: 1px solid var(--border); padding-top: var(--space-3); margin-top: var(--space-2); font-size: var(--text-base); }
        .bk__ledgerLink { display: inline-flex; align-items: center; gap: 0.3rem; font-size: var(--text-sm); }

        .bk__caseLine { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2); font-size: var(--text-sm); }
        .bk__caseText { max-width: 60ch; line-height: 1.55; }

        .bk__person { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
        .bk__avatar {
          display: grid; place-items: center; width: 2.5rem; height: 2.5rem; flex: 0 0 auto;
          border-radius: var(--radius-full); background: var(--primary-soft); color: var(--primary); font-weight: 600;
        }
        .bk__personName { font-size: var(--text-sm); }
        .bk__trust { display: grid; gap: 0.35rem; margin: 0 0 var(--space-3); padding: 0; list-style: none; font-size: var(--text-sm); }
        .bk__trust li { display: flex; align-items: center; gap: 0.3rem; }
        .bk__ok { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--success); font-weight: 600; }
        .bk__chatNote { margin-bottom: var(--space-3); }

        .bk__history { margin-top: var(--space-6); padding-top: var(--space-5); border-top: 1px solid var(--border); }
      `}</style>
    </div>
  );
}

/** The booking's own event log, which is append-only in the database. */
async function Timeline({ bookingId }: { bookingId: string }) {
  const database = await ready();
  const { rows } = await database.query<Record<string, any>>(
    `SELECT event_type, actor, from_status, to_status, occurred_at
       FROM booking_event WHERE booking_id = $1 ORDER BY id`,
    [bookingId],
  );

  if (rows.length === 0) return <p className="text-sm muted">Событий пока нет.</p>;

  return (
    <ol className="tl">
      {rows.map((e, index) => (
        <li key={index} className="tl__item">
          <span className="tl__dot" aria-hidden="true" />
          <span className="tl__body">
            <strong className="tl__status">
              {BOOKING_STATUS_LABEL[e.to_status] ?? e.to_status}
            </strong>
            <span className="tl__when">
              {new Date(e.occurred_at).toISOString().slice(0, 16).replace('T', ', ')}
              {e.actor ? ` · ${e.actor === 'TENANT' ? 'арендатор' : e.actor === 'LANDLORD' ? 'хозяин' : 'система'}` : ''}
            </span>
          </span>
        </li>
      ))}
      <style>{`
        .tl { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
        .tl__item { display: flex; align-items: flex-start; gap: var(--space-3); }
        .tl__dot { width: 8px; height: 8px; margin-top: 0.45rem; border-radius: var(--radius-full); background: var(--primary); flex: 0 0 auto; }
        .tl__body { display: grid; gap: 0.1rem; }
        .tl__status { font-size: var(--text-sm); }
        .tl__when { font-size: var(--text-xs); color: var(--text-tertiary); }
      `}</style>
    </ol>
  );
}
