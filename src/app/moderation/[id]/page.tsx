import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { MapPanel } from '@/ui/map-panel.tsx';
import { Amenities } from '@/ui/amenities.tsx';
import { ModerationDecision } from '@/ui/moderation-decision.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';
import { Money, formatNightsGenitive, plural } from '@/ui/primitives.tsx';
import { MODERATION_REASON_TEXT, type ModerationReasonCode } from '@/server/domain/moderation.ts';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Проверка объявления',
  robots: { index: false, follow: false },
};

const SMOKING: Record<string, string> = {
  PROHIBITED: 'Курение запрещено',
  ALLOWED: 'Курение разрешено',
  BALCONY_ONLY: 'Курение только на балконе',
};
const PETS: Record<string, string> = {
  PROHIBITED: 'С животными нельзя',
  ALLOWED: 'Можно с животными',
  SMALL_ONLY: 'Только небольшие животные',
  ON_REQUEST: 'С животными по согласованию',
};
const TYPE: Record<string, string> = {
  APARTMENT: 'Квартира',
  ROOM: 'Комната',
  HOUSE: 'Дом',
  COTTAGE: 'Коттедж',
  STUDIO: 'Студия',
  TOWNHOUSE: 'Таунхаус',
};
const DECISION_LABEL: Record<string, string> = {
  PUBLISHED: 'Одобрено',
  REJECTED: 'Отклонено',
  PAUSED: 'Скрыто',
};
const STATUS_BADGE: Record<string, { label: string; tone: string }> = {
  PENDING_MODERATION: { label: 'Ждёт проверки', tone: 'warning' },
  PUBLISHED: { label: 'Опубликовано', tone: 'verified' },
  REJECTED: { label: 'Отклонено', tone: 'danger' },
  PAUSED: { label: 'Скрыто', tone: 'solid-neutral' },
  DRAFT: { label: 'Черновик', tone: 'solid-neutral' },
};

function when(iso: string): string {
  const [date, time] = iso.split('T');
  const [y, m, d] = (date ?? '').split('-');
  return `${Number(d)}.${m}.${y}, ${(time ?? '').slice(0, 5)}`;
}

export default async function ModerationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(signInUrl(`/moderation/${id}`));
  if (!can(user.roles, 'listing.moderate')) notFound();

  const services = await readyServices();
  let listing: Record<string, any>;
  let history: Awaited<ReturnType<typeof services.listings.moderationHistory>>;
  try {
    listing = (await services.listings.getForModeration(id)) as Record<string, any>;
    history = await services.listings.moderationHistory(id);
  } catch {
    notFound();
  }

  const pricing = listing.pricing as Record<string, string>;
  const rules = listing.rules as Record<string, any>;
  const owner = listing.owner as Record<string, any>;
  const duration = listing.duration as { minNights: number; maxNights: number };
  const photos = listing.photos as { id: string; storageKey: string; isCover: boolean; width: number | null; height: number | null }[];
  const badge = STATUS_BADGE[listing.status] ?? { label: listing.status, tone: 'solid-neutral' };

  const facts: { icon: IconName; label: string; value: string }[] = [
    { icon: 'home', label: 'Тип', value: TYPE[listing.propertyType] ?? listing.propertyType },
    listing.rooms !== null && { icon: 'rooms' as IconName, label: 'Комнат', value: String(listing.rooms) },
    listing.areaSqm && { icon: 'area' as IconName, label: 'Площадь', value: `${Math.round(Number(listing.areaSqm))} м²` },
    listing.floor !== null && {
      icon: 'floors' as IconName,
      label: 'Этаж',
      value: listing.totalFloors ? `${listing.floor} из ${listing.totalFloors}` : String(listing.floor),
    },
    listing.beds !== null && { icon: 'bed' as IconName, label: 'Спальных мест', value: String(listing.beds) },
    listing.bathrooms !== null && { icon: 'bath' as IconName, label: 'Санузлов', value: String(listing.bathrooms) },
    { icon: 'users', label: 'Гостей', value: String(listing.maxGuests) },
  ].filter(Boolean) as { icon: IconName; label: string; value: string }[];

  return (
    <div className="container mdp">
      <nav className="mdp__back">
        <Link href="/moderation" className="mdp__backLink">
          <Icon name="arrowLeft" size={16} />
          Очередь модерации
        </Link>
      </nav>

      <header className="mdp__head">
        <div className="mdp__headMain">
          <div className="mdp__titleRow">
            <h1 className="mdp__title">{listing.title || 'Без названия'}</h1>
            <span className={`badge badge-${badge.tone}`}>{badge.label}</span>
          </div>
          <p className="mdp__meta">
            <Icon name="pin" size={15} />
            {listing.district ? `${listing.city} · ${listing.district}` : listing.city}
            {listing.submittedAt && ` · отправлено ${when(listing.submittedAt)}`}
          </p>
        </div>
        {listing.status === 'PUBLISHED' && (
          <Link href={`/listing/${listing.id}`} className="btn btn-secondary btn-sm">
            <Icon name="eye" size={15} />
            Как видят гости
          </Link>
        )}
      </header>

      {/* The decision sits above the content: a moderator who has already
          made up their mind should not have to scroll back. */}
      <section className="mdp__decide panel">
        <ModerationDecision propertyId={String(listing.id)} status={String(listing.status)} />
      </section>

      <div className="mdp__layout">
        <div className="mdp__main">
          <section className="mdp__section">
            <h2 className="mdp__h2">
              Фотографии · {photos.length}
            </h2>
            {photos.length === 0 ? (
              <p className="mdp__muted">Фотографий нет — объявление нельзя публиковать.</p>
            ) : (
              <ul className="mdp__photos">
                {photos.map((p) => (
                  <li key={p.id} className="mdp__photo">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/media/${p.storageKey}`} alt="" loading="lazy" />
                    {p.isCover && <span className="mdp__cover">Главное</span>}
                    {p.width && p.height && (
                      <span className="mdp__dims numeric">
                        {p.width}×{p.height}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mdp__section">
            <h2 className="mdp__h2">Об объекте</h2>
            <div className="mdp__facts">
              {facts.map((f) => (
                <div key={f.label} className="mdp__fact">
                  <Icon name={f.icon} size={18} />
                  <span className="mdp__factValue">{f.value}</span>
                  <span className="mdp__factLabel">{f.label}</span>
                </div>
              ))}
            </div>
            <p className="mdp__duration">
              <Icon name="calendar" size={17} />
              Сдаётся от {formatNightsGenitive(duration.minNights)} до{' '}
              {formatNightsGenitive(duration.maxNights)}
            </p>
            {listing.description ? (
              <p className="prose mdp__description">{listing.description}</p>
            ) : (
              <p className="mdp__muted">Описание не заполнено.</p>
            )}
          </section>

          <section className="mdp__section">
            <h2 className="mdp__h2">Цена</h2>
            <dl className="mdp__rows">
              <Row label="Основная ставка">
                {pricing.basePriceMinor ? (
                  <>
                    <Money minor={pricing.basePriceMinor!} /> {pricing.priceUnit === 'MONTH' ? 'в месяц' : 'за ночь'}
                  </>
                ) : (
                  'не указана'
                )}
              </Row>
              <Row label="Уборка">
                {Number(pricing.cleaningFeeMinor) > 0 ? <Money minor={pricing.cleaningFeeMinor!} /> : 'нет'}
              </Row>
              <Row label="Коммунальные">
                {pricing.utilitiesMode === 'INCLUDED'
                  ? 'входят в цену'
                  : pricing.utilitiesMode === 'FIXED_EXTRA'
                    ? <><Money minor={pricing.utilitiesFixedMinor ?? '0'} /> доплата</>
                    : 'по счётчику'}
              </Row>
              <Row label="Залог">
                {Number(pricing.depositMinor) > 0 ? <Money minor={pricing.depositMinor!} /> : 'нет'}
              </Row>
              <Row label="Бронирование">
                {listing.bookingMode === 'REQUEST'
                  ? 'по запросу'
                  : listing.bookingMode === 'INSTANT'
                    ? 'мгновенное'
                    : 'мгновенное и по запросу'}
                {listing.negotiationEnabled && ' · цена обсуждается'}
              </Row>
            </dl>
          </section>

          {listing.amenities.length > 0 && (
            <section className="mdp__section">
              <h2 className="mdp__h2">Удобства · {listing.amenities.length}</h2>
              <Amenities rows={listing.amenities} />
            </section>
          )}

          <section className="mdp__section">
            <h2 className="mdp__h2">Правила</h2>
            <ul className="mdp__rules">
              <li>{SMOKING[rules.smoking] ?? rules.smoking}</li>
              <li>{PETS[rules.pets] ?? rules.pets}</li>
              <li>{rules.childrenAllowed ? 'Можно с детьми' : 'Не подходит для детей'}</li>
              <li>{rules.partiesAllowed ? 'Мероприятия разрешены' : 'Вечеринки запрещены'}</li>
              <li>
                Заезд с {String(rules.checkInFrom ?? '14:00').slice(0, 5)}, выезд до{' '}
                {String(rules.checkOutUntil ?? '12:00').slice(0, 5)}
              </li>
            </ul>
          </section>

          <section className="mdp__section">
            <h2 className="mdp__h2">Расположение</h2>
            <p className="mdp__muted mdp__locNote">
              Показана та же приблизительная точка, которую видят гости. Точный адрес модератору не
              раскрывается — он доступен только арендатору с подтверждённым бронированием.
            </p>
            <div className="mdp__map">
              <MapPanel
                markers={[
                  {
                    id: String(listing.id),
                    latitude: Number(listing.location.latitude),
                    longitude: Number(listing.location.longitude),
                    precision: String(listing.location.precision),
                    priceMinor: pricing.basePriceMinor ?? '0',
                    priceUnit: pricing.priceUnit ?? 'NIGHT',
                    title: String(listing.title ?? ''),
                  },
                ]}
              />
            </div>
          </section>
        </div>

        <aside className="mdp__aside">
          <section className="panel mdp__owner">
            <h2 className="mdp__asideH2">Владелец</h2>
            <div className="mdp__ownerRow">
              <span className="mdp__avatar" aria-hidden="true">
                {String(owner.displayName).trim().charAt(0).toUpperCase()}
              </span>
              <div>
                <strong className="mdp__ownerName">{owner.displayName}</strong>
                <p className="text-xs muted">
                  {owner.accountKind === 'COMPANY' ? 'Компания' : 'Частный хозяин'}
                </p>
              </div>
            </div>
            <dl className="mdp__rows">
              <Row label="Личность">
                {owner.verificationLevel >= 1 ? (
                  <span className="mdp__ok">
                    <Icon name="checkCircle" size={14} />
                    подтверждена
                  </span>
                ) : (
                  'не подтверждена'
                )}
              </Row>
              <Row label="Объект">
                {listing.propertyVerified ? 'проверен' : 'не проверен'}
              </Row>
              <Row label="Рейтинг">
                {owner.rating === null ? 'нет отзывов' : owner.rating.toFixed(1)}
              </Row>
              <Row label="Завершено сделок">{String(owner.completedRentals)}</Row>
              <Row label="Объявлений">{String(owner.listingCount)}</Row>
              <Row label="С нами с">{when(String(owner.memberSince)).split(',')[0]!}</Row>
            </dl>
            <p className="hint">
              Документы, удостоверяющие личность, модератору недоступны — их проверяет отдельная
              роль, и каждый доступ записывается.
            </p>
          </section>

          <section className="panel mdp__history">
            <h2 className="mdp__asideH2">История решений</h2>
            {history.length === 0 ? (
              <p className="text-sm muted">Решений ещё не было. Это первая проверка.</p>
            ) : (
              <ol className="mdp__historyList">
                {history.map((h) => (
                  <li key={h.id} className="mdp__event">
                    <span className={`badge badge-${h.decision === 'PUBLISHED' ? 'verified' : h.decision === 'REJECTED' ? 'danger' : 'solid-neutral'}`}>
                      {DECISION_LABEL[h.decision] ?? h.decision}
                    </span>
                    <p className="text-xs dim">
                      {when(h.createdAt)}
                      {h.moderatorName ? ` · ${h.moderatorName}` : ''}
                    </p>
                    {h.reasonCodes.length > 0 && (
                      <ul className="mdp__reasons">
                        {h.reasonCodes.map((c) => (
                          <li key={c}>
                            {MODERATION_REASON_TEXT[c as ModerationReasonCode] ?? c}
                          </li>
                        ))}
                      </ul>
                    )}
                    {h.comment && <p className="mdp__comment">«{h.comment}»</p>}
                  </li>
                ))}
              </ol>
            )}
            {history.length > 1 && (
              <p className="hint">
                Объявление проверяется {history.length + 1}-й раз. Прошлые замечания видны выше.
              </p>
            )}
          </section>
        </aside>
      </div>

      <style>{`
        .mdp { padding-block: var(--space-4) var(--space-8); max-width: 68rem; }
        .mdp__back { margin-bottom: var(--space-3); }
        .mdp__backLink { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .mdp__backLink:hover { color: var(--text-primary); }

        .mdp__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
        .mdp__headMain { display: grid; gap: var(--space-2); min-width: 0; }
        .mdp__titleRow { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
        .mdp__title { font-size: var(--text-2xl); font-weight: 650; letter-spacing: -0.022em; }
        .mdp__meta { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; font-size: var(--text-sm); color: var(--text-secondary); }

        .mdp__decide { margin-bottom: var(--space-5); }

        .mdp__layout { display: grid; gap: var(--space-6); }
        @media (min-width: 960px) {
          .mdp__layout { grid-template-columns: minmax(0, 1fr) 20rem; align-items: start; }
          .mdp__aside { position: sticky; top: calc(var(--header-height) + 0.75rem); }
        }
        .mdp__main { display: grid; min-width: 0; }
        .mdp__aside { display: grid; gap: var(--space-3); min-width: 0; }

        .mdp__section { padding-block: var(--space-5); }
        .mdp__section:first-child { padding-top: 0; }
        .mdp__section + .mdp__section { border-top: 1px solid var(--border); }
        .mdp__h2 { font-size: var(--text-lg); font-weight: 600; margin-bottom: var(--space-3); }
        .mdp__asideH2 { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }
        .mdp__muted { color: var(--text-secondary); font-size: var(--text-sm); }

        .mdp__photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
        .mdp__photo { position: relative; border-radius: var(--radius-sm); overflow: hidden; background: var(--surface-sunken); }
        .mdp__photo img { width: 100%; aspect-ratio: 3 / 2; object-fit: cover; display: block; }
        .mdp__cover, .mdp__dims {
          position: absolute; padding: 0.1rem 0.4rem; border-radius: var(--radius-sm);
          background: color-mix(in srgb, var(--surface) 92%, transparent);
          font-size: var(--text-2xs); font-weight: 600;
        }
        .mdp__cover { left: 0.35rem; top: 0.35rem; }
        .mdp__dims { right: 0.35rem; bottom: 0.35rem; color: var(--text-secondary); }

        .mdp__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr)); gap: var(--space-3); }
        .mdp__fact { display: grid; gap: 0.1rem; }
        .mdp__fact > svg { color: var(--text-tertiary); margin-bottom: 0.15rem; }
        .mdp__factValue { font-size: var(--text-base); font-weight: 600; }
        .mdp__factLabel { font-size: var(--text-xs); color: var(--text-tertiary); }
        .mdp__duration {
          display: flex; align-items: center; gap: 0.5rem;
          margin-top: var(--space-4); padding: var(--space-2) var(--space-3);
          background: var(--primary-soft); border-radius: var(--radius-sm);
          font-size: var(--text-sm);
        }
        .mdp__duration > svg { color: var(--primary); }
        .mdp__description { margin-top: var(--space-4); color: var(--text-secondary); white-space: pre-line; }

        .mdp__rows { display: grid; margin: 0; }
        .mdp__row { display: grid; grid-template-columns: 9rem 1fr; gap: var(--space-3); padding-block: 0.4rem; font-size: var(--text-sm); }
        .mdp__row dt { color: var(--text-secondary); }
        .mdp__row dd { margin: 0; }
        .mdp__ok { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--success); font-weight: 600; }

        .mdp__rules { display: grid; gap: var(--space-2); margin: 0; padding-left: 1.1rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .mdp__locNote { max-width: 60ch; margin-bottom: var(--space-3); }
        .mdp__map { height: 16rem; }

        .mdp__ownerRow { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
        .mdp__avatar {
          display: grid; place-items: center; width: 2.5rem; height: 2.5rem; flex: 0 0 auto;
          border-radius: var(--radius-full); background: var(--primary-soft); color: var(--primary);
          font-weight: 600;
        }
        .mdp__ownerName { font-size: var(--text-sm); }

        .mdp__historyList { display: grid; gap: var(--space-4); list-style: none; margin: 0; padding: 0; }
        .mdp__event { display: grid; gap: 0.25rem; justify-items: start; }
        .mdp__reasons { margin: 0.15rem 0 0; padding-left: 1.1rem; font-size: var(--text-xs); color: var(--text-secondary); }
        .mdp__comment { font-size: var(--text-xs); color: var(--text-primary); font-style: italic; }

        @media (max-width: 560px) {
          .mdp__row { grid-template-columns: 1fr; gap: 0; }
          .mdp__row dt { font-size: var(--text-xs); }
        }
      `}</style>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mdp__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
