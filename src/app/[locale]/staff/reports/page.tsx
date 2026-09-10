import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link, redirect } from '@/i18n/navigation.ts';
import { currentUser, signInUrl } from '@/server/session.ts';
import { ready } from '@/server/runtime.ts';
import { can } from '@/server/auth/rbac.ts';
import { StaffShell } from '@/ui/staff-shell.tsx';
import { Icon } from '@/ui/icons.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('StaffReports');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * The report queue.
 *
 * There is no `/admin/reports/:id/decide` — filing a report never hides
 * anything on its own, and the actual decision already lives on four
 * separate screens depending on what got reported: a listing is judged on
 * the moderation console, a review on its own queue, a user account on the
 * user record, a message on the message queue. Building a fifth decision
 * surface here would either duplicate one of those or drift from it, so
 * this page does the one honest thing available to it: show what was
 * reported and send the reader to wherever the report can actually be
 * resolved. `REVIEW` has no per-row deep link because the reviewed-review
 * queue keys off the review itself, not the report — the destination is
 * still exactly right, just not pre-filtered to one row.
 */

interface ReportRow {
  id: string;
  reporter_id: string;
  target_type: 'PROPERTY' | 'USER' | 'MESSAGE' | 'REVIEW';
  target_id: string;
  category: string;
  detail: string | null;
  status: string;
  created_at: string;
}

// Every category any report-filing endpoint in this codebase currently
// issues (messages: SPAM/ABUSE/FRAUD/OFF_PLATFORM/OTHER; reviews:
// FALSE_INFORMATION/ABUSE/PRIVATE_DATA/NOT_ABOUT_STAY/SPAM/OTHER). `category`
// itself is free text in the schema, not an enum, so anything outside this
// map still renders — just humanized instead of translated.
const CATEGORY_KEY: Record<string, string> = {
  SPAM: 'categorySpam',
  ABUSE: 'categoryAbuse',
  FRAUD: 'categoryFraud',
  OFF_PLATFORM: 'categoryOffPlatform',
  OTHER: 'categoryOther',
  FALSE_INFORMATION: 'categoryFalseInformation',
  PRIVATE_DATA: 'categoryPrivateData',
  NOT_ABOUT_STAY: 'categoryNotAboutStay',
};

function humanize(raw: string): string {
  return raw
    .toLowerCase()
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('ru-BY', { dateStyle: 'short', timeStyle: 'short' });
}

function targetHref(type: ReportRow['target_type'], targetId: string): string {
  switch (type) {
    case 'PROPERTY':
      return `/moderation/${targetId}`;
    case 'USER':
      return `/staff/users/${targetId}`;
    case 'REVIEW':
      return '/staff/reviews';
    case 'MESSAGE':
      return '/staff/messages';
  }
}

export default async function StaffReportsPage() {
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) redirect({ href: signInUrl('/staff/reports'), locale });
  // 404, not 403 — consistent with every other staff surface.
  if (!can(user!.roles, 'case.view')) notFound();

  const t = await getTranslations('StaffReports');
  const database = await ready();

  const { rows: items } = await database.query<ReportRow>(
    `SELECT id, reporter_id, target_type, target_id, category, detail, status, created_at
       FROM report WHERE status IN ('OPEN','REVIEWING') ORDER BY created_at LIMIT 100`,
  );

  const categoryLabel = (raw: string): string => {
    const key = CATEGORY_KEY[raw];
    return key ? t(key) : humanize(raw);
  };

  const goToLabel: Record<ReportRow['target_type'], string> = {
    PROPERTY: t('goToProperty'),
    USER: t('goToUser'),
    REVIEW: t('goToReviewsQueue'),
    MESSAGE: t('goToMessagesQueue'),
  };

  const targetTypeLabel: Record<ReportRow['target_type'], string> = {
    PROPERTY: t('targetTypeProperty'),
    USER: t('targetTypeUser'),
    MESSAGE: t('targetTypeMessage'),
    REVIEW: t('targetTypeReview'),
  };

  return (
    <StaffShell
      roles={user!.roles}
      withheldRoles={user!.withheldRoles}
      current="/staff/reports"
      title={t('title')}
      subtitle={t('subtitle')}
      badges={[{ label: t('badgeQueue'), count: items.length, tone: items.length > 0 ? 'warning' : undefined }]}
    >
      <p className="rq__notice">
        <Icon name="info" size={16} />
        {t('notice')}
      </p>

      {items.length === 0 ? (
        <div className="rq__empty">
          <Icon name="checkCircle" size={26} />
          <p className="title-sm">{t('emptyTitle')}</p>
          <p className="text-sm muted">{t('emptyBody')}</p>
        </div>
      ) : (
        <ul className="rq__list">
          {items.map((item) => (
            <li key={item.id} className="rq__row">
              <div className="rq__main">
                <div className="rq__top">
                  <span className="badge badge-solid-neutral">{targetTypeLabel[item.target_type]}</span>
                  <span className={`badge badge-${item.status === 'OPEN' ? 'warning' : 'primary'}`}>
                    {item.status === 'OPEN' ? t('statusOpen') : t('statusReviewing')}
                  </span>
                  <strong className="rq__category">{categoryLabel(item.category)}</strong>
                </div>

                <p className="rq__detail">{item.detail || <span className="muted">{t('detailNone')}</span>}</p>

                <p className="rq__meta">
                  {t('reporterLabel')} <code className="rq__id">{item.reporter_id}</code>
                  {' · '}
                  {t('targetLabel')} <code className="rq__id">{item.target_id}</code>
                  {' · '}
                  {when(item.created_at)}
                </p>
              </div>

              <div className="rq__action">
                <Link href={targetHref(item.target_type, item.target_id)} className="btn btn-secondary btn-sm">
                  {goToLabel[item.target_type]}
                  <Icon name="arrowRight" size={15} />
                </Link>
                {item.target_type === 'REVIEW' && <p className="rq__hint">{t('reviewsHint')}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <style>{`
        .rq__notice {
          display: flex; align-items: flex-start; gap: 0.45rem;
          padding: var(--space-3) var(--space-4); margin-bottom: var(--space-4);
          background: var(--surface-sunken); border-radius: var(--radius-sm);
          font-size: var(--text-xs); line-height: 1.5; color: var(--text-secondary);
        }
        .rq__notice > svg { color: var(--text-tertiary); flex: 0 0 auto; margin-top: 0.1rem; }

        .rq__list { display: grid; gap: var(--space-2); list-style: none; margin: 0; padding: 0; }
        .rq__row {
          display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);
          padding: var(--space-3) var(--space-4);
          background: var(--surface); border-radius: var(--radius-md);
          flex-wrap: wrap;
        }

        .rq__main { display: grid; gap: 0.3rem; flex: 1 1 20rem; min-width: 0; }
        .rq__top { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
        .rq__category { font-size: var(--text-sm); }
        .rq__detail { font-size: var(--text-sm); line-height: 1.55; color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
        .rq__meta { font-size: var(--text-2xs); color: var(--text-tertiary); }

        /* An id is one unbreakable token; without this it sets the row's
           width on a phone. */
        .rq__id { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }

        .rq__action { display: grid; gap: 0.3rem; justify-items: end; flex: 0 0 auto; max-width: 16rem; text-align: right; }
        .rq__hint { font-size: var(--text-2xs); color: var(--text-tertiary); line-height: 1.5; }

        .rq__empty { display: grid; justify-items: center; gap: 0.3rem; padding: var(--space-8) var(--space-4); text-align: center; }
        .rq__empty > svg { color: var(--success); margin-bottom: var(--space-2); }

        @media (max-width: 640px) {
          .rq__row { flex-direction: column; }
          .rq__action { justify-items: start; text-align: left; max-width: none; width: 100%; }
        }
      `}</style>
    </StaffShell>
  );
}
