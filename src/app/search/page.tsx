import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SearchForm } from '@/ui/search-form.tsx';
import { ListingCard, type ListingCardData } from '@/ui/listing-card.tsx';
import { MapPanel } from '@/ui/map-panel.tsx';
import { CardSkeleton, EmptyState, ErrorState, formatNights, plural } from '@/ui/primitives.tsx';
import { ready } from '@/server/runtime.ts';
import { SearchService } from '@/server/services/search-service.ts';

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

  try {
    const service = new SearchService(await ready());
    result = await service.search({
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
      sort: (str(params.sort) as 'RELEVANCE' | 'PRICE_ASC' | 'PRICE_DESC' | 'RATING' | 'NEWEST') ?? 'RELEVANCE',
      limit: 24,
    });
  } catch (error) {
    // A search failure must not blank the page: the form stays usable so the
    // user can change something and try again.
    failure = error instanceof Error && error.name === 'DomainError' ? error.message : null;
    result = { items: [], total: 0, limit: 24, offset: 0 };
  }

  const nights =
    params.from && params.to && typeof params.from === 'string' && typeof params.to === 'string'
      ? Math.round(
          (Date.parse(`${params.to}T00:00:00Z`) - Date.parse(`${params.from}T00:00:00Z`)) / 86_400_000,
        )
      : undefined;

  const activeFilters = [
    str(params.instant) === 'true' && 'Мгновенное бронирование',
    str(params.verified) === 'true' && 'Только проверенные',
    str(params.pets) === 'true' && 'Можно с животными',
  ].filter(Boolean) as string[];

  return (
    <div className="container" style={{ paddingBlock: '1.25rem' }}>
      <Suspense fallback={<div className="skeleton" style={{ height: '6rem' }} />}>
        <SearchForm compact />
      </Suspense>

      <div className="row" style={{ gap: '0.625rem', flexWrap: 'wrap', paddingBlock: 'var(--space-4)' }}>
        <h1 className="title-lg">
          {failure ? 'Поиск' : `${result.total} ${plural(result.total, 'объект', 'объекта', 'объектов')}`}
          {str(params.city) && !failure && ` в городе ${str(params.city)}`}
        </h1>
        {nights !== undefined && nights > 0 && (
          <span className="badge badge-neutral">на {formatNights(nights)}</span>
        )}
        {activeFilters.map((f) => (
          <span key={f} className="badge badge-primary">
            {f}
          </span>
        ))}
      </div>

      {failure && (
        <ErrorState
          title="Не удалось выполнить поиск"
          detail={`${failure} Измените параметры и попробуйте снова.`}
        />
      )}

      {!failure && result.items.length === 0 && (
        <EmptyState
          title="Ничего не найдено"
          description="Попробуйте расширить даты, увеличить бюджет или убрать часть фильтров. Также можно посмотреть соседние районы."
        />
      )}

      {result.items.length > 0 && (
        <div className="search-layout">
          <div className="search-results">
            {result.items.map((item) => (
              <ListingCard key={item.id} listing={item as unknown as ListingCardData} nights={nights} />
            ))}
          </div>

          <aside className="search-map" aria-label="Карта результатов">
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
        .search-layout { display: grid; gap: var(--space-5); }
        /* Minimum 300px, so photos stay large and titles stop wrapping to
           three lines. Two columns is the right density for browsing housing;
           three only once there is genuinely room. */
        .search-results {
          display: grid;
          gap: var(--space-4);
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        }
        @media (max-width: 560px) {
          /* On a phone this becomes a photo feed, which is what browsing
             housing actually is. */
          .search-results { grid-template-columns: 1fr; gap: var(--space-5); }
        }
        /* On a phone the listings come FIRST. The map was previously ordered
           above them, which pushed inventory 320px down the page — exactly the
           mistake the audit flagged on the homepage. */
        .search-map { min-height: 18rem; order: 1; margin-top: var(--space-2); }
        @media (min-width: 1024px) {
          .search-layout { grid-template-columns: minmax(0, 1fr) 22rem; align-items: start; }
          .search-map {
            order: 0;
            position: sticky;
            top: 4.75rem;
            height: calc(100vh - 6.5rem);
          }
        }
      `}</style>
    </div>
  );
}

export function SearchSkeleton() {
  return (
    <div className="search-results">
      {Array.from({ length: 6 }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}
