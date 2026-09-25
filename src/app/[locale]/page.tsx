import { Link } from '@/i18n/navigation.ts';
import { getTranslations } from 'next-intl/server';
import { SearchForm } from '@/ui/search-form.tsx';
import { ListingCard, type ListingCardData } from '@/ui/listing-card.tsx';
import { EmptyState } from '@/ui/primitives.tsx';
import { Icon } from '@/ui/icons.tsx';
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

const TRUST_KEYS = ['price', 'identity', 'reviews', 'history'] as const;

/**
 * Home.
 *
 * A marketplace front page, so the composition is: one sentence of orientation,
 * the search module, and then inventory. Everything that explains the product
 * sits *below* the evidence rather than in place of it.
 *
 * The hero band is the page's one coloured ground; the search form floats half
 * over its lower edge and is the only lifted object above the fold, which is
 * what makes it read as the entry point.
 */
export default async function HomePage() {
  const t = await getTranslations('Home');

  const TRUST = TRUST_KEYS.map((key) => ({
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
        <div className="home-trust__intro">
          <h2 id="trust-heading" className="title-lg">
            {t('trustHeading')}
          </h2>
          <Link href="/trust" className="link home-more">
            <span>{t('trustMore')}</span>
            <Icon name="arrowRight" size={16} />
          </Link>
        </div>
        <ol className="home-trust__list" aria-labelledby="trust-heading">
          {TRUST.map((item, index) => (
            <li key={item.title} className="home-trust__item">
              <span className="home-trust__num numeric" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="home-trust__title">{item.title}</h3>
              <p className="home-trust__body">{item.body}</p>
            </li>
          ))}
        </ol>
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
        /* One flat gradient and the scattered marks, nothing more. A sky-blue
           radial "light source" was tried here (DEC-085) and impeccable's
           detector rejected it as the stock spotlight-glow decoration; the
           cornflower field already gives the band its texture. */
        .home-hero__band {
          position: relative;
          overflow: hidden;
          background: var(--gradient-hero);
          padding-block: var(--space-6) var(--space-7);
        }
        .home-hero__field { z-index: 0; }
        .home-hero__inner { position: relative; z-index: 1; display: flex; flex-direction: column; }
        /* An eyebrow, not a pill: the translucent capsule-above-the-H1 is the
           most copied hero trope there is, and the mark already does the job
           of making this line feel like ours. */
        .home-hero__kicker {
          display: inline-flex; align-items: center; gap: 0.45rem;
          align-self: flex-start;
          margin-bottom: var(--space-3);
          color: var(--color-corn-200);
          font-size: var(--text-sm);
          font-weight: 500;
          letter-spacing: 0.01em;
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
        .home-cities .chip { min-height: 2.75rem; padding-inline: 0.85rem; }

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
        .home-head .link { font-weight: 500; font-size: var(--text-sm); min-height: 2.75rem; }
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

        /* Four promises, read in order, so they are an ordered list with the
           number doing what an icon-in-a-circle used to pretend to: an eye, a
           shield, a star and a speech bubble said nothing the titles did not.
           Desktop splits the heading off into its own narrower column so the
           block reads as an argument, not as the four-equal-tiles feature row
           every template ships. Hairlines, not boxes, separate the points. */
        .home-trust {
          display: grid; gap: var(--space-5);
          margin-top: var(--space-7);
          padding-top: var(--space-6);
          border-top: 1px solid var(--border);
        }
        .home-trust__intro { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); }
        .home-trust__intro .link { font-weight: 500; font-size: var(--text-sm); min-height: 2.75rem; }
        .home-trust__list {
          display: grid; gap: 0 var(--space-6);
          margin: 0; padding: 0; list-style: none;
        }
        .home-trust__item {
          display: grid; grid-template-columns: 2.5rem minmax(0, 1fr);
          align-content: start;
          column-gap: var(--space-3); row-gap: var(--space-1);
          padding-block: var(--space-4);
          border-top: 1px solid var(--border);
        }
        .home-trust__item:first-child { border-top: 0; padding-top: 0; }
        /* The four points arrive in reading order, 60ms apart, when the
           section scrolls in (<Reveal> swaps .reveal-init for .reveal-in).
           Order is the content here — 01 before 04 — so the stagger says
           something; it never delays anything a visitor could act on. */
        .home-trust__item { transition: opacity 360ms var(--ease-out), transform 360ms var(--ease-out); }
        .home-trust.reveal-init:not(.reveal-in) .home-trust__item { opacity: 0; transform: translateY(8px); }
        .home-trust.reveal-in .home-trust__item:nth-child(2) { transition-delay: 60ms; }
        .home-trust.reveal-in .home-trust__item:nth-child(3) { transition-delay: 120ms; }
        .home-trust.reveal-in .home-trust__item:nth-child(4) { transition-delay: 180ms; }
        .home-trust__num {
          grid-row: span 2;
          font-size: var(--text-xl); font-weight: 600; line-height: 1.2;
          letter-spacing: -0.02em;
          color: var(--primary);
        }
        .home-trust__title { font-size: var(--text-base); font-weight: 600; line-height: 1.35; }
        .home-trust__body { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.6; max-width: 46ch; }

        @media (min-width: 900px) {
          .home-trust { grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: var(--space-7); }
          .home-trust__intro { position: sticky; top: calc(var(--header-height) + var(--space-5)); align-self: start; }
          .home-trust__list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .home-trust__item:nth-child(2) { border-top: 0; padding-top: 0; }
        }

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
