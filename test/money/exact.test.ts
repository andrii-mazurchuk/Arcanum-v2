// Exact money arithmetic (S-16): ExactDecimal parsed from text as written, Fraction over bigint,
// and the one half-away-from-zero rounding, all from src/money/exact.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const exact = () => import('../../src/money/exact');

describe('money/exact', () => {
  test('roundHalfAwayFromZero matches the declared table', async () => {
    const { parseExactDecimal, decimalToFraction, fraction, roundHalfAwayFromZero } =
      await exact();

    const table: [string, bigint][] = [
      ['412.451', 412n],
      ['4120.55', 4121n],
      ['365.55', 366n],
      ['-234.5', -235n],
      ['234.5', 235n],
      ['-234.4', -234n],
      ['0.5', 1n],
      ['-0.5', -1n],
      ['3455.2', 3455n],
      ['7', 7n],
    ];
    for (const [t, want] of table) {
      const f = decimalToFraction(parseExactDecimal(t)!);
      expect(roundHalfAwayFromZero(f)).toBe(want);
    }

    expect(roundHalfAwayFromZero(fraction(5n, 2n))).toBe(3n);
    expect(roundHalfAwayFromZero(fraction(-5n, 2n))).toBe(-3n);
    expect(roundHalfAwayFromZero(fraction(1n, 3n))).toBe(0n);
    expect(roundHalfAwayFromZero(fraction(2n, 3n))).toBe(1n);
  });

  test('parseExactDecimal and midpoint are exact', async () => {
    const { parseExactDecimal, decimalToString, midpoint, decimalToFraction, fractionsEqual } =
      await exact();
    const p = (t: string) => parseExactDecimal(t)!;

    expect(parseExactDecimal('41.10')).toEqual({ digits: 4110n, scale: 2 });
    expect(parseExactDecimal('10')).toEqual({ digits: 10n, scale: 0 });
    expect(parseExactDecimal('-0.5')).toEqual({ digits: -5n, scale: 1 });
    expect(parseExactDecimal('41.311')).toEqual({ digits: 41311n, scale: 3 });

    for (const t of ['1e3', '+1', '1,5', ' 1', '1 ', '1.', '.5', '', '-', 'abc']) {
      expect(parseExactDecimal(t)).toBeNull();
    }

    for (const t of ['41.10', '-0.5', '10', '41.311']) {
      expect(decimalToString(p(t))).toBe(t);
    }

    // Aligned to scale 3: 41100 + 41311 = 82411; x5 = 412055; scale 4.
    expect(midpoint(p('41.10'), p('41.311'))).toEqual({ digits: 412055n, scale: 4 });

    // Aligned to scale 4: 412000 + 412902 = 824902; x5 = 4124510; scale 5.
    const m = midpoint(p('41.20'), p('41.2902'));
    expect(m).toEqual({ digits: 4124510n, scale: 5 });
    expect(fractionsEqual(decimalToFraction(m), decimalToFraction(p('41.2451')))).toBe(true);
  });

  test('fraction invariants and RangeError', async () => {
    const { fraction, decimalToFraction, mulF, divF, reciprocal, fractionsEqual } = await exact();

    expect(fraction(6n, -4n)).toEqual({ num: -3n, den: 2n });
    expect(fraction(-6n, -4n)).toEqual({ num: 3n, den: 2n });
    expect(fraction(0n, 5n)).toEqual({ num: 0n, den: 1n });
    expect(fraction(0n, -7n)).toEqual({ num: 0n, den: 1n });

    expect(decimalToFraction({ digits: 4110n, scale: 2 })).toEqual({ num: 411n, den: 10n });

    expect(mulF(fraction(2n, 3n), fraction(3n, 4n))).toEqual({ num: 1n, den: 2n });
    expect(divF(fraction(1n, 2n), fraction(1n, 4n))).toEqual({ num: 2n, den: 1n });
    expect(reciprocal(fraction(-2n, 5n))).toEqual({ num: -5n, den: 2n });

    expect(fractionsEqual(fraction(6n, -4n), fraction(-3n, 2n))).toBe(true);
    expect(fractionsEqual(fraction(1n, 2n), fraction(1n, 3n))).toBe(false);

    expect(() => fraction(1n, 0n)).toThrow(RangeError);
    expect(() => reciprocal(fraction(0n, 1n))).toThrow(RangeError);
    expect(() => divF(fraction(1n, 1n), fraction(0n, 3n))).toThrow(RangeError);
  });
});
