import { Link } from '@/i18n/navigation.ts';
import { getTranslations } from 'next-intl/server';
import { SearchForm } from '@/ui/search-form.tsx';
import { ListingCard, type ListingCardData } from '@/ui/listing-card.tsx';
import { EmptyState } from '@/ui/primitives.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';
import { CornflowerField, CornflowerMark } from '@/ui/brand.tsx';
import { Reveal } from '@/ui/reveal.tsx';
import { ready } from '@/server/runtime.ts';
import { SearchService } from '@/server/services/search-service.ts';

export const dynamic = 'force-dynamic';

// The href value stays the Russian city name in every locale — that's the
// exact string search-service.ts matches against `p.city` in the database
// (`lower(p.city) = lower(...)`), which is itself stored only in Russian.
// Only the visible chip label is localized.
const CITIES = [
  { value: 'Минск', key: 'minsk' },
  { value: 'Гродно', key: 'grodno' },
  { value: 'Брест', key: 'brest' },
  { value: 'Витебск', key: 'vitebsk' },
  { value: 'Гомель', key: 'gomel' },
  { value: 'Могилёв', key: 'mogilev' },
] as const;

const TRUST_ICONS: { icon: IconName; key: 'price' | 'identity' | 'reviews' | 'history' }[] = [
  { icon: 'eye', key: 'price' },
  { icon: 'shieldCheck', key: 'identity' },
  { icon: 'star', key: 'reviews' },
  { icon: 'message', key: 'history' },
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
  const t = await getTranslations('Home');

  const TRUST: { icon: IconName; title: string; body: string }[] = TRUST_ICONS.map(({ icon, key }) => ({
    icon,
    title: t(`trust.${key}.title`),
    body: t(`trust.${key}.body`),
  }));

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
        title: t('empty.failedTitle'),
        description: t('empty.failedDescription'),
      }
    : {
        title: t('empty.noneTitle'),
        description: t('empty.noneDescription'),
      };

  return (
    <>
      <section className="home-hero">
        <div className="home-hero__band">
          <CornflowerField className="home-hero__field" />
          <div className="container home-hero__inner">
            <span className="home-hero__kicker">
              <CornflowerMark size={16} />
              {t('kicker')}
            </span>
            <h1 className="display home-hero__title">{t('title')}</h1>
            <p className="home-hero__sub">{t('subtitle')}</p>
          </div>
        </div>

        <div className="container home-hero__search">
          <SearchForm />

          <nav className="scroll-x home-cities" aria-label={t('citiesAria')}>
            {CITIES.map((city) => (
              <Link
                key={city.key}
                href={`/search?city=${encodeURIComponent(city.value)}`}
                className="chip chip-sm"
              >
                {t(`cities.${city.key}`)}
              </Link>
            ))}
          </nav>
        </div>
      </section>

      <section className="container home-listings" aria-labelledby="recent-heading">
        <div className="home-head">
          <h2 id="recent-heading" className="title-lg">
            {t('recentHeading')}
          </h2>
          <Link href="/search" className="link home-more">
            <span>{t('allListings')}</span>
            <Icon name="arrowRight" size={16} />
          </Link>
        </div>

        {featured.length > 0 ? (
          <div className="home-grid">
            {featured.map((listing, index) => (
              <ListingCard key={listing.id} listing={listing} eager={index < 4} />
            ))}
          </div>
        ) : (
          <EmptyState
            title={empty.title}
            description={empty.description}
            action={
              <Link href="/search" className="btn btn-secondary">
                {t('goToSearch')}
              </Link>
            }
          />
        )}
      </section>

      <Reveal as="section" className="container home-trust">
        <hr className="hairline" />
        <h2 id="trust-heading" className="title-lg">
          {t('trustHeading')}
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
      </Reveal>

      <Reveal as="section" className="home-host">
        <div className="container home-host__inner">
          <div className="home-host__copy">
            <h2 id="host-heading" className="title-md">
              {t('hostHeading')}
            </h2>
            <p>{t('hostBody')}</p>
          </div>
          <Link href="/dashboard/listings/new" className="btn btn-primary btn-lg home-host__cta">
            {t('hostCta')}
          </Link>
        </div>
      </Reveal>

      <style>{`
        /* The hero now carries a ground — a deep cornflower band with the mark
           scattered across it — and the search module floats half over its
           lower edge. That overlap is the one deliberate elevation above the
           grid on this page: everything else still sits flat. */
        .home-hero { padding-bottom: var(--space-4); }
        .home-hero__band {
          position: relative;
          overflow: hidden;
          background: var(--gradient-hero);
          padding-block: var(--space-6) var(--space-7);
        }
        .home-hero__field { z-index: 0; }
        .home-hero__inner { position: relative; z-index: 1; display: flex; flex-direction: column; }
        .home-hero__kicker {
          display: inline-flex; align-items: center; gap: 0.4rem;
          align-self: flex-start;
          margin-bottom: var(--space-3);
          padding: 0.3rem 0.7rem 0.3rem 0.55rem;
          border-radius: var(--radius-full);
          background: rgb(255 255 255 / 0.12);
          color: var(--color-corn-100);
          font-size: var(--text-xs);
          font-weight: 600;
        }
        .home-hero__title { max-width: 40rem; color: #fff; }
        .home-hero__sub {
          margin-top: var(--space-3);
          max-width: 34rem;
          font-size: var(--text-lg);
          color: var(--color-corn-100);
        }

        .home-hero__search { margin-top: calc(-1 * var(--space-7)); position: relative; z-index: 2; }

        /* Scrolls on a phone and bleeds to the screen edge, so a half-visible
           chip reads as "more to the right" instead of as a clipped row. The
           block padding is there to keep focus rings out of the scroll clip. */
        .home-cities {
          margin: calc(var(--space-3) - 3px) -1rem -3px;
          padding: 3px 1rem;
        }
        .home-cities .chip { min-height: 2.5rem; padding-inline: 0.85rem; }

        .home-listings { margin-top: var(--space-6); }
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
        @media (hover: hover) and (pointer: fine) {
          .home-head .link:hover { text-decoration: none; }
          .home-head .link:hover span { text-decoration: underline; text-underline-offset: 3px; }
        }
        .home-head .link svg { transition: transform 140ms ease; }
        @media (hover: hover) and (pointer: fine) {
          .home-head .link:hover svg { transform: translateX(2px); }
        }

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
        .home-trust__glyph {
          display: inline-flex; align-items: center; justify-content: center;
          width: 2.75rem; height: 2.75rem;
          margin-bottom: var(--space-3);
          border-radius: var(--radius-full);
          background: var(--primary-soft);
          color: var(--primary);
        }
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
          .home-hero__band { padding-block: var(--space-7) calc(var(--space-7) + var(--space-3)); }
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
