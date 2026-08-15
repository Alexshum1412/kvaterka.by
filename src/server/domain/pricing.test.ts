import { describe, expect, it } from 'vitest';
import { parseMoney, toDecimalString } from './money.ts';
import {
  computeRent,
  NIGHTS_PER_BILLING_MONTH,
  nightsBetween,
  PricingError,
  quote,
  verifyStoredFee,
  type PricingInput,
} from './pricing.ts';

const nightly = (byn: string): PricingInput => ({
  basePriceMinor: parseMoney(byn).amountMinor,
  basePriceUnit: 'NIGHT',
});

const monthly = (byn: string): PricingInput => ({
  basePriceMinor: parseMoney(byn).amountMinor,
  basePriceUnit: 'MONTH',
});

describe('nightsBetween', () => {
  it('counts nights, not days', () => {
    expect(nightsBetween('2026-09-01', '2026-09-08')).toBe(7);
  });

  it('handles a month boundary', () => {
    expect(nightsBetween('2026-08-30', '2026-09-02')).toBe(3);
  });

  it('handles a leap day', () => {
    expect(nightsBetween('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('rejects a zero-night stay', () => {
    expect(() => nightsBetween('2026-09-01', '2026-09-01')).toThrow(PricingError);
  });

  it('rejects a reversed range', () => {
    expect(() => nightsBetween('2026-09-08', '2026-09-01')).toThrow(PricingError);
  });
});

describe('nightly pricing', () => {
  it('multiplies the nightly rate by the number of nights', () => {
    expect(toDecimalString(computeRent('2026-09-01', '2026-09-08', nightly('90')))).toBe('630.00');
  });

  it('does not drift on an awkward rate', () => {
    expect(toDecimalString(computeRent('2026-09-01', '2026-09-04', nightly('33.33')))).toBe('99.99');
  });
});

describe('monthly pricing', () => {
  it('charges exactly the advertised monthly price for a 30-night stay', () => {
    // The whole point of DEC-012: a landlord advertising 1900/month must see
    // 1900 for a month, not 1874.
    expect(toDecimalString(computeRent('2026-09-01', '2026-10-01', monthly('1900')))).toBe('1900.00');
  });

  it('charges two months for a 60-night stay', () => {
    const to = new Date('2026-09-01T00:00:00Z');
    to.setUTCDate(to.getUTCDate() + 2 * NIGHTS_PER_BILLING_MONTH);
    expect(toDecimalString(computeRent('2026-09-01', to.toISOString().slice(0, 10), monthly('1900')))).toBe(
      '3800.00',
    );
  });

  it('prices a partial month per night', () => {
    // 35 nights = 1 month (1900.00) + 5 nights at 63.33
    const to = new Date('2026-09-01T00:00:00Z');
    to.setUTCDate(to.getUTCDate() + 35);
    const rent = computeRent('2026-09-01', to.toISOString().slice(0, 10), monthly('1900'));
    expect(toDecimalString(rent)).toBe('2216.65');
  });

  it('prices a stay shorter than a month per night', () => {
    // 10 nights at round(190000/30) = 6333 kopecks = 63.33
    const rent = computeRent('2026-09-01', '2026-09-11', monthly('1900'));
    expect(toDecimalString(rent)).toBe('633.30');
  });
});

describe('length-of-stay tiers', () => {
  const tiered: PricingInput = {
    ...nightly('120'),
    rules: [
      { kind: 'LENGTH_OF_STAY', minNights: 1, maxNights: 3, priceMinor: 12000n, priceUnit: 'NIGHT', priority: 0 },
      { kind: 'LENGTH_OF_STAY', minNights: 4, maxNights: 7, priceMinor: 10500n, priceUnit: 'NIGHT', priority: 0 },
      { kind: 'LENGTH_OF_STAY', minNights: 8, maxNights: 30, priceMinor: 9000n, priceUnit: 'NIGHT', priority: 0 },
    ],
  };

  it('applies the short-stay tier', () => {
    expect(toDecimalString(computeRent('2026-09-01', '2026-09-03', tiered))).toBe('240.00');
  });

  it('applies the mid tier', () => {
    expect(toDecimalString(computeRent('2026-09-01', '2026-09-06', tiered))).toBe('525.00');
  });

  it('applies the long-stay discount', () => {
    expect(toDecimalString(computeRent('2026-09-01', '2026-09-11', tiered))).toBe('900.00');
  });

  it('falls back to the base price when no tier matches', () => {
    // 40 nights is outside every tier.
    const to = new Date('2026-09-01T00:00:00Z');
    to.setUTCDate(to.getUTCDate() + 40);
    expect(toDecimalString(computeRent('2026-09-01', to.toISOString().slice(0, 10), tiered))).toBe('4800.00');
  });
});

describe('seasonal pricing', () => {
  const seasonal: PricingInput = {
    ...nightly('100'),
    rules: [
      { kind: 'SEASONAL', from: '2026-12-30', to: '2027-01-03', priceMinor: 25000n, priceUnit: 'NIGHT', priority: 10 },
    ],
  };

  it('charges the season rate inside the season', () => {
    expect(toDecimalString(computeRent('2026-12-30', '2027-01-02', seasonal))).toBe('750.00');
  });

  it('charges the base rate outside the season', () => {
    expect(toDecimalString(computeRent('2026-11-01', '2026-11-04', seasonal))).toBe('300.00');
  });

  it('splits a stay that straddles the season boundary', () => {
    // 28,29 Dec at 100 + 30,31 Dec at 250 = 200 + 500
    expect(toDecimalString(computeRent('2026-12-28', '2027-01-01', seasonal))).toBe('700.00');
  });

  it('lets the higher-priority season win an overlap', () => {
    const overlapping: PricingInput = {
      ...nightly('100'),
      rules: [
        { kind: 'SEASONAL', from: '2026-12-01', to: '2027-01-15', priceMinor: 15000n, priceUnit: 'NIGHT', priority: 1 },
        { kind: 'SEASONAL', from: '2026-12-30', to: '2027-01-03', priceMinor: 25000n, priceUnit: 'NIGHT', priority: 10 },
      ],
    };
    expect(toDecimalString(computeRent('2026-12-30', '2026-12-31', overlapping))).toBe('250.00');
    expect(toDecimalString(computeRent('2026-12-05', '2026-12-06', overlapping))).toBe('150.00');
  });
});

describe('total price transparency', () => {
  const input: PricingInput = {
    ...nightly('80'),
    cleaningFeeMinor: parseMoney('30').amountMinor,
    depositMinor: parseMoney('300').amountMinor,
  };

  it('matches the worked example from the specification', () => {
    // Rental 560 + mandatory cleaning 30 = 590 expected.
    const q = quote('2026-09-01', '2026-09-08', input);
    expect(toDecimalString(q.rent)).toBe('560.00');
    expect(toDecimalString(q.totalExpected)).toBe('590.00');
  });

  it('keeps the refundable deposit out of the committed total', () => {
    const q = quote('2026-09-01', '2026-09-08', input);
    expect(toDecimalString(q.deposit)).toBe('300.00');
    expect(toDecimalString(q.totalExpected)).toBe('590.00');
  });

  it('keeps the deposit out of the fee base — it is not landlord revenue', () => {
    const q = quote('2026-09-01', '2026-09-08', input);
    expect(toDecimalString(q.feeBase)).toBe('590.00');
    expect(toDecimalString(q.estimatedServiceFee)).toBe('29.50');
  });

  it('includes fixed utilities in both the total and the fee base', () => {
    const q = quote('2026-09-01', '2026-09-08', {
      ...input,
      utilitiesMode: 'FIXED_EXTRA',
      utilitiesFixedMinor: parseMoney('45').amountMinor,
    });
    expect(toDecimalString(q.totalExpected)).toBe('635.00');
    expect(toDecimalString(q.feeBase)).toBe('635.00');
  });

  it('excludes metered utilities from the total and flags them as variable', () => {
    const q = quote('2026-09-01', '2026-09-08', { ...input, utilitiesMode: 'VARIABLE_METERED' });
    expect(q.hasVariableCosts).toBe(true);
    expect(toDecimalString(q.totalExpected)).toBe('590.00');
    expect(q.lines.find((l) => l.code === 'UTILITIES_METERED')?.variable).toBe(true);
  });

  it('never hides a mandatory charge inside a variable line', () => {
    const q = quote('2026-09-01', '2026-09-08', input);
    const mandatory = q.lines.filter((l) => !l.variable && l.code !== 'DEPOSIT');
    const total = mandatory.reduce((acc, l) => acc + l.amount.amountMinor, 0n);
    expect(total).toBe(q.totalExpected.amountMinor);
  });

  it('ignores a fixed utilities amount when the mode is not FIXED_EXTRA', () => {
    const q = quote('2026-09-01', '2026-09-08', {
      ...input,
      utilitiesMode: 'INCLUDED',
      utilitiesFixedMinor: parseMoney('45').amountMinor,
    });
    expect(toDecimalString(q.totalExpected)).toBe('590.00');
  });
});

describe('fee verification', () => {
  it('accepts a correctly computed stored fee', () => {
    expect(verifyStoredFee(59000n, 500, 2950n)).toBe(true);
  });

  it('rejects a tampered stored fee', () => {
    expect(verifyStoredFee(59000n, 500, 2900n)).toBe(false);
  });

  it('agrees with the quote for a range of stays', () => {
    for (let nights = 1; nights <= 60; nights += 1) {
      const to = new Date('2026-09-01T00:00:00Z');
      to.setUTCDate(to.getUTCDate() + nights);
      const q = quote('2026-09-01', to.toISOString().slice(0, 10), nightly('77.77'));
      expect(verifyStoredFee(q.feeBase.amountMinor, 500, q.estimatedServiceFee.amountMinor)).toBe(true);
    }
  });
});
