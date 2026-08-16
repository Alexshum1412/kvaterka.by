import Link from 'next/link';
import { SearchForm } from '@/ui/search-form.tsx';
import { ListingCard, type ListingCardData } from '@/ui/listing-card.tsx';
import { EmptyState } from '@/ui/primitives.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';
import { ready } from '@/server/runtime.ts';
import { SearchService } from '@/server/services/search-service.ts';

export const dynamic = 'force-dynamic';

const CITIES = ['Минск', 'Гродно', 'Брест', 'Витебск', 'Гомель', 'Могилёв'];

const TRUST: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'eye',
    title: 'Итоговая цена сразу',
    body:
      'Аренда, уборка и обязательные платежи показаны одной суммой. То, что нельзя ' +
      'посчитать заранее — коммуналку по счётчику — помечаем отдельно, а не прячем.',
  },
  {
    icon: 'shieldCheck',
    title: 'Понятно, с кем имеете дело',
    body:
      'Подтверждение личности и проверка права сдавать объект — разные отметки, ' +
      'и мы их не смешиваем. Компании обозначены как компании.',
  },
  {
    icon: 'star',
    title: 'Отзывы после реальных сделок',
    body:
      'Отзыв можно оставить только по завершённой аренде. Оба отзыва открываются ' +
      'одновременно, чтобы никто не подстраивал оценку под чужую.',
  },
  {
    icon: 'message',
    title: 'История остаётся у вас',
    body:
      'Переписка, даты и условия сохраняются. Если возникнет спор, обеим сторонам ' +
      'есть на что сослаться.',
  },
];

/**
 * Home.
 *
 * A marketplace front page, so the composition is: one sentence of orientation,
 * the search module, and then inventory. Everything that explains the product
 * sits *below* the evidence rather than in place of it.
 *
 * The hero deliberately has no ground of its own. On the near-white page the
 * only lifted object above the fold is the search form, which is what makes it
 * read as the entry point without a coloured band doing the shouting.
 */
export default async function HomePage() {
  let featured: ListingCardData[] = [];
  let failed = false;
  try {
    const service = new SearchService(await ready());
    const result = await service.search({ sort: 'RELEVANCE', limit: 6 });
    featured = result.items as unknown as ListingCardData[];
  } catch {
    // The homepage still works without inventory; the search box is the point.
    featured = [];
    failed = true;
  }

  // Two different silences, and the visitor deserves to know which one it is.
  const empty = failed
    ? {
        title: 'Объявления сейчас не загрузились',
        description: 'Похоже, это временный сбой. Обновите страницу или откройте поиск.',
      }
    : {
        title: 'Пока нет опубликованных объявлений',
        description: 'Как только хозяева опубликуют жильё, оно появится здесь.',
      };

  return (
    <>
      <section className="home-hero">
        <div className="container home-hero__inner">
          <h1 className="display home-hero__title">Найдите квартиру на нужный срок</h1>
          <p className="home-hero__sub">На сутки, на месяц или на год — по всей Беларуси.</p>

          <SearchForm />

          <nav className="scroll-x home-cities" aria-label="Популярные города">
            {CITIES.map((city) => (
              <Link key={city} href={`/search?city=${encodeURIComponent(city)}`} className="chip chip-sm">
                {city}
              </Link>
            ))}
          </nav>
        </div>
      </section>

      <section className="container home-listings" aria-labelledby="recent-heading">
        <div className="home-head">
          <h2 id="recent-heading" className="title-lg">
            Недавно опубликованные
          </h2>
          <Link href="/search" className="link home-more">
            <span>Все объявления</span>
            <Icon name="arrowRight" size={16} />
          </Link>
        </div>

        {featured.length > 0 ? (
          <div className="home-grid">
            {featured.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </div>
        ) : (
          <EmptyState
            title={empty.title}
            description={empty.description}
            action={
              <Link href="/search" className="btn btn-secondary">
                Перейти к поиску
              </Link>
            }
          />
        )}
      </section>

      <section className="container home-trust" aria-labelledby="trust-heading">
        <hr className="hairline" />
        <h2 id="trust-heading" className="title-lg">
          Почему Кватэрка
        </h2>
        <div className="home-trust__grid">
          {TRUST.map((item) => (
            <article key={item.title} className="home-trust__item">
              <span className="home-trust__glyph">
                <Icon name={item.icon} size={20} />
              </span>
              <h3 className="home-trust__title">{item.title}</h3>
              <p className="home-trust__body">{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="home-host" aria-labelledby="host-heading">
        <div className="container home-host__inner">
          <div className="home-host__copy">
            <h2 id="host-heading" className="title-md">
              Сдаёте квартиру?
            </h2>
            <p>
              Разместить объявление бесплатно. Сервисный сбор 5% — только после того, как аренда
              состоялась и это подтвердили обе стороны. Деньги за аренду вы получаете напрямую.
            </p>
          </div>
          <Link href="/dashboard/listings/new" className="btn btn-primary btn-lg home-host__cta">
            Разместить объявление
          </Link>
        </div>
      </section>

      <style>{`
        /* The hero carries no ground and no wash. Its height budget is spent on
           the H1, one line of orientation and the search module — anything else
           pushes inventory off a 900px-tall screen. */
        .home-hero { padding-block: var(--space-4) var(--space-3); }
        .home-hero__inner { display: flex; flex-direction: column; }
        .home-hero__title { max-width: 46rem; }
        .home-hero__sub {
          margin-top: var(--space-2);
          margin-bottom: var(--space-4);
          max-width: 44rem;
          font-size: var(--text-base);
          color: var(--text-secondary);
        }

        /* Scrolls on a phone and bleeds to the screen edge, so a half-visible
           chip reads as "more to the right" instead of as a clipped row. The
           block padding is there to keep focus rings out of the scroll clip. */
        .home-cities {
          margin: calc(var(--space-3) - 3px) -1rem -3px;
          padding: 3px 1rem;
        }
        .home-cities .chip { min-height: 2.5rem; padding-inline: 0.85rem; }

        .home-listings { margin-top: var(--space-4); }
        .home-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: var(--space-2) var(--space-4);
          margin-bottom: var(--space-3);
        }
        /* The heading owns the weight in this row; the link is a way out, not a
           second headline. */
        .home-head .link { font-weight: 500; font-size: var(--text-sm); min-height: 2.5rem; }
        .home-head .link:hover { text-decoration: none; }
        .home-head .link:hover span { text-decoration: underline; text-underline-offset: 3px; }
        .home-head .link svg { transition: transform 140ms ease; }
        .home-head .link:hover svg { transform: translateX(2px); }

        .home-grid {
          display: grid;
          gap: var(--space-5);
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        }
        @media (max-width: 560px) { .home-grid { grid-template-columns: 1fr; } }

        /* Plain columns of text. Four boxes here would turn the reasons to
           trust us into an advertisement; a glyph and whitespace are enough. */
        .home-trust { margin-top: var(--space-7); }
        .home-trust hr { margin-bottom: var(--space-6); }
        .home-trust h2 { margin-bottom: var(--space-5); }
        .home-trust__grid {
          display: grid;
          gap: var(--space-5) var(--space-6);
          grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        }
        .home-trust__glyph { display: block; margin-bottom: var(--space-3); color: var(--primary); }
        .home-trust__title { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-2); }
        .home-trust__body { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; }

        .home-host {
          margin-top: var(--space-7);
          padding-block: var(--space-6);
          background: var(--surface-sunken);
        }
        .home-host__inner { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-4); }
        .home-host__copy { display: flex; flex-direction: column; gap: var(--space-2); }
        .home-host__copy p {
          max-width: 56ch;
          font-size: var(--text-sm);
          color: var(--text-secondary);
          line-height: 1.6;
        }

        @media (min-width: 768px) {
          .home-hero { padding-block: var(--space-6) var(--space-5); }
          .home-hero__sub { font-size: var(--text-lg); }
          .home-cities { margin-inline: -1.5rem; padding-inline: 1.5rem; }
        }
        @media (min-width: 840px) {
          .home-host { padding-block: var(--space-7); }
          .home-host__inner { flex-direction: row; align-items: center; justify-content: space-between; gap: var(--space-6); }
          .home-host__cta { flex: 0 0 auto; }
        }
      `}</style>
    </>
  );
}
