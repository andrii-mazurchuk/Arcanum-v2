// Release waits (S-237): the deadline rule and the call counts it is built from, the wait loop's
// cadence and deadline under a fake clock, and the coverage condition the waits probe with, from
// src/release/waits. The limits are the stand-ins' own (S-236).
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const waits = () => import('../../src/release/waits');
const standIns = () => import('../../src/release/stand-ins');

type Probe = () => Promise<{ met: boolean; observed: string }>;

// A fake clock: sleep advances t by exactly what was asked and records it; a loop that never stops
// is cut off instead of hanging the run.
const fakeClock = () => {
  const c = {
    t: 0,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.sleeps.push(ms);
      c.t += ms;
      if (c.sleeps.length > 20) throw new Error('runaway');
    },
  };
  return c;
};

describe('release/waits', () => {
  test('deadline and call counts', async () => {
    const { waitDeadlineMs, spacingMs, monobankJobCalls, secondJobCalls, POLL_INTERVAL_MS } = await waits();
    const { MONOBANK_STAND_IN_LIMITS, SECOND_STAND_IN_LIMITS } = await standIns();

    // A-134's worked case: 10 x 120 000 + 120 000 + 60 000.
    expect(waitDeadlineMs({ runningCalls: 5, nextCalls: 5, spacingMs: 60_000, pollIntervalMs: 60_000 })).toBe(
      1_380_000,
    );

    expect(spacingMs(MONOBANK_STAND_IN_LIMITS)).toBe(60_000);
    expect(spacingMs(SECOND_STAND_IN_LIMITS)).toBe(2_000);
    expect(
      spacingMs([
        { callClass: 'a', calls: 1, windowMs: 1000 },
        { callClass: 'b', calls: 2, windowMs: 10_000 },
      ]),
    ).toBe(5_000);

    expect(monobankJobCalls(3)).toBe(4);
    expect(secondJobCalls([6, 3])).toBe(3);
    expect(secondJobCalls([120])).toBe(4);
    expect(secondJobCalls([0, 0])).toBe(3);
    expect(secondJobCalls([50])).toBe(2);
    expect(secondJobCalls([51])).toBe(3);

    // P1, Monobank: 8 x 120 000 + 120 000 + 60 000.
    expect(waitDeadlineMs({ runningCalls: 4, nextCalls: 4, spacingMs: 60_000, pollIntervalMs: POLL_INTERVAL_MS })).toBe(
      1_140_000,
    );
    // P6, second source: 6 x 4 000 + 180 000.
    expect(waitDeadlineMs({ runningCalls: 3, nextCalls: 3, spacingMs: 2_000, pollIntervalMs: 60_000 })).toBe(204_000);
  });

  test('waitFor cadence and deadline', async () => {
    const { waitFor, ASK_INTERVAL_MS } = await waits();
    expect(ASK_INTERVAL_MS).toBe(5_000);

    // 1. Met on the third probe, after two intervals.
    {
      const c = fakeClock();
      let n = 0;
      const probe: Probe = async () => {
        n += 1;
        return n === 3 ? { met: true, observed: 'o3' } : { met: false, observed: 'o' + n };
      };
      const out = await waitFor(60_000, probe, c.now, c.sleep);
      expect(out).toEqual({ met: true, observed: 'o3', elapsedMs: 10_000 });
      expect(c.sleeps).toEqual([5_000, 5_000]);
      expect(n).toBe(3);
    }

    // 2. Never met, deadline 12 000: gives up at the first probe at or after the deadline, with
    // that probe's observation.
    {
      const c = fakeClock();
      let n = 0;
      let last = '';
      const tAfterSleep: number[] = [];
      const sleep = async (ms: number) => {
        await c.sleep(ms);
        tAfterSleep.push(c.t);
      };
      const probe: Probe = async () => {
        n += 1;
        last = 'o' + n;
        return { met: false, observed: last };
      };
      const out = await waitFor(12_000, probe, c.now, sleep);
      expect(out.met).toBe(false);
      expect(out.observed).toBe(last);
      expect(out.elapsedMs).toBeGreaterThanOrEqual(12_000);
      expect(out.elapsedMs).toBeLessThanOrEqual(15_000);
      expect(n === 3 || n === 4).toBe(true);
      for (const ms of c.sleeps) expect(ms).toBeLessThanOrEqual(ASK_INTERVAL_MS);
      for (const t of tAfterSleep) expect(t).toBeLessThanOrEqual(15_000);
    }

    // 3a. A probe that throws counts as not met; met on the next probe, after one interval.
    {
      const c = fakeClock();
      let n = 0;
      const probe: Probe = async () => {
        n += 1;
        if (n === 1) throw new Error('stand-in down');
        return { met: true, observed: 'up' };
      };
      const out = await waitFor(60_000, probe, c.now, c.sleep);
      expect(out.met).toBe(true);
      expect(out.elapsedMs).toBe(5_000);
      expect(c.sleeps).toEqual([5_000]);
      expect(n).toBe(2);
    }

    // 3b. A probe that always throws: not met, observed being the error's message.
    {
      const c = fakeClock();
      const probe: Probe = async () => {
        throw new Error('stand-in down');
      };
      const out = await waitFor(4_000, probe, c.now, c.sleep);
      expect(out.met).toBe(false);
      expect(out.observed).toBe('stand-in down');
    }
  });

  test('covers', async () => {
    const { covers } = await waits();

    expect(covers([{ startAt: 0, endAt: 120_000 }], 0, 150_000)).toBe(true); // 90 000 <= 120 000
    expect(covers([{ startAt: 0, endAt: 120_000 }], 0, 190_000)).toBe(false); // 130 000 > 120 000
    expect(covers([{ startAt: 0, endAt: 120_000 }], 0, 180_000)).toBe(true); // exactly 120 000
    expect(covers([{ startAt: 60_000, endAt: 600_000 }], 0, 120_000)).toBe(false); // starts after from
    expect(
      covers(
        [
          { startAt: 0, endAt: 100_000 },
          { startAt: 100_000, endAt: 600_000 },
        ],
        0,
        500_000,
      ),
    ).toBe(false); // no single range spans it
    expect(covers(null, 0, 1)).toBe(false);
    expect(covers([], 0, 1)).toBe(false);
  });
});
