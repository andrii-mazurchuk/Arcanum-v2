// Stagnant-jar check (S-155): STAGNANT_WINDOW_MS and isStagnant over the closed 720-hour stretch
// ending at the as-at instant, from src/analytics/signals.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const signals = () => import('../../src/analytics/signals');

describe('analysis/stagnant', () => {
  test('stagnant: closed 720-hour stretch', async () => {
    const { STAGNANT_WINDOW_MS, isStagnant } = await signals();

    // End of October 2026 in Warsaw: 2026-10-31T23:00Z.
    const asAt = Date.parse('2026-11-01T00:00:00+01:00');
    const W = STAGNANT_WINDOW_MS;
    expect(W).toBe(720 * 3_600_000);

    const sep20 = Date.parse('2026-09-20T12:00:00+02:00');
    const oct15 = Date.parse('2026-10-15T12:00:00+02:00');

    expect(isStagnant([sep20], asAt)).toBe(true);
    expect(isStagnant([oct15], asAt)).toBe(false);
    expect(isStagnant([], asAt)).toBe(true);

    // Closed lower bound.
    expect(isStagnant([asAt - W], asAt)).toBe(false);
    expect(isStagnant([asAt - W - 1], asAt)).toBe(true);

    // Closed upper bound.
    expect(isStagnant([asAt], asAt)).toBe(false);

    // Top-ups after the as-at instant are ignored.
    expect(isStagnant([asAt + 1], asAt)).toBe(true);
    expect(isStagnant([sep20, asAt + 1], asAt)).toBe(true);

    // asAt - W is 2026-10-01T23:00Z; 30 local days before asAt is 2026-10-02T00:00+02:00,
    // i.e. 2026-10-01T22:00Z. A top-up between them is outside the 720-hour stretch.
    expect(asAt - W).toBe(Date.parse('2026-10-01T23:00:00Z'));
    expect(isStagnant([Date.parse('2026-10-01T22:30:00Z')], asAt)).toBe(true);

    // Any iterable, not only an array.
    expect(
      isStagnant(
        (function* () {
          yield asAt - 1;
        })(),
        asAt,
      ),
    ).toBe(false);
  });
});
