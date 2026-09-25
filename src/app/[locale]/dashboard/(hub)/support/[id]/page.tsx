import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { TicketReplyForm } from '@/ui/ticket-reply-form.tsx';
import { Icon } from '@/ui/icons.tsx';
import type { AppLocale } from '@/i18n/routing.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('SupportTickets');
  return { title: t('detailMetaTitle'), robots: { index: false, follow: false } };
}

const STATUS_TONE: Record<string, string> = {
  OPEN: 'warning',
  IN_PROGRESS: 'primary',
  WAITING_ON_USER: 'warning',
  RESOLVED: 'verified',
  CLOSED: 'solid-neutral',
};

/**
 * One ticket, as its own author sees it — the "support chat" the product
 * brief asked for. `ownDetail()` only ever assembles `PARTIES`-visible
 * events, so this page needs no entitlement logic of its own: whatever it
 * receives is already safe to show. It renders as a message thread rather
 * than a flat log, which is the whole difference between a case file and a
 * chat — the same rows, read differently.
 */
export default async function MyTicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const locale = (await getLocale()) as AppLocale;
  const user = await currentUser();
  if (!user) redirect({ href: signInUrl(`/dashboard/support/${id}`), locale });

  const t = await getTranslations('SupportTickets');
  const services = await readyServices();

  let ticket: Record<string, any>;
  try {
    ticket = (await services.tickets.ownDetail(id, user!.userId)) as Record<string, any>;
  } catch {
    notFound();
  }

  const dateFormat = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const fmt = (value: string | null) => (value ? dateFormat.format(new Date(value)) : '');

  const status = ticket.status as string;
  const messages = ticket.messages as Record<string, any>[];
  const property = ticket.property as Record<string, any> | null;

  return (
    <div className="container td">
      <Link href="/dashboard/support" className="td__back">
        <Icon name="arrowLeft" size={15} />
        {t('detailBack')}
      </Link>

      <header className="td__head">
        <div className="td__headTop">
          <h1 className="title-lg">{t('detailTitle', { reference: ticket.reference })}</h1>
          <span className={`badge badge-${STATUS_TONE[status] ?? 'solid-neutral'}`}>{t(`status_${status}`)}</span>
        </div>
        <p className="text-sm muted">
          {t('detailCreated', { date: fmt(ticket.createdAt) })}
          {property && <> · {property.title}</>}
        </p>
      </header>

      {ticket.resolution && (
        <div className="td__resolution">
          <strong>{t('detailResolutionTitle')}</strong>
          <p>{ticket.resolution}</p>
          <span className="hint">{t('detailResolutionDate', { date: fmt(ticket.resolvedAt) })}</span>
        </div>
      )}

      <section className="td__thread" aria-label={t('sectionWhatHappened')}>
        {messages.length === 0 ? (
          <p className="text-sm muted">{t('chatEmpty')}</p>
        ) : (
          <ul className="td__bubbles">
            {messages.map((m, i) => (
              <li key={i} className={m.fromAuthor ? 'td__bubble is-mine' : 'td__bubble'}>
                <span className="td__bubbleAuthor">{m.fromAuthor ? t('chatFromYou') : t('chatFromSupport')}</span>
                <p className="td__bubbleText">{m.note}</p>
                <span className="td__bubbleWhen">{fmt(m.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {ticket.canReply ? (
        <TicketReplyForm ticketId={id} />
      ) : (
        <p className="hint">{t('replyClosedNotice')}</p>
      )}

      <style>{`
        .td { padding-block: var(--space-4) var(--space-8); max-width: 42rem; }
        .td__back { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.5rem; margin-bottom: var(--space-2); font-size: var(--text-sm); color: var(--text-secondary); }
        @media (hover: hover) and (pointer: fine) {
          .td__back:hover { color: var(--text-primary); }
        }

        .td__head { margin-bottom: var(--space-4); }
        .td__headTop { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }

        .td__resolution {
          display: grid; gap: 0.2rem; margin-bottom: var(--space-5);
          padding: var(--space-3) var(--space-4); background: var(--success-soft); border-radius: var(--radius-sm);
          font-size: var(--text-sm);
        }

        .td__thread { margin-bottom: var(--space-5); }
        .td__bubbles { display: grid; gap: var(--space-3); list-style: none; margin: 0; padding: 0; }
        .td__bubble {
          display: grid; gap: 0.2rem; max-width: 80%;
          padding: var(--space-3); background: var(--surface); border-radius: var(--radius-md);
          justify-self: start;
        }
        .td__bubble.is-mine { background: var(--primary-soft); justify-self: end; }
        .td__bubbleAuthor { font-size: var(--text-2xs); font-weight: 600; color: var(--text-tertiary); }
        .td__bubbleText { font-size: var(--text-sm); line-height: 1.55; white-space: pre-wrap; }
        .td__bubbleWhen { font-size: var(--text-2xs); color: var(--text-tertiary); justify-self: end; }

        @media (max-width: 480px) {
          .td__bubble { max-width: 92%; }
        }
      `}</style>
    </div>
  );
}
