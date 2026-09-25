import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { readyServices } from '@/server/runtime.ts';
import { VerificationRequestForm } from '@/ui/verification-request-form.tsx';
import { Icon } from '@/ui/icons.tsx';
import {
  applicantExplanation,
  firstFixTarget,
  LEVEL_CLAIM,
  LEVEL_EXPLANATION,
  LEVEL_LABEL,
  STATUS_LABEL,
  type OwnershipBasis,
  type VerificationFixTarget,
  type VerificationReasonCode,
} from '@/server/domain/verification.ts';
import type { AppLocale } from '@/i18n/routing.ts';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('DashboardVerification');
  return { title: t('meta.title'), robots: { index: false, follow: false } };
}

/**
 * The applicant's side of verification.
 *
 * Everything on this page comes from `forApplicant`, which selects the
 * applicant-facing columns only — the internal note is not in that query at
 * all, so it cannot leak through a later refactor of this file.
 *
 * A refusal ends with somewhere to go. The reason codes carry both a plain
 * explanation and a fix target, so «Данные не совпадают» links to the profile
 * name field rather than leaving somebody to guess, and resubmitting keeps what
 * they already filled in. The listing-moderation flow learned this (DEC-030)
 * and it is the same lesson.
 */

const STATUS_TONE: Record<string, string> = {
  SUBMITTED: 'warning',
  IN_REVIEW: 'primary',
  NEEDS_INFO: 'warning',
  APPROVED: 'verified',
  REJECTED: 'danger',
  EXPIRED: 'solid-neutral',
};

/** Where a reason code sends somebody. Every target is a real destination. */
const FIX_LINK: Record<VerificationFixTarget, { href: string; labelKey: string }> = {
  PROFILE_NAME: { href: '/dashboard/verification#profile', labelKey: 'fixProfileName' },
  IDENTITY_DOCUMENTS: { href: '/dashboard/verification#documents', labelKey: 'fixIdentityDocuments' },
  SELFIE: { href: '/dashboard/verification#documents', labelKey: 'fixSelfie' },
  PROPERTY_DOCUMENTS: { href: '/dashboard/verification#documents', labelKey: 'fixPropertyDocuments' },
  SUPPORT: { href: '/dashboard/chat', labelKey: 'fixSupport' },
};

function day(value: string | null, months: readonly string[]): string {
  if (!value) return '—';
  const iso = new Date(value).toISOString();
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

export default async function VerificationPage() {
  const user = await currentUser();
  const locale = (await getLocale()) as AppLocale;
  if (!user) redirect({ href: signInUrl('/dashboard/verification'), locale });

  const t = await getTranslations('DashboardVerification');
  const months = t.raw('months') as string[];

  const services = await readyServices();
  const state = (await services.verification.forApplicant(user!.userId)) as Record<string, any>;

  const level = Number(state.level) as 0 | 1 | 2;
  const current = state.current as Record<string, any> | null;
  const history = state.history as Record<string, any>[];
  const properties = state.properties as { id: string; title: string; city: string; verified: boolean }[];
  const collectionEnabled = state.collectionEnabled === true;

  // The most recent refusal that has not been superseded — what to fix.
  const lastRefusal = history.find(
    (h) => ['REJECTED', 'NEEDS_INFO'].includes(String(h.status)) && !history.some((o) => o.supersedesId === h.id),
  );
  const refusalCodes = (lastRefusal?.reasonCodes ?? []) as VerificationReasonCode[];
  const fixTarget = firstFixTarget(refusalCodes);

  const nextLevel: 1 | 2 | null = level === 0 ? 1 : level === 1 ? 2 : null;

  return (
    <div className="container vp">
      <nav className="vp__back">
        <Link href="/dashboard" className="vp__backLink">
          <Icon name="arrowLeft" size={16} />
          {t('backToDashboard')}
        </Link>
      </nav>

      <header className="vp__head">
        <h1 className="title-lg">{t('title')}</h1>
        <p className="text-sm muted">{t('intro')}</p>
      </header>

      {/* The ladder, with the honest claim under each rung. */}
      <section className="vp__levels" aria-label={t('levelsAriaLabel')}>
        {([0, 1, 2] as const).map((l) => (
          <div
            key={l}
            className="vp__level"
            data-state={l < level ? 'past' : l === level ? 'now' : 'future'}
          >
            <span className="vp__levelTop">
              <span className="vp__levelMark" aria-hidden="true">
                {l < level ? <Icon name="check" size={13} /> : l === level ? <Icon name="dot" size={13} /> : l}
              </span>
              <strong className="vp__levelName">{LEVEL_LABEL[l]}</strong>
              {l === level && <span className="badge badge-primary">{t('currentBadge')}</span>}
            </span>
            <span className="vp__levelClaim">{LEVEL_CLAIM[l]}</span>
          </div>
        ))}
      </section>

      <p className="vp__explain">
        <Icon name="info" size={16} />
        {LEVEL_EXPLANATION[level]}
      </p>

      {current && (
        <section className="vp__card">
          <h2 className="vp__h2">
            {t('applicationForLevel', { level: LEVEL_LABEL[current.targetLevel as 1 | 2] })}
            <span className={`badge badge-${STATUS_TONE[current.status] ?? 'solid-neutral'}`}>
              {STATUS_LABEL[current.status as keyof typeof STATUS_LABEL] ?? current.status}
            </span>
          </h2>
          <p className="text-sm muted">{t('submittedOn', { date: day(current.submittedAt, months) })}</p>

          {current.status === 'NEEDS_INFO' && (
            <>
              <p className="vp__lead">{t('needsInfoLead')}</p>
              <ul className="vp__fixes">
                {applicantExplanation(current.reasonCodes as VerificationReasonCode[]).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              {current.message && <p className="vp__message">{current.message}</p>}
            </>
          )}

          {(current.status === 'SUBMITTED' || current.status === 'IN_REVIEW') && (
            <p className="vp__lead">{collectionEnabled ? t('queuedLead') : t('collectionDisabledLead')}</p>
          )}
        </section>
      )}

      {!current && lastRefusal && (
        <section className="vp__card vp__card--refused">
          <h2 className="vp__h2">
            {t('previousRejectedTitle')}
            <span className="badge badge-danger">
              {STATUS_LABEL[lastRefusal.status as keyof typeof STATUS_LABEL] ?? lastRefusal.status}
            </span>
          </h2>
          <ul className="vp__fixes">
            {applicantExplanation(refusalCodes).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          {lastRefusal.message && <p className="vp__message">{lastRefusal.message}</p>}
          {fixTarget && (
            <Link href={FIX_LINK[fixTarget].href} className="btn btn-secondary btn-sm">
              {t(FIX_LINK[fixTarget].labelKey)}
            </Link>
          )}
          <p className="hint">{t('resubmitHint')}</p>
        </section>
      )}

      {!current && nextLevel !== null && (
        <section className="vp__card" id="documents">
          <h2 className="vp__h2">
            {lastRefusal ? t('sendAgainTitle') : t('getLevelTitle', { level: LEVEL_LABEL[nextLevel] })}
          </h2>
          <p className="text-sm muted vp__lead">{LEVEL_CLAIM[nextLevel]}</p>
          <VerificationRequestForm
            targetLevel={nextLevel}
            properties={properties}
            collectionEnabled={collectionEnabled}
            {...(lastRefusal ? { supersedesId: String(lastRefusal.id) } : {})}
            {...(lastRefusal?.declared
              ? { prefill: lastRefusal.declared as { ownershipBasis?: OwnershipBasis; note?: string } }
              : {})}
          />
        </section>
      )}

      {level === 2 && (
        <section className="vp__card">
          <h2 className="vp__h2">
            {t('allVerifiedTitle')}
            <span className="badge badge-verified">Verified</span>
          </h2>
          <p className="text-sm muted">{LEVEL_EXPLANATION[2]}</p>
        </section>
      )}

      <section className="vp__card" id="profile">
        <h2 className="vp__h2">{t('profileNameHeading')}</h2>
        <p className="text-sm muted">
          {t('profileNameBody')} <strong>{user!.displayName}</strong>
        </p>
        <p className="hint">{t('profileNameHint')}</p>
      </section>

      {history.length > 0 && (
        <section className="vp__card">
          <h2 className="vp__h2">{t('historyHeading')}</h2>
          <ul className="vp__history">
            {history.map((h) => (
              <li key={h.id}>
                <span className={`badge badge-${STATUS_TONE[h.status] ?? 'solid-neutral'}`}>
                  {STATUS_LABEL[h.status as keyof typeof STATUS_LABEL] ?? h.status}
                </span>{' '}
                {LEVEL_LABEL[h.targetLevel as 1 | 2]} · {day(h.submittedAt, months)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="hint vp__legal">{t('legalNote')}</p>

      <style>{`
        .vp { padding-block: var(--space-4) var(--space-8); max-width: 46rem; }
        .vp__back { margin-bottom: var(--space-3); }
        .vp__backLink { display: inline-flex; align-items: center; gap: 0.35rem; min-height: 2.75rem; font-size: var(--text-sm); color: var(--text-secondary); }
        @media (hover: hover) and (pointer: fine) {
          .vp__backLink:hover { color: var(--text-primary); }
        }
        .vp__head { display: grid; gap: 0.25rem; margin-bottom: var(--space-5); }
        .vp__head p { max-width: 58ch; }

        .vp__levels { display: grid; gap: var(--space-2); margin-bottom: var(--space-4); }
        @media (min-width: 720px) { .vp__levels { grid-template-columns: repeat(3, 1fr); } }
        .vp__level {
          display: grid; gap: 0.25rem; padding: var(--space-3) var(--space-4);
          background: var(--surface); border-radius: var(--radius-md);
        }
        .vp__level[data-state='now'] { background: var(--primary-soft); }
        .vp__level[data-state='future'] { background: transparent; box-shadow: inset 0 0 0 1px var(--border); }
        .vp__levelTop { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
        .vp__levelMark {
          display: grid; place-items: center; width: 1.375rem; height: 1.375rem; flex: 0 0 auto;
          border-radius: var(--radius-full); background: var(--surface-sunken); color: var(--text-tertiary);
          font-size: var(--text-2xs); font-weight: 700;
        }
        .vp__level[data-state='past'] .vp__levelMark { background: var(--success); color: #fff; }
        .vp__level[data-state='now'] .vp__levelMark { background: var(--primary); color: var(--text-on-primary); }
        .vp__levelName { font-size: var(--text-sm); }
        .vp__levelClaim { font-size: var(--text-2xs); color: var(--text-secondary); line-height: 1.45; }

        .vp__explain {
          display: flex; align-items: flex-start; gap: 0.5rem;
          padding: var(--space-3) var(--space-4); margin-bottom: var(--space-5);
          background: var(--surface-sunken); border-radius: var(--radius-sm);
          font-size: var(--text-xs); line-height: 1.55; color: var(--text-secondary);
        }
        .vp__explain > svg { color: var(--text-tertiary); flex: 0 0 auto; margin-top: 0.1rem; }

        .vp__card { display: grid; gap: var(--space-2); justify-items: start; padding-block: var(--space-5); }
        .vp__card + .vp__card { border-top: 1px solid var(--border); }
        .vp__h2 { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-lg); font-weight: 650; letter-spacing: -0.015em; }
        .vp__lead { font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.55; max-width: 58ch; }
        .vp__fixes { display: grid; gap: var(--space-2); margin: var(--space-1) 0 0; padding-left: 1.1rem; font-size: var(--text-sm); line-height: 1.55; color: var(--text-secondary); max-width: 60ch; }
        .vp__message {
          padding: var(--space-3); margin-top: var(--space-2);
          background: var(--surface-sunken); border-radius: var(--radius-sm);
          font-size: var(--text-sm); line-height: 1.55; white-space: pre-wrap; max-width: 60ch;
        }
        .vp__history { display: grid; gap: 0.4rem; margin: 0; padding: 0; list-style: none; font-size: var(--text-sm); color: var(--text-secondary); }
        .vp__legal { border-top: 1px solid var(--border); padding-top: var(--space-4); margin-top: var(--space-4); max-width: 62ch; }
      `}</style>
    </div>
  );
}
