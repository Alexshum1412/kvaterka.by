'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation.ts';
import { api, ApiError } from '@/lib/api-client.ts';
import { Icon } from '@/ui/icons.tsx';
import { formatMoney, money } from '@/server/domain/money.ts';
import { BOOST_TIERS, HIGHLIGHT_TIERS, PIN_TIERS } from '@/server/domain/promotion-tiers.ts';
import type { AppLocale } from '@/i18n/routing.ts';

const DATE_LOCALE: Record<AppLocale, string> = {
  ru: 'ru-BY',
  be: 'be-BY',
  en: 'en-US',
};

type PromoKind = 'boost' | 'highlight' | 'pin';

/** One row per selectable card — shape shared across all three promotion kinds. */
interface TierOption {
  readonly id: string;
  readonly priceMinor: bigint;
}

const BOOST_TIER_OPTIONS: readonly TierOption[] = Object.values(BOOST_TIERS);
const HIGHLIGHT_TIER_OPTIONS: readonly TierOption[] = Object.values(HIGHLIGHT_TIERS);
const PIN_TIER_OPTIONS: readonly TierOption[] = Object.values(PIN_TIERS);

/**
 * Pause/resume/delete/promote for one listing card.
 *
 * `POST /listings/:id/status` has existed since the lifecycle was built —
 * nothing here is new backend, only the first UI that calls it. Delete is
 * really "archive": the row and its history (past bookings, reviews) stay,
 * the same soft-delete convention the rest of the product uses for an
 * account closure. A second click is required before it fires — this is
 * the one action on this card that cannot be undone from the dashboard.
 *
 * Promotion (DEC-072) used to be a single "Boost" button that fired a
 * purchase on click, with no price shown anywhere first — a real gap this
 * rewrite also closes, not only the pricing redesign it was asked for. The
 * "Продвинуть" toggle below expands into three independent `PromotionGroup`s
 * (boost tiers, the highlight add-on, pin durations), each its own
 * confirm-then-buy flow: picking a tier arms an inline "buy for {price}?"
 * step, exactly like the delete confirmation above it, rather than charging
 * on the first click.
 */
export function ListingStatusActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const t = useTranslations('Dashboard');
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promoOpen, setPromoOpen] = useState(false);

  async function setStatus(next: 'PAUSED' | 'PUBLISHED' | 'ARCHIVED') {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/listings/${id}/status`, { status: next });
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('statusChangeError'));
      setBusy(false);
      setConfirmingDelete(false);
    }
  }

  if (status === 'ARCHIVED') return null;

  const canPause = status === 'PUBLISHED';
  const canResume = status === 'PAUSED';
  const canPromote = status === 'PUBLISHED';
  // Every other state (DRAFT, PENDING_MODERATION, REJECTED, PUBLISHED, PAUSED)
  // can be archived by its owner — see OWNER_TRANSITIONS in listing-service.ts.
  const canDelete = true;

  return (
    <div className="lsa">
      {canPromote && (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => setPromoOpen((open) => !open)}
          aria-expanded={promoOpen}
        >
          <Icon name="star" size={15} />
          {promoOpen ? t('promoToggleClose') : t('promoToggleOpen')}
        </button>
      )}
      {canPause && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void setStatus('PAUSED')}>
          <Icon name="eye" size={15} />
          {t('hide')}
        </button>
      )}
      {canResume && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void setStatus('PUBLISHED')}>
          <Icon name="checkCircle" size={15} />
          {t('republish')}
        </button>
      )}
      {canDelete &&
        (confirmingDelete ? (
          <span className="lsa__confirm">
            <span className="lsa__confirmText">
              {status === 'PENDING_MODERATION'
                ? t('confirmWithdrawDelete')
                : status === 'PUBLISHED'
                  ? t('confirmDeletePublished')
                  : t('confirmDelete')}
            </span>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy}
              onClick={() => void setStatus('ARCHIVED')}
            >
              {busy ? t('deleting') : t('confirmYes')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => setConfirmingDelete(false)}
            >
              {t('cancel')}
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-ghost lsa__delete"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
            aria-label={t('deleteAriaLabel')}
          >
            <Icon name="close" size={15} />
            {t('delete')}
          </button>
        ))}
      {error && (
        <span className="error-text lsa__error" role="alert">
          {error}
        </span>
      )}

      {canPromote && promoOpen && (
        <div className="lsa__promo">
          <PromotionGroup
            kind="boost"
            apiPath={`/listings/${id}/boost`}
            options={BOOST_TIER_OPTIONS}
            onPurchased={() => router.refresh()}
          />
          <PromotionGroup
            kind="highlight"
            apiPath={`/listings/${id}/highlight`}
            options={HIGHLIGHT_TIER_OPTIONS}
            onPurchased={() => router.refresh()}
          />
          <PromotionGroup
            kind="pin"
            apiPath={`/listings/${id}/pin`}
            options={PIN_TIER_OPTIONS}
            onPurchased={() => router.refresh()}
          />
        </div>
      )}

      <style>{`
        .lsa { display: contents; }
        .lsa__delete { color: var(--error); }
        .lsa__delete:hover:not(:disabled) { background: var(--error-soft, var(--surface-sunken)); }
        .lsa__confirm { display: inline-flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
        .lsa__confirmText { font-size: var(--text-xs); color: var(--text-secondary); }
        .lsa__error { flex-basis: 100%; font-size: var(--text-xs); }

        /* flex-basis:100% inside the parent's flex-wrap row (.dash-pc__actions)
           makes this drop onto its own line below the action buttons, with no
           portal or absolute positioning needed — .lsa itself is display:contents,
           so this <div> is a direct flex child of that row. */
        .lsa__promo {
          flex-basis: 100%;
          display: flex; flex-direction: column; gap: var(--space-4);
          margin-top: var(--space-3);
          padding: var(--space-4);
          background: var(--surface-sunken);
          border-radius: var(--radius-md);
        }
      `}</style>
    </div>
  );
}

/**
 * One purchasable group: a heading, a short explanation of what it does, a
 * grid of tier cards each showing its real price, and an inline confirm step
 * before the purchase actually fires. Boost/highlight/pin share this exact
 * shape (pick a tier, see the price, confirm, buy) even though their tiers
 * and API routes differ — see `TierOption`.
 */
function PromotionGroup({
  kind,
  apiPath,
  options,
  onPurchased,
}: {
  kind: PromoKind;
  apiPath: string;
  options: readonly TierOption[];
  onPurchased: () => void;
}) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations('Boost');
  const [pendingTier, setPendingTier] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successUntil, setSuccessUntil] = useState<string | null>(null);

  async function confirmPurchase(tierId: string) {
    setBuying(true);
    setError(null);
    try {
      const result = await api.post<{
        endsAt?: string;
        boosts?: readonly { endsAt: string }[];
      }>(apiPath, { tierId });
      // Boost returns a schedule of rows; highlight/pin return one. Either
      // way, the date worth showing is when the LAST purchased row lapses.
      const until = result.boosts?.length ? result.boosts[result.boosts.length - 1]!.endsAt : (result.endsAt ?? null);
      setSuccessUntil(until);
      setPendingTier(null);
      onPurchased();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('error'));
    } finally {
      setBuying(false);
    }
  }

  const formattedDate = (iso: string) =>
    new Date(iso).toLocaleDateString(DATE_LOCALE[locale], { day: 'numeric', month: 'long' });

  return (
    <div className="lsa-group">
      <p className="lsa-group__heading">{t(`${kind}.heading`)}</p>
      <p className="lsa-group__hint">{t(`${kind}.hint`)}</p>

      {successUntil && (
        <p className="lsa-group__success">
          <Icon name="checkCircle" size={15} />
          {t(`${kind}.successUntil`, { date: formattedDate(successUntil) })}
        </p>
      )}

      <div className="lsa-group__tiers">
        {options.map((option) => {
          const isPending = pendingTier === option.id;
          const price = formatMoney(money(option.priceMinor));
          return (
            <div key={option.id} className={`lsa-tier${isPending ? ' lsa-tier--active' : ''}`}>
              <button
                type="button"
                className="lsa-tier__card"
                disabled={buying}
                onClick={() => setPendingTier(isPending ? null : option.id)}
              >
                <span className="lsa-tier__name">{t(`${kind}.tiers.${option.id}.name`)}</span>
                <span className="lsa-tier__desc">{t(`${kind}.tiers.${option.id}.description`)}</span>
                <span className="lsa-tier__price numeric">{price}</span>
              </button>
              {isPending && (
                <div className="lsa-tier__confirm">
                  <span>{t('confirmQuestion', { name: t(`${kind}.tiers.${option.id}.name`), price })}</span>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={buying}
                    onClick={() => void confirmPurchase(option.id)}
                  >
                    {buying ? t('buying') : t('confirmYes')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={buying}
                    onClick={() => setPendingTier(null)}
                  >
                    {t('confirmCancel')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <span className="error-text" role="alert">
          {error}
        </span>
      )}

      <style>{`
        .lsa-group__heading { font-size: var(--text-sm); font-weight: 650; color: var(--text-primary); }
        .lsa-group__hint { margin-top: 0.1rem; font-size: var(--text-xs); color: var(--text-secondary); }
        .lsa-group__success {
          margin-top: var(--space-2);
          display: inline-flex; align-items: center; gap: 0.3rem;
          font-size: var(--text-xs); font-weight: 500;
          color: var(--success);
        }
        .lsa-group__tiers {
          margin-top: var(--space-2);
          display: flex; flex-wrap: wrap; gap: var(--space-2);
        }
        .lsa-tier { display: flex; flex-direction: column; }
        .lsa-tier__card {
          display: flex; flex-direction: column; gap: 0.15rem;
          min-width: 9rem;
          padding: var(--space-2) var(--space-3);
          background: var(--surface);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-sm);
          text-align: left;
          cursor: pointer;
        }
        .lsa-tier__card:hover:not(:disabled) { border-color: var(--border-control); }
        .lsa-tier--active .lsa-tier__card { border-color: var(--primary); background: var(--primary-soft); }
        .lsa-tier__name { font-size: var(--text-sm); font-weight: 600; color: var(--text-primary); }
        .lsa-tier__desc { font-size: var(--text-2xs); color: var(--text-secondary); }
        .lsa-tier__price { margin-top: 0.2rem; font-size: var(--text-sm); font-weight: 650; color: var(--primary); }
        .lsa-tier__confirm {
          margin-top: var(--space-1);
          display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;
          font-size: var(--text-xs); color: var(--text-secondary);
        }
      `}</style>
    </div>
  );
}
