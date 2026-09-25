import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation.ts';
import { CornflowerMark } from './brand.tsx';

/**
 * The site footer.
 *
 * It sits on the page ground rather than on its own surface: a footer that
 * is lighter than the content above it stops competing with it, and a single
 * hairline is enough to say where the page ends.
 *
 * The legal paragraph stays. It is small and grey because it is reference
 * text, not a promise — but it states plainly what Кватэрка.by is and is
 * not, and that is the one thing on this page that may never be trimmed for
 * looks.
 */
export async function SiteFooter() {
  const t = await getTranslations('Footer');
  return (
    <footer className="ftr">
      <div className="container ftr__inner">
        <div className="ftr__grid">
          <div className="ftr__brand">
            <span className="ftr__lockup">
              <CornflowerMark size={22} className="ftr__mark" />
              <span className="ftr__word">
                Кватэрка<span className="ftr__tld">.by</span>
              </span>
            </span>
          </div>

          <div className="ftr__col">
            <h2 className="ftr__head">{t('tenantsHeading')}</h2>
            <ul className="ftr__list">
              <li>
                <Link href="/search" className="ftr__link">
                  {t('searchLink')}
                </Link>
              </li>
              <li>
                <Link href="/how-it-works" className="ftr__link">
                  {t('howItWorksLink')}
                </Link>
              </li>
              <li>
                <Link href="/trust" className="ftr__link">
                  {t('trustLink')}
                </Link>
              </li>
            </ul>
          </div>

          <div className="ftr__col">
            <h2 className="ftr__head">{t('hostsHeading')}</h2>
            <ul className="ftr__list">
              <li>
                <Link href="/host" className="ftr__link">
                  {t('hostLink')}
                </Link>
              </li>
              <li>
                <Link href="/host/fees" className="ftr__link">
                  {t('feesLink')}
                </Link>
              </li>
            </ul>
          </div>

          <div className="ftr__col">
            <h2 className="ftr__head">{t('platformHeading')}</h2>
            <ul className="ftr__list">
              <li>
                <Link href="/about" className="ftr__link">
                  {t('aboutLink')}
                </Link>
              </li>
              <li>
                <Link href="/faq" className="ftr__link">
                  {t('faqLink')}
                </Link>
              </li>
              <li>
                <Link href="/terms" className="ftr__link">
                  {t('termsLink')}
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="ftr__link">
                  {t('privacyLink')}
                </Link>
              </li>
              <li>
                <Link href="/support" className="ftr__link">
                  {t('supportLink')}
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <p className="ftr__legal">{t('legal')}</p>

        <div className="ftr__bottom">
          {/* The language switcher lives in the header now — always above
              the fold, not something to scroll all the way down to find. */}
          <p className="ftr__copy">{t('copyright', { year: new Date().getFullYear() })}</p>
        </div>
      </div>

      <style>{`
        .ftr {
          margin-top: var(--space-8);
          border-top: 1px solid var(--border);
        }
        .ftr__inner { padding-block: var(--space-6); }

        .ftr__grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: var(--space-5);
          margin-bottom: var(--space-6);
        }
        .ftr__brand { grid-column: 1 / -1; }
        .ftr__lockup { display: inline-flex; align-items: center; gap: 0.5rem; }
        .ftr__mark { color: var(--primary); }
        .ftr__word {
          font-size: var(--text-base);
          font-weight: 700;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          white-space: nowrap;
        }
        .ftr__tld { font-weight: 500; color: var(--text-secondary); }

        .ftr__col { min-width: 0; }
        .ftr__head {
          margin-bottom: var(--space-1);
          font-size: var(--text-sm);
          font-weight: 600;
          letter-spacing: 0;
          color: var(--text-primary);
        }
        .ftr__list { list-style: none; margin: 0; padding: 0; }
        .ftr__link {
          display: inline-flex;
          align-items: center;
          min-height: 2.5rem;
          font-size: var(--text-sm);
          line-height: 1.4;
          color: var(--text-secondary);
          transition: color 140ms ease;
        }
        @media (hover: hover) and (pointer: fine) {
          .ftr__link:hover {
            color: var(--text-primary);
            text-decoration: underline;
            text-underline-offset: 3px;
          }
        }
        /* Ten stacked links: 44px on a mouse would loosen the columns for
           nothing, so the full touch height is for touch screens only. */
        @media (pointer: coarse) {
          .ftr__link { min-height: 2.75rem; }
        }

        .ftr__legal {
          max-width: 72ch;
          font-size: var(--text-xs);
          line-height: 1.6;
          color: var(--text-tertiary);
        }

        .ftr__bottom {
          margin-top: var(--space-3);
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: var(--space-3);
          justify-content: space-between;
        }
        .ftr__copy {
          font-size: var(--text-xs);
          color: var(--text-tertiary);
        }

        @media (min-width: 768px) {
          .ftr__grid {
            grid-template-columns: minmax(0, 1.3fr) repeat(3, minmax(0, 1fr));
            gap: var(--space-6);
          }
          .ftr__brand { grid-column: auto; }
        }
      `}</style>
    </footer>
  );
}
