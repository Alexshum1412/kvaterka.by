'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { EmptyState } from '@/ui/primitives.tsx';

/**
 * The reported-review queue.
 *
 * Every row here exists because somebody filed a report, not because the
 * review itself carries a flag — reporting a review never hides it (a party
 * who dislikes their rating cannot suppress it by reporting it), so this is
 * the only place the report actually gets a verdict.
 *
 * Removal is optimistic: the row leaves the list the instant a decision is
 * submitted, since the row *is* the queue item and the caller's next move
 * is the next row, not watching a spinner. A failed request puts the row
 * back where it was and surfaces the error above the list — the moderator's
 * typed note is kept (lifted to this component, not row-local state) so a
 * transient failure never costs them the sentence they just wrote.
 */

export type ReportCategory = 'FALSE_INFORMATION' | 'ABUSE' | 'PRIVATE_DATA' | 'NOT_ABOUT_STAY' | 'SPAM' | 'OTHER';
type Decision = 'PUBLISHED' | 'HIDDEN' | 'REMOVED';

export interface ReportedReview {
  id: string;
  booking_id: string;
  author_id: string;
  subject_id: string;
  author_role: 'TENANT' | 'LANDLORD';
  overall: number;
  body: string;
  what_was_good: string | null;
  what_to_improve: string | null;
  status: 'PUBLISHED' | 'PENDING';
  created_at: string;
  report_id: string;
  report_category: ReportCategory;
  report_detail: string | null;
  author_name: string;
  subject_name: string;
}

const CATEGORY_KEY: Record<ReportCategory, string> = {
  FALSE_INFORMATION: 'categoryFalseInformation',
  ABUSE: 'categoryAbuse',
  PRIVATE_DATA: 'categoryPrivateData',
  NOT_ABOUT_STAY: 'categoryNotAboutStay',
  SPAM: 'categorySpam',
  OTHER: 'categoryOther',
};

const DECISION_ICON: Record<Decision, 'checkCircle' | 'eye' | 'close'> = {
  PUBLISHED: 'checkCircle',
  HIDDEN: 'eye',
  REMOVED: 'close',
};

export function ReviewModerationQueue({ initialItems }: { initialItems: ReportedReview[] }) {
  const t = useTranslations('StaffReviews');
  const locale = useLocale();
  const [items, setItems] = useState(initialItems);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<{ id: string; decision: Decision } | null>(null);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  async function decide(item: ReportedReview, decision: Decision) {
    const note = (notes[item.id] ?? '').trim();
    if (note.length < 3) return;

    const index = items.findIndex((i) => i.id === item.id);
    setBusy({ id: item.id, decision });
    setBannerError(null);
    // Optimistic: the row is gone before the request resolves.
    setItems((prev) => prev.filter((i) => i.id !== item.id));

    try {
      await api.post(`/admin/moderation/reviews/${item.id}`, { decision, note });
      setNotes((prev) => {
        const { [item.id]: _discard, ...rest } = prev;
        return rest;
      });
    } catch (e) {
      // Roll back: put the row back where it was, keep the note.
      setItems((prev) => {
        const next = [...prev];
        next.splice(Math.min(index, next.length), 0, item);
        return next;
      });
      setBannerError(e instanceof ApiError ? e.message : t('genericError'));
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return <EmptyState title={t('emptyTitle')} description={t('emptyBody')} />;
  }

  return (
    <div className="rmq">
      {bannerError && (
        <p className="rmq__banner" role="alert">
          <Icon name="alert" size={16} />
          <span>{bannerError}</span>
          <button type="button" className="rmq__bannerClose" aria-label={t('dismissError')} onClick={() => setBannerError(null)}>
            <Icon name="close" size={14} />
          </button>
        </p>
      )}

      <ul className="rmq__list">
        {items.map((item) => (
          <li key={item.id} className="rmq__row card">
            <div className="rmq__top">
              <span className="rmq__stars" aria-label={t('ratingAria', { rating: item.overall })}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <Icon key={n} name="star" size={16} solid={n <= item.overall} />
                ))}
              </span>
              <span className="badge badge-solid-neutral">
                {t(item.author_role === 'TENANT' ? 'roleTenant' : 'roleLandlord')}
              </span>
              <span className="badge badge-neutral">
                {t(item.status === 'PUBLISHED' ? 'statusPublished' : 'statusPending')}
              </span>
              <span className="rmq__date">{dateFormat.format(new Date(item.created_at))}</span>
            </div>

            <p className="rmq__reviewer">{t('reviewLine', { author: item.author_name, subject: item.subject_name })}</p>

            {item.body && <p className="rmq__body">{item.body}</p>}

            {(item.what_was_good || item.what_to_improve) && (
              <div className="rmq__notes">
                {item.what_was_good && (
                  <div className="rmq__note">
                    <strong>{t('whatWasGood')}</strong>
                    <p>{item.what_was_good}</p>
                  </div>
                )}
                {item.what_to_improve && (
                  <div className="rmq__note">
                    <strong>{t('whatToImprove')}</strong>
                    <p>{item.what_to_improve}</p>
                  </div>
                )}
              </div>
            )}

            <p className="rmq__meta">
              {t('bookingLabel')}: <code className="rmq__id">{item.booking_id}</code>
            </p>

            <div className="rmq__report">
              <span className="badge badge-warning">
                <Icon name="alert" size={13} />
                {t(CATEGORY_KEY[item.report_category] ?? 'categoryOther')}
              </span>
              <p>{item.report_detail || t('reportNoDetail')}</p>
            </div>

            <form
              className="rmq__form"
              onSubmit={(e) => e.preventDefault()}
            >
              <label className="field">
                <span className="label">{t('noteLabel')}</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={notes[item.id] ?? ''}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  placeholder={t('notePlaceholder')}
                  minLength={3}
                  maxLength={1000}
                />
                <span className="hint">{t('noteHint')}</span>
              </label>

              <div className="rmq__actions">
                {(['PUBLISHED', 'HIDDEN', 'REMOVED'] as const).map((decision) => {
                  const isBusy = busy?.id === item.id && busy.decision === decision;
                  const disabled = (notes[item.id] ?? '').trim().length < 3 || busy !== null;
                  return (
                    <button
                      key={decision}
                      type="button"
                      className={decision === 'REMOVED' ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm'}
                      disabled={disabled}
                      onClick={() => decide(item, decision)}
                    >
                      <Icon name={DECISION_ICON[decision]} size={15} />
                      {isBusy ? t('saving') : t(`decision${decision === 'PUBLISHED' ? 'Keep' : decision === 'HIDDEN' ? 'Hide' : 'Remove'}`)}
                    </button>
                  );
                })}
              </div>
            </form>
          </li>
        ))}
      </ul>

      <style>{`
        .rmq__banner {
          display: flex; align-items: center; gap: var(--space-2);
          padding: var(--space-3) var(--space-4); margin-bottom: var(--space-4);
          background: var(--error-soft); color: var(--error);
          border-radius: var(--radius-sm); font-size: var(--text-sm); line-height: 1.5;
        }
        .rmq__banner > svg:first-child { flex: 0 0 auto; }
        .rmq__banner > span { flex: 1 1 auto; min-width: 0; }
        .rmq__bannerClose {
          flex: 0 0 auto; border: 0; background: none; color: inherit; cursor: pointer;
          display: flex; align-items: center; padding: 0.2rem;
        }

        .rmq__list { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); list-style: none; margin: 0; padding: 0; }
        .rmq__row { display: grid; gap: var(--space-2); padding: var(--space-4); min-width: 0; }

        .rmq__top { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
        .rmq__stars { display: inline-flex; gap: 0.1rem; color: var(--warning); }
        .rmq__stars svg[fill='none'] { color: var(--border-control); }
        .rmq__date { margin-left: auto; font-size: var(--text-2xs); color: var(--text-tertiary); }

        .rmq__reviewer { font-size: var(--text-sm); font-weight: 600; }
        .rmq__body { font-size: var(--text-sm); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }

        .rmq__notes { display: grid; gap: var(--space-2); grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
        .rmq__note strong { display: block; font-size: var(--text-xs); font-weight: 600; margin-bottom: 0.15rem; }
        .rmq__note p { font-size: var(--text-sm); line-height: 1.5; color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }

        .rmq__meta { font-size: var(--text-2xs); color: var(--text-tertiary); }
        .rmq__id { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }

        .rmq__report {
          display: grid; gap: 0.3rem; padding: var(--space-3);
          background: var(--warning-soft); border-radius: var(--radius-sm);
        }
        .rmq__report > p { font-size: var(--text-sm); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }

        .rmq__form { display: grid; gap: var(--space-3); padding-top: var(--space-2); border-top: 1px solid var(--border); }
        .rmq__actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }

        @media (max-width: 560px) {
          .rmq__date { margin-left: 0; flex-basis: 100%; }
          .rmq__actions > * { flex: 1 1 auto; }
        }
      `}</style>
    </div>
  );
}
