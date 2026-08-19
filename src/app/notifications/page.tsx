import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { NOTIFICATION_CATEGORY_TITLE } from '@/server/services/notification-service.ts';
import { NotificationList, type InboxItem } from '@/ui/notification-list.tsx';
import { EmptyState } from '@/ui/primitives.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Уведомления',
  // What somebody has been told is a record of their bookings, their disputes
  // and their verification decisions. Never indexed.
  robots: { index: false, follow: false },
};

/**
 * Where a notification points.
 *
 * The payload carries ids and nothing that needs displaying, which is
 * deliberate: a message that copies the state of a booking disagrees with that
 * booking the moment either changes, so the row links to the thing and lets
 * the thing speak for itself.
 *
 * NOTHING FROM THE PAYLOAD IS EVER RENDERED. Two categories carry a
 * single-use token — email verification and password reset — and a token is
 * the one thing that must not be sitting in a list that stays readable for as
 * long as the account exists. Those rows get a title and no link; the token
 * travels by the channel it was minted for.
 */
function linkFor(payload: Record<string, unknown>): string | null {
  const id = (key: string): string | null => {
    const value = payload[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const bookingId = id('bookingId');
  if (bookingId) return `/bookings/${bookingId}`;

  const conversationId = id('conversationId');
  if (conversationId) return `/dashboard/chat/${conversationId}`;

  const propertyId = id('propertyId');
  if (propertyId) return `/dashboard/listings/${propertyId}/edit`;

  if (id('requestId')) return '/dashboard/verification';

  // A dispute case with no booking id, a security notice, a token — no
  // destination that would be more useful than staying here.
  return null;
}

export default async function NotificationsPage() {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/notifications'));

  const services = await readyServices();
  const rows = await services.notifications.inbox(user.userId, 50);

  const items: InboxItem[] = rows.map((row) => {
    const category = String(row['category']);
    const payload = (row['payload'] ?? {}) as Record<string, unknown>;
    const createdAt = row['createdAt'];
    const readAt = row['readAt'];

    return {
      id: String(row['id']),
      category,
      // The same titles the platform uses when it speaks outside the product,
      // so a person reads the same sentence wherever they meet it.
      title: NOTIFICATION_CATEGORY_TITLE[category] ?? 'Уведомление',
      href: linkFor(payload),
      readAt: readAt instanceof Date ? readAt.toISOString() : readAt === null ? null : String(readAt),
      createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
    };
  });

  return (
    <div className="container" style={{ paddingBlock: 'var(--space-5) var(--space-7)', maxWidth: '44rem' }}>
      <header className="stack" style={{ gap: 'var(--space-1)', marginBottom: 'var(--space-4)' }}>
        <h1 className="title-lg">Уведомления</h1>
        <p className="text-sm muted">
          Всё, о чём вам сообщила Кватэрка: запросы на бронирование, решения, напоминания.{' '}
          <Link href="/dashboard/account" className="link">
            Настроить, что присылать
          </Link>
        </p>
      </header>

      {items.length === 0 ? (
        <EmptyState
          title="Пока ничего нет"
          description="Здесь появятся запросы на бронирование, ответы хозяев, напоминания о заезде и решения по проверке."
          action={
            <Link href="/search" className="btn btn-primary">
              Смотреть квартиры
            </Link>
          }
        />
      ) : (
        <NotificationList items={items} />
      )}
    </div>
  );
}
