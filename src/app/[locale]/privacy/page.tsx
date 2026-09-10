import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation.ts';
import { Prose } from '@/ui/prose.tsx';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Privacy');
  return {
    title: t('title'),
    description: t('metaDescription'),
  };
}

/**
 * The privacy page.
 *
 * Same posture as `/terms`: this is not a privacy policy, because no lawyer
 * has drafted one and LEGAL-003 — the legal basis, the residency and the
 * retention periods — is unanswered. What it is instead is a factual account
 * of what the software does, every line of which is checkable in the code:
 * which fields are hashed, which role can read what, what an access log
 * records, what closing an account does and does not destroy.
 *
 * A marketplace that collects identity documents and answers 404 on its
 * privacy link is not a cosmetic problem, and neither is one that publishes a
 * confident policy describing retention windows nobody has chosen.
 */
export default async function PrivacyPage() {
  const t = await getTranslations('Privacy');

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

      <h2>{t('collect.heading')}</h2>
      <ul>
        <li>{t('collect.item1')}</li>
        <li>{t('collect.item2')}</li>
        <li>{t('collect.item3')}</li>
        <li>{t('collect.item4')}</li>
        <li>{t('collect.item5')}</li>
        <li>{t('collect.item6')}</li>
      </ul>

      <h2>{t('notStored.heading')}</h2>
      <ul>
        <li>{t.rich('notStored.item1Rich', { strong: (chunks) => <strong>{chunks}</strong> })}</li>
        <li>{t.rich('notStored.item2Rich', { strong: (chunks) => <strong>{chunks}</strong> })}</li>
        <li>{t.rich('notStored.item3Rich', { strong: (chunks) => <strong>{chunks}</strong> })}</li>
        <li>{t('notStored.item4')}</li>
      </ul>

      <h2>{t('address.heading')}</h2>
      <p>{t('address.body')}</p>

      <h2>{t('id.heading')}</h2>
      <p>
        {t.rich('id.introRich', {
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
      <ul>
        <li>{t('id.item1')}</li>
        <li>{t.rich('id.item2Rich', { strong: (chunks) => <strong>{chunks}</strong> })}</li>
        <li>{t('id.item3')}</li>
        <li>{t('id.item4')}</li>
      </ul>

      <h2>{t('comms.heading')}</h2>
      <p>{t('comms.body')}</p>

      <h2>{t('close.heading')}</h2>
      <p>
        {t.rich('close.p1Rich', {
          link: (chunks) => (
            <Link href="/dashboard/account" className="link">
              {chunks}
            </Link>
          ),
        })}
      </p>
      <p>{t('close.p2')}</p>
    </Prose>
  );
}
