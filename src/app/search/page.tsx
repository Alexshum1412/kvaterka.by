import type { Metadata } from 'next';
import { SearchForm } from '@/ui/search-form.tsx';
import { SearchFilters, type AmenityOption } from '@/ui/search-filters.tsx';
import { ListingCard, type ListingCardData } from '@/ui/listing-card.tsx';
import { MapPanel } from '@/ui/map-panel.tsx';
import { CardSkeleton, EmptyState, ErrorState, formatNights, plural } from '@/ui/primitives.tsx';
import { ready, readyServices } from '@/server/runtime.ts';
import { currentUser } from '@/server/session.ts';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const params = await searchParams;
  const city = typeof params.city === 'string' ? params.city : null;
  // City pages are the SEO surface (spec §59); the private dashboards are
  // excluded from indexing by the header rule in next.config.ts.
  return {
    title: city ? `Аренда жилья в городе ${city}` : 'Поиск жилья',
    description: city
      ? `Квартиры и дома в аренду в городе ${city}: посуточно, на месяц и на длительный срок. Честная итоговая цена.`
      : 'Поиск жилья в аренду по всей Беларуси.',
    alternates: { canonical: city ? `/search?city=${encodeURIComponent(city)}` : '/search' },
  };
}

const str = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: string | string[] | undefined): number | undefined => {
  const s = str(v);
  const n = s === undefined ? NaN : Number(s);
  return Number.isFinite(n) ? n : undefined;
};

export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;

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
      sort:
        (str(params.sort) as 'RELEVANCE' | 'PRICE_ASC' | 'PRICE_DESC' | 'RATING' | 'NEWEST') ??
        'RELEVANCE',
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
    `SELECT code, category, name_ru, icon FROM amenity ORDER BY sort_order`,
  );

  // One query for the whole page rather than one per card.
  const viewer = await currentUser();
  const saved = viewer
    ? await services.favorites.savedAmong(viewer.userId, result.items.map((i) => i.id))
    : new Set<string>();

  const nights =
    params.from && params.to && typeof params.from === 'string' && typeof params.to === 'string'
      ? Math.round(
          (Date.parse(`${params.to}T00:00:00Z`) - Date.parse(`${params.from}T00:00:00Z`)) / 86_400_000,
        )
      : undefined;

  const city = str(params.city);

  // The query the server actually filtered on, flattened for the client
  // filter bar so its chips cannot disagree with these results.
  const appliedQuery: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > 0) appliedQuery[key] = value;
  }

  return (
    <div className="container srch">
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

      <div className="srch__head">
        <h1 className="srch__count">
          {failure ? (
            'Поиск'
          ) : (
            <>
              {result.total} {plural(result.total, 'вариант', 'варианта', 'вариантов')}
              {city && ` в городе ${city}`}
            </>
          )}
        </h1>
        {nights !== undefined && nights > 0 && (
          <span className="srch__duration">на {formatNights(nights)}</span>
        )}
      </div>

      <SearchFilters amenities={amenityRows.rows} applied={appliedQuery} />

      {failure && (
        <ErrorState
          title="Не удалось выполнить поиск"
          detail={`${failure} Измените параметры и попробуйте снова.`}
        />
      )}

      {!failure && result.items.length === 0 && (
        <EmptyState
          title="Ничего не нашли"
          description="Попробуйте изменить район или срок аренды — или уберите часть фильтров."
        />
      )}

      {result.items.length > 0 && (
        <div className="srch__layout">
          <div className="srch__results">
            {result.items.map((item) => (
              <ListingCard
                key={item.id}
                listing={item as unknown as ListingCardData}
                nights={nights}
                initialFavourite={viewer ? saved.has(item.id) : undefined}
              />
            ))}
          </div>

          <aside className="srch__map" id="map" aria-label="Карта результатов">
            <MapPanel
              markers={result.items.map((i) => ({
                id: i.id,
                latitude: i.location.latitude,
                longitude: i.location.longitude,
                precision: i.location.precision,
                priceMinor: i.stayTotalMinor ?? i.basePriceMinor,
                priceUnit: i.priceUnit,
                title: i.title,
              }))}
            />
          </aside>
        </div>
      )}

      <style>{`
        .srch { padding-block: var(--space-4) var(--space-7); display: grid; gap: var(--space-4); }
        .srch__head { display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
        .srch__count { font-size: var(--text-xl); font-weight: 600; letter-spacing: -0.018em; }
        .srch__duration { font-size: var(--text-sm); color: var(--text-secondary); }

        .srch__layout { display: grid; gap: var(--space-5); }
        .srch__results {
          display: grid;
          gap: var(--space-5) var(--space-4);
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        }
        @media (max-width: 560px) {
          /* On a phone this becomes a photo feed, which is what browsing
             housing actually is. */
          .srch__results { grid-template-columns: 1fr; gap: var(--space-6); }
        }

        /* Listings come FIRST on a phone. The map is reachable from the
           filter bar rather than sitting on top of the inventory. */
        .srch__map { order: 1; min-height: 20rem; scroll-margin-top: 5rem; }
        @media (min-width: 1024px) {
          .srch__layout { grid-template-columns: minmax(0, 1fr) 21rem; align-items: start; }
          .srch__map {
            order: 0;
            position: sticky;
            top: calc(var(--header-height) + 0.75rem);
            /* dvh, not vh: iOS Safari changes the viewport as the toolbar
               collapses and vh makes the panel jump. */
            height: calc(100dvh - var(--header-height) - 1.5rem);
          }
        }
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
