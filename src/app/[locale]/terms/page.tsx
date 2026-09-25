import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation.ts';
import { Prose } from '@/ui/prose.tsx';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Terms');
  return {
    title: t('title'),
    description: t('metaDescription'),
  };
}

/**
 * Terms of service, and the honest state of them.
 *
 * This page is deliberately NOT a terms-of-service document. No lawyer
 * qualified in Belarus has drafted or reviewed one, and inventing plausible
 * contractual language would be worse than a missing page: it would be a
 * document people rely on that binds nobody and asserts obligations nobody
 * checked. docs/LEGAL.md records this as an open question, and this
 * page says the same thing in public rather than only in the repository.
 *
 * What it CAN state truthfully is how the platform actually behaves, because
 * that is observable in the code and enforced by tests. So the page describes
 * the rules the software applies today, and marks clearly where the formal
 * document is still missing.
 */
export default async function TermsPage() {
  const t = await getTranslations('Terms');

  return (
    <Prose title={t('title')} lede={t('lede')}>
      <div className="prose__note">
        <p>
          {t.rich('note.p1Rich', {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
        <p>{t('note.p2')}</p>
      </div>

      <h2>{t('what.heading')}</h2>
      <p>{t('what.body')}</p>

      <h2>{t('not.heading')}</h2>
      <ul>
        <li>{t.rich('not.item1Rich', { strong: (chunks) => <strong>{chunks}</strong> })}</li>
        <li>{t.rich('not.item2Rich', { strong: (chunks) => <strong>{chunks}</strong> })}</li>
        <li>{t.rich('not.item3Rich', { strong: (chunks) => <strong>{chunks}</strong> })}</li>
      </ul>

      <h2>{t('fee.heading')}</h2>
      <p>
        {t.rich('fee.bodyRich', {
          link: (chunks) => (
            <Link href="/host/fees" className="link">
              {chunks}
            </Link>
          ),
        })}
      </p>

      <h2>{t('rules.heading')}</h2>
      <ul>
        <li>{t('rules.item1')}</li>
        <li>{t('rules.item2')}</li>
        <li>{t('rules.item3')}</li>
        <li>{t('rules.item4')}</li>
        <li>{t('rules.item5')}</li>
      </ul>

      <h2>{t('disputes.heading')}</h2>
      <p>{t('disputes.body')}</p>

      <p>
        {t.rich('footerRich', {
          privacyLink: (chunks) => (
            <Link href="/privacy" className="link">
              {chunks}
            </Link>
          ),
          supportLink: (chunks) => (
            <Link href="/support" className="link">
              {chunks}
            </Link>
          ),
        })}
      </p>
    </Prose>
  );
}
