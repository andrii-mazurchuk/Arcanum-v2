// Answer text helpers (S-118): the one case-folding routine with folded equality and substring
// tests, and fixed-decimal text of an exact fraction rounded half away from zero, all from
// src/answers/text. Fractions are built with S-16 `fraction` from src/money/exact.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const text = () => import('../../src/answers/text');
const exact = () => import('../../src/money/exact');

describe('answers/text', () => {
  test('foldCase folds with full mappings', async () => {
    const { foldCase, foldedEquals, foldedIncludes } = await text();

    // A lower-case-only fold leaves 'straße'; an upper-case-only fold leaves 'STRASSE'.
    expect(foldCase('straße')).toBe('strasse');
    expect(foldCase('STRASSE')).toBe('strasse');
    expect(foldedEquals('straße', 'STRASSE')).toBe(true);

    expect(foldedEquals('Сільпо', 'сільпо')).toBe(true);
    expect(foldedEquals('ҐРУНТ', 'ґрунт')).toBe(true);
    expect(foldedIncludes('Оплата: ЗАРПЛАТА за листопад', 'зарплат')).toBe(true);

    // Equality is whole; inclusion is substring, haystack first.
    expect(foldedEquals('Silpo Express', 'silpo')).toBe(false);
    expect(foldedIncludes('Silpo Express', 'SILPO')).toBe(true);
    expect(foldedIncludes('Silpo', 'Silpo Express')).toBe(false);
  });

  test('fractionText table', async () => {
    const { fractionText } = await text();
    const { fraction } = await exact();

    const table: [bigint, bigint, number, string][] = [
      [461000n, 11000n, 4, '41.9091'], // 419090.909... -> 419091 (truncation gives 41.9090)
      [42n, 1n, 4, '42.0000'],
      [100n, 41n, 2, '2.44'], // 243.90... -> 244
      [3n, 8n, 1, '0.4'], // 3.75 -> 4
      [1n, 8n, 2, '0.13'], // 12.5 -> 13 (half-to-even gives 12)
      [-1n, 8n, 2, '-0.13'], // -12.5 -> -13 (Math.round gives -12)
      [-1n, 200n, 2, '-0.01'], // -0.5 -> -1 (Math.round gives -0)
      [-1n, 250n, 2, '0.00'], // -0.4 -> 0, no sign (sign from f gives -0.00)
      [0n, 1n, 2, '0.00'],
      [-1n, 2n, 0, '-1'],
      [75n, 2n, 1, '37.5'],
      // Beyond 2^53: a Number-based conversion loses these digits.
      [123456789012345678901n, 100n, 2, '1234567890123456789.01'],
    ];
    for (const [n, d, decimals, want] of table) {
      expect(fractionText(fraction(n, d), decimals)).toBe(want);
    }

    const third = fraction(1n, 3n);
    for (const bad of [13, -1, 1.5]) {
      expect(() => fractionText(third, bad)).toThrow(RangeError);
    }
    expect(() => fractionText(third, 0)).not.toThrow();
    expect(fractionText(third, 0)).toBe('0');
    expect(fractionText(third, 12)).toBe('0.333333333333');
  });
});
