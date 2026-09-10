import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { VerificationDecision, type AvailableAction } from '@/ui/verification-decision.tsx';
import { Icon } from '@/ui/icons.tsx';
import {
  BASIS_EXPECTED_DOCUMENT,
  LEVEL_CLAIM,
  LEVEL_LABEL,
  OWNERSHIP_BASIS_LABEL,
  REASON_SHORT,
  STATUS_LABEL,
  type OwnershipBasis,
  type VerificationReasonCode,
} from '@/server/domain/verification.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('StaffVerification');
  return { title: t('detailMetaTitle'), robots: { index: false, follow: false } };
}

/**
 * One verification request, as a working file.
 *
 * The order is the order a verifier works in: who is asking, what they claim,
 * what the platform holds about them, then the decision.
 *
 * NO DOCUMENT IS SHOWN HERE. The list is metadata — type, date, whether it has
 * been purged, how many times it has been opened. Opening one is a separate
 * request to `GET /admin/verification/documents/:id`, which demands a stated
 * purpose and writes an access-log row before the key leaves the server. The
 * link is rendered only for a caller holding `document.read`, and the fact that
 * it is missing is stated rather than left as an absence.
 */

const STATUS_TONE: Record<string, string> = {
  SUBMITTED: 'warning',
  IN_REVIEW: 'primary',
  NEEDS_INFO: 'warning',
  APPROVED: 'verified',
  REJECTED: 'danger',
  EXPIRED: 'solid-neutral',
};

function stamp(value: string | null, months: readonly string[]): string {
  if (!value) return '—';
  const iso = new Date(value).toISOString();
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${months[Number(m) - 1]}, ${iso.slice(11, 16)}`;
}

function monthYear(value: string | null, months: readonly string[]): string {
  if (!value) return '—';
  const iso = new Date(value).toISOString();
  const [y, m] = iso.slice(0, 10).split('-');
  return `${months[Number(m) - 1]} ${y}`;
}

export default async function VerificationCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl(`/staff/verification/${id}`), locale });
  if (!can(user!.roles, 'verification.review')) notFound();

  const t = await getTranslations('StaffVerification');
  const months = t.raw('case.months') as string[];
  const docTypeLabels = t.raw('case.documents.docType') as Record<string, string>;
  const eventLabels = t.raw('case.timeline.event') as Record<string, string>;

  const services = await readyServices();
  const staff = {
    userId: user!.userId,
    role: user!.roles.includes('VERIFIER') ? 'VERIFIER' : 'ADMIN',
    canReview: true,
    canDecide: can(user!.roles, 'verification.decide'),
    canReadDocuments: can(user!.roles, 'document.read'),
  };

  let detail: Record<string, any>;
  try {
    detail = (await services.verification.detail(id, staff)) as Record<string, any>;
  } catch {
    notFound();
  }

  const assignable = (await services.verification.assignableStaff(staff)) as {
    id: string;
    displayName: string;
  }[];

  const applicant = detail.applicant as Record<string, any>;
  const property = detail.property as Record<string, any> | null;
  const documents = detail.documents as Record<string, any>[];
  const timeline = detail.timeline as Record<string, any>[];
  const priorDecisions = detail.priorDecisions as Record<string, any>[];
  const declared = (detail.declared ?? {}) as { ownershipBasis?: OwnershipBasis; note?: string };
  const evidence = detail.evidence as Record<string, any>;
  const tone = STATUS_TONE[detail.status] ?? 'solid-neutral';

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/verification"
      title={t('case.title', { name: applicant.displayName, level: detail.targetLevel })}
      subtitle={detail.kind === 'IDENTITY' ? t('case.subtitleIdentity') : t('case.subtitleOwnership')}
    >
      <Link href="/staff/verification" className="vc__back">
        <Icon name="arrowLeft" size={15} />
        {t('case.back')}
      </Link>

      <div className="vc__banner">
        <span className={`badge badge-${tone}`}>{STATUS_LABEL[detail.status as keyof typeof STATUS_LABEL] ?? detail.status}</span>
        <span className="badge badge-solid-neutral">
          {detail.priority === 'HIGH' ? t('case.priorityHigh') : t('case.priorityNormal')}
        </span>
        {detail.overdue && (
          <span className="badge badge-danger">
            <Icon name="alert" size={12} />
            {t('case.overdueTag', { hours: detail.slaHours })}
          </span>
        )}
        <span className="vc__age">{t('case.waiting', { count: Number(detail.ageHours) })}</span>
      </div>

      <div className="vc__layout">
        <div className="vc__main">
          <section className="vc__section">
            <h2 className="vc__h2">{t('case.applicant.sectionTitle')}</h2>
            <div className="vc__facts">
              <Fact label={t('case.applicant.factNow')} value={LEVEL_LABEL[applicant.level as 0 | 1 | 2] ?? String(applicant.level)} />
              <Fact label={t('case.applicant.factWants')} value={LEVEL_LABEL[detail.targetLevel as 1 | 2] ?? String(detail.targetLevel)} />
              <Fact label={t('case.applicant.factMemberSince')} value={monthYear(applicant.memberSince, months)} />
              <Fact
                label={t('case.applicant.factRentals')}
                value={t('case.applicant.rentalsValue', {
                  tenant: applicant.completedAsTenant,
                  landlord: applicant.completedAsLandlord,
                })}
              />
              <Fact
                label={t('case.applicant.factRating')}
                value={
                  applicant.rating === null
                    ? t('case.applicant.noReviews')
                    : t('case.applicant.ratingValue', { rating: Number(applicant.rating).toFixed(1), count: applicant.reviewCount })
                }
              />
              <Fact
                label={t('case.applicant.factContacts')}
                value={`${applicant.emailVerified ? t('case.applicant.emailVerified') : t('case.applicant.emailUnverified')} · ${applicant.phoneVerified ? t('case.applicant.phoneVerified') : t('case.applicant.phoneUnverified')}`}
              />
            </div>
            <p className="vc__row2">
              {applicant.hasPublishedListing && (
                <span className="badge badge-warning">{t('case.applicant.listingLiveBadge')}</span>
              )}
              {applicant.accountStatus !== 'ACTIVE' && (
                <span className="badge badge-danger">{t('case.applicant.accountStatusBadge', { status: applicant.accountStatus })}</span>
              )}
              <Link href={`/profiles/${applicant.id}`} className="link text-sm">
                {t('case.applicant.publicProfileLink')}
              </Link>
            </p>
            <p className="hint">{t('case.applicant.hint')}</p>
          </section>

          {detail.kind === 'PROPERTY_OWNERSHIP' && (
            <section className="vc__section">
              <h2 className="vc__h2">{t('case.property.sectionTitle')}</h2>
              {property ? (
                <>
                  <div className="vc__facts">
                    <Fact label={t('case.property.factListing')} value={property.title} />
                    <Fact
                      label={t('case.property.factWhere')}
                      value={property.district ? `${property.city}, ${property.district}` : property.city}
                    />
                    <Fact label={t('case.property.factStatus')} value={property.status} />
                    <Fact
                      label={t('case.property.factVerified')}
                      value={property.verified ? t('case.property.yes') : t('case.property.no')}
                    />
                  </div>
                  <p className="vc__row2">
                    <Link href={`/listing/${property.id}`} className="link text-sm">
                      {t('case.property.openListingLink')}
                    </Link>
                  </p>
                </>
              ) : (
                <p className="text-sm muted">{t('case.property.unavailable')}</p>
              )}

              {declared.ownershipBasis ? (
                <div className="vc__declared">
                  <strong>{OWNERSHIP_BASIS_LABEL[declared.ownershipBasis]}</strong>
                  <p className="text-xs muted">
                    {t('case.property.expectedDocument', { doc: BASIS_EXPECTED_DOCUMENT[declared.ownershipBasis] })}
                  </p>
                  {declared.note && <p className="vc__declaredNote">{declared.note}</p>}
                  <p className="hint">{t('case.property.declaredHint')}</p>
                </div>
              ) : (
                <p className="text-sm muted">{t('case.property.notStated')}</p>
              )}

              <p className="hint">{t('case.property.addressHint')}</p>
            </section>
          )}

          <section className="vc__section">
            <h2 className="vc__h2">
              {t('case.documents.sectionTitle')}
              <span className="vc__count">{documents.length}</span>
            </h2>

            {!evidence.collectionEnabled && (
              <p className="vc__legal">
                <Icon name="shield" size={16} />
                {t.rich('case.documents.legalNoticeRich', { code: (chunks) => <code>{chunks}</code> })}
              </p>
            )}

            {documents.length === 0 ? (
              <p className="text-sm muted">{t('case.documents.none')}</p>
            ) : (
              <ul className="vc__docs">
                {documents.map((d) => (
                  <li key={d.id} className="vc__doc">
                    <span className="vc__docMain">
                      <strong className="vc__docType">{docTypeLabels[d.docType] ?? d.docType}</strong>
                      <span className="vc__docMeta">
                        {t('case.documents.uploadedAt', { date: stamp(d.uploadedAt, months) })}
                        {d.purged ? ` · ${t('case.documents.purgedSuffix')}` : ''}
                        {d.readCount > 0
                          ? ` · ${t('case.documents.openedCount', { count: Number(d.readCount) })}`
                          : ` · ${t('case.documents.neverOpened')}`}
                      </span>
                    </span>
                    {staff.canReadDocuments && !d.purged ? (
                      // Goes to the logged route, which requires a stated purpose.
                      <span className="vc__docAction text-xs muted">{t('case.documents.readOnlyLogged')}</span>
                    ) : (
                      <span className="vc__docLocked text-xs">
                        <Icon name="shield" size={13} />
                        {d.purged ? t('case.documents.lockedPurged') : t('case.documents.lockedNoAccess')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <p className={evidence.sufficient ? 'vc__ok' : 'vc__missing'}>
              <Icon name={evidence.sufficient ? 'checkCircle' : 'info'} size={15} />
              {evidence.explanation}
            </p>
          </section>

          {priorDecisions.length > 0 && (
            <section className="vc__section">
              <h2 className="vc__h2">{t('case.prior.sectionTitle')}</h2>
              <ul className="vc__prior">
                {priorDecisions.map((p) => (
                  <li key={p.id}>
                    <span className={`badge badge-${STATUS_TONE[p.status] ?? 'solid-neutral'}`}>
                      {STATUS_LABEL[p.status as keyof typeof STATUS_LABEL] ?? p.status}
                    </span>{' '}
                    {t('case.prior.levelLine', { level: p.targetLevel, date: stamp(p.decidedAt, months) })}
                    {(p.reasonCodes as VerificationReasonCode[]).length > 0 && (
                      <span className="vc__priorCodes">
                        {(p.reasonCodes as VerificationReasonCode[])
                          .map((c) => REASON_SHORT[c])
                          .join(', ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="hint">{t('case.prior.hint')}</p>
            </section>
          )}

          {(detail.fraudSignals as Record<string, any>[]).length > 0 && (
            <section className="vc__section">
              <h2 className="vc__h2">{t('case.signals.sectionTitle')}</h2>
              <ul className="vc__signals">
                {(detail.fraudSignals as Record<string, any>[]).map((s, i) => (
                  <li key={i}>
                    {s.kind} · {t('case.signals.weight')} {s.severity} · {stamp(s.detectedAt, months)}
                    {s.outcome ? ` · ${s.outcome}` : ''}
                  </li>
                ))}
              </ul>
              <p className="hint">{t('case.signals.hint')}</p>
            </section>
          )}

          <section className="vc__section">
            <h2 className="vc__h2">{t('case.timeline.sectionTitle')}</h2>
            <ol className="vc__timeline">
              {timeline.map((e, i) => (
                <li key={i} className={e.internal ? 'vc__event is-internal' : 'vc__event'}>
                  <span className="vc__eventDot" aria-hidden="true" />
                  <span className="vc__eventBody">
                    <span className="vc__eventTop">
                      <strong>{eventLabels[e.type] ?? e.type}</strong>
                      {e.internal ? (
                        <span className="vc__tag">{t('case.timeline.internalTag')}</span>
                      ) : (
                        <span className="vc__tag vc__tag--seen">{t('case.timeline.seenTag')}</span>
                      )}
                    </span>
                    {(e.reasonCodes as VerificationReasonCode[]).length > 0 && (
                      <span className="vc__eventCodes">
                        {(e.reasonCodes as VerificationReasonCode[]).map((c) => REASON_SHORT[c]).join(', ')}
                      </span>
                    )}
                    {e.note && <span className="vc__eventNote">{e.note}</span>}
                    <span className="vc__eventWhen">
                      {stamp(e.at, months)}
                      {e.actorName ? ` · ${e.actorName}` : ''}
                      {e.actorRole ? ` · ${e.actorRole}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="vc__aside">
          <section className="panel">
            <h2 className="vc__asideH2">{t('case.aside.whatHappensTitle')}</h2>
            <p className="vc__claim">{LEVEL_CLAIM[detail.targetLevel as 1 | 2]}</p>
            <p className="hint">{t('case.aside.whatHappensHint')}</p>
          </section>

          <section className="panel">
            <h2 className="vc__asideH2">{t('case.aside.decisionTitle')}</h2>
            <VerificationDecision
              requestId={id}
              actions={detail.availableActions as AvailableAction[]}
              evidence={{
                sufficient: evidence.sufficient === true,
                explanation: String(evidence.explanation),
                collectionEnabled: evidence.collectionEnabled === true,
              }}
              assignedTo={detail.assignedTo ?? null}
              assignableStaff={assignable}
              currentUserId={user!.userId}
              canReadDocuments={staff.canReadDocuments}
            />
          </section>

          {detail.internalNote && (
            <section className="panel">
              <h2 className="vc__asideH2">{t('case.aside.internalNoteTitle')}</h2>
              <p className="text-sm">{detail.internalNote}</p>
              <p className="hint">{t('case.aside.internalNoteHint')}</p>
            </section>
          )}
        </aside>
      </div>

      <style>{`
        .vc__back { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.5rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .vc__back:hover { color: var(--text-primary); }

        .vc__banner { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-block: var(--space-3) var(--space-5); }
        .vc__age { font-size: var(--text-xs); color: var(--text-tertiary); }

        .vc__layout { display: grid; gap: var(--space-6); }
        @media (min-width: 960px) {
          .vc__layout { grid-template-columns: minmax(0, 1fr) 21rem; align-items: start; }
          .vc__aside { position: sticky; top: calc(var(--header-height) + 0.75rem); }
        }
        .vc__main { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; align-content: start; }
        .vc__aside { display: grid; gap: var(--space-3); min-width: 0; }

        .vc__section { padding-block: var(--space-5); }
        .vc__section:first-child { padding-top: 0; }
        .vc__section + .vc__section { border-top: 1px solid var(--border); }
        .vc__h2 { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }
        .vc__asideH2 { font-size: var(--text-sm); font-weight: 600; margin-bottom: var(--space-3); }
        .vc__count { font-size: var(--text-2xs); font-weight: 700; padding: 0.05rem 0.35rem; border-radius: var(--radius-full); background: var(--surface-sunken); color: var(--text-secondary); }

        .vc__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--space-3); margin-bottom: var(--space-3); }
        .vc__fact { display: grid; gap: 0.1rem; }
        .vc__factLabel { font-size: var(--text-2xs); color: var(--text-tertiary); }
        .vc__factValue { font-size: var(--text-sm); font-weight: 500; }
        .vc__row2 { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-2); }

        .vc__declared { display: grid; gap: 0.2rem; padding: var(--space-3); margin-block: var(--space-3); background: var(--surface-sunken); border-radius: var(--radius-sm); }
        .vc__declared strong { font-size: var(--text-sm); }
        .vc__declaredNote { font-size: var(--text-sm); color: var(--text-secondary); white-space: pre-wrap; }

        .vc__legal {
          display: flex; align-items: flex-start; gap: 0.45rem;
          padding: var(--space-3); margin-bottom: var(--space-3);
          background: var(--warning-soft); border-radius: var(--radius-sm);
          font-size: var(--text-xs); line-height: 1.5; color: var(--text-secondary);
        }
        .vc__legal > svg { color: var(--warning); flex: 0 0 auto; margin-top: 0.1rem; }
        /* A flag name is one 33-character unbreakable token in a monospace
           face. At 375 it cannot wrap, so it set the width of the whole page
           and scrolled it sideways. */
        .vc__legal code { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }

        .vc__docs { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
        .vc__doc {
          display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
          padding: var(--space-3); background: var(--surface); border-radius: var(--radius-sm);
        }
        .vc__docMain { display: grid; gap: 0.1rem; min-width: 0; }
        .vc__docType { font-size: var(--text-sm); }
        .vc__docMeta { font-size: var(--text-2xs); color: var(--text-tertiary); }
        .vc__docAction, .vc__docLocked { flex: 0 0 auto; }
        .vc__docLocked { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--text-tertiary); }

        .vc__ok, .vc__missing { display: flex; align-items: flex-start; gap: 0.4rem; margin-top: var(--space-3); font-size: var(--text-xs); line-height: 1.5; }
        .vc__ok { color: var(--success); }
        .vc__missing { color: var(--text-secondary); }
        .vc__ok > svg, .vc__missing > svg { flex: 0 0 auto; margin-top: 0.1rem; }

        .vc__prior, .vc__signals { display: grid; gap: 0.35rem; margin: 0 0 var(--space-2); padding: 0; list-style: none; font-size: var(--text-xs); color: var(--text-secondary); }
        .vc__priorCodes { display: block; color: var(--text-tertiary); }

        .vc__timeline { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
        .vc__event { display: flex; align-items: flex-start; gap: var(--space-3); }
        .vc__eventDot { width: 8px; height: 8px; margin-top: 0.4rem; border-radius: var(--radius-full); background: var(--primary); flex: 0 0 auto; }
        .vc__event.is-internal .vc__eventDot { background: var(--border-control); }
        .vc__eventBody { display: grid; gap: 0.1rem; min-width: 0; }
        .vc__eventTop { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-sm); }
        .vc__tag { font-size: var(--text-2xs); font-weight: 600; padding: 0.05rem 0.35rem; border-radius: var(--radius-full); background: var(--surface-sunken); color: var(--text-tertiary); }
        .vc__tag--seen { background: var(--primary-soft); color: var(--primary); }
        .vc__eventCodes { font-size: var(--text-2xs); color: var(--text-tertiary); }
        .vc__eventNote { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.5; white-space: pre-wrap; max-width: 64ch; }
        .vc__eventWhen { font-size: var(--text-2xs); color: var(--text-tertiary); }

        .vc__claim { font-size: var(--text-sm); font-weight: 500; margin-bottom: var(--space-2); }
      `}</style>
    </StaffShell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="vc__fact">
      <span className="vc__factLabel">{label}</span>
      <span className="vc__factValue">{value}</span>
    </div>
  );
}
