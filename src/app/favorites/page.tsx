import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { ListingCard, type ListingCardData } from '@/ui/listing-card.tsx';
import { EmptyState, plural } from '@/ui/primitives.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Избранное',
  // A shortlist says a lot about a person's plans. It is never indexed.
  robots: { index: false, follow: false },
};

export default async function FavoritesPage() {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/favorites'));

  const services = await readyServices();
  const ids = await services.favorites.list(user.userId);

  let items: ListingCardData[] = [];
  if (ids.length > 0) {
    const result = await services.search.search({ ids, limit: 50 });
    // The query returns them in relevance order; the shortlist is more
    // useful newest-saved first, which is the order `list` already gives.
    const byId = new Map(result.items.map((i) => [i.id, i as unknown as ListingCardData]));
    items = ids.map((id) => byId.get(id)).filter((i): i is ListingCardData => i !== undefined);
  }

  // A saved listing that is no longer published simply drops out of the
  // set above. Saying so is better than leaving the user to wonder why
  // the count moved.
  const missing = ids.length - items.length;

  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5) var(--space-7)' }}>
      <header className="stack" style={{ gap: 'var(--space-1)', marginBottom: 'var(--space-5)' }}>
        <h1 className="title-lg">Избранное</h1>
        <p className="text-sm muted">
          {items.length === 0
            ? 'Сохраняйте квартиры, чтобы вернуться к ним позже.'
            : `${items.length} ${plural(items.length, 'квартира', 'квартиры', 'квартир')} в вашем списке.`}
        </p>
      </header>

      {items.length === 0 ? (
        <EmptyState
          title="Пока ничего не сохранено"
          description="Нажмите на сердечко у любого объявления — оно появится здесь."
          action={
            <Link href="/search" className="btn btn-primary">
              Смотреть квартиры
            </Link>
          }
        />
      ) : (
        <>
          <div className="fav-grid">
            {items.map((listing) => (
              <ListingCard key={listing.id} listing={listing} initialFavourite />
            ))}
          </div>
          {missing > 0 && (
            <p className="hint" style={{ marginTop: 'var(--space-4)' }}>
              {missing === 1
                ? 'Одно сохранённое объявление сейчас недоступно — хозяин снял его с публикации.'
                : `${missing} сохранённых объявлений сейчас недоступны — хозяева сняли их с публикации.`}
            </p>
          )}
        </>
      )}

      <style>{`
        .fav-grid {
          display: grid;
          gap: var(--space-5) var(--space-4);
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        }
        @media (max-width: 560px) { .fav-grid { grid-template-columns: 1fr; } }
      `}</style>
    </div>
  );
}
