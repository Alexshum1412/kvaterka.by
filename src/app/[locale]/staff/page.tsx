import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready, readyServices } from '@/server/runtime.ts';
import { checkOperations } from '@/server/services/watchdog.ts';
import { listRecentErrors } from '@/server/services/error-log.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('StaffOverview');
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

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
  const t = await getTranslations('StaffOverview');
  const locale = await getLocale();
  const user = await currentUser();
  // `redirect` above never returns, but next-intl's generic typing for it
  // doesn't narrow `user` for the type checker the way `next/navigation`'s
  // does.
  if (!user) redirect({ href: signInUrl('/staff'), locale });
  // Not 403: whether an operations console exists is not something an ordinary
  // account needs confirmed.
  if (!can(user!.roles, 'case.view')) notFound();

  const services = await readyServices();
  const overview = (await services.disputes.overview({
    userId: user!.userId,
    role: user!.roles.includes('ADMIN') ? 'ADMIN' : (user!.roles[0] ?? 'STAFF'),
    canView: true,
    canHandle: can(user!.roles, 'case.handle'),
    canResolve: can(user!.roles, 'case.resolve'),
    canReadMessages: can(user!.roles, 'message.review'),
    canViewFinance: can(user!.roles, 'debt.view'),
  })) as Record<string, any>;

  const cards: Card[] = ([
    {
      key: 'pressing',
      label: t('cardPressingLabel'),
      detail: t('cardPressingDetail'),
      count: overview.disputes.pressing,
      href: '/staff/disputes?status=ACTIVE&priority=URGENT',
      icon: 'alert',
      tone: 'urgent',
      visible: true,
    },
    {
      key: 'open',
      label: t('cardOpenLabel'),
      detail: t('cardOpenDetail'),
      count: overview.disputes.open,
      href: '/staff/disputes?status=OPEN',
      icon: 'message',
      tone: 'action',
      visible: true,
    },
    {
      key: 'escalated',
      label: t('cardEscalatedLabel'),
      detail: t('cardEscalatedDetail'),
      count: overview.disputes.escalated,
      href: '/staff/disputes?status=ESCALATED',
      icon: 'arrowRight',
      tone: 'action',
      visible: true,
    },
    {
      key: 'mine',
      label: t('cardMineLabel'),
      detail: t('cardMineDetail'),
      count: overview.disputes.mine,
      href: '/staff/disputes?status=ACTIVE&assigned=ME',
      icon: 'users',
      tone: 'calm',
      visible: can(user!.roles, 'case.handle'),
    },
    {
      key: 'unassigned',
      label: t('cardUnassignedLabel'),
      detail: t('cardUnassignedDetail'),
      count: overview.disputes.unassigned,
      href: '/staff/disputes?status=ACTIVE&assigned=UNASSIGNED',
      icon: 'clock',
      tone: 'action',
      visible: can(user!.roles, 'case.handle'),
    },
    {
      key: 'listings',
      label: t('cardListingsLabel'),
      detail: t('cardListingsDetail'),
      count: overview.moderation.pendingListings,
      href: '/moderation',
      icon: 'checkCircle',
      tone: 'action',
      visible: can(user!.roles, 'listing.moderate'),
    },
    {
      key: 'frozen',
      label: t('cardFrozenLabel'),
      detail: t('cardFrozenDetail'),
      count: overview.finance.frozenBookings,
      href: '/staff/disputes?status=ACTIVE',
      icon: 'gauge',
      tone: 'calm',
      visible: can(user!.roles, 'debt.view'),
    },
    {
      key: 'flagged',
      label: t('cardFlaggedLabel'),
      detail: t('cardFlaggedDetail'),
      count: overview.reports.flaggedMessages,
      href: '/staff/messages',
      icon: 'shield',
      tone: 'calm',
      visible: can(user!.roles, 'message.review'),
    },
    {
      key: 'reports',
      label: t('cardReportsLabel'),
      detail: t('cardReportsDetail'),
      count: overview.reports.open,
      href: '/staff/reports',
      icon: 'info',
      tone: 'calm',
      visible: true,
    },
    {
      key: 'verification',
      label: t('cardVerificationLabel'),
      detail: t('cardVerificationDetail'),
      count: overview.verification.pending,
      href: '/staff/verification',
      icon: 'shieldCheck',
      tone: 'calm',
      visible: can(user!.roles, 'verification.review'),
    },
  ] satisfies Card[]).filter((c) => c.visible);

  /* The watchdog's view (DEC-086), for administrators: the same checks the
     lifecycle job alerts on, and what the error tracker has recorded. */
  const isAdmin = user!.roles.includes('ADMIN');
  const sql = await ready();
  const alerts = isAdmin ? await checkOperations(sql) : [];
  const errors = isAdmin ? await listRecentErrors(sql) : [];

  const pressing = cards.filter((c) => c.tone === 'urgent' && c.count > 0);
  const rest = cards.filter((c) => !pressing.includes(c));

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff"
      title={t('title')}
      subtitle={t('subtitle')}
    >
      {pressing.length === 0 && overview.disputes.open === 0 && (
        <p className="ov__calm">
          <Icon name="checkCircle" size={17} />
          {t('noUrgent')}
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
              <span className="ov__cardSoon">{t('screenNotReady')}</span>
            </div>
          );
        })}
      </div>

      {isAdmin && (
        <section className="ov__watch" aria-labelledby="ov-watch">
          <h2 id="ov-watch" className="ov__watchTitle">{t('watchdogTitle')}</h2>
          {alerts.length === 0 ? (
            <p className="ov__calm">
              <Icon name="checkCircle" size={17} />
              {t('watchdogCalm')}
            </p>
          ) : (
            <ul className="ov__alerts">
              {alerts.map((a) => (
                <li key={a.kind} className="ov__alert">
                  <Icon name="alert" size={16} />
                  <span>{t(`alert_${a.kind}`)}</span>
                  <strong className="numeric">{a.count}</strong>
                </li>
              ))}
            </ul>
          )}

          <h3 className="ov__watchSub">{t('errorsTitle')}</h3>
          {errors.length === 0 ? (
            <p className="ov__muted">{t('errorsEmpty')}</p>
          ) : (
            <ul className="ov__errors">
              {errors.map((e) => (
                <li key={e.fingerprint} className="ov__error">
                  <code className="ov__errorMsg">{e.message}</code>
                  <span className="ov__muted">
                    {e.source} · {e.path ?? '—'} · {t('errorsTimes', { count: e.count })} ·{' '}
                    {new Date(e.last_seen).toLocaleString(locale)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <style>{`
        .ov__watch { margin-top: var(--space-6); display: grid; gap: var(--space-3); }
        .ov__watchTitle { font-size: var(--text-xl); font-weight: 600; }
        .ov__watchSub { font-size: var(--text-base); font-weight: 600; margin-top: var(--space-3); }
        .ov__muted { font-size: var(--text-sm); color: var(--text-secondary); }
        .ov__alerts, .ov__errors { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
        .ov__alert {
          display: flex; align-items: center; gap: var(--space-2);
          padding: var(--space-3) var(--space-4); border-radius: var(--radius-sm);
          background: var(--warning-soft); font-size: var(--text-sm);
        }
        .ov__alert > svg { color: var(--warning); flex: 0 0 auto; }
        .ov__alert strong { margin-left: auto; }
        .ov__error { display: grid; gap: 0.2rem; padding-block: var(--space-2); border-top: 1px solid var(--border); }
        .ov__errorMsg { font-family: ui-monospace, monospace; font-size: var(--text-xs); overflow-wrap: anywhere; }
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
        @media (hover: hover) and (pointer: fine) {
          a.ov__card:hover { box-shadow: var(--shadow-raised); }
        }
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
