// Tier rule (S-153): TIERS and tierOf, judged by exact cross-multiplied comparisons of a period's
// minor-unit total x against the sum S of n baseline periods, from src/analytics/trends.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const trends = () => import('../../src/analytics/trends');

describe('analysis/tiers', () => {
  test('tiers: boundary table', async () => {
    const { TIERS, tierOf } = await trends();

    expect(TIERS).toEqual(['elevated', 'high', 'spike']);

    // n = 4, weeks 100, 0, 200, 100: S = 400. Boundaries are inclusive.
    const table: [bigint, string | null][] = [
      [149n, null], // 2*149*4 = 1192 < 1200
      [150n, 'elevated'], // 2*150*4 = 1200 >= 1200
      [199n, 'elevated'],
      [200n, 'high'], // 200*4 = 800 >= 800
      [299n, 'high'],
      [300n, 'spike'], // 300*4 = 1200 >= 1200
      [0n, null],
    ];
    for (const [x, want] of table) {
      expect(tierOf(x, 400n, 4)).toBe(want);
    }

    // n = 3, months 300, 0, 0: S = 300.
    expect(tierOf(250n, 300n, 3)).toBe('high');
    expect(tierOf(240n, 300n, 3)).toBe('high');

    // Zero baseline: never a tier.
    expect(tierOf(1n, 0n, 3)).toBeNull();
    expect(tierOf(1_000_000n, 0n, 4)).toBeNull();
    expect(tierOf(0n, 0n, 1)).toBeNull();

    // A baseline average rounded to 100 would tier these differently.
    expect(tierOf(150n, 301n, 3)).toBeNull(); // 2*150*3 = 900 < 3*301 = 903
    expect(tierOf(299n, 299n, 3)).toBe('spike'); // 299*3 = 897 >= 3*299 = 897

    expect(() => tierOf(1n, 1n, 0)).toThrow(RangeError);
    expect(() => tierOf(1n, 1n, 1.5)).toThrow(RangeError);
    expect(() => tierOf(-1n, 1n, 3)).toThrow(RangeError);
    expect(() => tierOf(1n, -1n, 3)).toThrow(RangeError);
  });
});
