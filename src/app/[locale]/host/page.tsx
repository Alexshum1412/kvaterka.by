import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation.ts';
import { getTranslations } from 'next-intl/server';
import { Prose } from '@/ui/prose.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';
import { Reveal } from '@/ui/reveal.tsx';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Host');
  return {
    title: t('title'),
    description: t('metaDescription'),
  };
}

export default async function HostPage() {
  const t = await getTranslations('Host');

  const STEPS: { icon: IconName; title: string; body: string }[] = [
    { icon: 'edit', title: t('steps.describe.title'), body: t('steps.describe.body') },
    { icon: 'image', title: t('steps.photos.title'), body: t('steps.photos.body') },
    { icon: 'calendar', title: t('steps.dates.title'), body: t('steps.dates.body') },
    { icon: 'checkCircle', title: t('steps.moderation.title'), body: t('steps.moderation.body') },
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
        <h2>{t('howHeading')}</h2>
        <ol className="step-list" role="list">
          {STEPS.map((step) => (
            <li key={step.title} className="step-list__item">
              <span className="step-list__glyph">
                <Icon name={step.icon} size={20} />
              </span>
              <div className="step-list__copy">
                <b>{step.title}</b>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <Reveal as="div">
          <h2>{t('calendar.heading')}</h2>
          <p>
            {t.rich('calendar.bodyRich', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>

          <h2>{t('requests.heading')}</h2>
          <p>{t('requests.body')}</p>
        </Reveal>

        <Reveal as="div">
          <h2>{t('money.heading')}</h2>
          <p>
            {t.rich('money.bodyRich', {
              link: (chunks) => (
                <Link href="/host/fees" className="link">
                  {chunks}
                </Link>
              ),
            })}
          </p>

          <p>
            <Link href="/dashboard/listings/new" className="btn btn-primary">
              {t('money.cta')}
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

        /* Same icon-circle language as the home page's trust grid, applied to
           a sequential process instead of independent reasons — so it stays
           a vertical list rather than a grid. */
        .step-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-5); }
        .step-list__item { display: flex; align-items: flex-start; gap: var(--space-4); }
        .step-list__glyph {
          display: inline-flex; align-items: center; justify-content: center;
          flex: 0 0 auto;
          width: 2.75rem; height: 2.75rem;
          border-radius: var(--radius-full);
          background: var(--primary-soft);
          color: var(--primary);
        }
        .step-list__copy b { display: block; color: var(--text-primary); font-weight: 600; font-size: var(--text-base); margin-bottom: 0.2rem; }
        .step-list__copy p { margin: 0; color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.6; }
      `}</style>
    </>
  );
}
