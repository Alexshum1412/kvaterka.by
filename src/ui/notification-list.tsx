'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api-client.ts';
import { Icon } from './icons.tsx';

/**
 * The inbox.
 *
 * Everything this platform tells a person is written to `notification` and
 * then, for the IN_APP channel, IS that message — there is nothing external to
 * call, the row is the delivery. Twenty-six places in the product write rows.
 * Until now nothing read them: the API existed, the worker existed, and no
 * screen in the application called either. So every booking request, every
 * verification decision, every debt notice landed in a table no user could
 * open. This component is the missing reader.
 *
 * Two decisions worth stating.
 *
 * A notification here is a POINTER, not a copy. The payload carries ids, and
 * the row renders a title and a link to the thing itself, because a message
 * duplicating the state of a booking will disagree with that booking the
 * moment anything changes. The one place the product tolerates a stale
 * sentence is the copy sent OUT of the platform, where there is no link to
 * follow — and even there it deliberately carries no detail.
 *
 * Reading is marked optimistically and not rolled back on failure. The cost of
 * being wrong is a dot that reappears on the next load; the cost of the
 * alternative — a spinner on every row — is a list that feels broken.
 */

export interface InboxItem {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  /** Where this notification points, if it points anywhere. */
  readonly href: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} дн назад`;
  return new Date(iso).toLocaleDateString('ru-BY', { day: 'numeric', month: 'long' });
}

export function NotificationList({ items }: { items: readonly InboxItem[] }) {
  const router = useRouter();
  const [read, setRead] = useState<Set<string>>(
    () => new Set(items.filter((i) => i.readAt !== null).map((i) => i.id)),
  );
  const [busy, setBusy] = useState(false);

  const unread = items.filter((i) => !read.has(i.id)).length;

  async function markAll(): Promise<void> {
    setBusy(true);
    setRead(new Set(items.map((i) => i.id)));
    try {
      await api.post('/notifications/read', {});
      // The header carries the same count, and it is rendered on the server.
      router.refresh();
    } catch {
      // Deliberately silent: see the note about optimism above.
    } finally {
      setBusy(false);
    }
  }

  async function open(item: InboxItem): Promise<void> {
    if (read.has(item.id)) return;
    setRead((previous) => new Set(previous).add(item.id));
    try {
      await api.post('/notifications/read', { id: item.id });
      router.refresh();
    } catch {
      /* see above */
    }
  }

  return (
    <div className="nl">
      <div className="nl__head">
        <p className="text-sm muted">
          {unread === 0 ? 'Всё прочитано' : `${unread} ${unread === 1 ? 'непрочитанное' : 'непрочитанных'}`}
        </p>
        {unread > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={markAll} disabled={busy}>
            Отметить всё прочитанным
          </button>
        )}
      </div>

      <ul className="nl__list">
        {items.map((item) => {
          const isRead = read.has(item.id);
          const body = (
            <>
              <span className={`nl__dot${isRead ? ' nl__dot--read' : ''}`} aria-hidden="true" />
              <span className="nl__body">
                <span className="nl__title">{item.title}</span>
                <time className="nl__time" dateTime={item.createdAt}>
                  {timeAgo(item.createdAt)}
                </time>
              </span>
              {item.href && <Icon name="chevronRight" size={18} className="nl__go" />}
            </>
          );

          return (
            <li key={item.id} className={`nl__item${isRead ? '' : ' nl__item--unread'}`}>
              {item.href ? (
                <Link href={item.href} className="nl__row" onClick={() => void open(item)}>
                  {body}
                </Link>
              ) : (
                <button type="button" className="nl__row" onClick={() => void open(item)}>
                  {body}
                </button>
              )}
              {!isRead && <span className="sr-only">Не прочитано</span>}
            </li>
          );
        })}
      </ul>

      <style>{`
        .nl__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); min-height: 2.25rem; }
        .nl__list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--surface); }
        .nl__item + .nl__item { border-top: 1px solid var(--border); }
        .nl__item--unread { background: var(--primary-soft); }

        /* A row is a link or a button, and both must look and behave the same:
           full width, left aligned, and tall enough to be a touch target. */
        .nl__row {
          display: flex; align-items: center; gap: var(--space-3);
          width: 100%; min-height: 3.5rem;
          padding: var(--space-3) var(--space-4);
          text-align: left; background: none; border: 0; cursor: pointer;
          font: inherit; color: inherit;
        }
        .nl__row:hover { background: var(--surface-sunken); }

        .nl__dot { flex: 0 0 auto; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--primary); }
        .nl__dot--read { background: transparent; }

        .nl__body { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; flex: 1 1 auto; }
        .nl__title { font-size: var(--text-sm); font-weight: 500; overflow-wrap: anywhere; }
        .nl__item--unread .nl__title { font-weight: 600; }
        .nl__time { font-size: var(--text-xs); color: var(--text-secondary); }
        .nl__go { flex: 0 0 auto; color: var(--text-secondary); }
      `}</style>
    </div>
  );
}
