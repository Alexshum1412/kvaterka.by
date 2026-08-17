import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { Icon } from '@/ui/icons.tsx';
import { BOOKING_STATUS_LABEL, bookingTone, plural } from '@/ui/primitives.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Сообщения',
  robots: { index: false, follow: false },
};

/**
 * Conversation list.
 *
 * The header has linked here since the redesign; until now it went
 * nowhere. Conversations come from the existing messaging service, which
 * already scopes them to the caller — a participant sees their own
 * threads and nothing else.
 */

type Params = Record<string, string | string[] | undefined>;

function ago(iso: string | null): string {
  if (!iso) return '';
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

export default async function ChatListPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/dashboard/chat'));

  const params = await searchParams;
  const services = await readyServices();

  // Arriving from a booking or a listing with ?property=… opens (or reuses)
  // that conversation rather than dumping the visitor in a list.
  const propertyId = typeof params.property === 'string' ? params.property : null;
  if (propertyId) {
    try {
      const conversation = await services.messaging.startConversation(propertyId, user.userId);
      redirect(`/dashboard/chat/${conversation.id}`);
    } catch {
      // Not a tenant for that listing, or it does not exist. Fall through to
      // the list rather than explaining which.
    }
  }

  const conversations = await services.messaging.listConversations(user.userId);
  const unread = conversations.reduce((sum, c) => sum + c.unreadCount, 0);

  return (
    <div className="container cl">
      <header className="cl__head">
        <h1 className="title-lg">Сообщения</h1>
        <p className="text-sm muted">
          {conversations.length === 0
            ? 'Переписка появится, когда вы напишете хозяину или получите заявку.'
            : unread > 0
              ? `${unread} ${plural(unread, 'непрочитанное сообщение', 'непрочитанных сообщения', 'непрочитанных сообщений')}`
              : `${conversations.length} ${plural(conversations.length, 'диалог', 'диалога', 'диалогов')}`}
        </p>
      </header>

      {conversations.length === 0 ? (
        <div className="cl__empty">
          <Icon name="message" size={26} />
          <p className="title-sm">Пока нет переписки</p>
          <p className="text-sm muted">
            Напишите хозяину со страницы объявления — вся история останется здесь.
          </p>
          <Link href="/search" className="btn btn-primary">
            Найти жильё
          </Link>
        </div>
      ) : (
        <ul className="cl__list">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link href={`/dashboard/chat/${c.id}`} className="cl__row">
                <span className="cl__avatar" aria-hidden="true">
                  {c.counterparty.displayName.trim().charAt(0).toUpperCase()}
                </span>

                <span className="cl__main">
                  <span className="cl__top">
                    <strong className="cl__name truncate">{c.counterparty.displayName}</strong>
                    {c.counterparty.verificationLevel >= 1 && (
                      <Icon name="checkCircle" size={13} className="cl__verified" />
                    )}
                    {c.bookingStatus && (
                      <span className={`badge badge-${bookingTone(c.bookingStatus)}`}>
                        {BOOKING_STATUS_LABEL[c.bookingStatus] ?? c.bookingStatus}
                      </span>
                    )}
                  </span>
                  <span className="cl__property truncate">
                    {c.propertyTitle ?? 'Объявление удалено'}
                  </span>
                </span>

                <span className="cl__end">
                  {c.unreadCount > 0 && <span className="cl__unread">{c.unreadCount}</span>}
                  <span className="cl__ago">{ago(c.lastMessageAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <style>{`
        .cl { padding-block: var(--space-5) var(--space-8); max-width: 46rem; }
        .cl__head { display: grid; gap: 0.2rem; margin-bottom: var(--space-4); }
        .cl__list { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
        .cl__row {
          display: flex; align-items: center; gap: var(--space-3);
          padding: var(--space-3);
          background: var(--surface); border-radius: var(--radius-md);
          transition: box-shadow 160ms ease;
        }
        .cl__row:hover { box-shadow: var(--shadow-raised); }
        .cl__avatar {
          display: grid; place-items: center; flex: 0 0 auto;
          width: 2.75rem; height: 2.75rem;
          border-radius: var(--radius-full);
          background: var(--primary-soft); color: var(--primary); font-weight: 600;
        }
        .cl__main { display: grid; gap: 0.1rem; flex: 1 1 auto; min-width: 0; }
        .cl__top { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
        .cl__name { font-size: var(--text-sm); }
        .cl__verified { color: var(--success); flex: 0 0 auto; }
        .cl__property { font-size: var(--text-xs); color: var(--text-secondary); }
        .cl__end { display: grid; justify-items: end; gap: 0.25rem; flex: 0 0 auto; }
        .cl__unread {
          display: grid; place-items: center; min-width: 1.25rem; height: 1.25rem;
          padding-inline: 0.25rem; border-radius: var(--radius-full);
          background: var(--primary); color: var(--text-on-primary);
          font-size: var(--text-2xs); font-weight: 700;
        }
        .cl__ago { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .cl__empty { display: grid; justify-items: center; gap: 0.3rem; padding: var(--space-8) var(--space-4); text-align: center; }
        .cl__empty > svg { color: var(--text-tertiary); margin-bottom: var(--space-2); }
        .cl__empty > .btn { margin-top: var(--space-3); }
      `}</style>
    </div>
  );
}
