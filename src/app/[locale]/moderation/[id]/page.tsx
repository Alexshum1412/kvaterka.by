import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { MapPanel } from '@/ui/map-panel.tsx';
import { Amenities } from '@/ui/amenities.tsx';
import { ModerationDecision } from '@/ui/moderation-decision.tsx';
import { Icon, type IconName } from '@/ui/icons.tsx';
import { Money, formatNightsGenitiveLocalized, propertyTypeLabel } from '@/ui/primitives.tsx';
import { MODERATION_REASON_TEXT, type ModerationReasonCode } from '@/server/domain/moderation.ts';
import type { AppLocale } from '@/i18n/routing.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Moderation');
  return { title: t('detailPageTitle'), robots: { index: false, follow: false } };
}

function when(iso: string): string {
  const [date, time] = iso.split('T');
  const [y, m, d] = (date ?? '').split('-');
  return `${Number(d)}.${m}.${y}, ${(time ?? '').slice(0, 5)}`;
}

export default async function ModerationDetailPage({
  params,
}: {
  params: Promise<{ id: string; locale: AppLocale }>;
}) {
  const { id, locale } = await params;
  const user = await currentUser();
  if (!user) redirect({ href: signInUrl(`/moderation/${id}`), locale });
  if (!can(user!.roles, 'listing.moderate')) notFound();

  const t = await getTranslations('Moderation');

  const SMOKING: Record<string, string> = {
    PROHIBITED: t('smokingProhibited'),
    ALLOWED: t('smokingAllowed'),
    BALCONY_ONLY: t('smokingBalconyOnly'),
  };
  const PETS: Record<string, string> = {
    PROHIBITED: t('petsProhibited'),
    ALLOWED: t('petsAllowed'),
    SMALL_ONLY: t('petsSmallOnly'),
    ON_REQUEST: t('petsOnRequest'),
  };
  const DECISION_LABEL: Record<string, string> = {
    PUBLISHED: t('decisionPublished'),
    REJECTED: t('decisionRejected'),
    PAUSED: t('decisionPaused'),
  };
  const STATUS_BADGE: Record<string, { label: string; tone: string }> = {
    PENDING_MODERATION: { label: t('statusPending'), tone: 'warning' },
    PUBLISHED: { label: t('statusPublished'), tone: 'verified' },
    REJECTED: { label: t('statusRejected'), tone: 'danger' },
    PAUSED: { label: t('statusPaused'), tone: 'solid-neutral' },
    DRAFT: { label: t('statusDraft'), tone: 'solid-neutral' },
  };

  const services = await readyServices();
  let listing: Record<string, any>;
  let history: Awaited<ReturnType<typeof services.listings.moderationHistory>>;
  try {
    listing = (await services.listings.getForModeration(id)) as Record<string, any>;
    history = await services.listings.moderationHistory(id);
  } catch {
    notFound();
  }

  const pricing = listing.pricing as Record<string, string>;
  const rules = listing.rules as Record<string, any>;
  const owner = listing.owner as Record<string, any>;
  const duration = listing.duration as { minNights: number; maxNights: number };
  const photos = listing.photos as { id: string; storageKey: string; isCover: boolean; width: number | null; height: number | null }[];
  const badge = STATUS_BADGE[listing.status] ?? { label: listing.status, tone: 'solid-neutral' };

  const facts: { icon: IconName; label: string; value: string }[] = [
    { icon: 'home', label: t('factType'), value: propertyTypeLabel(listing.propertyType, locale) },
    listing.rooms !== null && { icon: 'rooms' as IconName, label: t('factRooms'), value: String(listing.rooms) },
    listing.areaSqm && { icon: 'area' as IconName, label: t('factArea'), value: t('areaValue', { value: Math.round(Number(listing.areaSqm)) }) },
    listing.floor !== null && {
      icon: 'floors' as IconName,
      label: t('factFloor'),
      value: listing.totalFloors ? t('floorOf', { floor: listing.floor, total: listing.totalFloors }) : String(listing.floor),
    },
    listing.beds !== null && { icon: 'bed' as IconName, label: t('factBeds'), value: String(listing.beds) },
    listing.bathrooms !== null && { icon: 'bath' as IconName, label: t('factBathrooms'), value: String(listing.bathrooms) },
    { icon: 'users', label: t('factGuests'), value: String(listing.maxGuests) },
  ].filter(Boolean) as { icon: IconName; label: string; value: string }[];

  return (
    <div className="container mdp">
      <nav className="mdp__back">
        <Link href="/moderation" className="mdp__backLink">
          <Icon name="arrowLeft" size={16} />
          {t('backToQueue')}
        </Link>
      </nav>

      <header className="mdp__head">
        <div className="mdp__headMain">
          <div className="mdp__titleRow">
            <h1 className="mdp__title">{listing.title || t('untitled')}</h1>
            <span className={`badge badge-${badge.tone}`}>{badge.label}</span>
          </div>
          <p className="mdp__meta">
            <Icon name="pin" size={15} />
            {listing.district ? `${listing.city} · ${listing.district}` : listing.city}
            {listing.submittedAt && <> · {t('submittedOn', { date: when(listing.submittedAt) })}</>}
          </p>
        </div>
        {listing.status === 'PUBLISHED' && (
          <Link href={`/listing/${listing.id}`} className="btn btn-secondary btn-sm">
            <Icon name="eye" size={15} />
            {t('viewAsGuest')}
          </Link>
        )}
      </header>

      {/* The decision sits above the content: a moderator who has already
          made up their mind should not have to scroll back. */}
      <section className="mdp__decide panel">
        <ModerationDecision propertyId={String(listing.id)} status={String(listing.status)} />
      </section>

      <div className="mdp__layout">
        <div className="mdp__main">
          <section className="mdp__section">
            <h2 className="mdp__h2">{t('photosHeading', { count: photos.length })}</h2>
            {photos.length === 0 ? (
              <p className="mdp__muted">{t('noPhotos')}</p>
            ) : (
              <ul className="mdp__photos">
                {photos.map((p) => (
                  <li key={p.id} className="mdp__photo">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/media/${p.storageKey}`} alt="" loading="lazy" />
                    {p.isCover && <span className="mdp__cover">{t('coverPhoto')}</span>}
                    {p.width && p.height && (
                      <span className="mdp__dims numeric">
                        {p.width}×{p.height}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mdp__section">
            <h2 className="mdp__h2">{t('aboutHeading')}</h2>
            <div className="mdp__facts">
              {facts.map((f) => (
                <div key={f.label} className="mdp__fact">
                  <Icon name={f.icon} size={18} />
                  <span className="mdp__factValue">{f.value}</span>
                  <span className="mdp__factLabel">{f.label}</span>
                </div>
              ))}
            </div>
            <p className="mdp__duration">
              <Icon name="calendar" size={17} />
              {t('rentedFrom', {
                min: formatNightsGenitiveLocalized(duration.minNights, locale),
                max: formatNightsGenitiveLocalized(duration.maxNights, locale),
              })}
            </p>
            {listing.description ? (
              <p className="prose mdp__description">{listing.description}</p>
            ) : (
              <p className="mdp__muted">{t('noDescription')}</p>
            )}
          </section>

          <section className="mdp__section">
            <h2 className="mdp__h2">{t('priceHeading')}</h2>
            <dl className="mdp__rows">
              <Row label={t('rowBaseRate')}>
                {pricing.basePriceMinor ? (
                  <>
                    <Money minor={pricing.basePriceMinor!} /> {pricing.priceUnit === 'MONTH' ? t('monthlyRate') : t('nightlyRate')}
                  </>
                ) : (
                  t('notSpecified')
                )}
              </Row>
              <Row label={t('rowCleaning')}>
                {Number(pricing.cleaningFeeMinor) > 0 ? <Money minor={pricing.cleaningFeeMinor!} /> : t('none')}
              </Row>
              <Row label={t('rowUtilities')}>
                {pricing.utilitiesMode === 'INCLUDED'
                  ? t('utilitiesIncluded')
                  : pricing.utilitiesMode === 'FIXED_EXTRA'
                    ? <><Money minor={pricing.utilitiesFixedMinor ?? '0'} /> {t('utilitiesExtraSuffix')}</>
                    : t('utilitiesMetered')}
              </Row>
              <Row label={t('rowDeposit')}>
                {Number(pricing.depositMinor) > 0 ? <Money minor={pricing.depositMinor!} /> : t('none')}
              </Row>
              <Row label={t('rowBooking')}>
                {listing.bookingMode === 'REQUEST'
                  ? t('bookingRequest')
                  : listing.bookingMode === 'INSTANT'
                    ? t('bookingInstant')
                    : t('bookingInstantAndRequest')}
                {listing.negotiationEnabled && <> · {t('negotiable')}</>}
              </Row>
            </dl>
          </section>

          {listing.amenities.length > 0 && (
            <section className="mdp__section">
              <h2 className="mdp__h2">{t('amenitiesHeading', { count: listing.amenities.length })}</h2>
              <Amenities rows={listing.amenities} />
            </section>
          )}

          <section className="mdp__section">
            <h2 className="mdp__h2">{t('rulesHeading')}</h2>
            <ul className="mdp__rules">
              <li>{SMOKING[rules.smoking] ?? rules.smoking}</li>
              <li>{PETS[rules.pets] ?? rules.pets}</li>
              <li>{rules.childrenAllowed ? t('childrenAllowed') : t('childrenNotAllowed')}</li>
              <li>{rules.partiesAllowed ? t('partiesAllowed') : t('partiesNotAllowed')}</li>
              <li>
                {t('checkInOut', {
                  from: String(rules.checkInFrom ?? '14:00').slice(0, 5),
                  to: String(rules.checkOutUntil ?? '12:00').slice(0, 5),
                })}
              </li>
            </ul>
          </section>

          <section className="mdp__section">
            <h2 className="mdp__h2">{t('locationHeading')}</h2>
            <p className="mdp__muted mdp__locNote">{t('locationNote')}</p>
            <div className="mdp__map">
              <MapPanel
                markers={[
                  {
                    id: String(listing.id),
                    latitude: Number(listing.location.latitude),
                    longitude: Number(listing.location.longitude),
                    precision: String(listing.location.precision),
                    priceMinor: pricing.basePriceMinor ?? '0',
                    priceUnit: pricing.priceUnit ?? 'NIGHT',
                    title: String(listing.title ?? ''),
                  },
                ]}
              />
            </div>
          </section>
        </div>

        <aside className="mdp__aside">
          <section className="panel mdp__owner">
            <h2 className="mdp__asideH2">{t('ownerHeading')}</h2>
            <div className="mdp__ownerRow">
              <span className="mdp__avatar" aria-hidden="true">
                {String(owner.displayName).trim().charAt(0).toUpperCase()}
              </span>
              <div>
                <strong className="mdp__ownerName">{owner.displayName}</strong>
                <p className="text-xs muted">{owner.accountKind === 'COMPANY' ? t('accountCompany') : t('accountPrivateHost')}</p>
              </div>
            </div>
            <dl className="mdp__rows">
              <Row label={t('rowIdentity')}>
                {owner.verificationLevel >= 1 ? (
                  <span className="mdp__ok">
                    <Icon name="checkCircle" size={14} />
                    {t('confirmed')}
                  </span>
                ) : (
                  t('notConfirmed')
                )}
              </Row>
              <Row label={t('rowPropertyVerification')}>{listing.propertyVerified ? t('propertyVerified') : t('propertyNotVerified')}</Row>
              <Row label={t('rowRating')}>{owner.rating === null ? t('noReviews') : owner.rating.toFixed(1)}</Row>
              <Row label={t('rowCompletedRentals')}>{String(owner.completedRentals)}</Row>
              <Row label={t('rowListingsCount')}>{String(owner.listingCount)}</Row>
              <Row label={t('rowMemberSince')}>{when(String(owner.memberSince)).split(',')[0]!}</Row>
            </dl>
            <p className="hint">{t('identityDocsHint')}</p>
          </section>

          <section className="panel mdp__history">
            <h2 className="mdp__asideH2">{t('historyHeading')}</h2>
            {history.length === 0 ? (
              <p className="text-sm muted">{t('noHistory')}</p>
            ) : (
              <ol className="mdp__historyList">
                {history.map((h) => (
                  <li key={h.id} className="mdp__event">
                    <span className={`badge badge-${h.decision === 'PUBLISHED' ? 'verified' : h.decision === 'REJECTED' ? 'danger' : 'solid-neutral'}`}>
                      {DECISION_LABEL[h.decision] ?? h.decision}
                    </span>
                    <p className="text-xs dim">
                      {when(h.createdAt)}
                      {h.moderatorName ? ` · ${h.moderatorName}` : ''}
                    </p>
                    {h.reasonCodes.length > 0 && (
                      <ul className="mdp__reasons">
                        {h.reasonCodes.map((c) => (
                          <li key={c}>{MODERATION_REASON_TEXT[c as ModerationReasonCode] ?? c}</li>
                        ))}
                      </ul>
                    )}
                    {h.comment && <p className="mdp__comment">{t('commentQuote', { comment: h.comment })}</p>}
                  </li>
                ))}
              </ol>
            )}
            {history.length > 1 && <p className="hint">{t('reviewRepeatHint', { count: history.length + 1 })}</p>}
          </section>
        </aside>
      </div>

      <style>{`
        .mdp { padding-block: var(--space-4) var(--space-8); max-width: 68rem; }
        .mdp__back { margin-bottom: var(--space-3); }
        .mdp__backLink { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; font-size: var(--text-sm); color: var(--text-secondary); }
        @media (hover: hover) and (pointer: fine) {
          .mdp__backLink:hover { color: var(--text-primary); }
        }

        .mdp__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
        .mdp__headMain { display: grid; gap: var(--space-2); min-width: 0; }
        .mdp__titleRow { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
        .mdp__title { font-size: var(--text-2xl); font-weight: 650; letter-spacing: -0.022em; }
        .mdp__meta { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; font-size: var(--text-sm); color: var(--text-secondary); }

        .mdp__decide { margin-bottom: var(--space-5); }

        .mdp__layout { display: grid; gap: var(--space-6); }
        @media (min-width: 960px) {
          .mdp__layout { grid-template-columns: minmax(0, 1fr) 20rem; align-items: start; }
          .mdp__aside { position: sticky; top: calc(var(--header-height) + 0.75rem); }
        }
        .mdp__main { display: grid; min-width: 0; }
        .mdp__aside { display: grid; gap: var(--space-3); min-width: 0; }

        .mdp__section { padding-block: var(--space-5); }
        .mdp__section:first-child { padding-top: 0; }
        .mdp__section + .mdp__section { border-top: 1px solid var(--border); }
        .mdp__h2 { font-size: var(--text-lg); font-weight: 600; margin-bottom: var(--space-3); }
        .mdp__asideH2 { font-size: var(--text-base); font-weight: 600; margin-bottom: var(--space-3); }
        .mdp__muted { color: var(--text-secondary); font-size: var(--text-sm); }

        .mdp__photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
        .mdp__photo { position: relative; border-radius: var(--radius-sm); overflow: hidden; background: var(--surface-sunken); }
        .mdp__photo img { width: 100%; aspect-ratio: 3 / 2; object-fit: cover; display: block; }
        .mdp__cover, .mdp__dims {
          position: absolute; padding: 0.1rem 0.4rem; border-radius: var(--radius-sm);
          background: color-mix(in srgb, var(--surface) 92%, transparent);
          font-size: var(--text-2xs); font-weight: 600;
        }
        .mdp__cover { left: 0.35rem; top: 0.35rem; }
        .mdp__dims { right: 0.35rem; bottom: 0.35rem; color: var(--text-secondary); }

        .mdp__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr)); gap: var(--space-3); }
        .mdp__fact { display: grid; gap: 0.1rem; }
        .mdp__fact > svg { color: var(--text-tertiary); margin-bottom: 0.15rem; }
        .mdp__factValue { font-size: var(--text-base); font-weight: 600; }
        .mdp__factLabel { font-size: var(--text-xs); color: var(--text-tertiary); }
        .mdp__duration {
          display: flex; align-items: center; gap: 0.5rem;
          margin-top: var(--space-4); padding: var(--space-2) var(--space-3);
          background: var(--primary-soft); border-radius: var(--radius-sm);
          font-size: var(--text-sm);
        }
        .mdp__duration > svg { color: var(--primary); }
        .mdp__description { margin-top: var(--space-4); color: var(--text-secondary); white-space: pre-line; }

        .mdp__rows { display: grid; margin: 0; }
        .mdp__row { display: grid; grid-template-columns: 9rem 1fr; gap: var(--space-3); padding-block: 0.4rem; font-size: var(--text-sm); }
        .mdp__row dt { color: var(--text-secondary); }
        .mdp__row dd { margin: 0; }
        .mdp__ok { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--success); font-weight: 600; }

        .mdp__rules { display: grid; gap: var(--space-2); margin: 0; padding-left: 1.1rem; font-size: var(--text-sm); color: var(--text-secondary); }
        .mdp__locNote { max-width: 60ch; margin-bottom: var(--space-3); }
        .mdp__map { height: 16rem; }

        .mdp__ownerRow { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3); }
        .mdp__avatar {
          display: grid; place-items: center; width: 2.5rem; height: 2.5rem; flex: 0 0 auto;
          border-radius: var(--radius-full); background: var(--primary-soft); color: var(--primary);
          font-weight: 600;
        }
        .mdp__ownerName { font-size: var(--text-sm); }

        .mdp__historyList { display: grid; gap: var(--space-4); list-style: none; margin: 0; padding: 0; }
        .mdp__event { display: grid; gap: 0.25rem; justify-items: start; }
        .mdp__reasons { margin: 0.15rem 0 0; padding-left: 1.1rem; font-size: var(--text-xs); color: var(--text-secondary); }
        .mdp__comment { font-size: var(--text-xs); color: var(--text-primary); font-style: italic; }

        @media (max-width: 560px) {
          .mdp__row { grid-template-columns: 1fr; gap: 0; }
          .mdp__row dt { font-size: var(--text-xs); }
        }
      `}</style>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mdp__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
