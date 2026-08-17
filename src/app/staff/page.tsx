import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Операции',
  robots: { index: false, follow: false },
};

/**
 * The operations overview.
 *
 * Every number here is a queue somebody can act on, and every one is a link
 * into that queue. There are no totals — «пользователей: 4 812» tells a support
 * agent nothing they can do anything about, and a console full of numbers
 * nobody acts on trains people to stop reading it.
 *
 * A card is rendered only if the caller could actually open what it counts.
 */

interface Card {
  key: string;
  label: string;
  detail: string;
  count: number;
  href: string | null;
  icon: IconName;
  tone: 'urgent' | 'action' | 'calm';
  visible: boolean;
}

export default async function StaffOverviewPage() {
  const user = await currentUser();
  if (!user) redirect(signInUrl('/staff'));
  // Not 403: whether an operations console exists is not something an ordinary
  // account needs confirmed.
  if (!can(user.roles, 'case.view')) notFound();

  const services = await readyServices();
  const overview = (await services.disputes.overview({
    userId: user.userId,
    role: user.roles.includes('ADMIN') ? 'ADMIN' : (user.roles[0] ?? 'STAFF'),
    canView: true,
    canHandle: can(user.roles, 'case.handle'),
    canResolve: can(user.roles, 'case.resolve'),
    canReadMessages: can(user.roles, 'message.review'),
    canViewFinance: can(user.roles, 'debt.view'),
  })) as Record<string, any>;

  const cards: Card[] = ([
    {
      key: 'pressing',
      label: 'Требуют внимания сейчас',
      detail: 'Безопасность, мошенничество или активное проживание.',
      count: overview.disputes.pressing,
      href: '/staff/disputes?status=ACTIVE&priority=URGENT',
      icon: 'alert',
      tone: 'urgent',
      visible: true,
    },
    {
      key: 'open',
      label: 'Новые обращения',
      detail: 'Их ещё никто не взял в работу.',
      count: overview.disputes.open,
      href: '/staff/disputes?status=OPEN',
      icon: 'message',
      tone: 'action',
      visible: true,
    },
    {
      key: 'escalated',
      label: 'Переданы выше',
      detail: 'Ждут решения администратора.',
      count: overview.disputes.escalated,
      href: '/staff/disputes?status=ESCALATED',
      icon: 'arrowRight',
      tone: 'action',
      visible: true,
    },
    {
      key: 'mine',
      label: 'На вас',
      detail: 'Назначенные вам и ещё не закрытые.',
      count: overview.disputes.mine,
      href: '/staff/disputes?status=ACTIVE&assigned=ME',
      icon: 'users',
      tone: 'calm',
      visible: can(user.roles, 'case.handle'),
    },
    {
      key: 'unassigned',
      label: 'Без исполнителя',
      detail: 'Открыты и ни на кого не назначены.',
      count: overview.disputes.unassigned,
      href: '/staff/disputes?status=ACTIVE&assigned=UNASSIGNED',
      icon: 'clock',
      tone: 'action',
      visible: can(user.roles, 'case.handle'),
    },
    {
      key: 'listings',
      label: 'Объявления на проверке',
      detail: 'Владельцы ждут ответа.',
      count: overview.moderation.pendingListings,
      href: '/moderation',
      icon: 'checkCircle',
      tone: 'action',
      visible: can(user.roles, 'listing.moderate'),
    },
    {
      key: 'frozen',
      label: 'Бронирования в споре',
      detail: 'Сбор не начисляется, пока идёт разбор.',
      count: overview.finance.frozenBookings,
      href: '/staff/disputes?status=ACTIVE',
      icon: 'gauge',
      tone: 'calm',
      visible: can(user.roles, 'debt.view'),
    },
    {
      key: 'flagged',
      label: 'Сообщения на проверке',
      detail: 'Фильтр контактов пометил их.',
      count: overview.reports.flaggedMessages,
      href: null,
      icon: 'shield',
      tone: 'calm',
      visible: can(user.roles, 'message.review'),
    },
    {
      key: 'reports',
      label: 'Жалобы',
      detail: 'На объявления, отзывы и сообщения.',
      count: overview.reports.open,
      href: null,
      icon: 'info',
      tone: 'calm',
      visible: true,
    },
    {
      key: 'verification',
      label: 'Заявки на верификацию',
      detail: 'Документы открывает только VERIFIER.',
      count: overview.verification.pending,
      href: null,
      icon: 'shieldCheck',
      tone: 'calm',
      visible: can(user.roles, 'verification.review'),
    },
  ] satisfies Card[]).filter((c) => c.visible);

  const pressing = cards.filter((c) => c.tone === 'urgent' && c.count > 0);
  const rest = cards.filter((c) => !pressing.includes(c));

  return (
    <StaffShell
      roles={user.roles}
      current="/staff"
      title="Операции"
      subtitle="Только то, по чему нужно принять решение."
    >
      {pressing.length === 0 && overview.disputes.open === 0 && (
        <p className="ov__calm">
          <Icon name="checkCircle" size={17} />
          Срочных обращений нет.
        </p>
      )}

      <div className="ov__grid">
        {[...pressing, ...rest].map((c) => {
          const body = (
            <>
              <span className="ov__cardTop">
                <Icon name={c.icon} size={16} />
                <span className="ov__cardLabel">{c.label}</span>
              </span>
              <span className="ov__cardCount numeric">{c.count}</span>
              <span className="ov__cardDetail">{c.detail}</span>
            </>
          );
          const className = `ov__card ov__card--${c.tone}${c.count > 0 ? ' is-live' : ''}`;
          return c.href ? (
            <Link key={c.key} href={c.href} className={className}>
              {body}
            </Link>
          ) : (
            <div key={c.key} className={className}>
              {body}
              {/* Honest about a queue that has no screen yet, rather than a
                  link that goes nowhere. */}
              <span className="ov__cardSoon">Экран ещё не готов — данные доступны через API</span>
            </div>
          );
        })}
      </div>

      <style>{`
        .ov__calm {
          display: flex; align-items: center; gap: 0.45rem;
          margin-bottom: var(--space-4); font-size: var(--text-sm);
          color: var(--success); font-weight: 500;
        }
        .ov__grid {
          display: grid; gap: var(--space-3);
          grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
        }
        .ov__card {
          display: grid; gap: 0.2rem; align-content: start;
          padding: var(--space-4);
          background: var(--surface); border-radius: var(--radius-md);
          min-height: 6.5rem;
        }
        a.ov__card:hover { box-shadow: var(--shadow-raised); }
        .ov__cardTop { display: flex; align-items: center; gap: 0.4rem; color: var(--text-tertiary); }
        .ov__cardLabel { font-size: var(--text-xs); font-weight: 500; color: var(--text-secondary); }
        .ov__cardCount { font-size: var(--text-2xl); font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; }
        .ov__cardDetail { font-size: var(--text-2xs); color: var(--text-tertiary); line-height: 1.4; }
        .ov__cardSoon { font-size: var(--text-2xs); color: var(--text-tertiary); font-style: italic; margin-top: 0.2rem; }

        /* Colour is not the only carrier: a live urgent card also gets the
           only left rule on the screen. */
        .ov__card--urgent.is-live { box-shadow: inset 3px 0 0 var(--error); }
        .ov__card--urgent.is-live .ov__cardCount { color: var(--error); }
        .ov__card--action.is-live .ov__cardCount { color: var(--primary); }
      `}</style>
    </StaffShell>
  );
}
