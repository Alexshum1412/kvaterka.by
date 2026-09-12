/**
 * Promotion tier menus — the half that needs no database.
 *
 * `BOOST_TIERS`/`HIGHLIGHT_TIERS`/`PIN_TIERS` and `splitBoostAmount` are pure
 * domain data and arithmetic (see promotion-tiers.ts's own header for why
 * they live outside boost-service.ts). Same reasoning as
 * `pg10-migrations.static.test.ts`: no PGlite instance needed to check that a
 * price table is internally consistent or that a rounding function sums
 * exactly, so this stays its own fast file rather than a corner of
 * `promotions.integration.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { BOOST_TIERS, HIGHLIGHT_TIERS, PIN_TIERS, splitBoostAmount } from '@/server/domain/promotion-tiers.ts';

describe('splitBoostAmount', () => {
  it('splits an evenly divisible total into equal shares', () => {
    expect(splitBoostAmount(1_200n, 3)).toEqual([400n, 400n, 400n]);
    expect(splitBoostAmount(1_500n, 4)).toEqual([375n, 375n, 375n, 375n]);
  });

  it('splits a single-row tier into one share equal to the total', () => {
    expect(splitBoostAmount(4_500n, 1)).toEqual([4_500n]);
  });

  it('sums to EXACTLY the total even when it does not divide evenly, with the remainder spread by rounding rather than dumped on one row', () => {
    const shares = splitBoostAmount(1_000n, 3);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(1_000n);
    // 1000/3 = 333.33..., so no share is more than a kopeck away from the
    // ideal 333.33 — the remainder is spread (334 on the middle share), not
    // piled entirely onto the first or last row.
    expect(shares).toEqual([333n, 334n, 333n]);
  });

  it('sums to the total for every tier actually on the menu', () => {
    for (const tier of Object.values(BOOST_TIERS)) {
      const shares = splitBoostAmount(tier.priceMinor, tier.count);
      expect(shares).toHaveLength(tier.count);
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(tier.priceMinor);
      for (const share of shares) expect(share).toBeGreaterThan(0n);
    }
  });
});

describe('BOOST_TIERS', () => {
  it('prices the flagship MONTHLY bundle at or below every other periodic-bump tier, per bump', () => {
    // The product owner's own two anchor prices: 1 boost = 5 Br, 4 boosts
    // spaced a week apart = 15 Br total (DEC-072).
    expect(BOOST_TIERS.SINGLE.priceMinor).toBe(500n);
    expect(BOOST_TIERS.MONTHLY.priceMinor).toBe(1_500n);
    expect(BOOST_TIERS.MONTHLY.count).toBe(4);
    expect(BOOST_TIERS.MONTHLY.intervalDays).toBe(7);

    const perBump = (id: 'SINGLE' | 'TRIPLE_WEEKLY' | 'MONTHLY') => {
      const tier = BOOST_TIERS[id];
      return Number(tier.priceMinor) / tier.count;
    };
    // Worst to best value, exactly as the product owner asked for
    // ("выгодные и не выгодные" offers): single is the worst per-bump deal,
    // the monthly bundle the best.
    expect(perBump('SINGLE')).toBeGreaterThan(perBump('TRIPLE_WEEKLY'));
    expect(perBump('TRIPLE_WEEKLY')).toBeGreaterThan(perBump('MONTHLY'));
  });

  it('prices CONTINUOUS_WEEK as a premium, not a bargain, next to the periodic tiers', () => {
    // 7 daily bumps at the SINGLE rate would be 35.00 Br; guaranteed
    // uninterrupted placement costs strictly more than that on this menu —
    // it trades a worse price for a stronger guarantee, deliberately.
    const sevenSingles = BOOST_TIERS.SINGLE.priceMinor * 7n;
    expect(BOOST_TIERS.CONTINUOUS_WEEK.priceMinor).toBeGreaterThan(sevenSingles);
    expect(BOOST_TIERS.CONTINUOUS_WEEK.boostDurationDays).toBe(7);
    expect(BOOST_TIERS.CONTINUOUS_WEEK.count).toBe(1);
  });

  it('schedules every periodic tier a week apart, and the single tier with no schedule at all', () => {
    expect(BOOST_TIERS.SINGLE.intervalDays).toBe(0);
    expect(BOOST_TIERS.TRIPLE_WEEKLY.intervalDays).toBe(7);
    expect(BOOST_TIERS.MONTHLY.intervalDays).toBe(7);
  });
});

describe('HIGHLIGHT_TIERS', () => {
  it('has exactly the one published tier, priced as stated to the product owner', () => {
    expect(Object.keys(HIGHLIGHT_TIERS)).toEqual(['WEEK']);
    expect(HIGHLIGHT_TIERS.WEEK.priceMinor).toBe(800n);
    expect(HIGHLIGHT_TIERS.WEEK.durationDays).toBe(7);
  });
});

describe('PIN_TIERS', () => {
  it('discounts longer durations per day, while staying premium-priced throughout', () => {
    expect(PIN_TIERS['1D'].priceMinor).toBe(1_000n);
    expect(PIN_TIERS['2D'].priceMinor).toBe(1_800n);
    expect(PIN_TIERS['7D'].priceMinor).toBe(5_000n);

    const perDay = (id: '1D' | '2D' | '7D') => Number(PIN_TIERS[id].priceMinor) / PIN_TIERS[id].durationDays;
    // Each longer tier is a real discount vs. buying the shorter tier
    // repeatedly, but 7D is still the most expensive placement product on
    // the platform per day — never cheaper, per unit time, than a boost.
    expect(perDay('2D')).toBeLessThan(perDay('1D'));
    expect(perDay('7D')).toBeLessThan(perDay('2D'));
    expect(PIN_TIERS['7D'].priceMinor).toBeLessThan(PIN_TIERS['1D'].priceMinor * 7n);
  });
});
