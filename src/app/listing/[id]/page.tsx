import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ready } from '@/server/runtime.ts';
import { SearchService } from '@/server/services/search-service.ts';
import { ReviewService } from '@/server/services/review-service.ts';
import { AvailabilityService } from '@/server/services/availability-service.ts';
import { BookingPanel } from '@/ui/booking-panel.tsx';
import { MapPanel } from '@/ui/map-panel.tsx';
import {
  Badge,
  FreshnessIndicator,
  Money,
  PROPERTY_TYPE_LABEL,
  VerificationBadges,
  formatNights,
  formatNightsGenitive,
  plural,
} from '@/ui/primitives.tsx';
import { formatMoney, fromStorage } from '@/server/domain/money.ts';

export const dynamic = 'force-dynamic';

type Listing = Record<string, any>;

async function loadListing(id: string): Promise<Listing | null> {
  try {
    return await new SearchService(await ready()).getPublicListing(id, null);
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const listing = await loadListing(id);
  if (!listing) return { title: 'Объявление не найдено' };

  return {
    title: `${listing.title} — ${listing.city}`,
    description: String(listing.description || '').slice(0, 160) || `Аренда: ${listing.title} в городе ${listing.city}.`,
    alternates: { canonical: `/listing/${id}` },
    openGraph: { title: listing.title as string, type: 'article' },
  };
}

const POLICY_LABEL: Record<string, Record<string, string>> = {
  smoking: {
    PROHIBITED: 'Курение запрещено',
    ALLOWED: 'Курение разрешено',
    BALCONY_ONLY: 'Курение только на балконе',
  },
  pets: {
    PROHIBITED: 'С животными нельзя',
    ALLOWED: 'Можно с животными',
    SMALL_ONLY: 'Только небольшие животные',
    ON_REQUEST: 'С животными по согласованию',
  },
};

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const listing = await loadListing(id);
  if (!listing || listing.status !== 'PUBLISHED') notFound();

  const database = await ready();
  const reviewService = new ReviewService(database);
  const [reviewData, confirmedFacts, amenityRows, calendar] = await Promise.all([
    reviewService.listForProperty(id, 6),
    reviewService.confirmedFacts(id),
    database.query<{ code: string; name_ru: string }>(
      `SELECT a.code, a.name_ru FROM property_amenity pa
        JOIN amenity a ON a.code = pa.amenity_code
       WHERE pa.property_id = $1 ORDER BY a.sort_order`,
      [id],
    ),
    new AvailabilityService(database)
      .getCalendar(id, isoToday(), isoToday(90))
      .catch(() => null),
  ]);

  const pricing = listing.pricing as Record<string, string>;
  const rules = listing.rules as Record<string, unknown>;
  const owner = listing.owner as Record<string, any>;
  const duration = listing.duration as { minNights: number; maxNights: number };

  return (
    <div className="container" style={{ paddingBlock: '1.25rem' }}>
      <nav aria-label="Навигация" style={{ fontSize: 'var(--text-sm)', marginBottom: '0.75rem' }}>
        <Link href={`/search?city=${encodeURIComponent(listing.city)}`} style={{ color: 'var(--fg-muted)' }}>
          ← {listing.city}
        </Link>
      </nav>

      <header className="stack" style={{ gap: '0.5rem', marginBottom: '1rem' }}>
        <h1 style={{ fontSize: 'var(--text-3xl)' }}>{listing.title}</h1>
        <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Badge tone="neutral">{PROPERTY_TYPE_LABEL[listing.propertyType] ?? listing.propertyType}</Badge>
          <VerificationBadges
            identityLevel={Number(owner.verificationLevel)}
            propertyVerified={Boolean(listing.verification?.propertyVerified)}
          />
          {listing.rating !== null && (
            <span className="numeric" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
              ★ {Number(listing.rating).toFixed(1)}{' '}
              <span style={{ color: 'var(--fg-subtle)', fontWeight: 400 }}>
                ({listing.reviewCount} {plural(Number(listing.reviewCount), 'отзыв', 'отзыва', 'отзывов')})
              </span>
            </span>
          )}
          {calendar && <FreshnessIndicator freshness={calendar.freshness} />}
        </div>
      </header>

      <Gallery photos={(listing.photos ?? []) as { id: string; storageKey: string }[]} />

      <div className="listing-layout">
        <div className="stack" style={{ gap: '1.5rem' }}>
          {/* --- facts ------------------------------------------------ */}
          <section className="panel">
            <h2 className="section-title">Об объекте</h2>
            <dl className="facts">
              {[
                listing.rooms !== null && ['Комнат', String(listing.rooms)],
                listing.areaSqm && ['Площадь', `${Math.round(Number(listing.areaSqm))} м²`],
                listing.floor !== null && [
                  'Этаж',
                  listing.totalFloors ? `${listing.floor} из ${listing.totalFloors}` : String(listing.floor),
                ],
                listing.beds !== null && ['Спальных мест', String(listing.beds)],
                listing.bathrooms !== null && ['Санузлов', String(listing.bathrooms)],
                ['Максимум гостей', String(listing.maxGuests)],
                [
                  'Срок аренды',
                  `от ${formatNightsGenitive(duration.minNights)} до ${formatNightsGenitive(duration.maxNights)}`,
                ],
                [
                  'Заезд / выезд',
                  `с ${String(rules.checkInFrom ?? '14:00').slice(0, 5)} / до ${String(rules.checkOutUntil ?? '12:00').slice(0, 5)}`,
                ],
              ]
                .filter(Boolean)
                .map((entry) => {
                  const [label, value] = entry as [string, string];
                  return (
                    <div key={label} className="fact">
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  );
                })}
            </dl>

            {listing.description && (
              <p style={{ marginTop: '1rem', color: 'var(--fg-muted)', whiteSpace: 'pre-line' }}>
                {listing.description}
              </p>
            )}
          </section>

          {/* --- amenities, with guest-confirmed evidence -------------- */}
          {amenityRows.rows.length > 0 && (
            <section className="panel">
              <h2 className="section-title">Удобства</h2>
              <ul className="amenities">
                {amenityRows.rows.map((a) => {
                  const fact = confirmedFacts[a.code];
                  return (
                    <li key={a.code}>
                      <span>{a.name_ru}</span>
                      {/* "Landlord says" versus "guests confirmed" (spec §35). */}
                      {fact && fact.total > 0 && (
                        <span className="amenity-confirm">
                          подтвердили {fact.confirmed} из {fact.total}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* --- house rules ------------------------------------------ */}
          <section className="panel">
            <h2 className="section-title">Правила</h2>
            <ul className="rules">
              <li>{POLICY_LABEL.smoking![String(rules.smoking)] ?? String(rules.smoking)}</li>
              <li>{POLICY_LABEL.pets![String(rules.pets)] ?? String(rules.pets)}</li>
              <li>{rules.childrenAllowed ? 'Можно с детьми' : 'Не подходит для детей'}</li>
              <li>{rules.partiesAllowed ? 'Мероприятия разрешены' : 'Вечеринки и мероприятия запрещены'}</li>
              {rules.quietHoursFrom != null && rules.quietHoursTo != null && (
                <li>
                  Тихие часы: с {String(rules.quietHoursFrom).slice(0, 5)} до{' '}
                  {String(rules.quietHoursTo).slice(0, 5)}
                </li>
              )}
            </ul>
          </section>

          {/* --- location --------------------------------------------- */}
          <section className="panel">
            <h2 className="section-title">Расположение</h2>
            <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)', marginBottom: '0.75rem' }}>
              {listing.district ? `${listing.city}, ${listing.district}` : listing.city}. Показано примерное
              расположение — точный адрес открывается после подтверждения бронирования.
            </p>
            <div style={{ height: '18rem' }}>
              <MapPanel
                markers={[
                  {
                    id: listing.id,
                    latitude: Number(listing.location.latitude),
                    longitude: Number(listing.location.longitude),
                    precision: String(listing.location.precision),
                    priceMinor: pricing.basePriceMinor!,
                    priceUnit: pricing.priceUnit!,
                    title: listing.title,
                  },
                ]}
              />
            </div>
          </section>

          {/* --- landlord --------------------------------------------- */}
          <section className="panel">
            <h2 className="section-title">Хозяин</h2>
            <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
              <div className="stack grow" style={{ gap: '0.35rem' }}>
                <strong>{owner.displayName}</strong>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--fg-muted)' }}>
                  {owner.accountKind === 'COMPANY' ? 'Компания' : 'Частный хозяин'} ·{' '}
                  {owner.completedRentals} {plural(Number(owner.completedRentals), 'сделка', 'сделки', 'сделок')}
                </span>
                <VerificationBadges
                  identityLevel={Number(owner.verificationLevel)}
                  propertyVerified={Boolean(listing.verification?.propertyVerified)}
                />
              </div>
              <Link href={`/profiles/${owner.id}`} className="btn btn-secondary">
                Профиль и доверие
              </Link>
            </div>
          </section>

          {/* --- reviews ---------------------------------------------- */}
          <section className="panel">
            <h2 className="section-title">
              Отзывы {listing.reviewCount ? `(${listing.reviewCount})` : ''}
            </h2>
            {reviewData.length === 0 ? (
              <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--text-sm)' }}>
                Отзывов пока нет. Их можно оставить только после завершённой аренды, поэтому здесь не
                бывает случайных оценок.
              </p>
            ) : (
              <ul className="stack" style={{ gap: '1rem', listStyle: 'none', padding: 0, margin: 0 }}>
                {reviewData.map((review) => {
                  const r = review as Record<string, any>;
                  return (
                    <li key={r.id} className="stack" style={{ gap: '0.35rem' }}>
                      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 'var(--text-sm)' }}>{r.author.name}</strong>
                        <span className="numeric" style={{ fontSize: 'var(--text-sm)' }}>
                          ★ {r.ratings.overall}
                        </span>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-subtle)' }}>
                          {r.stayLength}
                        </span>
                      </div>
                      {r.body && <p style={{ fontSize: 'var(--text-sm)' }}>{r.body}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* --- booking ------------------------------------------------ */}
        <aside className="listing-aside">
          <BookingPanel
            propertyId={listing.id}
            minNights={duration.minNights}
            maxNights={duration.maxNights}
            bookingMode={String(listing.bookingMode)}
            basePriceFormatted={formatMoney(fromStorage(pricing.basePriceMinor!))}
            priceUnit={String(pricing.priceUnit)}
          />

          {pricing.utilitiesMode === 'VARIABLE_METERED' && (
            <p className="hint" style={{ marginTop: '0.75rem' }}>
              Коммунальные платежи по счётчику оплачиваются отдельно и заранее не известны.
            </p>
          )}
          {Number(pricing.cleaningFeeMinor) > 0 && (
            <p className="hint" style={{ marginTop: '0.5rem' }}>
              Обязательная уборка <Money minor={pricing.cleaningFeeMinor!} /> уже включена в итоговую сумму.
            </p>
          )}
        </aside>
      </div>

      <style>{`
        .section-title { font-size: var(--text-lg); margin-bottom: 0.75rem; }
        .listing-layout { display: grid; gap: 1.5rem; margin-top: 1.5rem; }
        .listing-aside { min-width: 0; }
        @media (min-width: 960px) {
          .listing-layout { grid-template-columns: minmax(0, 1fr) 22rem; align-items: start; }
          .listing-aside { position: sticky; top: 4.75rem; }
        }
        .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; margin: 0; }
        .fact dt { font-size: var(--text-xs); color: var(--fg-subtle); }
        .fact dd { margin: 0; font-size: var(--text-sm); font-weight: 600; }
        .amenities, .rules { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
        .amenities { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
        .amenities li { display: flex; flex-direction: column; font-size: var(--text-sm); }
        .amenity-confirm { font-size: var(--text-2xs); color: var(--color-success-600); font-weight: 600; }
        .rules li { font-size: var(--text-sm); color: var(--fg-muted); }
      `}</style>
    </div>
  );
}

function Gallery({ photos }: { photos: { id: string; storageKey: string }[] }) {
  if (photos.length === 0) {
    return (
      <div
        className="card"
        style={{ aspectRatio: '16 / 9', background: 'var(--bg-sunken)', display: 'grid', placeItems: 'center' }}
      >
        <span style={{ color: 'var(--fg-subtle)', fontSize: 'var(--text-sm)' }}>Фотографий пока нет</span>
      </div>
    );
  }

  return (
    <div className="gallery">
      {photos.slice(0, 5).map((photo, index) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={photo.id}
          src={`/media/${photo.storageKey}`}
          alt=""
          className={index === 0 ? 'gallery__main' : 'gallery__thumb'}
          loading={index === 0 ? 'eager' : 'lazy'}
          decoding="async"
        />
      ))}
      <style>{`
        .gallery {
          display: grid;
          gap: 0.5rem;
          border-radius: var(--radius-lg);
          overflow: hidden;
        }
        .gallery img { width: 100%; height: 100%; object-fit: cover; display: block; background: var(--bg-sunken); }
        .gallery__main { aspect-ratio: 16 / 10; }
        .gallery__thumb { display: none; }
        @media (min-width: 760px) {
          .gallery { grid-template-columns: 2fr 1fr 1fr; grid-template-rows: 1fr 1fr; height: 24rem; }
          .gallery__main { grid-row: span 2; height: 100%; aspect-ratio: auto; }
          .gallery__thumb { display: block; }
        }
      `}</style>
    </div>
  );
}

function isoToday(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
