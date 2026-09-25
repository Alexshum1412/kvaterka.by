import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { TicketActions, type AvailableTicketAction } from '@/ui/ticket-actions.tsx';
import { Icon } from '@/ui/icons.tsx';
import { TICKET_CATEGORY_LABEL, type TicketCategory } from '@/server/domain/support-ticket.ts';

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

const EVENT_KEYS = [
  'OPENED',
  'USER_REPLY',
  'RESUMED_BY_REPLY',
  'INTERNAL_NOTE',
  'ASSIGNED',
  'UNASSIGNED',
  'STATUS_TAKE',
  'STATUS_REQUEST_INFO',
  'STATUS_RESUME',
  'STATUS_RESOLVE',
  'STATUS_CLOSE',
  'STATUS_REOPEN',
] as const;

function stamp(value: string | null, locale: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

/**
 * One ticket, as a working file — a sibling of `/staff/disputes/[id]`,
 * without the evidence sections a booking dispute needs (no messages,
 * finance or moderation history to gate): a ticket carries one thread and
 * one decision, so the whole file is visible to anyone holding `case.view`.
 */
export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations('SupportTickets');
  const locale = await getLocale();
  const user = await currentUser();
  if (!user) redirect({ href: signInUrl(`/staff/tickets/${id}`), locale });
  if (!can(user!.roles, 'case.view')) notFound();

  const EVENT_LABEL: Record<string, string> = Object.fromEntries(
    EVENT_KEYS.map((key) => [key, t(`event_${key}`)]),
  );

  const services = await readyServices();
  const staff = {
    userId: user!.userId,
    role: user!.roles.includes('ADMIN') ? 'ADMIN' : (user!.roles[0] ?? 'STAFF'),
    canView: true,
    canHandle: can(user!.roles, 'case.handle'),
    canResolve: can(user!.roles, 'case.resolve'),
  };

  let detail: Record<string, any>;
  try {
    detail = (await services.tickets.detail(id, staff)) as Record<string, any>;
  } catch {
    notFound();
  }

  const assignable = staff.canHandle
    ? ((await services.tickets.assignableStaff(staff)) as { id: string; displayName: string }[])
    : [];

  const status = STATUS_TONE[detail.status] ?? 'solid-neutral';
  const property = detail.property as Record<string, any> | null;
  const timeline = detail.timeline as Record<string, any>[];
  const openedBy = detail.openedBy as Record<string, any>;

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/tickets"
      title={t('detailTitle', { reference: detail.reference })}
      subtitle={TICKET_CATEGORY_LABEL[detail.category as TicketCategory] ?? detail.category}
    >
      <Link href="/staff/tickets" className="tkd__back">
        <Icon name="arrowLeft" size={15} />
        {t('backToQueue')}
      </Link>

      <div className="tkd__banner">
        <span className={`badge badge-${status}`}>{t(`status_${detail.status}`)}</span>
        <span className="tkd__age">{t('ageOpened', { hours: Number(detail.ageHours) })}</span>
      </div>

      <div className="tkd__layout">
        <div className="tkd__main">
          <section className="tkd__section">
            <h2 className="tkd__h2">{t('sectionWhatHappened')}</h2>
            <p className="tkd__summary">{detail.summary}</p>
            {detail.resolution && (
              <div className="tkd__resolution">
                <strong>{t('resolutionLabel')}</strong>
                <p>{detail.resolution}</p>
                <span className="hint">{t('resolvedAt', { date: stamp(detail.resolvedAt, locale) })}</span>
              </div>
            )}
          </section>

          <section className="tkd__section">
            <h2 className="tkd__h2">{t('sectionAuthor')}</h2>
            <p className="text-sm">
              {openedBy.displayName}
              {openedBy.email ? ` · ${openedBy.email}` : ''}
            </p>
            {property && (
              <p className="tkd__property">
                <Icon name="home" size={15} />
                {property.title}
                {property.city ? ` · ${property.city}` : ''}
                {' · '}
                <Link href={`/listing/${property.id}`} className="link">
                  {t('factProperty')}
                </Link>
              </p>
            )}
          </section>

          {timeline.length > 0 && (
            <section className="tkd__section">
              <h2 className="tkd__h2">{t('sectionHistory')}</h2>
              <ol className="tkd__timeline">
                {timeline.map((e, index) => (
                  <li key={index} className={e.internal ? 'tkd__event is-internal' : 'tkd__event'}>
                    <span className="tkd__eventDot" aria-hidden="true" />
                    <span className="tkd__eventBody">
                      <span className="tkd__eventTop">
                        <strong>{EVENT_LABEL[e.type] ?? e.type}</strong>
                        {e.internal && <span className="tkd__internal">{t('internalOnlyBadge')}</span>}
                      </span>
                      {e.note && <span className="tkd__eventNote">{e.note}</span>}
                      <span className="tkd__eventWhen">
                        {stamp(e.at, locale)}
                        {e.actorName ? ` · ${e.actorName}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <aside className="tkd__aside">
          <section className="panel">
            <h2 className="tkd__asideH2">{t('sectionActions')}</h2>
            <TicketActions
              ticketId={id}
              actions={detail.availableActions as AvailableTicketAction[]}
              canHandle={staff.canHandle}
              assignedTo={detail.assignedTo ?? null}
              assignableStaff={assignable}
              currentUserId={user!.userId}
            />
          </section>
        </aside>
      </div>

      <style>{`
        .tkd__back { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.5rem; font-size: var(--text-sm); color: var(--text-secondary); }
        @media (hover: hover) and (pointer: fine) {
          .tkd__back:hover { color: var(--text-primary); }
        }

        .tkd__banner { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-block: var(--space-3) var(--space-5); }
        .tkd__age { font-size: var(--text-xs); color: var(--text-tertiary); }

        .tkd__layout { display: grid; gap: var(--space-6); }
        @media (min-width: 960px) {
          .tkd__layout { grid-template-columns: minmax(0, 1fr) 21rem; align-items: start; }
          .tkd__aside { position: sticky; top: calc(var(--header-height) + 0.75rem); }
        }
        .tkd__main { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; align-content: start; }
        .tkd__aside { display: grid; gap: var(--space-3); min-width: 0; }

        .tkd__section { padding-block: var(--space-5); }
        .tkd__section:first-child { padding-top: 0; }
        .tkd__section + .tkd__section { border-top: 1px solid var(--border); }
        .tkd__h2 { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }
        .tkd__asideH2 { font-size: var(--text-sm); font-weight: 600; margin-bottom: var(--space-3); }

        .tkd__summary { font-size: var(--text-sm); line-height: 1.6; white-space: pre-wrap; max-width: 68ch; }
        .tkd__resolution {
          display: grid; gap: 0.2rem; margin-top: var(--space-4);
          padding: var(--space-3); background: var(--success-soft); border-radius: var(--radius-sm);
          font-size: var(--text-sm);
        }
        .tkd__property { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; font-size: var(--text-sm); margin-top: var(--space-2); }
        .tkd__property > svg { color: var(--text-tertiary); }

        .tkd__timeline { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
        .tkd__event { display: flex; align-items: flex-start; gap: var(--space-3); }
        .tkd__eventDot { width: 8px; height: 8px; margin-top: 0.4rem; border-radius: var(--radius-full); background: var(--primary); flex: 0 0 auto; }
        .tkd__event.is-internal .tkd__eventDot { background: var(--border-control); }
        .tkd__eventBody { display: grid; gap: 0.1rem; min-width: 0; }
        .tkd__eventTop { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-sm); }
        .tkd__internal {
          font-size: var(--text-2xs); font-weight: 600; color: var(--text-tertiary);
          padding: 0.05rem 0.35rem; border-radius: var(--radius-full); background: var(--surface-sunken);
        }
        .tkd__eventNote { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; white-space: pre-wrap; max-width: 68ch; }
        .tkd__eventWhen { font-size: var(--text-2xs); color: var(--text-tertiary); }
      `}</style>
    </StaffShell>
  );
}
