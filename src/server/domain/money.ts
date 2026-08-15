/**
 * Monetary values.
 *
 * INVARIANT: money is NEVER represented as a JS `number` anywhere in this codebase.
 * All amounts are integer minor units (kopecks for BYN) held in `bigint`.
 *
 * Rationale (DEC-004): IEEE-754 doubles cannot represent 0.1 exactly, so a 5%
 * service fee computed in floats is neither reproducible nor auditable. The
 * platform's fee is a legal debt claim against a landlord — it must be
 * recomputable, byte-for-byte, from the stored inputs at any time in the future.
 */

/** ISO-4217 currencies the platform knows about. Belarus launch = BYN only. */
export const CURRENCIES = ['BYN'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Number of minor units in one major unit, per currency. */
const MINOR_UNITS: Record<Currency, bigint> = {
  BYN: 100n,
};

export interface Money {
  /** Integer amount in minor units (kopecks). May be negative (landlord debt). */
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function money(amountMinor: bigint | number, currency: Currency = 'BYN'): Money {
  if (typeof amountMinor === 'number') {
    if (!Number.isInteger(amountMinor)) {
      throw new MoneyError(`Refusing to build Money from non-integer number ${amountMinor}`);
    }
    if (!Number.isSafeInteger(amountMinor)) {
      throw new MoneyError(`Amount ${amountMinor} exceeds safe integer range; pass a bigint`);
    }
    return { amountMinor: BigInt(amountMinor), currency };
  }
  return { amountMinor, currency };
}

export const zero = (currency: Currency = 'BYN'): Money => ({ amountMinor: 0n, currency });

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function sum(items: readonly Money[], currency: Currency = 'BYN'): Money {
  return items.reduce<Money>((acc, m) => add(acc, m), zero(currency));
}

export function negate(a: Money): Money {
  return { amountMinor: -a.amountMinor, currency: a.currency };
}

/** Multiply by a whole number of units (e.g. price per night × 7 nights). */
export function multiplyByCount(a: Money, count: number | bigint): Money {
  // Validate before converting: BigInt(1.5) throws a RangeError, which would
  // escape as an opaque runtime error instead of a domain error.
  if (typeof count === 'number' && !Number.isInteger(count)) {
    throw new MoneyError(`multiplyByCount requires an integer count, got ${count}`);
  }
  const n = typeof count === 'bigint' ? count : BigInt(count);
  if (n < 0n) throw new MoneyError('Count must not be negative');
  return { amountMinor: a.amountMinor * n, currency: a.currency };
}

export const isZero = (a: Money): boolean => a.amountMinor === 0n;
export const isNegative = (a: Money): boolean => a.amountMinor < 0n;
export const isPositive = (a: Money): boolean => a.amountMinor > 0n;
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}
export const equals = (a: Money, b: Money): boolean => a.currency === b.currency && a.amountMinor === b.amountMinor;

/* ------------------------------------------------------------------ *
 * Rounding
 * ------------------------------------------------------------------ */

/**
 * Divide `numerator` by `denominator` rounding half away from zero, in exact
 * integer arithmetic. This is the platform's single rounding policy (DEC-005).
 *
 * "Half away from zero" (a.k.a. commercial rounding) is used rather than
 * banker's rounding because it is what a Belarusian accountant and a landlord
 * reading an invoice both expect: 50.5 kopecks becomes 51, never 50.
 */
export function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('Division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;
  // (|n| * 2 + |d|) / (|d| * 2) == round-half-up on |n|/|d|
  const quotient = (absNum * 2n + absDen) / (absDen * 2n);
  return negative ? -quotient : quotient;
}

/* ------------------------------------------------------------------ *
 * Percentages / service fee
 * ------------------------------------------------------------------ */

/** Basis points. 500 bps = 5.00%. Integer only — never a float percentage. */
export type BasisPoints = number;

export const BPS_DENOMINATOR = 10_000n;

/** The platform's default landlord service fee: 5.00%. */
export const DEFAULT_SERVICE_FEE_BPS: BasisPoints = 500;

export function assertValidBps(bps: BasisPoints): void {
  if (!Number.isInteger(bps)) throw new MoneyError(`Basis points must be an integer, got ${bps}`);
  if (bps < 0 || bps > 10_000) throw new MoneyError(`Basis points out of range [0,10000], got ${bps}`);
}

/**
 * Apply a basis-point rate to an amount, rounding half away from zero.
 *
 * Deterministic and reproducible: given the same (amountMinor, bps) this always
 * yields the same result, on any platform, forever. That property is what makes
 * a stored fee auditable.
 */
export function applyBps(amount: Money, bps: BasisPoints): Money {
  assertValidBps(bps);
  return {
    amountMinor: divideRoundHalfAwayFromZero(amount.amountMinor * BigInt(bps), BPS_DENOMINATOR),
    currency: amount.currency,
  };
}

/**
 * Compute the platform service fee owed by the landlord on a completed rental.
 *
 * `feeBase` is NOT necessarily the total the tenant pays: variable pass-through
 * costs (metered utilities) are excluded from the fee base. The caller is
 * responsible for building the base; see `bookingFeeBase()` in pricing.ts.
 */
export function serviceFee(feeBase: Money, bps: BasisPoints = DEFAULT_SERVICE_FEE_BPS): Money {
  if (isNegative(feeBase)) throw new MoneyError('Service fee base must not be negative');
  return applyBps(feeBase, bps);
}

/* ------------------------------------------------------------------ *
 * Parsing / formatting
 * ------------------------------------------------------------------ */

/**
 * Parse human input into Money. Accepts "1 234,56", "1234.56", "1234", with
 * non-breaking and thin spaces as group separators (common when pasting).
 *
 * Rejects anything with more decimal places than the currency supports rather
 * than silently truncating a user's money.
 */
export function parseMoney(input: string, currency: Currency = 'BYN'): Money {
  const minorUnits = MINOR_UNITS[currency];
  const decimals = String(minorUnits).length - 1;

  const cleaned = input
    .trim()
    .replace(/[\s\u00A0\u2009\u202F']/g, '')
    .replace(',', '.');

  if (cleaned === '') throw new MoneyError('Empty amount');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) throw new MoneyError(`Not a valid amount: "${input}"`);

  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [wholePart = '0', fracPart = ''] = unsigned.split('.');

  if (fracPart.length > decimals) {
    throw new MoneyError(`${currency} supports ${decimals} decimal places, got "${input}"`);
  }

  const paddedFraction = fracPart.padEnd(decimals, '0');
  const magnitude = BigInt(wholePart) * minorUnits + BigInt(paddedFraction === '' ? '0' : paddedFraction);
  return { amountMinor: negative ? -magnitude : magnitude, currency };
}

/** Machine-readable decimal string, e.g. "1234.56". Use for APIs and exports. */
export function toDecimalString(m: Money): string {
  const minorUnits = MINOR_UNITS[m.currency];
  const decimals = String(minorUnits).length - 1;
  const negative = m.amountMinor < 0n;
  const abs = negative ? -m.amountMinor : m.amountMinor;
  const whole = abs / minorUnits;
  const frac = abs % minorUnits;
  const fracStr = decimals > 0 ? '.' + frac.toString().padStart(decimals, '0') : '';
  return `${negative ? '-' : ''}${whole}${fracStr}`;
}

/**
 * Human display. Deliberately does NOT use Intl with a currency style: the
 * Belarusian convention is "1 234,56 BYN" and Intl output varies across ICU
 * versions, which would make snapshot tests and server/client rendering diverge.
 */
export function formatMoney(m: Money, opts: { showCurrency?: boolean; locale?: 'ru' | 'be' | 'en' } = {}): string {
  const { showCurrency = true } = opts;
  const decimal = toDecimalString(m);
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [whole = '0', frac] = unsigned.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  const body = frac ? `${grouped},${frac}` : grouped;
  const sign = negative ? '−' : ''; // U+2212 MINUS SIGN, not a hyphen
  return showCurrency ? `${sign}${body}\u00A0${m.currency}` : `${sign}${body}`;
}

/** Persist as a string so no JSON layer can turn it into a float. */
export const toStorage = (m: Money): string => m.amountMinor.toString();
export const fromStorage = (raw: string | bigint | number, currency: Currency = 'BYN'): Money => ({
  amountMinor: BigInt(raw),
  currency,
});
