import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation.ts';
import { getTranslations } from 'next-intl/server';
import { Prose } from '@/ui/prose.tsx';
import { Icon } from '@/ui/icons.tsx';
import { CornflowerField, CornflowerMark } from '@/ui/brand.tsx';
import { Reveal } from '@/ui/reveal.tsx';
import { DEFAULT_SERVICE_FEE_BPS, BPS_DENOMINATOR } from '@/server/domain/money.ts';

const RATE_PERCENT = (BigInt(DEFAULT_SERVICE_FEE_BPS) * 100n) / BPS_DENOMINATOR;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('About');
  return {
    title: t('title'),
    description: t('metaDescription'),
  };
}

/**
 * About.
 *
 * No team section: there is no public/ folder, no real photography, and
 * inventing names and headshots would be exactly the kind of fabrication
 * that makes a site look fake. The visual anchor is the brand mark instead.
 * Every claim below is the same honest framing already carried in the site
 * footer's legal paragraph and the how-it-works page — restated, not
 * invented.
 */
export default async function AboutPage() {
  const t = await getTranslations('About');

  return (
    <>
      <nav className="container about-crumbs" aria-label={t('breadcrumbLabel')}>
        <ol>
          <li>
            <Link href="/">{t('breadcrumbHome')}</Link>
          </li>
          <li aria-hidden="true">
            <Icon name="chevronRight" size={12} />
          </li>
          <li aria-current="page">{t('title')}</li>
        </ol>
      </nav>

      <section className="about-hero">
        <CornflowerField className="about-hero__field" />
        <div className="container about-hero__inner">
          <CornflowerMark size={56} gradient />
          <p className="about-hero__tag">{t('heroTag')}</p>
        </div>
      </section>

      <Prose title={t('title')} lede={t('lede')}>
        <h2>{t('whatWeDo.heading')}</h2>
        <p>{t('whatWeDo.p1')}</p>
        <p>{t('whatWeDo.p2')}</p>

        <h2>{t('whyNeeded.heading')}</h2>
        <p>{t('whyNeeded.intro')}</p>
        <ul>
          <li>{t('whyNeeded.li1')}</li>
          <li>{t('whyNeeded.li2')}</li>
          <li>{t('whyNeeded.li3')}</li>
        </ul>
        <p>
          <Link href="/trust" className="link">
            {t('whyNeeded.trustLink')}
          </Link>
        </p>

        <Reveal as="div">
          <h2>{t('howWeEarn.heading')}</h2>
          <p>{t('howWeEarn.body', { rate: String(RATE_PERCENT) })}</p>
          <p>
            <Link href="/host/fees" className="link">
              {t('howWeEarn.feesLink')}
            </Link>
          </p>

          <h2>{t('contact.heading')}</h2>
          <p>{t('contact.body')}</p>
          <p>
            <Link href="/support" className="link">
              {t('contact.supportLink')}
            </Link>{' '}
            ·{' '}
            <Link href="/faq" className="link">
              {t('contact.faqLink')}
            </Link>
          </p>

          <div className="about-cta">
            <Link href="/search" className="btn btn-secondary">
              {t('cta.browse')}
            </Link>
            <Link href="/dashboard/listings/new" className="btn btn-primary">
              {t('cta.publish')}
            </Link>
          </div>
        </Reveal>
      </Prose>

      <style>{`
        .about-crumbs { padding-top: var(--space-4); max-width: 42rem; margin-inline: auto; }
        .about-crumbs ol {
          display: flex; align-items: center; gap: 0.35rem;
          list-style: none; margin: 0; padding: 0;
          font-size: var(--text-xs); color: var(--text-tertiary);
        }
        .about-crumbs li { display: flex; align-items: center; }
        .about-crumbs a { color: var(--text-secondary); min-height: 1.75rem; display: inline-flex; align-items: center; }
        @media (hover: hover) and (pointer: fine) {
          .about-crumbs a:hover { color: var(--primary); text-decoration: underline; text-underline-offset: 3px; }
        }
        .about-crumbs li[aria-current='page'] { color: var(--text-primary); font-weight: 500; }

        /* A quiet brand band, not a photograph nobody has. Same gradient the
           home hero uses, scaled down — this page has no inventory to sell,
           just an identity to state plainly. */
        .about-hero {
          position: relative;
          overflow: hidden;
          margin-top: var(--space-4);
          padding-block: var(--space-6);
          background: var(--gradient-hero);
        }
        .about-hero__field { z-index: 0; }
        .about-hero__inner {
          position: relative; z-index: 1;
          display: flex; flex-direction: column; align-items: center; gap: var(--space-3);
          text-align: center;
        }
        .about-hero__tag {
          max-width: 30rem;
          font-size: var(--text-lg);
          color: var(--color-corn-100);
        }

        .about-cta { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-4); }
      `}</style>
    </>
  );
}
