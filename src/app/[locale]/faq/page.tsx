import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation.ts';
import { getTranslations } from 'next-intl/server';
import { Prose } from '@/ui/prose.tsx';
import { Icon } from '@/ui/icons.tsx';
import { Reveal } from '@/ui/reveal.tsx';
import { DEFAULT_SERVICE_FEE_BPS, BPS_DENOMINATOR } from '@/server/domain/money.ts';

/* Same source the ledger actually charges against (see /host/fees) — this
   page cannot drift into quoting a rate the platform doesn't apply. */
const RATE_PERCENT = (BigInt(DEFAULT_SERVICE_FEE_BPS) * 100n) / BPS_DENOMINATOR;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Faq');
  return {
    title: t('title'),
    description: t('metaDescription'),
  };
}

/**
 * FAQ.
 *
 * A real accordion — native <details>/<summary>, no client state. Every
 * answer here is traceable to something implemented: the booking state
 * machine (src/server/domain/booking/states.ts) for the request/cancel
 * questions, verification.ts for what proof is currently accepted, and the
 * host/fees page's own rate constant for the money question. Where the
 * honest answer is "this isn't finished yet" — identity documents — it says
 * so instead of describing a policy that doesn't exist.
 */
export default async function FaqPage() {
  const t = await getTranslations('Faq');
  const rate = String(RATE_PERCENT);

  return (
    <>
      <nav className="container faq-crumbs" aria-label={t('breadcrumbLabel')}>
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

      <Prose title={t('title')} lede={t('lede')}>
        <h2>{t('booking.heading')}</h2>
        <div className="faq-list">
          <details className="faq-item">
            <summary className="faq-item__q">
              <span>{t('booking.howToBook.question')}</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>{t('booking.howToBook.answer')}</p>
              <p>
                <Link href="/how-it-works" className="link">
                  {t('booking.howToBook.moreLink')}
                </Link>
              </p>
            </div>
          </details>

          <details className="faq-item">
            <summary className="faq-item__q">
              <span>{t('booking.cancel.question')}</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>{t('booking.cancel.answerP1')}</p>
              <p>{t('booking.cancel.answerP2')}</p>
            </div>
          </details>

          <details className="faq-item">
            <summary className="faq-item__q">
              <span>{t('booking.noResponse.question')}</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>{t('booking.noResponse.answer')}</p>
            </div>
          </details>
        </div>

        <h2>{t('money.heading')}</h2>
        <div className="faq-list">
          <details className="faq-item">
            <summary className="faq-item__q">
              <span>{t('money.hiddenFees.question')}</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>{t('money.hiddenFees.answer', { rate })}</p>
              <p>
                <Link href="/host/fees" className="link">
                  {t('money.hiddenFees.feesLink')}
                </Link>
              </p>
            </div>
          </details>

          <details className="faq-item">
            <summary className="faq-item__q">
              <span>{t('money.verification.question')}</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>{t('money.verification.answer')}</p>
              <p>
                <Link href="/trust" className="link">
                  {t('money.verification.trustLink')}
                </Link>
              </p>
            </div>
          </details>

          <details className="faq-item">
            <summary className="faq-item__q">
              <span>{t('money.contactHost.question')}</span>
              <Icon name="chevronDown" size={20} className="faq-item__chev" />
            </summary>
            <div className="faq-item__a">
              <p>{t('money.contactHost.answer')}</p>
            </div>
          </details>
        </div>

        <Reveal as="div">
          <h2>{t('living.heading')}</h2>
          <div className="faq-list">
            <details className="faq-item">
              <summary className="faq-item__q">
                <span>{t('living.nightCheckin.question')}</span>
                <Icon name="chevronDown" size={20} className="faq-item__chev" />
              </summary>
              <div className="faq-item__a">
                <p>{t('living.nightCheckin.answer')}</p>
              </div>
            </details>

            <details className="faq-item">
              <summary className="faq-item__q">
                <span>{t('living.somethingWrong.question')}</span>
                <Icon name="chevronDown" size={20} className="faq-item__chev" />
              </summary>
              <div className="faq-item__a">
                <p>{t('living.somethingWrong.answerP1')}</p>
                <p>
                  <Link href="/trust" className="link">
                    {t('living.somethingWrong.trustLink')}
                  </Link>{' '}
                  ·{' '}
                  <Link href="/support" className="link">
                    {t('living.somethingWrong.supportLink')}
                  </Link>
                </p>
              </div>
            </details>
          </div>
        </Reveal>

        <p className="faq-more">
          {t.rich('moreRich', {
            link: (chunks) => (
              <Link href="/support" className="link">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </Prose>

      <style>{`
        .faq-crumbs { padding-top: var(--space-4); max-width: 42rem; margin-inline: auto; }
        .faq-crumbs ol {
          display: flex; align-items: center; gap: 0.35rem;
          list-style: none; margin: 0; padding: 0;
          font-size: var(--text-xs); color: var(--text-tertiary);
        }
        .faq-crumbs li { display: flex; align-items: center; }
        .faq-crumbs a { color: var(--text-secondary); min-height: 1.75rem; display: inline-flex; align-items: center; }
        @media (hover: hover) and (pointer: fine) {
          .faq-crumbs a:hover { color: var(--primary); text-decoration: underline; text-underline-offset: 3px; }
        }
        .faq-crumbs li[aria-current='page'] { color: var(--text-primary); font-weight: 500; }

        .faq-list { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-3); }

        /* A control, not a card: a visible border so it reads as clickable,
           the way every other control in this system does. */
        .faq-item {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          /* Lets the browser animate ::details-content between its 0 and
             auto heights instead of the native instant snap. */
          interpolate-size: allow-keywords;
        }
        .faq-item::details-content {
          height: 0;
          overflow: hidden;
          /* impeccable-disable-next-line layout-transition -- ::details-content has no transform path; height is the only way to animate a native disclosure */
          transition: height 200ms ease-out, content-visibility 200ms allow-discrete;
        }
        .faq-item[open]::details-content { height: auto; }

        .faq-item__q {
          display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
          min-height: 2.75rem;
          padding: var(--space-4) var(--space-5);
          cursor: pointer;
          list-style: none;
          font-size: var(--text-sm);
          font-weight: 600;
          color: var(--text-primary);
          border-radius: var(--radius-md);
          transition: background-color 140ms ease;
        }
        .faq-item__q::-webkit-details-marker { display: none; }
        @media (hover: hover) and (pointer: fine) {
          .faq-item__q:hover { background: var(--surface-sunken); }
        }

        .faq-item__chev { color: var(--text-tertiary); transition: transform 200ms ease; }
        .faq-item[open] .faq-item__chev { transform: rotate(180deg); }
        .faq-item[open] .faq-item__q { border-radius: var(--radius-md) var(--radius-md) 0 0; }

        .faq-item__a { padding: 0 var(--space-5) var(--space-4); font-size: var(--text-sm); line-height: 1.7; }
        .faq-item__a p { margin-bottom: var(--space-2); color: var(--text-secondary); }
        .faq-item__a p:last-child { margin-bottom: 0; }

        .faq-more { margin-top: var(--space-5); color: var(--text-secondary); }
      `}</style>
    </>
  );
}
