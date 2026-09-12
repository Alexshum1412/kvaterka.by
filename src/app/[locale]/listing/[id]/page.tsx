import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation.ts';
import type { AppLocale } from '@/i18n/routing.ts';
import { ready, readyServices } from '@/server/runtime.ts';
import { currentUser } from '@/server/session.ts';
import { SearchService } from '@/server/services/search-service.ts';
import { ReviewService } from '@/server/services/review-service.ts';
import { AvailabilityService } from '@/server/services/availability-service.ts';
import { BookingPanel } from '@/ui/booking-panel.tsx';
import { MapPanel } from '@/ui/map-panel.tsx';
import { Amenities, type AmenityRow } from '@/ui/amenities.tsx';
import { FavouriteButton } from '@/ui/favourite-button.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';
import { CornflowerMark } from '@/ui/brand.tsx';
import {
  FreshnessIndicator,
  Money,
  VerificationBadges,
  formatNightsGenitiveLocalized,
  propertyTypeLabel,
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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const listing = await loadListing(id);
  const t = await getTranslations('ListingDetail');
  if (!listing) return { title: t('meta.notFoundTitle') };

  return {
    title: `${listing.title} — ${listing.city}`,
    description:
      String(listing.description || '').slice(0, 160) ||
      t('meta.descriptionFallback', { title: listing.title, city: listing.city }),
    alternates: { canonical: `/listing/${id}` },
    openGraph: { title: listing.title as string, type: 'article' },
  };
}

/** Rule/policy enum keys, in a closed known set — anything unrecognised falls
 * back to the raw value, matching the original table lookup's behaviour. */
const SMOKING_KEYS = ['PROHIBITED', 'ALLOWED', 'BALCONY_ONLY'] as const;
const PETS_KEYS = ['PROHIBITED', 'ALLOWED', 'SMALL_ONLY', 'ON_REQUEST'] as const;

/** Review dimensions, in the order a tenant cares about them. */
const REVIEW_DIMENSION_KEYS = [
  'cleanliness',
  'accuracy',
  'communication',
  'checkIn',
  'location',
  'value',
  'rulesClarity',
] as const;

export default async function ListingPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  const listing = await loadListing(id);
  if (!listing || listing.status !== 'PUBLISHED') notFound();

  const t = await getTranslations('ListingDetail');

  const database = await ready();
  const reviewService = new ReviewService(database);
  const [reviewData, confirmedFacts, reviewSummary, amenityRows, calendar] = await Promise.all([
    reviewService.listForProperty(id, 6),
    reviewService.confirmedFacts(id),
    reviewService.dimensionSummary(id),
    database.query<AmenityRow>(
      `SELECT a.code, a.category, a.name_ru, a.name_be, a.name_en, a.icon FROM property_amenity pa
        JOIN amenity a ON a.code = pa.amenity_code
       WHERE pa.property_id = $1 ORDER BY a.sort_order`,
      [id],
    ),
    new AvailabilityService(database)
      .getCalendar(id, isoToday(), isoToday(90))
      .catch(() => null),
  ]);

  const viewer = await currentUser();
  const saved = viewer
    ? (await (await readyServices()).favorites.savedAmong(viewer.userId, [id])).has(id)
    : undefined;

  const pricing = listing.pricing as Record<string, string>;
  const rules = listing.rules as Record<string, unknown>;
  const owner = listing.owner as Record<string, any>;
  const duration = listing.duration as { minNights: number; maxNights: number };
  const photos = (listing.photos ?? []) as { id: string; storageKey: string }[];
  const place = listing.district ? `${listing.city} · ${listing.district}` : String(listing.city);

  const facts: { icon: IconName; label: string; value: string }[] = [
    listing.rooms !== null && { icon: 'rooms' as IconName, label: t('facts.rooms'), value: String(listing.rooms) },
    listing.areaSqm && {
      icon: 'area' as IconName,
      label: t('facts.area'),
      value: t('facts.areaValue', { value: Math.round(Number(listing.areaSqm)) }),
    },
    listing.floor !== null && {
      icon: 'floors' as IconName,
      label: t('facts.floor'),
      value: listing.totalFloors
        ? t('facts.floorOf', { floor: listing.floor, total: listing.totalFloors })
        : String(listing.floor),
    },
    listing.beds !== null && { icon: 'bed' as IconName, label: t('facts.beds'), value: String(listing.beds) },
    listing.bathrooms !== null && {
      icon: 'bath' as IconName,
      label: t('facts.bathrooms'),
      value: String(listing.bathrooms),
    },
    { icon: 'users' as IconName, label: t('facts.maxGuests'), value: String(listing.maxGuests) },
  ].filter(Boolean) as { icon: IconName; label: string; value: string }[];

  /* Sub-ratings are the difference between "4.9" and knowing what was good.
     The averages come from the database across EVERY published review — this
     used to average the six reviews the page had just fetched and label the
     result «Чистота 4.9», which is a different number as soon as a listing has
     more than six. */
  const dimensionAverages = REVIEW_DIMENSION_KEYS.map((key) => {
    const entry = reviewSummary.dimensions[key];
    return entry ? { key, label: t(`dimensions.${key}`), value: entry.average, count: entry.count } : null;
  }).filter(Boolean) as { key: string; label: string; value: number; count: number }[];

  // LodgingBusiness structured data. Every field below reads an existing
  // property of `listing` — nothing here is invented. No street address is
  // sent (the platform never exposes one before a booking is confirmed,
  // DEC-020), geo is the same blurred public point already sent to the
  // client for the map, and the rating only appears once there is at least
  // one real review behind it.
  const jsonLd: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LodgingBusiness',
    name: listing.title,
    description: listing.description ? String(listing.description).slice(0, 300) : undefined,
    address: {
      '@type': 'PostalAddress',
      addressLocality: listing.city,
      addressRegion: listing.district || undefined,
      addressCountry: 'BY',
    },
    ...(listing.location?.latitude != null && listing.location?.longitude != null
      ? {
          geo: {
            '@type': 'GeoCoordinates',
            latitude: Number(listing.location.latitude),
            longitude: Number(listing.location.longitude),
          },
        }
      : {}),
    ...(Number(listing.reviewCount) > 0 && listing.rating != null
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: Number(listing.rating).toFixed(1),
            reviewCount: Number(listing.reviewCount),
          },
        }
      : {}),
    priceRange: formatMoney(fromStorage(pricing.basePriceMinor!)),
  };

  return (
    <div className="container lst">
      {/* Static JSON-LD built entirely from this page's own fetched data. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />

      <nav className="lst__crumbs" aria-label={t('breadcrumbs.aria')}>
        <Link href="/" className="lst__crumbLink">
          <Icon name="home" size={14} />
          {t('breadcrumbs.home')}
        </Link>
        <Icon name="chevronRight" size={13} className="lst__crumbSep" />
        <Link
          href={`/search?city=${encodeURIComponent(String(listing.city))}`}
          className="lst__crumbLink"
        >
          {listing.city}
        </Link>
        <Icon name="chevronRight" size={13} className="lst__crumbSep" />
        <span className="lst__crumbCurrent truncate" aria-current="page">
          {listing.title}
        </span>
      </nav>

      {/* The apartment identifies itself before the photographs, so the
          information does not start below the fold. */}
      <header className="lst__head">
        <div className="lst__headMain">
          <h1 className="lst__title">{listing.title}</h1>
          <div className="lst__meta">
            <span className="lst__place">
              <Icon name="pin" size={15} />
              {place}
            </span>
            {listing.rating !== null && (
              <span className="lst__rating numeric">
                <Icon name="star" size={15} solid />
                {Number(listing.rating).toFixed(1)}
                <span className="lst__ratingCount">
                  ({t('header.reviewCount', { count: Number(listing.reviewCount) })})
                </span>
              </span>
            )}
            <span className="lst__type">{propertyTypeLabel(listing.propertyType, locale as AppLocale)}</span>
          </div>
        </div>
        <FavouriteButton propertyId={String(listing.id)} initial={saved} className="lst__fav" />
      </header>

      <Gallery photos={photos} title={String(listing.title)} t={t} />

      <div className="lst__layout">
        <div className="lst__body">
          <section className="lst__section">
            <div className="lst__facts">
              {facts.map((f) => (
                <div key={f.label} className="lst__fact">
                  <Icon name={f.icon} size={20} className="lst__factIcon" />
                  <span className="lst__factValue">{f.value}</span>
                  <span className="lst__factLabel">{f.label}</span>
                </div>
              ))}
            </div>

            {/* Renting by the night OR by the year is the whole product.
                It does not belong in a table row. */}
            <p className="lst__duration">
              <Icon name="calendar" size={18} />
              <span>
                {t.rich('duration.text', {
                  min: formatNightsGenitiveLocalized(duration.minNights, locale as AppLocale),
                  max: formatNightsGenitiveLocalized(duration.maxNights, locale as AppLocale),
                  strongMin: (chunks) => <strong>{chunks}</strong>,
                  strongMax: (chunks) => <strong>{chunks}</strong>,
                })}
              </span>
            </p>

            {listing.description && (
              <p className="prose lst__description">{listing.description}</p>
            )}
          </section>

          {amenityRows.rows.length > 0 && (
            <section className="lst__section">
              <h2 className="lst__h2">{t('amenitiesTitle')}</h2>
              <Amenities rows={amenityRows.rows} confirmedFacts={confirmedFacts} />
            </section>
          )}

          <section className="lst__section">
            <h2 className="lst__h2">{t('rulesTitle')}</h2>
            <ul className="lst__rules">
              <Rule
                icon={String(rules.smoking) === 'PROHIBITED' ? 'noSmoking' : 'smoking'}
                text={
                  (SMOKING_KEYS as readonly string[]).includes(String(rules.smoking))
                    ? t(`policy.smoking.${String(rules.smoking)}`)
                    : String(rules.smoking)
                }
              />
              <Rule
                icon="paw"
                text={
                  (PETS_KEYS as readonly string[]).includes(String(rules.pets))
                    ? t(`policy.pets.${String(rules.pets)}`)
                    : String(rules.pets)
                }
              />
              <Rule icon="baby" text={rules.childrenAllowed ? t('rules.childrenAllowed') : t('rules.childrenNotAllowed')} />
              <Rule
                icon="party"
                text={rules.partiesAllowed ? t('rules.partiesAllowed') : t('rules.partiesNotAllowed')}
              />
              <Rule
                icon="clock"
                text={t('rules.checkInOut', {
                  from: String(rules.checkInFrom ?? '14:00').slice(0, 5),
                  to: String(rules.checkOutUntil ?? '12:00').slice(0, 5),
                })}
              />
              {rules.quietHoursFrom != null && rules.quietHoursTo != null && (
                <Rule
                  icon="bell"
                  text={t('rules.quietHours', {
                    from: String(rules.quietHoursFrom).slice(0, 5),
                    to: String(rules.quietHoursTo).slice(0, 5),
                  })}
                />
              )}
            </ul>
            {calendar && (
              <div className="lst__freshness">
                <FreshnessIndicator freshness={calendar.freshness} />
              </div>
            )}
          </section>

          <section className="lst__section">
            <h2 className="lst__h2">
              {listing.reviewCount
                ? t('reviews.titleWithCount', { count: Number(listing.reviewCount) })
                : t('reviews.title')}
            </h2>

            {reviewData.length === 0 ? (
              <p className="lst__muted">
                {t('reviews.empty')}
              </p>
            ) : (
              <>
                {/* Honest about a thin sample. An average over two stays is
                    arithmetically fine and evidentially weak, and saying so is
                    cheaper than having a guest discover it. */}
                {reviewSummary.count > 0 && reviewSummary.count < 3 && (
                  <p className="lst__thin">
                    <Icon name="info" size={15} />
                    {t('reviews.thin', { count: reviewSummary.count })}
                  </p>
                )}

                {dimensionAverages.length > 0 && (
                  <dl className="lst__dims">
                    {dimensionAverages.map((d) => (
                      <div key={d.key} className="lst__dim">
                        <dt className="lst__dimLabel">{d.label}</dt>
                        <dd className="lst__dimValue">
                          <span className="lst__bar" aria-hidden="true">
                            <span className="lst__barFill" style={{ width: `${(d.value / 5) * 100}%` }} />
                          </span>
                          <span className="numeric">{d.value.toFixed(1)}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}

                <ul className="lst__reviews">
                  {reviewData.map((review) => {
                    const r = review as Record<string, any>;
                    return (
                      <li key={r.id} className="lst__review">
                        <div className="lst__reviewHead">
                          <strong className="lst__reviewAuthor">{r.author.name}</strong>
                          <span className="lst__reviewScore numeric">
                            <Icon name="star" size={13} solid />
                            {r.ratings.overall}
                          </span>
                          <span className="lst__reviewStay">{r.stayLength}</span>
                        </div>
                        {r.body && <p className="lst__reviewBody">{r.body}</p>}
                        {r.wouldRentAgain === true && (
                          <span className="lst__again">
                            <Icon name="checkCircle" size={14} />
                            {t('reviews.wouldRentAgain')}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>

          <section className="lst__section">
            <h2 className="lst__h2">{t('location.title')}</h2>
            <p className="lst__muted lst__locationNote">
              {t('location.note', { place })}
            </p>
            <div className="lst__map">
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

          <section className="lst__section">
            <h2 className="lst__h2">{t('owner.title')}</h2>
            <div className="lst__owner">
              <span className="lst__avatar" aria-hidden="true">
                {String(owner.displayName).trim().charAt(0).toUpperCase()}
              </span>
              <div className="lst__ownerBody">
                <strong className="lst__ownerName">{owner.displayName}</strong>
                <span className="lst__muted lst__ownerLine">
                  {owner.accountKind === 'COMPANY' ? t('owner.company') : t('owner.private')} ·{' '}
                  {t('owner.completedRentals', { count: Number(owner.completedRentals) })}
                </span>
                <VerificationBadges
                  identityLevel={Number(owner.verificationLevel)}
                  propertyVerified={Boolean(listing.verification?.propertyVerified)}
                />
              </div>
              <Link href={`/profiles/${owner.id}`} className="btn btn-secondary btn-sm">
                {t('owner.profileLink')}
              </Link>
            </div>
          </section>
        </div>

        <aside className="lst__aside" id="booking">
          <BookingPanel
            propertyId={listing.id}
            minNights={duration.minNights}
            maxNights={duration.maxNights}
            bookingMode={String(listing.bookingMode)}
            basePriceFormatted={formatMoney(fromStorage(pricing.basePriceMinor!))}
            priceUnit={String(pricing.priceUnit)}
          />

          {pricing.utilitiesMode === 'VARIABLE_METERED' && (
            <p className="hint lst__asideNote">
              {t('aside.utilitiesNote')}
            </p>
          )}
          {Number(pricing.cleaningFeeMinor) > 0 && (
            <p className="hint lst__asideNote">
              {t.rich('aside.cleaningFeeNote', {
                money: () => <Money minor={pricing.cleaningFeeMinor!} />,
              })}
            </p>
          )}
        </aside>
      </div>

      {/* On a phone the booking panel is two thousand pixels down the page,
          so the price and the way to act on it ride along the bottom. */}
      <div className="lst__dock">
        <span className="lst__dockPrice">
          <strong className="numeric">{formatMoney(fromStorage(pricing.basePriceMinor!))}</strong>
          <span className="lst__dockUnit">{pricing.priceUnit === 'MONTH' ? t('priceUnit.perMonth') : t('priceUnit.perNight')}</span>
        </span>
        <a href="#booking" className="btn btn-primary">
          {String(listing.bookingMode) === 'REQUEST' ? t('dock.requestButton') : t('dock.bookButton')}
        </a>
      </div>

      <style>{`
        .lst { padding-block: var(--space-4) var(--space-8); }
        .lst__crumbs {
          display: flex; align-items: center; gap: 0.4rem;
          min-width: 0;
          margin-bottom: var(--space-3);
          font-size: var(--text-sm); color: var(--text-secondary);
        }
        .lst__crumbLink { display: inline-flex; align-items: center; gap: 0.3rem; flex: 0 0 auto; min-height: 1.5rem; }
        .lst__crumbLink:hover { color: var(--primary); }
        .lst__crumbSep { flex: 0 0 auto; color: var(--text-tertiary); }
        .lst__crumbCurrent { flex: 1 1 auto; min-width: 0; color: var(--text-primary); font-weight: 500; }

        .lst__head {
          display: flex; align-items: flex-start; gap: var(--space-4);
          margin-bottom: var(--space-4);
        }
        .lst__headMain { display: grid; gap: var(--space-2); min-width: 0; }
        .lst__title { font-size: var(--text-2xl); font-weight: 700; letter-spacing: -0.025em; }
        .lst__meta {
          display: flex; align-items: center; gap: var(--space-4);
          flex-wrap: wrap;
          font-size: var(--text-sm); color: var(--text-secondary);
        }
        .lst__place, .lst__rating { display: inline-flex; align-items: center; gap: 0.3rem; }
        .lst__rating { color: var(--text-primary); font-weight: 600; }
        .lst__ratingCount { color: var(--text-tertiary); font-weight: 400; }
        .lst__fav { position: static; margin-left: auto; flex: 0 0 auto; }

        .lst__layout { display: grid; gap: var(--space-6); margin-top: var(--space-5); }
        .lst__body { display: grid; gap: 0; min-width: 0; }
        .lst__aside { min-width: 0; display: grid; gap: var(--space-2); align-content: start; }
        .lst__asideNote { margin-top: 0; }
        @media (min-width: 960px) {
          .lst__layout { grid-template-columns: minmax(0, 1fr) 21rem; align-items: start; }
          .lst__aside { position: sticky; top: calc(var(--header-height) + 0.75rem); }
        }

        /* Sections are separated by a hairline and space, not by four walls. */
        .lst__section { padding-block: var(--space-6); }
        .lst__section:first-child { padding-top: 0; }
        .lst__section + .lst__section { border-top: 1px solid var(--border); }
        .lst__h2 { font-size: var(--text-xl); font-weight: 600; margin-bottom: var(--space-4); }
        .lst__muted { color: var(--text-secondary); font-size: var(--text-sm); }

        .lst__facts {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
          gap: var(--space-4);
        }
        .lst__fact { display: grid; gap: 0.1rem; }
        .lst__factIcon { color: var(--text-tertiary); margin-bottom: 0.25rem; }
        .lst__factValue { font-size: var(--text-lg); font-weight: 600; letter-spacing: -0.02em; }
        .lst__factLabel { font-size: var(--text-xs); color: var(--text-tertiary); }

        .lst__duration {
          display: flex; align-items: center; gap: 0.6rem;
          margin-top: var(--space-5);
          padding: var(--space-3) var(--space-4);
          background: var(--primary-soft);
          border-radius: var(--radius-sm);
          font-size: var(--text-sm);
          color: var(--text-primary);
        }
        .lst__duration > svg { color: var(--primary); }
        .lst__description { margin-top: var(--space-5); color: var(--text-secondary); white-space: pre-line; }

        .lst__rules { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
        .lst__rule { display: flex; align-items: center; gap: 0.6rem; font-size: var(--text-sm); }
        .lst__rule > svg { color: var(--text-tertiary); }
        .lst__freshness { margin-top: var(--space-4); }

        .lst__dims {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
          gap: var(--space-3) var(--space-5);
          margin: 0 0 var(--space-6);
        }
        .lst__dim { display: grid; gap: 0.25rem; }
        .lst__dimLabel { font-size: var(--text-xs); color: var(--text-secondary); }
        .lst__dimValue {
          margin: 0; display: flex; align-items: center; gap: 0.5rem;
          font-size: var(--text-sm); font-weight: 600;
        }
        .lst__bar {
          flex: 1 1 auto; height: 4px; border-radius: var(--radius-full);
          background: var(--surface-sunken); overflow: hidden;
        }
        .lst__barFill { display: block; height: 100%; background: var(--primary); border-radius: inherit; }

        .lst__thin {
          display: flex; align-items: flex-start; gap: 0.45rem;
          margin-bottom: var(--space-4); padding: var(--space-3);
          background: var(--surface-sunken); border-radius: var(--radius-sm);
          font-size: var(--text-xs); line-height: 1.5; color: var(--text-secondary);
        }
        .lst__thin > svg { color: var(--text-tertiary); flex: 0 0 auto; margin-top: 0.05rem; }

        .lst__reviews { display: grid; gap: var(--space-5); margin: 0; padding: 0; list-style: none; }
        .lst__review { display: grid; gap: 0.35rem; }
        .lst__reviewHead { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
        .lst__reviewAuthor { font-size: var(--text-sm); }
        .lst__reviewScore { display: inline-flex; align-items: center; gap: 0.25rem; font-size: var(--text-sm); font-weight: 600; }
        .lst__reviewStay { font-size: var(--text-xs); color: var(--text-tertiary); }
        .lst__reviewBody { font-size: var(--text-sm); line-height: 1.6; color: var(--text-secondary); }
        .lst__again {
          display: inline-flex; align-items: center; gap: 0.3rem;
          font-size: var(--text-xs); font-weight: 600; color: var(--success);
        }

        .lst__locationNote { margin-bottom: var(--space-3); max-width: 60ch; }
        .lst__map { height: 18rem; }

        .lst__owner { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
        .lst__avatar {
          display: grid; place-items: center;
          width: 3rem; height: 3rem; flex: 0 0 auto;
          border-radius: var(--radius-full);
          background: var(--primary-soft); color: var(--primary);
          font-size: var(--text-lg); font-weight: 600;
        }
        .lst__ownerBody { display: grid; gap: 0.3rem; flex: 1 1 12rem; min-width: 0; }
        .lst__ownerName { font-size: var(--text-base); }
        .lst__ownerLine { font-size: var(--text-xs); }

        .lst__dock {
          position: fixed;
          inset-inline: 0;
          bottom: 0;
          z-index: 30;
          display: flex; align-items: center; justify-content: space-between;
          gap: var(--space-4);
          padding: var(--space-3) var(--space-4);
          /* Safe-area inset so the bar clears the iOS home indicator. */
          padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
          background: var(--surface);
          border-top: 1px solid var(--border);
          /* Same tinted-navy shadow family as --shadow-raised, flipped
             upward — the bar sits over the page, not on it. */
          box-shadow: 0 -6px 20px rgb(11 37 69 / 0.08);
        }
        .lst__dockPrice { display: flex; align-items: baseline; gap: 0.35rem; min-width: 0; }
        .lst__dockPrice strong { font-size: var(--text-lg); font-weight: 650; letter-spacing: -0.02em; }
        .lst__dockUnit { font-size: var(--text-xs); color: var(--text-secondary); }
        .lst__aside { scroll-margin-top: calc(var(--header-height) + 1rem); }
        @media (min-width: 960px) { .lst__dock { display: none; } }
        /* The dock floats over the page, so the page has to end above it. */
        @media (max-width: 959px) { .lst { padding-bottom: 6rem; } }
      `}</style>
    </div>
  );
}

function Rule({ icon, text }: { icon: IconName; text: string }) {
  return (
    <li className="lst__rule">
      <Icon name={icon} size={18} />
      {text}
    </li>
  );
}

function Gallery({
  photos,
  title,
  t,
}: {
  photos: { id: string; storageKey: string }[];
  title: string;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  if (photos.length === 0) {
    return (
      <div className="gal gal--empty">
        <span className="gal__emptyMark" aria-hidden="true">
          <CornflowerMark size={64} />
        </span>
        <span>{t('gallery.empty')}</span>
        <style>{`
          .gal--empty {
            aspect-ratio: 16 / 7;
            display: grid; place-items: center; align-content: center; gap: var(--space-3);
            background: var(--surface-sunken);
            border-radius: var(--radius-lg);
            color: var(--text-tertiary);
            font-size: var(--text-sm);
          }
          .gal__emptyMark { color: var(--accent); opacity: 0.5; }
        `}</style>
      </div>
    );
  }

  const shown = photos.slice(0, 5);

  return (
    <div className="gal">
      {shown.map((photo, index) => (
        <span
          key={photo.id}
          className={`media-zoom ${index === 0 ? 'gal__mainWrap' : 'gal__thumbWrap'}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/media/${photo.storageKey}`}
            alt={index === 0 ? t('gallery.mainAlt', { title }) : t('gallery.photoAlt', { title, index: index + 1 })}
            loading={index === 0 ? 'eager' : 'lazy'}
            decoding="async"
          />
        </span>
      ))}
      {photos.length > shown.length && (
        // Information, not a control: there is no gallery viewer yet, and a
        // button that opens nothing is worse than a count.
        <p className="gal__more">{t('gallery.morePhotos', { count: photos.length })}</p>
      )}

      <style>{`
        .gal {
          position: relative;
          display: grid;
          gap: 0.5rem;
          border-radius: var(--radius-lg);
          overflow: hidden;
        }
        /* Full-bleed on a phone: a photograph of a home should not sit in a
           16px gutter. */
        @media (max-width: 640px) {
          .gal { margin-inline: calc(var(--space-4) * -1); border-radius: 0; }
        }
        .gal img {
          width: 100%; height: 100%;
          object-fit: cover; display: block;
          background: var(--surface-sunken);
        }
        /* .media-zoom (globals.css) needs an overflow-hidden parent per
           image — these wrappers are that parent, one per grid cell, so the
           hover scale never bleeds into a neighbouring photo. */
        .gal__mainWrap { display: block; aspect-ratio: 3 / 2; }
        .gal__thumbWrap { display: none; }
        .gal__more {
          position: absolute; right: var(--space-3); bottom: var(--space-3);
          padding: 0.25rem 0.6rem;
          border-radius: var(--radius-sm);
          background: color-mix(in srgb, var(--surface) 92%, transparent);
          font-size: var(--text-xs); font-weight: 600;
          box-shadow: var(--shadow-subtle);
        }
        @media (min-width: 760px) {
          .gal { grid-template-columns: 2fr 1fr 1fr; grid-template-rows: 1fr 1fr; height: 26rem; }
          .gal__mainWrap { grid-row: span 2; height: 100%; aspect-ratio: auto; }
          .gal__thumbWrap { display: block; }
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
