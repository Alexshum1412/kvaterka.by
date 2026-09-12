import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation.ts';
import { Prose } from '@/ui/prose.tsx';
import { TicketForm } from '@/ui/ticket-form.tsx';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready } from '@/server/runtime.ts';

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
 * Several screens tell a person to "write to support". Until DEC-073 there
 * was nowhere for that to actually go for a problem that is not a booking
 * dispute, a verification resubmission, or a moderation resubmit — this page
 * used to say so plainly rather than pretend otherwise.
 *
 * That gap is now closed: every real problem is still routed to the
 * mechanism that genuinely handles it first (a dispute has a queue and
 * staff, verification has a resubmission path, account data has a screen),
 * and anything left over — or anything where the person cannot even reach
 * those paths — goes through the ticket form below, which reaches an actual
 * person and is tracked to a decision.
 */
export default async function SupportPage() {
  const t = await getTranslations('Support');
  const tt = await getTranslations('SupportTickets');
  const user = await currentUser();

  let properties: { id: string; title: string }[] = [];
  if (user) {
    const database = await ready();
    const { rows } = await database.query<{ id: string; title: string }>(
      `SELECT id, title FROM property WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`,
      [user.userId],
    );
    properties = rows;
  }

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

      <h2>{tt('formTitle')}</h2>
      <p>{tt('formIntro')}</p>

      {user ? (
        <>
          <TicketForm properties={properties} />
          <p className="support__myTickets">
            {tt('myTicketsIntro')}{' '}
            <Link href="/dashboard/support" className="link">
              {tt('myTicketsLink')}
            </Link>
          </p>
        </>
      ) : (
        <p>
          {tt('formSignInPrompt')}{' '}
          <Link href={signInUrl('/support')} className="link">
            {tt('formSignInLink')}
          </Link>
        </p>
      )}

      <style>{`
        .support__myTickets { margin-top: var(--space-3); }
      `}</style>
    </Prose>
  );
}
