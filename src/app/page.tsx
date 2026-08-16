import { Suspense } from 'react';
import Link from 'next/link';
import { SearchForm } from '@/ui/search-form.tsx';
import { ListingCard, type ListingCardData } from '@/ui/listing-card.tsx';
import { CardSkeleton } from '@/ui/primitives.tsx';
import { ready } from '@/server/runtime.ts';
import { SearchService } from '@/server/services/search-service.ts';

export const dynamic = 'force-dynamic';

const CITIES = ['Минск', 'Гродно', 'Брест', 'Витебск', 'Гомель', 'Могилёв'];

/**
 * Home.
 *
 * Redesign rationale (UI_UX_AUDIT §4): the previous homepage was a marketing
 * landing page — a promise block, then a second promise block, then a landlord
 * CTA, and no actual inventory anywhere. A marketplace has to show what it has.
 * Search is dominant, real listings follow immediately, and the reasons to
 * trust us sit *below* the evidence rather than in place of it.
 */
export default async function HomePage() {
  let featured: ListingCardData[] = [];
  try {
    const service = new SearchService(await ready());
    const result = await service.search({ sort: 'RELEVANCE', limit: 6 });
    featured = result.items as unknown as ListingCardData[];
  } catch {
    // The homepage still works without inventory; the search box is the point.
    featured = [];
  }

  return (
    <>
      <section className="hero">
        <div className="container stack" style={{ gap: 'var(--space-5)' }}>
          <div className="stack" style={{ gap: 'var(--space-3)', maxWidth: '46rem' }}>
            <h1 className="display">Квартира на нужный вам срок</h1>
            <p className="hero__sub prose">
              На сутки, на месяц или на год. Итоговая цена видна до бронирования, а отзывы оставляют
              только те, кто действительно снимал.
            </p>
          </div>

          <Suspense fallback={<div className="skeleton" style={{ height: '7rem' }} />}>
            <SearchForm />
          </Suspense>

          <nav className="scroll-x" aria-label="Популярные города">
            {CITIES.map((city) => (
              <Link key={city} href={`/search?city=${encodeURIComponent(city)}`} className="chip">
                {city}
              </Link>
            ))}
          </nav>
        </div>
      </section>

      <section className="container section" aria-labelledby="featured-heading">
        <div className="row" style={{ justifyContent: 'space-between', gap: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
          <h2 id="featured-heading" className="title-lg">
            Недавно опубликованные
          </h2>
          <Link href="/search" className="btn btn-ghost btn-sm">
            Все объявления →
          </Link>
        </div>

        {featured.length > 0 ? (
          <div className="home-grid">
            {featured.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </div>
        ) : (
          <div className="home-grid" aria-hidden="true">
            {Array.from({ length: 3 }, (_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        )}
      </section>

      <section className="container section" aria-labelledby="trust-heading">
        <h2 id="trust-heading" className="title-lg" style={{ marginBottom: 'var(--space-4)' }}>
          Почему Кватэрка
        </h2>
        <div className="trust-grid">
          {[
            {
              title: 'Итоговая цена сразу',
              body:
                'Аренда, уборка и обязательные платежи показаны одной суммой. То, что нельзя ' +
                'посчитать заранее — коммуналку по счётчику — помечаем отдельно, а не прячем.',
            },
            {
              title: 'Понятно, с кем имеете дело',
              body:
                'Подтверждение личности и проверка права сдавать объект — разные отметки, ' +
                'и мы их не смешиваем. Компании обозначены как компании.',
            },
            {
              title: 'Отзывы после реальных сделок',
              body:
                'Отзыв можно оставить только по завершённой аренде. Оба отзыва открываются ' +
                'одновременно, чтобы никто не подстраивал оценку под чужую.',
            },
            {
              title: 'История остаётся у вас',
              body:
                'Переписка, даты и условия сохраняются. Если возникнет спор, обеим сторонам ' +
                'есть на что сослаться.',
            },
          ].map((item) => (
            <article key={item.title} className="trust-item">
              <h3 className="trust-item__title">{item.title}</h3>
              <p className="trust-item__body">{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="container" style={{ paddingBottom: 'var(--space-7)' }}>
        <div className="host-cta">
          <div className="stack grow" style={{ gap: 'var(--space-2)' }}>
            <h2 style={{ fontSize: 'var(--text-xl)' }}>Сдаёте квартиру?</h2>
            <p className="prose" style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
              Разместить объявление бесплатно. Сервисный сбор 5% — только после того, как аренда
              состоялась и это подтвердили обе стороны. Деньги за аренду вы получаете напрямую.
            </p>
          </div>
          <Link href="/dashboard/listings/new" className="btn btn-primary btn-lg">
            Разместить объявление
          </Link>
        </div>
      </section>

      <style>{`
        .hero {
          padding-block: var(--space-6) var(--space-7);
          background:
            linear-gradient(180deg, var(--primary-soft) 0%, transparent 60%),
            var(--background);
        }
        .hero__sub { font-size: var(--text-lg); color: var(--text-secondary); }

        .home-grid, .trust-grid { display: grid; gap: var(--space-4); }
        .home-grid { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
        @media (max-width: 560px) { .home-grid { grid-template-columns: 1fr; } }

        /* Plain columns, not four bordered cards. The rule is one column of
           text per idea; a box adds nothing here. */
        .trust-grid { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-5); }
        .trust-item__title {
          font-size: var(--text-base); font-weight: 650;
          margin-bottom: var(--space-2);
          padding-top: var(--space-2);
          border-top: 2px solid var(--primary);
          display: inline-block;
        }
        .trust-item__body { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; }

        .host-cta {
          display: flex; flex-direction: column; gap: var(--space-4);
          align-items: flex-start;
          padding: var(--space-5);
          border-radius: var(--radius-md);
          background: var(--surface-sunken);
        }
        @media (min-width: 720px) { .host-cta { flex-direction: row; align-items: center; } }
      `}</style>
    </>
  );
}
