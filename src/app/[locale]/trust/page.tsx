import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation.ts';
import { Prose } from '@/ui/prose.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';
import { Reveal } from '@/ui/reveal.tsx';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Trust');
  return {
    title: t('title'),
    description: t('metaDescription'),
  };
}

export default async function TrustPage() {
  const t = await getTranslations('Trust');

  const TIERS: { icon: IconName; title: string; body: string }[] = [
    { icon: 'check', title: t('tiers.basic.title'), body: t('tiers.basic.body') },
    { icon: 'shieldCheck', title: t('tiers.verified.title'), body: t('tiers.verified.body') },
    { icon: 'shield', title: t('tiers.identity.title'), body: t('tiers.identity.body') },
  ];

  return (
    <>
      <nav aria-label={t('breadcrumbLabel')} className="page-crumb">
        <ol>
          <li>
            <Link href="/">{t('breadcrumbHome')}</Link>
            <Icon name="chevronRight" size={14} />
          </li>
          <li aria-current="page">{t('title')}</li>
        </ol>
      </nav>

      <Prose title={t('title')} lede={t('lede')}>
        <Reveal as="div">
          <h2>{t('review.heading')}</h2>
          <p>{t('review.p1')}</p>
          <p>
            {t.rich('review.p2Rich', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          <p>{t('review.p3')}</p>
        </Reveal>

        <h2>{t('tiers.heading')}</h2>
        <ul className="tier-list" role="list">
          {TIERS.map((tier) => (
            <li key={tier.title} className="tier-list__item">
              <span className="tier-list__glyph">
                <Icon name={tier.icon} size={20} />
              </span>
              <div className="tier-list__copy">
                <b>{tier.title}</b>
                <p>{tier.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <p>
          {t.rich('tiers.footerRich', {
            link: (chunks) => (
              <Link href="/dashboard/verification" className="link">
                {chunks}
              </Link>
            ),
          })}
        </p>

        <h2>{t('rating.heading')}</h2>
        <p>{t('rating.body')}</p>

        <h2>{t('comms.heading')}</h2>
        <p>{t('comms.body')}</p>

        <Reveal as="div">
          <h2>{t('dispute.heading')}</h2>
          <p>{t('dispute.body')}</p>

          <h2>{t('promise.heading')}</h2>
          <div className="prose__note">
            <p>
              {t.rich('promise.bodyRich', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </div>
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
        @media (hover: hover) and (pointer: fine) {
          .page-crumb a:hover { color: var(--primary); text-decoration: underline; text-underline-offset: 3px; }
        }
        .page-crumb li[aria-current] { color: var(--text-secondary); font-weight: 500; }
        .page-crumb svg { flex: 0 0 auto; }
        @media (min-width: 768px) { .page-crumb { padding-inline: 1.5rem; } }

        /* Same icon-circle language as the home page's trust grid — apt here
           of all pages, since this literally is a trust section. */
        .tier-list { list-style: none; padding: 0; margin: 0 0 var(--space-3); display: flex; flex-direction: column; gap: var(--space-4); }
        .tier-list__item { display: flex; align-items: flex-start; gap: var(--space-4); }
        .tier-list__glyph {
          display: inline-flex; align-items: center; justify-content: center;
          flex: 0 0 auto;
          width: 2.75rem; height: 2.75rem;
          border-radius: var(--radius-full);
          background: var(--primary-soft);
          color: var(--primary);
        }
        .tier-list__copy b { display: block; color: var(--text-primary); font-weight: 600; font-size: var(--text-base); margin-bottom: 0.2rem; }
        .tier-list__copy p { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.6; }
      `}</style>
    </>
  );
}
