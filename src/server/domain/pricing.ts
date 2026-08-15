/**
 * Price quoting.
 *
 * Produces the complete, honest total a tenant is asked to commit to (spec §8):
 * base rent, mandatory extras, and — separately and clearly — anything that
 * genuinely cannot be known in advance.
 *
 * Everything here is integer arithmetic on kopecks. A quote is deterministic:
 * the same property, dates and rules always yield the same numbers, which is
 * what allows the confirmed terms to be frozen and later re-verified.
 */

import {
  add,
  applyBps,
  DEFAULT_SERVICE_FEE_BPS,
  divideRoundHalfAwayFromZero,
  money,
  multiplyByCount,
  serviceFee,
  sum,
  zero,
  type BasisPoints,
  type Money,
} from './money.ts';

export type PriceUnit = 'NIGHT' | 'MONTH';
export type UtilitiesMode = 'INCLUDED' | 'FIXED_EXTRA' | 'VARIABLE_METERED';

/**
 * Nights per billing month for long-term pricing (DEC-012).
 *
 * A landlord who advertises "1900 BYN/month" expects a 30-night stay to cost
 * exactly 1900, so the quote bills whole 30-night months at the monthly price
 * and prices the remainder per night. Converting monthly→nightly with 365/12
 * would have quoted 1874 for that stay and made the platform look like it
 * shaves money off landlords.
 */
export const NIGHTS_PER_BILLING_MONTH = 30;

export interface LengthOfStayRule {
  readonly kind: 'LENGTH_OF_STAY';
  readonly minNights: number;
  readonly maxNights: number;
  readonly priceMinor: bigint;
  readonly priceUnit: PriceUnit;
  readonly priority: number;
}

export interface SeasonalRule {
  readonly kind: 'SEASONAL';
  readonly from: string; // inclusive ISO date
  readonly to: string; // exclusive ISO date
  readonly priceMinor: bigint;
  readonly priceUnit: PriceUnit;
  readonly priority: number;
}

export type PricingRule = LengthOfStayRule | SeasonalRule;

export interface PricingInput {
  readonly basePriceMinor: bigint;
  readonly basePriceUnit: PriceUnit;
  readonly cleaningFeeMinor?: bigint;
  readonly utilitiesMode?: UtilitiesMode;
  readonly utilitiesFixedMinor?: bigint;
  readonly depositMinor?: bigint;
  readonly rules?: readonly PricingRule[];
  readonly serviceFeeBps?: BasisPoints;
}

export interface QuoteLine {
  readonly code: string;
  readonly label: string;
  readonly amount: Money;
  /** Variable lines are shown separately and excluded from the committed total. */
  readonly variable: boolean;
}

export interface Quote {
  readonly nights: number;
  readonly rent: Money;
  readonly lines: readonly QuoteLine[];
  /** What the tenant commits to. Excludes metered utilities and the deposit. */
  readonly totalExpected: Money;
  /** Refundable, so never part of the total or of the fee base. */
  readonly deposit: Money;
  /** The amount the 5% is computed from. Stored on the booking. */
  readonly feeBase: Money;
  /** What the landlord will owe the platform once the rental completes. */
  readonly estimatedServiceFee: Money;
  readonly hasVariableCosts: boolean;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

export function nightsBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new PricingError(`Invalid date range ${from}..${to}`);
  const nights = Math.round((end - start) / 86_400_000);
  if (nights <= 0) throw new PricingError(`Stay must be at least one night (${from}..${to})`);
  return nights;
}

/** ISO date of `from` plus n days, in UTC. */
function addDays(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Normalise any price to a per-night amount, for per-night rule application. */
function toNightly(priceMinor: bigint, unit: PriceUnit): bigint {
  return unit === 'NIGHT'
    ? priceMinor
    : divideRoundHalfAwayFromZero(priceMinor, BigInt(NIGHTS_PER_BILLING_MONTH));
}

/**
 * Rent for a stay.
 *
 * Seasonal rules are applied night by night, so a stay that straddles a season
 * boundary is charged correctly on both sides rather than being forced into one
 * bucket. Length-of-stay tiers apply to the whole stay, since they are a
 * discount for committing to a duration.
 */
export function computeRent(from: string, to: string, input: PricingInput): Money {
  const nights = nightsBetween(from, to);
  const rules = input.rules ?? [];

  const losRule = rules
    .filter((r): r is LengthOfStayRule => r.kind === 'LENGTH_OF_STAY')
    .filter((r) => nights >= r.minNights && nights <= r.maxNights)
    .sort((a, b) => b.priority - a.priority || b.minNights - a.minNights)[0];

  const effectiveUnit = losRule?.priceUnit ?? input.basePriceUnit;
  const effectivePrice = losRule?.priceMinor ?? input.basePriceMinor;

  const seasonal = rules
    .filter((r): r is SeasonalRule => r.kind === 'SEASONAL')
    .sort((a, b) => b.priority - a.priority);

  const seasonalNightly = (date: string): bigint | null => {
    const hit = seasonal.find((s) => date >= s.from && date < s.to);
    return hit ? toNightly(hit.priceMinor, hit.priceUnit) : null;
  };

  const hasSeasonalOverlap = seasonal.some((s) => {
    for (let i = 0; i < nights; i += 1) {
      const d = addDays(from, i);
      if (d >= s.from && d < s.to) return true;
    }
    return false;
  });

  // Whole-month billing only applies when no seasonal rule interferes; mixing
  // month billing with per-night season overrides would be ambiguous, and the
  // tenant-visible number must never be ambiguous.
  if (effectiveUnit === 'MONTH' && !hasSeasonalOverlap) {
    const months = Math.floor(nights / NIGHTS_PER_BILLING_MONTH);
    const remainder = nights % NIGHTS_PER_BILLING_MONTH;
    const monthly = money(effectivePrice);
    const nightly = money(toNightly(effectivePrice, 'MONTH'));
    return add(multiplyByCount(monthly, months), multiplyByCount(nightly, remainder));
  }

  const baseNightly = toNightly(effectivePrice, effectiveUnit);
  let total = zero();
  for (let i = 0; i < nights; i += 1) {
    total = add(total, money(seasonalNightly(addDays(from, i)) ?? baseNightly));
  }
  return total;
}

export function quote(from: string, to: string, input: PricingInput): Quote {
  const nights = nightsBetween(from, to);
  const rent = computeRent(from, to, input);

  const cleaning = money(input.cleaningFeeMinor ?? 0n);
  const utilitiesMode = input.utilitiesMode ?? 'INCLUDED';
  const utilitiesFixed = money(utilitiesMode === 'FIXED_EXTRA' ? (input.utilitiesFixedMinor ?? 0n) : 0n);
  const deposit = money(input.depositMinor ?? 0n);

  const lines: QuoteLine[] = [{ code: 'RENT', label: 'Аренда', amount: rent, variable: false }];
  if (cleaning.amountMinor > 0n) {
    lines.push({ code: 'CLEANING', label: 'Уборка (обязательно)', amount: cleaning, variable: false });
  }
  if (utilitiesFixed.amountMinor > 0n) {
    lines.push({ code: 'UTILITIES', label: 'Коммунальные (фиксированно)', amount: utilitiesFixed, variable: false });
  }
  if (utilitiesMode === 'VARIABLE_METERED') {
    // Deliberately zero-valued: the tenant is told this exists and that it
    // cannot be quoted, rather than being surprised by it at check-out.
    lines.push({ code: 'UTILITIES_METERED', label: 'Коммунальные по счётчику', amount: zero(), variable: true });
  }
  if (deposit.amountMinor > 0n) {
    lines.push({ code: 'DEPOSIT', label: 'Залог (возвратный)', amount: deposit, variable: false });
  }

  const totalExpected = sum(lines.filter((l) => !l.variable && l.code !== 'DEPOSIT').map((l) => l.amount));

  // The fee base excludes the refundable deposit (it is not landlord revenue)
  // and metered utilities (a pass-through the landlord does not profit from).
  const feeBase = add(add(rent, cleaning), utilitiesFixed);

  return {
    nights,
    rent,
    lines,
    totalExpected,
    deposit,
    feeBase,
    estimatedServiceFee: serviceFee(feeBase, input.serviceFeeBps ?? DEFAULT_SERVICE_FEE_BPS),
    hasVariableCosts: utilitiesMode === 'VARIABLE_METERED',
  };
}

/** Recompute a stored fee to verify it, for audits and reconciliation. */
export function verifyStoredFee(baseMinor: bigint, bps: BasisPoints, feeMinor: bigint): boolean {
  return applyBps(money(baseMinor), bps).amountMinor === feeMinor;
}
