import type { Metadata } from 'next';
import { Link, getPathname } from '@/i18n/navigation.ts';
import { getLocale, getTranslations } from 'next-intl/server';
import { SearchForm } from '@/ui/search-form.tsx';
import { SearchFilters, type AmenityOption } from '@/ui/search-filters.tsx';
import { ListingCard, type ListingCardData } from '@/ui/listing-card.tsx';
import { SearchMobileView } from '@/ui/search-mobile-view.tsx';
import { CardSkeleton, EmptyState, ErrorState, formatNightsLocalized } from '@/ui/primitives.tsx';
import { Icon } from '@/ui/icons.tsx';
import { ready, readyServices } from '@/server/runtime.ts';
import { currentUser } from '@/server/session.ts';
import { nightsBetween, PricingError } from '@/server/domain/pricing.ts';
import type { AppLocale } from '@/i18n/routing.ts';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({
  params: routeParams,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const { locale } = await routeParams;
  const params = await searchParams;
  const city = typeof params.city === 'string' ? params.city : null;
  const t = await getTranslations('Search');
  // City pages are the SEO surface (spec §59); the private dashboards are
  // excluded from indexing by the header rule in next.config.ts.
  return {
    title: city ? t('meta.titleCity', { city }) : t('meta.titleDefault'),
    description: city ? t('meta.descriptionCity', { city }) : t('meta.descriptionDefault'),
    alternates: {
      canonical: getPathname({ locale, href: city ? `/search?city=${encodeURIComponent(city)}` : '/search' }),
    },
  };
}

const str = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: string | string[] | undefined): number | undefined => {
  const s = str(v);
  const n = s === undefined ? NaN : Number(s);
  return Number.isFinite(n) ? n : undefined;
};

// `from`/`to` here are raw, unvalidated query-string values — a malformed or
// reversed pair is a routine URL, not a bug, so nightsBetween()'s
// PricingError is turned into `undefined` (the header line's own "no
// duration to show" state) rather than left to crash the page.
function safeNights(from: string, to: string): number | undefined {
  try {
    return nightsBetween(from, to);
  } catch (e) {
    if (e instanceof PricingError) return undefined;
    throw e;
  }
}

/** "12 июля – 19 июля", for the one-line summary in the header band. */
function formatDateRange(from: string, to: string, locale: AppLocale): string | undefined {
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) return undefined;
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' });
  return `${fmt.format(fromDate)} – ${fmt.format(toDate)}`;
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const locale = (await getLocale()) as AppLocale;
  const t = await getTranslations('Search');

  let result;
  let failure: string | null = null;

  const services = await readyServices();

  try {
    result = await services.search.search({
      city: str(params.city),
      district: str(params.district),
      query: str(params.q),
      from: str(params.from),
      to: str(params.to),
      durationMode: str(params.durationMode) as 'SHORT' | 'MEDIUM' | 'LONG' | undefined,
      guests: num(params.guests),
      rooms: num(params.rooms),
      priceMinMinor: str(params.priceMin),
      priceMaxMinor: str(params.priceMax),
      amenities: str(params.amenities)?.split(',').filter(Boolean),
      instantBooking: str(params.instant) === 'true',
      verifiedOnly: str(params.verified) === 'true',
      pets: str(params.pets) === 'true',
      // Every one of these is enforced server-side by SearchService. A
      // filter the backend cannot apply is not exposed in the UI.
      propertyTypes: str(params.types)?.split(',').filter(Boolean),
      minBeds: num(params.beds),
      smoking: str(params.smoking) === 'true' ? true : undefined,
      children: str(params.children) === 'true' ? true : undefined,
      minRating: num(params.minRating),
      negotiable: str(params.negotiable) === 'true' ? true : undefined,
      ownerKind: str(params.ownerKind) as 'PRIVATE' | 'COMPANY' | undefined,
      sort:
        (str(params.sort) as 'RELEVANCE' | 'PRICE_ASC' | 'PRICE_DESC' | 'RATING' | 'NEWEST') ?? 'RELEVANCE',
      limit: 24,
    });
  } catch (error) {
    // A search failure must not blank the page: the form stays usable so the
    // visitor can change something and try again.
    failure = error instanceof Error && error.name === 'DomainError' ? error.message : null;
    result = { items: [], total: 0, limit: 24, offset: 0 };
  }

  const database = await ready();
  const amenityRows = await database.query<AmenityOption>(
    `SELECT code, category, name_ru, name_be, name_en, icon FROM amenity ORDER BY sort_order`,
  );

  // One query for the whole page rather than one per card.
  const viewer = await currentUser();
  const saved = viewer
    ? await services.favorites.savedAmong(
        viewer.userId,
        result.items.map((i) => i.id),
      )
    : new Set<string>();

  const nights =
    params.from && params.to && typeof params.from === 'string' && typeof params.to === 'string'
      ? safeNights(params.from, params.to)
      : undefined;

  const city = str(params.city);

  // The query the server actually filtered on, flattened for the client
  // filter bar so its chips cannot disagree with these results.
  const appliedQuery: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > 0) appliedQuery[key] = value;
  }

  // One-line summary for the header band. Built straight from what was
  // actually searched on, same as the filter chips below — never invented.
  const guestsParam = str(params.guests);
  const summaryLine = [
    city,
    params.from && params.to && typeof params.from === 'string' && typeof params.to === 'string'
      ? formatDateRange(params.from, params.to, locale)
      : undefined,
    guestsParam ? t('guestsSummary', { count: Number(guestsParam) }) : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  return (
    <div className="container container-wide srch">
      <nav className="srch__crumbs" aria-label={t('breadcrumbsAria')}>
        <Link href="/" className="srch__crumbLink">
          <Icon name="home" size={14} />
          {t('home')}
        </Link>
        <Icon name="chevronRight" size={13} className="srch__crumbSep" />
        <span className="srch__crumbCurrent" aria-current="page">
          {t('current')}
        </span>
      </nav>

      <SearchForm
        compact
        initial={{
          city: str(params.city),
          from: str(params.from),
          to: str(params.to),
          durationMode: str(params.durationMode),
          guests: str(params.guests),
        }}
      />

      <div className="srch__band panel panel-soft">
        <div className="srch__head">
          <h1 className="srch__count">
            {failure ? (
              t('loadingTitle')
            ) : (
              <>
                {t('resultsCount', { count: result.total })}
                {city && t('inCity', { city })}
              </>
            )}
          </h1>
          {nights !== undefined && nights > 0 && (
            <span className="srch__duration">
              {t('forDuration', { duration: formatNightsLocalized(nights, locale) })}
            </span>
          )}
        </div>
        {summaryLine && <p className="srch__summary">{summaryLine}</p>}
      </div>

      <SearchFilters amenities={amenityRows.rows} applied={appliedQuery} />

      {failure && <ErrorState title={t('errorTitle')} detail={t('errorDetail', { failure })} />}

      {!failure && result.items.length === 0 && (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      )}

      {/* Cards title themselves with <h3>; without this the outline jumps
          from the page's <h1> straight to them. */}
      {result.items.length > 0 && <h2 className="sr-only">{t('resultsHeading')}</h2>}

      {result.items.length > 0 && (
        <SearchMobileView
          mapAriaLabel={t('mapAria')}
          markers={result.items.map((i) => ({
            id: i.id,
            latitude: i.location.latitude,
            longitude: i.location.longitude,
            precision: i.location.precision,
            priceMinor: i.stayTotalMinor ?? i.basePriceMinor,
            priceUnit: i.priceUnit,
            title: i.title,
          }))}
        >
          {/* SearchMobileView supplies the .srch__results grid itself. Wrapping
              the cards in a second one here nested a whole grid inside a
              single 300px cell of the outer grid — one card per row on
              desktop, beside two columns of empty space. */}
          {result.items.map((item, index) => (
            <ListingCard
              key={item.id}
              listing={item as unknown as ListingCardData}
              nights={nights}
              initialFavourite={viewer ? saved.has(item.id) : undefined}
              eager={index < 4}
            />
          ))}
        </SearchMobileView>
      )}

      <style>{`
        .srch { padding-block: var(--space-4) var(--space-7); display: grid; gap: var(--space-4); }

        .srch__crumbs {
          display: flex; align-items: center; gap: 0.4rem;
          font-size: var(--text-sm); color: var(--text-secondary);
        }
        .srch__crumbLink { display: inline-flex; align-items: center; gap: 0.3rem; min-height: 1.5rem; }
        @media (hover: hover) and (pointer: fine) {
          .srch__crumbLink:hover { color: var(--primary); }
        }
        .srch__crumbSep { color: var(--text-tertiary); }
        .srch__crumbCurrent { color: var(--text-primary); font-weight: 500; }

        /* A real header band: a quiet sunken ground under the count and the
           one-line summary of what was actually searched, so the results
           read as an answer to a specific question rather than a bare list. */
        .srch__band { display: grid; gap: 0.375rem; }
        .srch__head { display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
        .srch__count { font-size: var(--text-xl); font-weight: 600; letter-spacing: -0.018em; }
        .srch__duration { font-size: var(--text-sm); color: var(--text-secondary); }
        .srch__summary { font-size: var(--text-sm); color: var(--text-secondary); }

      `}</style>
    </div>
  );
}

export function SearchSkeleton() {
  return (
    <div className="srch__results">
      {Array.from({ length: 6 }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}
