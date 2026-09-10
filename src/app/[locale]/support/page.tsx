import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation.ts';
import { Prose } from '@/ui/prose.tsx';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Support');
  return {
    title: t('title'),
    description: t('metaDescription'),
  };
}

/**
 * Support.
 *
 * Several screens tell a person to "write to support" and route them to
 * `/dashboard/chat`, which is a list of conversations about flats — there is
 * no support conversation type, and `startConversation` requires a real
 * property and a real owner, so no such thread can exist. The instruction was
 * a dead end.
 *
 * This page does not invent a channel that does not exist. What it does is
 * route each real problem to the mechanism that genuinely handles it — a
 * dispute has a queue and staff, verification has a resubmission path, account
 * data has a screen — and state plainly which problems currently have no
 * route, rather than sending somebody in a circle.
 */
export default async function SupportPage() {
  const t = await getTranslations('Support');

  return (
    <Prose title={t('title')} lede={t('lede')}>
      <h2>{t('booking.heading')}</h2>
      <p>{t('booking.body')}</p>
      <p>
        <Link href="/trips" className="link">
          {t('booking.tripsLink')}
        </Link>{' '}
        ·{' '}
        <Link href="/dashboard/bookings" className="link">
          {t('booking.bookingsLink')}
        </Link>
      </p>

      <h2>{t('verification.heading')}</h2>
      <p>{t('verification.body')}</p>
      <p>
        <Link href="/dashboard/verification" className="link">
          {t('verification.link')}
        </Link>
      </p>

      <h2>{t('listing.heading')}</h2>
      <p>{t('listing.body')}</p>
      <p>
        <Link href="/dashboard" className="link">
          {t('listing.link')}
        </Link>
      </p>

      <h2>{t('fee.heading')}</h2>
      <p>{t('fee.body')}</p>
      <p>
        <Link href="/dashboard/finance" className="link">
          {t('fee.financeLink')}
        </Link>{' '}
        ·{' '}
        <Link href="/host/fees" className="link">
          {t('fee.feesLink')}
        </Link>
      </p>

      <h2>{t('data.heading')}</h2>
      <p>{t('data.body')}</p>
      <p>
        <Link href="/dashboard/account" className="link">
          {t('data.accountLink')}
        </Link>{' '}
        ·{' '}
        <Link href="/privacy" className="link">
          {t('data.privacyLink')}
        </Link>
      </p>

      <div className="prose__note">
        <p>
          {t.rich('note.p1Rich', {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
        <p>{t('note.p2')}</p>
      </div>
    </Prose>
  );
}
