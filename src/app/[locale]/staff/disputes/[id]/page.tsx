import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { DisputeActions, type AvailableAction } from '@/ui/dispute-actions.tsx';
import { Icon } from '@/ui/icons.tsx';
import { Money, formatNightsLocalized } from '@/ui/primitives.tsx';
import { DISPUTE_CATEGORY_LABEL, type DisputeCategory } from '@/server/domain/dispute.ts';
import type { AppLocale } from '@/i18n/routing.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Disputes');
  return { title: t('detailMetaTitle'), robots: { index: false, follow: false } };
}

/**
 * One case, as a working file.
 *
 * The order is the order somebody actually works in: what happened, who is
 * involved, what the platform's own records say, then what to do about it. The
 * evidence sections come from `DisputeService.detail`, which assembles a
 * different file per caller — a section this caller is not entitled to is
 * absent rather than empty, and the screen says so in words instead of showing
 * a zero that reads as "there was nothing".
 */

const STATUS_TONE: Record<string, string> = {
  OPEN: 'warning',
  UNDER_REVIEW: 'primary',
  WAITING_FOR_PARTY: 'warning',
  ESCALATED: 'danger',
  RESOLVED: 'verified',
  CLOSED: 'solid-neutral',
};

const PRIORITY_TONE: Record<string, string> = {
  URGENT: 'danger',
  HIGH: 'warning',
  NORMAL: 'solid-neutral',
  LOW: 'neutral',
};

const EVENT_KEYS = [
  'OPENED_BY_PARTY',
  'INTERNAL_NOTE',
  'ASSIGNED',
  'UNASSIGNED',
  'BOOKING_OUTCOME',
  'STATUS_TAKE',
  'STATUS_RESUME',
  'STATUS_REQUEST_INFORMATION',
  'STATUS_ESCALATE',
  'STATUS_RESOLVE',
  'STATUS_CLOSE',
  'STATUS_REOPEN',
  // A party's own record, from `stay_event`.
  'STAY_CHECK_IN',
  'STAY_CHECK_OUT',
  // The booking's own state changes, from `booking_event`.
  'REQUEST',
  'INSTANT_BOOK',
  'ACCEPT_REQUEST',
  'DECLINE_REQUEST',
  'WITHDRAW',
  'EXPIRE',
  'CHECK_IN',
  'CHECK_OUT',
  'REACH_STAY_END',
  'CONFIRM_COMPLETION',
  'RESOLVE_COMPLETION',
  'CANCEL_BY_TENANT',
  'CANCEL_BY_LANDLORD',
  'OPEN_DISPUTE',
  'RESOLVE_DISPUTE_AS_COMPLETED',
  'RESOLVE_DISPUTE_AS_NOT_TAKEN_PLACE',
  'RESOLVE_DISPUTE_AS_CANCELLED',
] as const;

function stamp(value: string | null, months: readonly string[]): string {
  if (!value) return '—';
  const iso = new Date(value).toISOString();
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${months[Number(m) - 1]}, ${iso.slice(11, 16)}`;
}

function day(value: string | null, months: readonly string[]): string {
  if (!value) return '—';
  const [, m, d] = value.split('-');
  return `${Number(d)} ${months[Number(m) - 1]}`;
}

export default async function DisputeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations('Disputes');
  const locale = (await getLocale()) as AppLocale;
  const months = t.raw('months') as string[];
  const user = await currentUser();
  // `redirect` above never returns, but next-intl's generic typing for it
  // doesn't narrow `user` for the type checker the way `next/navigation`'s
  // does.
  if (!user) redirect({ href: signInUrl(`/staff/disputes/${id}`), locale });
  if (!can(user!.roles, 'case.view')) notFound();

  const STATUS_LABEL: Record<string, { label: string; tone: string }> = Object.fromEntries(
    Object.entries(STATUS_TONE).map(([key, tone]) => [key, { label: t(`statusDetail_${key}`), tone }]),
  );
  const PRIORITY_LABEL: Record<string, { label: string; tone: string }> = Object.fromEntries(
    Object.entries(PRIORITY_TONE).map(([key, tone]) => [key, { label: t(`priorityDetail_${key}`), tone }]),
  );
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
    canReadMessages: can(user!.roles, 'message.review'),
    canViewFinance: can(user!.roles, 'debt.view'),
  };

  let detail: Record<string, any>;
  try {
    detail = (await services.disputes.detail(id, staff)) as Record<string, any>;
  } catch {
    notFound();
  }

  const assignable = staff.canHandle
    ? ((await services.disputes.assignableStaff(staff)) as { id: string; displayName: string }[])
    : [];

  const status = STATUS_LABEL[detail.status] ?? { label: detail.status, tone: 'solid-neutral' };
  const priority = PRIORITY_LABEL[detail.priority] ?? PRIORITY_LABEL.NORMAL!;
  const booking = detail.booking as Record<string, any> | null;
  const property = detail.property as Record<string, any> | null;
  const parties = detail.parties as Record<string, any>[];
  const timeline = detail.timeline as Record<string, any>[];
  const entitlements = detail.entitlements as Record<string, boolean>;

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/disputes"
      title={t('detailTitle', { reference: detail.reference })}
      subtitle={DISPUTE_CATEGORY_LABEL[detail.category as DisputeCategory] ?? detail.category}
      badges={[
        { label: t('factStatus'), count: 0, tone: status.tone },
      ].slice(0, 0)}
    >
      <Link href="/staff/disputes" className="dd__back">
        <Icon name="arrowLeft" size={15} />
        {t('backToQueue')}
      </Link>

      <div className="dd__banner">
        <span className={`badge badge-${status.tone}`}>{status.label}</span>
        <span className={`badge badge-${priority.tone}`}>{priority.label}</span>
        {detail.overdue && (
          <span className="badge badge-danger">
            <Icon name="alert" size={12} />
            {t('overdueTargetBadge', { slaHours: detail.slaHours })}
          </span>
        )}
        <span className="dd__age">{t('ageOpened', { hours: Number(detail.ageHours) })}</span>
      </div>

      <div className="dd__layout">
        <div className="dd__main">
          <section className="dd__section">
            <h2 className="dd__h2">{t('sectionWhatHappened')}</h2>
            <p className="dd__summary">{detail.summary}</p>
            {detail.resolution && (
              <div className="dd__resolution">
                <strong>{t('resolutionLabel')}</strong>
                <p>{detail.resolution}</p>
                <span className="hint">{t('resolvedAt', { date: stamp(detail.resolvedAt, months) })}</span>
              </div>
            )}
          </section>

          {booking && (
            <section className="dd__section">
              <h2 className="dd__h2">{t('sectionBooking')}</h2>
              <div className="dd__facts">
                <Fact label={t('factNumber')} value={booking.reference} />
                <Fact label={t('factStatus')} value={booking.status} />
                <Fact
                  label={t('factDates')}
                  value={`${day(booking.stay.from, months)} — ${day(booking.stay.to, months)} · ${formatNightsLocalized(Number(booking.stay.nights), locale)}`}
                />
                <Fact
                  label={t('factCheckedInLabel')}
                  value={booking.checkedInAt ? stamp(booking.checkedInAt, months) : t('notMarked')}
                />
                <Fact
                  label={t('factTenantConfirmLabel')}
                  value={booking.completion.tenantAnswer ?? t('noAnswer')}
                />
                <Fact
                  label={t('factLandlordConfirmLabel')}
                  value={booking.completion.landlordAnswer ?? t('noAnswer')}
                />
              </div>
              {property && (
                <p className="dd__property">
                  <Icon name="home" size={15} />
                  {property.title} · {property.district ? `${property.city}, ${property.district}` : property.city}
                  {' · '}
                  <Link href={`/listing/${property.id}`} className="link">
                    {t('propertyListingLink')}
                  </Link>
                </p>
              )}
              <p className="hint">{t('addressHint')}</p>
            </section>
          )}

          <section className="dd__section">
            <h2 className="dd__h2">{t('sectionHistory')}</h2>
            <ol className="dd__timeline">
              {timeline.map((e, index) => (
                <li key={index} className={e.internal ? 'dd__event is-internal' : 'dd__event'}>
                  <span className="dd__eventDot" aria-hidden="true" />
                  <span className="dd__eventBody">
                    <span className="dd__eventTop">
                      <strong>{EVENT_LABEL[e.type] ?? e.type}</strong>
                      {e.kind === 'BOOKING' && e.to && (
                        <span className="dd__eventTag">{e.from} → {e.to}</span>
                      )}
                      {e.internal && <span className="dd__internal">{t('internalOnlyBadge')}</span>}
                    </span>
                    {e.note && <span className="dd__eventNote">{e.note}</span>}
                    <span className="dd__eventWhen">
                      {stamp(e.at, months)}
                      {e.actorName ? ` · ${e.actorName}` : ''}
                      {e.actorRole ? ` · ${e.actorRole}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="dd__section">
            <h2 className="dd__h2">{t('sectionEvidence')}</h2>

            <Evidence title={t('evidenceReviewsTitle')} empty={t('evidenceReviewsEmpty')}>
              {(detail.reviewState as Record<string, any>[]).map((r, i) => (
                <p key={i} className="dd__line">
                  {r.authorRole === 'TENANT' ? t('roleTenant') : t('roleLandlord')} ·{' '}
                  {t('reviewRating', { overall: r.overall })} ·{' '}
                  {r.status === 'PUBLISHED' ? t('reviewPublished') : t('reviewNotPublished')}
                </p>
              ))}
            </Evidence>

            <Evidence title={t('evidenceRiskTitle')} empty={t('evidenceRiskEmpty')}>
              {(detail.fraudSignals as Record<string, any>[]).map((s, i) => (
                <p key={i} className="dd__line">
                  {t('riskLine', { kind: s.kind, severity: s.severity, date: stamp(s.createdAt, months) })}
                </p>
              ))}
            </Evidence>

            <Evidence title={t('evidenceModerationTitle')} empty={t('evidenceModerationEmpty')}>
              {(detail.moderationHistory as Record<string, any>[]).map((m, i) => (
                <p key={i} className="dd__line">
                  {t('moderationLine', {
                    decision: m.decision,
                    codes: (m.reasonCodes as string[]).join(', ') || t('moderationNoCodes'),
                    date: stamp(m.createdAt, months),
                  })}
                </p>
              ))}
            </Evidence>

            {/* Absent, not empty: "нет доступа" and "переписки не было" are
                different statements and must not look the same. */}
            {entitlements.messages ? (
              <Evidence title={t('evidenceMessagesTitle')} empty={t('evidenceMessagesEmpty')}>
                {(detail.messages as Record<string, any>[] | undefined)?.map((m) => (
                  <p key={m.id} className="dd__line">
                    <strong>{m.senderName ?? t('messageSystemSender')}:</strong> {m.body}
                    {m.originalBody && m.originalBody !== m.body && (
                      <span className="dd__redacted">{t('messageRedacted', { text: m.originalBody })}</span>
                    )}
                  </p>
                ))}
              </Evidence>
            ) : (
              <Locked title={t('evidenceMessagesTitle')} need="message.review" lockedText={t('lockedNoAccessText')} />
            )}

            {entitlements.finance ? (
              <Evidence title={t('evidenceFinanceTitle')} empty={t('evidenceFinanceEmpty')}>
                {(() => {
                  const f = (detail.finance as Record<string, any> | undefined) ?? {};
                  return f.fee ? (
                    <>
                      <p className="dd__line">
                        {t('financeFeePrefix')} <Money minor={String(f.fee.feeMinor)} /> ({f.fee.ratePercent}%{' '}
                        {t('financeFeeOf')}{' '}
                        <Money minor={String(f.fee.baseMinor)} />) · {f.fee.status}
                      </p>
                      <p className="dd__line">
                        {t('financeBalancePrefix')} <Money minor={String(f.landlordBalanceMinor)} />
                      </p>
                    </>
                  ) : (
                    <p className="dd__line">
                      {t('financeNoFeePrefix')}{' '}
                      <Money minor={String(f.landlordBalanceMinor ?? '0')} />
                    </p>
                  );
                })()}
              </Evidence>
            ) : (
              <Locked title={t('evidenceFinanceTitle')} need="debt.view" lockedText={t('lockedNoAccessText')} />
            )}

            <Locked
              title={t('lockedDocumentsTitle')}
              need="document.read"
              lockedText={t('lockedNoAccessText')}
              note={t('lockedDocumentsNote')}
            />
          </section>
        </div>

        <aside className="dd__aside">
          <section className="panel">
            <h2 className="dd__asideH2">{t('sectionParties')}</h2>
            {parties.length === 0 && <p className="text-sm muted">{t('partiesNoData')}</p>}
            {parties.map((p) => (
              <div key={p.id} className="dd__party">
                <div className="dd__partyTop">
                  <strong className="dd__partyName">{p.displayName}</strong>
                  <span className="badge badge-solid-neutral">
                    {p.side === 'OPENED' ? t('partySideOpened') : t('partySideOther')}
                  </span>
                </div>
                <ul className="dd__partyFacts">
                  <li>
                    {p.identityVerified ? (
                      <span className="dd__ok">
                        <Icon name="checkCircle" size={13} />
                        {t('partyIdentityVerified')}
                      </span>
                    ) : (
                      <span className="muted">{t('partyIdentityNotVerified')}</span>
                    )}
                  </li>
                  {p.rating !== null && (
                    <li className="numeric">{t('partyRating', { rating: Number(p.rating).toFixed(1) })}</li>
                  )}
                  <li className="muted">
                    {t('partyCounts', { tenant: p.completedAsTenant, landlord: p.completedAsLandlord })}
                  </li>
                  <li className="muted">{t('partyTotalCases', { total: p.totalCases })}</li>
                  {p.accountStatus !== 'ACTIVE' && (
                    <li>
                      <span className="badge badge-danger">
                        {t('partyAccountStatus', { status: p.accountStatus })}
                      </span>
                    </li>
                  )}
                </ul>
                <Link href={`/profiles/${p.id}`} className="link text-xs">
                  {t('partyProfileLink')}
                </Link>
              </div>
            ))}
            <p className="hint dd__privacy">{t('partiesPrivacyHint')}</p>
          </section>

          <section className="panel">
            <h2 className="dd__asideH2">{t('sectionActions')}</h2>
            <DisputeActions
              caseId={id}
              actions={detail.availableActions as AvailableAction[]}
              canHandle={staff.canHandle}
              canResolve={staff.canResolve}
              assignedTo={detail.assignedTo ?? null}
              assignableStaff={assignable}
              currentUserId={user!.userId}
              bookingId={booking?.id ?? null}
              bookingStatus={booking?.status ?? null}
            />
          </section>
        </aside>
      </div>

      <style>{`
        .dd__back { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.5rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .dd__back:hover { color: var(--text-primary); }

        .dd__banner { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-block: var(--space-3) var(--space-5); }
        .dd__age { font-size: var(--text-xs); color: var(--text-tertiary); }

        .dd__layout { display: grid; gap: var(--space-6); }
        @media (min-width: 960px) {
          .dd__layout { grid-template-columns: minmax(0, 1fr) 21rem; align-items: start; }
          .dd__aside { position: sticky; top: calc(var(--header-height) + 0.75rem); }
        }
        .dd__main { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; align-content: start; }
        .dd__aside { display: grid; gap: var(--space-3); min-width: 0; }

        .dd__section { padding-block: var(--space-5); }
        .dd__section:first-child { padding-top: 0; }
        .dd__section + .dd__section { border-top: 1px solid var(--border); }
        .dd__h2 { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }
        .dd__asideH2 { font-size: var(--text-sm); font-weight: 600; margin-bottom: var(--space-3); }

        .dd__summary { font-size: var(--text-sm); line-height: 1.6; white-space: pre-wrap; max-width: 68ch; }
        .dd__resolution {
          display: grid; gap: 0.2rem; margin-top: var(--space-4);
          padding: var(--space-3); background: var(--success-soft); border-radius: var(--radius-sm);
          font-size: var(--text-sm);
        }

        .dd__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--space-3); margin-bottom: var(--space-3); }
        .dd__fact { display: grid; gap: 0.1rem; }
        .dd__factLabel { font-size: var(--text-2xs); color: var(--text-tertiary); }
        .dd__factValue { font-size: var(--text-sm); font-weight: 500; }
        .dd__property { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; font-size: var(--text-sm); margin-bottom: var(--space-2); }
        .dd__property > svg { color: var(--text-tertiary); }

        .dd__timeline { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
        .dd__event { display: flex; align-items: flex-start; gap: var(--space-3); }
        .dd__eventDot { width: 8px; height: 8px; margin-top: 0.4rem; border-radius: var(--radius-full); background: var(--primary); flex: 0 0 auto; }
        .dd__event.is-internal .dd__eventDot { background: var(--border-control); }
        .dd__eventBody { display: grid; gap: 0.1rem; min-width: 0; }
        .dd__eventTop { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-sm); }
        .dd__eventTag { font-size: var(--text-2xs); color: var(--text-tertiary); }
        .dd__internal {
          font-size: var(--text-2xs); font-weight: 600; color: var(--text-tertiary);
          padding: 0.05rem 0.35rem; border-radius: var(--radius-full); background: var(--surface-sunken);
        }
        .dd__eventNote { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; white-space: pre-wrap; max-width: 68ch; }
        .dd__eventWhen { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .dd__ev { margin-bottom: var(--space-4); }
        .dd__evTitle { font-size: var(--text-xs); font-weight: 600; color: var(--text-secondary); margin-bottom: 0.3rem; }
        .dd__line { font-size: var(--text-xs); color: var(--text-secondary); line-height: 1.6; }
        .dd__redacted { color: var(--warning); }
        .dd__locked {
          display: flex; align-items: flex-start; gap: 0.45rem;
          padding: var(--space-3); margin-bottom: var(--space-3);
          background: var(--surface-sunken); border-radius: var(--radius-sm);
          font-size: var(--text-xs); color: var(--text-secondary); line-height: 1.5;
        }
        .dd__locked > svg { color: var(--text-tertiary); flex: 0 0 auto; margin-top: 0.1rem; }
        .dd__lockedNeed { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }

        .dd__party { display: grid; gap: 0.3rem; padding-block: var(--space-3); }
        .dd__party + .dd__party { border-top: 1px solid var(--border); }
        .dd__partyTop { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
        .dd__partyName { font-size: var(--text-sm); }
        .dd__partyFacts { display: grid; gap: 0.2rem; margin: 0; padding: 0; list-style: none; font-size: var(--text-xs); }
        .dd__ok { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--success); font-weight: 600; }
        .dd__privacy { margin-top: var(--space-2); }
      `}</style>
    </StaffShell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="dd__fact">
      <span className="dd__factLabel">{label}</span>
      <span className="dd__factValue">{value}</span>
    </div>
  );
}

function Evidence({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children.flat().filter(Boolean) : children;
  const isEmpty = Array.isArray(items) ? items.length === 0 : !items;
  return (
    <div className="dd__ev">
      <p className="dd__evTitle">{title}</p>
      {isEmpty ? <p className="dd__line muted">{empty}</p> : items}
    </div>
  );
}

/** A section this caller is not entitled to. Named, so the absence is explicit. */
function Locked({
  title,
  need,
  lockedText,
  note,
}: {
  title: string;
  need: string;
  lockedText: string;
  note?: string;
}) {
  return (
    <div className="dd__locked">
      <Icon name="shield" size={15} />
      <span>
        <strong>{title}</strong> {lockedText}{' '}
        <span className="dd__lockedNeed">{need}</span>.{note ? ` ${note}` : ''}
      </span>
    </div>
  );
}
