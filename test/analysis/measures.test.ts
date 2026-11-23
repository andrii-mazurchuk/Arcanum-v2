// Exact measures (S-154): directionOf, savingsRate, tenthsText, lowSavingsSeverity and averageMinor,
// all exact bigint arithmetic with one half-away-from-zero rounding, from src/analytics/savings.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const savings = () => import('../../src/analytics/savings');

describe('analysis/measures', () => {
  test('measures: worked tables', async () => {
    const { directionOf, savingsRate, tenthsText, lowSavingsSeverity, averageMinor } = await savings();

    // directionOf: exactly 5% either way is stable.
    const directions: [bigint, bigint, string][] = [
      [100n, 104n, 'stable'],
      [100n, 94n, 'falling'],
      [100n, 105n, 'stable'], // 105*100 = 100*105: not rising
      [100n, 95n, 'stable'], // 95*100 = 100*95: not falling
      [100n, 106n, 'rising'],
      [100n, 0n, 'falling'],
    ];
    for (const [f, l, want] of directions) {
      expect<any>(directionOf(f, l)).toBe(want);
    }
    expect(() => directionOf(0n, 5n)).toThrow(RangeError);
    expect(() => directionOf(-1n, 5n)).toThrow(RangeError);

    // savingsRate: rounded once, half away from zero, to whole tenths of a percent.
    expect(savingsRate(1000n, 900n)).toEqual({
      income: 1000n,
      spending: 900n,
      net: 100n,
      tenths: 100n,
      text: '10.0%',
    });
    const exact9995 = savingsRate(100000n, 90005n); // exactly 9.995%
    expect(exact9995.net).toBe(9995n);
    expect(exact9995.tenths).toBe(100n);
    expect(exact9995.text).toBe('10.0%');
    const noIncome = savingsRate(0n, 5000n);
    expect(noIncome.net).toBe(-5000n);
    expect(noIncome.tenths).toBe(0n);
    expect(noIncome.text).toBe('0.0%');
    const minus005 = savingsRate(2000n, 2001n); // exactly -0.05%
    expect(minus005.net).toBe(-1n);
    expect(minus005.tenths).toBe(-1n);
    expect(minus005.text).toBe('-0.1%');

    // tenthsText
    const texts: [bigint, string][] = [
      [100n, '10.0%'],
      [199n, '19.9%'],
      [-1n, '-0.1%'],
      [0n, '0.0%'],
      [1234n, '123.4%'],
    ];
    for (const [t, want] of texts) {
      expect(tenthsText(t)).toBe(want);
    }

    // lowSavingsSeverity: judged on the shown tenths, not the exact fraction.
    expect(lowSavingsSeverity(savingsRate(100000n, 90005n))).toBe('warning');
    expect(lowSavingsSeverity(savingsRate(1000n, 900n))).toBe('warning');
    expect(lowSavingsSeverity(savingsRate(1000n, 901n))).toBe('alert'); // tenths 99n
    expect(lowSavingsSeverity(savingsRate(1000n, 801n))).toBe('warning'); // tenths 199n
    expect(lowSavingsSeverity(savingsRate(1000n, 800n))).toBeNull(); // tenths 200n
    expect(lowSavingsSeverity(savingsRate(0n, 5000n))).toBeNull();
    expect(lowSavingsSeverity(savingsRate(2000n, 2001n))).toBe('alert');

    // averageMinor: half away from zero on both signs.
    expect(averageMinor(10001n, 2)).toBe(5001n);
    expect(averageMinor(300n, 3)).toBe(100n);
    expect(averageMinor(1000n, 3)).toBe(333n);
    expect(averageMinor(-10001n, 2)).toBe(-5001n);
    expect(() => averageMinor(1n, 0)).toThrow(RangeError);
    expect(() => averageMinor(1n, 1.5)).toThrow(RangeError);
  });
});
