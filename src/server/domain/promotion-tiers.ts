/**
 * Paid placement tier menus — boost, highlight and pin (DEC-072).
 *
 * Domain data and the pure arithmetic over it, not service logic: looking up
 * a price or splitting one across a schedule touches no database and belongs
 * here, next to money.ts's own rounding policy that the split function
 * reuses. `boost-service.ts`/`highlight-service.ts`/`pin-service.ts` own the
 * actual purchase (the row inserts, the ledger charge, the audit log); they
 * import the tables below rather than defining their own.
 *
 * This is also the one place the UI's promotion picker
 * (`listing-status-actions.tsx`) imports from to show a real price before
 * the purchase POST fires. It is a 'use client' component, so it cannot pull
 * in the service classes (`Db`-shaped constructors, transactions) — but this
 * module has no such dependency, the same reason `money.ts` itself is
 * already imported from a client component (`booking-panel.tsx`). Showing a
 * price here is display only: the server never trusts it back, and always
 * re-resolves it from these same tables at purchase time.
 */

import { divideRoundHalfAwayFromZero } from './money.ts';

/* ==================================================================== *
 * Boost — a bump to the top of search for a short, fixed window, bought
 * singly or as a schedule of several bumps spaced `intervalDays` apart.
 * ==================================================================== */

export type BoostTierId = 'SINGLE' | 'TRIPLE_WEEKLY' | 'MONTHLY' | 'CONTINUOUS_WEEK';

export interface BoostTier {
  readonly id: BoostTierId;
  /** How many separate `listing_boost` rows a purchase of this tier inserts. */
  readonly count: number;
  /** Days between each row's `starts_at`. 0 when there is only one row. */
  readonly intervalDays: number;
  /** How long each individual row stays ACTIVE once it starts. */
  readonly boostDurationDays: number;
  /** Total price for the whole tier — split across `count` rows, never per-row input. */
  readonly priceMinor: bigint;
}

/** A single bump lasts a day — long enough to matter, short enough that four of them read as four separate pushes rather than one long placement. */
const BUMP_DURATION_DAYS = 1;

/**
 * The tier menu. A client-supplied price is never trusted — every purchase
 * path looks a `tierId` up in this table server-side.
 *
 * Per-bump value, worst to best: SINGLE 5.00 Br/bump, TRIPLE_WEEKLY 4.00
 * Br/bump, MONTHLY 3.75 Br/bump — the flagship bundle is deliberately the
 * cheapest per push. CONTINUOUS_WEEK is not a bump at all and is not meant
 * to be compared per-unit; it is priced as a premium alternative for someone
 * who wants uninterrupted placement instead of periodic pushes, not a deal.
 * See DECISIONS.md DEC-072 for the full reasoning.
 */
export const BOOST_TIERS: Readonly<Record<BoostTierId, BoostTier>> = {
  SINGLE: {
    id: 'SINGLE',
    count: 1,
    intervalDays: 0,
    boostDurationDays: BUMP_DURATION_DAYS,
    priceMinor: 500n, // 5.00 Br — the product owner's own example
  },
  TRIPLE_WEEKLY: {
    id: 'TRIPLE_WEEKLY',
    count: 3,
    intervalDays: 7,
    boostDurationDays: BUMP_DURATION_DAYS,
    priceMinor: 1_200n, // 12.00 Br — below 3×5.00, above the monthly bundle's per-bump rate
  },
  MONTHLY: {
    id: 'MONTHLY',
    count: 4,
    intervalDays: 7,
    boostDurationDays: BUMP_DURATION_DAYS,
    priceMinor: 1_500n, // 15.00 Br for 4 — the product owner's own example, the flagship deal
  },
  CONTINUOUS_WEEK: {
    id: 'CONTINUOUS_WEEK',
    count: 1,
    intervalDays: 0,
    boostDurationDays: 7,
    priceMinor: 4_500n, // 45.00 Br — premium convenience, deliberately not a good per-day deal
  },
};

/**
 * Split `totalMinor` into `count` integer shares that sum EXACTLY to
 * `totalMinor` — no row is ever a penny short or over because of rounding.
 *
 * Cumulative rounding (rather than "divide, then dump the remainder on the
 * first row") reuses the platform's one rounding policy
 * (`divideRoundHalfAwayFromZero`, DEC-005) for every share: share `i` is the
 * running total through row `i` minus the running total through row `i-1`,
 * so the shares telescope back to `totalMinor` by construction and every
 * individual share is still "half away from zero" of its ideal fraction.
 */
export function splitBoostAmount(totalMinor: bigint, count: number): bigint[] {
  const shares: bigint[] = [];
  let previousCumulative = 0n;
  for (let i = 1; i <= count; i += 1) {
    const cumulative = divideRoundHalfAwayFromZero(totalMinor * BigInt(i), BigInt(count));
    shares.push(cumulative - previousCumulative);
    previousCumulative = cumulative;
  }
  return shares;
}

/* ==================================================================== *
 * Highlight — a colour accent on the card. Visual only; never a ranking
 * signal. One tier today.
 * ==================================================================== */

export type HighlightTierId = 'WEEK';

export interface HighlightTier {
  readonly id: HighlightTierId;
  readonly durationDays: number;
  readonly priceMinor: bigint;
}

export const HIGHLIGHT_TIERS: Readonly<Record<HighlightTierId, HighlightTier>> = {
  WEEK: { id: 'WEEK', durationDays: 7, priceMinor: 800n }, // 8.00 Br
};

/* ==================================================================== *
 * Pin — the strongest placement, ranked above a boosted-but-unpinned
 * listing. Three flat durations, no schedule to split.
 * ==================================================================== */

export type PinTierId = '1D' | '2D' | '7D';

export interface PinTier {
  readonly id: PinTierId;
  readonly durationDays: number;
  readonly priceMinor: bigint;
}

/**
 * Per-day value, worst to best: 1D 10.00 Br/day, 2D 9.00 Br/day (a small
 * discount vs 2×10.00), 7D ~7.14 Br/day (a bigger discount vs 7×10.00=70.00,
 * but still the most expensive placement product on the platform per unit
 * time — deliberately premium-priced, not a bargain: it is the strongest
 * slot there is.
 */
export const PIN_TIERS: Readonly<Record<PinTierId, PinTier>> = {
  '1D': { id: '1D', durationDays: 1, priceMinor: 1_000n },
  '2D': { id: '2D', durationDays: 2, priceMinor: 1_800n },
  '7D': { id: '7D', durationDays: 7, priceMinor: 5_000n },
};
