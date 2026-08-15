import { describe, expect, it } from 'vitest';
import {
  add,
  applyBps,
  compare,
  DEFAULT_SERVICE_FEE_BPS,
  divideRoundHalfAwayFromZero,
  formatMoney,
  fromStorage,
  money,
  MoneyError,
  multiplyByCount,
  parseMoney,
  serviceFee,
  subtract,
  sum,
  toDecimalString,
  toStorage,
  zero,
} from './money.ts';

describe('money construction', () => {
  it('rejects non-integer numbers so a float can never enter the system', () => {
    expect(() => money(10.5)).toThrow(MoneyError);
  });

  it('accepts bigint minor units', () => {
    expect(money(100_00n).amountMinor).toBe(10000n);
  });

  it('rejects unsafe integers', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(add(money(1005n), money(2n)).amountMinor).toBe(1007n);
    expect(subtract(money(1005n), money(2000n)).amountMinor).toBe(-995n);
  });

  it('sums an empty list to zero', () => {
    expect(sum([])).toEqual(zero());
  });

  it('refuses to mix currencies', () => {
    const byn = money(100n, 'BYN');
    const fake = { amountMinor: 100n, currency: 'USD' } as unknown as typeof byn;
    expect(() => add(byn, fake)).toThrow(/Currency mismatch/);
  });

  it('multiplies price-per-night by nights without drift', () => {
    // 0.1-style drift check: 33.33 BYN x 3 must be exactly 99.99, not 99.98999...
    const perNight = parseMoney('33.33');
    expect(toDecimalString(multiplyByCount(perNight, 3))).toBe('99.99');
  });

  it('rejects fractional counts', () => {
    expect(() => multiplyByCount(money(100n), 1.5)).toThrow(MoneyError);
  });

  it('compares', () => {
    expect(compare(money(1n), money(2n))).toBe(-1);
    expect(compare(money(2n), money(2n))).toBe(0);
    expect(compare(money(3n), money(2n))).toBe(1);
  });
});

describe('rounding policy: half away from zero', () => {
  it.each([
    [10n, 4n, 3n], // 2.5 -> 3
    [-10n, 4n, -3n], // -2.5 -> -3
    [6n, 4n, 2n], // 1.5 -> 2
    [2n, 4n, 1n], // 0.5 -> 1
    [1n, 4n, 0n], // 0.25 -> 0
    [7n, 2n, 4n], // 3.5 -> 4
    [5n, 2n, 3n], // 2.5 -> 3 (banker's rounding would give 2)
    [0n, 5n, 0n],
  ])('%s / %s = %s', (n, d, expected) => {
    expect(divideRoundHalfAwayFromZero(n, d)).toBe(expected);
  });

  it('throws on division by zero', () => {
    expect(() => divideRoundHalfAwayFromZero(1n, 0n)).toThrow(MoneyError);
  });
});

describe('service fee (5%)', () => {
  it('matches the specification example: 1000 BYN -> 50 BYN', () => {
    const fee = serviceFee(parseMoney('1000'));
    expect(toDecimalString(fee)).toBe('50.00');
  });

  it('rounds a half-kopeck up', () => {
    // 10.10 BYN * 5% = 0.505 BYN = 50.5 kopecks -> 51 kopecks
    expect(serviceFee(parseMoney('10.10')).amountMinor).toBe(51n);
  });

  it('rounds below the half down', () => {
    // 10.05 * 5% = 50.25 kopecks -> 50
    expect(serviceFee(parseMoney('10.05')).amountMinor).toBe(50n);
  });

  it('is deterministic across repeated evaluation', () => {
    const base = parseMoney('1899.99');
    const results = new Set(Array.from({ length: 1000 }, () => serviceFee(base).amountMinor.toString()));
    expect(results.size).toBe(1);
    expect([...results][0]).toBe('9500'); // 94.9995 BYN -> 95.00 BYN
  });

  it('never produces a fractional kopeck for any amount up to 100k BYN', () => {
    for (let byn = 0; byn <= 100_000; byn += 137) {
      const fee = serviceFee(money(BigInt(byn) * 100n));
      expect(fee.amountMinor % 1n).toBe(0n);
    }
  });

  it('is exactly reproducible from stored values (audit requirement)', () => {
    const base = parseMoney('2450.37');
    const stored = toStorage(base);
    const recomputed = serviceFee(fromStorage(stored), DEFAULT_SERVICE_FEE_BPS);
    expect(recomputed.amountMinor).toBe(serviceFee(base).amountMinor);
    expect(toDecimalString(recomputed)).toBe('122.52'); // 122.5185 -> 122.52
  });

  it('rejects a negative fee base', () => {
    expect(() => serviceFee(money(-100n))).toThrow(MoneyError);
  });

  it('rejects out-of-range basis points', () => {
    expect(() => applyBps(money(100n), 10_001)).toThrow(MoneyError);
    expect(() => applyBps(money(100n), -1)).toThrow(MoneyError);
    expect(() => applyBps(money(100n), 5.5)).toThrow(MoneyError);
  });

  it('a 0% fee yields zero, not a rounding artifact', () => {
    expect(applyBps(parseMoney('999.99'), 0).amountMinor).toBe(0n);
  });
});

describe('parsing', () => {
  it.each([
    ['1234.56', 123456n],
    ['1234,56', 123456n],
    ['1 234,56', 123456n],
    ['1234', 123400n],
    ['0.05', 5n],
    ['-50', -5000n],
    ['1\u00A0234,56', 123456n], // non-breaking space
    ['1\u202F234,56', 123456n], // narrow no-break space
  ])('parses %s', (input, expected) => {
    expect(parseMoney(input).amountMinor).toBe(expected);
  });

  it.each(['', 'abc', '12.345', '1,2,3', '12.', '.5e3', '--5'])('rejects %s', (bad) => {
    expect(() => parseMoney(bad)).toThrow(MoneyError);
  });

  it('round-trips through decimal string', () => {
    for (const s of ['0.00', '0.01', '1.00', '99.99', '123456.78']) {
      expect(toDecimalString(parseMoney(s))).toBe(s);
    }
  });
});

describe('formatting', () => {
  it('groups thousands the Belarusian way and uses a comma decimal', () => {
    // No-break spaces are intentional: amounts must not wrap mid-number.
    expect(formatMoney(parseMoney('1234567.89'))).toBe('1\u00A0234\u00A0567,89\u00A0BYN');
  });

  it('renders landlord debt with a real minus sign', () => {
    expect(formatMoney(money(-5000n))).toBe('\u221250,00\u00A0BYN');
  });

  it('can omit the currency for compact UI', () => {
    expect(formatMoney(parseMoney('90'), { showCurrency: false })).toBe('90,00');
  });
});
