import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation.ts';
import { getTranslations } from 'next-intl/server';
import { Prose } from '@/ui/prose.tsx';
import { Icon } from '@/ui/icons.tsx';
import { Reveal } from '@/ui/reveal.tsx';
import { DEFAULT_SERVICE_FEE_BPS, BPS_DENOMINATOR } from '@/server/domain/money.ts';

/* Read from the same constant the ledger charges against, so this page cannot
   drift into quoting a rate the platform does not actually apply. */
const RATE_PERCENT = (BigInt(DEFAULT_SERVICE_FEE_BPS) * 100n) / BPS_DENOMINATOR;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('HostFees');
  return {
    title: t('title'),
    description: t('metaDescription'),
  };
}

export default async function HostFeesPage() {
  const t = await getTranslations('HostFees');
  const rate = String(RATE_PERCENT);

  return (
    <>
      <nav aria-label={t('breadcrumbLabel')} className="page-crumb">
        <ol>
          <li>
            <Link href="/">{t('breadcrumbHome')}</Link>
            <Icon name="chevronRight" size={14} />
          </li>
          <li>
            <Link href="/host">{t('breadcrumbHost')}</Link>
            <Icon name="chevronRight" size={14} />
          </li>
          <li aria-current="page">{t('title')}</li>
        </ol>
      </nav>

      <Prose title={t('title')} lede={t('lede', { rate })}>
        <div className="fee-highlight">
          <span className="display fee-highlight__num">{rate}%</span>
          <p className="fee-highlight__label">{t('highlight.label')}</p>
        </div>

        <h2>{t('whatsNot.heading')}</h2>
        <ul>
          <li>{t('whatsNot.li1')}</li>
          <li>{t('whatsNot.li2')}</li>
          <li>{t('whatsNot.li3')}</li>
          <li>{t('whatsNot.li4')}</li>
        </ul>

        <Reveal as="div">
          <h2>{t('when.heading')}</h2>
          <p>
            {t.rich('when.p1Rich', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          <p>{t('when.p2')}</p>

          <h2>{t('how.heading')}</h2>
          <p>{t('how.p1', { rate })}</p>
          <p>
            {t.rich('how.p2Rich', {
              link: (chunks) => (
                <Link href="/dashboard/finance" className="link">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </Reveal>

        <Reveal as="div">
          <h2>{t('debt.heading')}</h2>
          <p>
            {t.rich('debt.p1Rich', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          <p>{t('debt.p2')}</p>

          <div className="prose__note">
            <p>
              {t.rich('debt.noteRich', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </div>

          <p>
            <Link href="/dashboard/listings/new" className="btn btn-primary">
              {t('debt.cta')}
            </Link>
          </p>
        </Reveal>
      </Prose>

      <style>{`
        .page-crumb {
          max-width: 42rem;
          margin-inline: auto;
          padding-inline: 1rem;
          padding-block: var(--space-4) 0;
          font-size: var(--text-xs);
          color: var(--text-tertiary);
        }
        .page-crumb ol { display: flex; align-items: center; flex-wrap: wrap; gap: 0.35rem; list-style: none; padding: 0; margin: 0; }
        .page-crumb li { display: flex; align-items: center; gap: 0.35rem; }
        .page-crumb a { color: var(--text-tertiary); font-weight: 500; }
        .page-crumb a:hover { color: var(--primary); text-decoration: underline; text-underline-offset: 3px; }
        .page-crumb li[aria-current] { color: var(--text-secondary); font-weight: 500; }
        .page-crumb svg { flex: 0 0 auto; }
        @media (min-width: 768px) { .page-crumb { padding-inline: 1.5rem; } }

        /* The one numeral on the page that carries the whole story — sized
           and coloured like a display heading rather than buried in a sentence. */
        .fee-highlight {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: var(--space-2);
          margin-bottom: var(--space-6);
          padding: var(--space-5);
          background: var(--primary-soft);
          border-radius: var(--radius-lg);
        }
        .fee-highlight__num { font-size: var(--text-4xl); color: var(--primary); line-height: 1; }
        .fee-highlight__label { max-width: 34ch; margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.6; }
      `}</style>
    </>
  );
}
