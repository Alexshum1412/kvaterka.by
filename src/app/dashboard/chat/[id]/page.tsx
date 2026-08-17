import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { ChatThread } from '@/ui/chat-thread.tsx';
import { Icon } from '@/ui/icons.tsx';
import { BOOKING_STATUS_LABEL, bookingTone } from '@/ui/primitives.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Переписка',
  robots: { index: false, follow: false },
};

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(signInUrl(`/dashboard/chat/${id}`));

  const services = await readyServices();

  // listMessages checks participation and throws otherwise, so a stranger
  // gets the same 404 as for a conversation that does not exist.
  let messages: Awaited<ReturnType<typeof services.messaging.listMessages>>;
  try {
    messages = await services.messaging.listMessages(id, user.userId, { limit: 100 });
  } catch {
    notFound();
  }

  const conversations = await services.messaging.listConversations(user.userId);
  const conversation = conversations.find((c) => c.id === id);
  if (!conversation) notFound();

  // Opening a thread is reading it.
  await services.messaging.markRead(id, user.userId).catch(() => undefined);

  return (
    <div className="container cv">
      <nav className="cv__back">
        <Link href="/dashboard/chat" className="cv__backLink">
          <Icon name="arrowLeft" size={16} />
          Все сообщения
        </Link>
      </nav>

      <header className="cv__head">
        <span className="cv__avatar" aria-hidden="true">
          {conversation.counterparty.displayName.trim().charAt(0).toUpperCase()}
        </span>
        <div className="cv__who">
          <div className="cv__nameRow">
            <strong className="cv__name">{conversation.counterparty.displayName}</strong>
            {conversation.counterparty.verificationLevel >= 1 && (
              <span className="cv__verified">
                <Icon name="checkCircle" size={13} />
                Личность подтверждена
              </span>
            )}
          </div>
          {conversation.propertyId ? (
            <Link href={`/listing/${conversation.propertyId}`} className="cv__property truncate">
              {conversation.propertyTitle ?? 'Объявление'}
            </Link>
          ) : (
            <span className="cv__property">Объявление недоступно</span>
          )}
        </div>
        {conversation.bookingId && conversation.bookingStatus && (
          <Link href={`/bookings/${conversation.bookingId}`} className="cv__booking">
            <span className={`badge badge-${bookingTone(conversation.bookingStatus)}`}>
              {BOOKING_STATUS_LABEL[conversation.bookingStatus] ?? conversation.bookingStatus}
            </span>
          </Link>
        )}
      </header>

      {!conversation.contactReleased && (
        <p className="cv__notice">
          <Icon name="info" size={16} />
          Обменяться телефонами можно после подтверждённого бронирования. До этого переписка идёт
          здесь — так у обеих сторон остаётся история, если возникнет спор.
        </p>
      )}

      <section className="panel cv__thread">
        <ChatThread
          conversationId={id}
          initial={messages.map((m) => ({
            id: m.id,
            senderId: m.senderId,
            body: m.body,
            moderationState: m.moderationState,
            createdAt: m.createdAt,
            mine: m.mine,
            ...(m.filterNotice ? { filterNotice: m.filterNotice } : {}),
          }))}
          canWrite
        />
      </section>

      <style>{`
        .cv { padding-block: var(--space-4) var(--space-7); max-width: 44rem; }
        .cv__back { margin-bottom: var(--space-3); }
        .cv__backLink { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .cv__backLink:hover { color: var(--text-primary); }

        .cv__head { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
        .cv__avatar {
          display: grid; place-items: center; flex: 0 0 auto;
          width: 2.75rem; height: 2.75rem; border-radius: var(--radius-full);
          background: var(--primary-soft); color: var(--primary); font-weight: 600;
        }
        .cv__who { display: grid; gap: 0.1rem; flex: 1 1 auto; min-width: 0; }
        .cv__nameRow { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
        .cv__name { font-size: var(--text-base); }
        .cv__verified { display: inline-flex; align-items: center; gap: 0.25rem; font-size: var(--text-2xs); font-weight: 600; color: var(--success); }
        .cv__property { font-size: var(--text-sm); color: var(--text-secondary); }
        .cv__property:hover { color: var(--primary); }
        .cv__booking { flex: 0 0 auto; }

        .cv__notice {
          display: flex; align-items: flex-start; gap: 0.5rem;
          padding: var(--space-3);
          background: var(--surface-sunken); border-radius: var(--radius-sm);
          font-size: var(--text-xs); color: var(--text-secondary);
          margin-bottom: var(--space-3);
        }
        .cv__notice > svg { color: var(--primary); flex: 0 0 auto; }

        .cv__thread { padding: var(--space-3); }
      `}</style>
    </div>
  );
}
