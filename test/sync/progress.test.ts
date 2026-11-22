// Sync progress (S-90): the first-fill record (anchor, first-start instant, completion mark) and the
// pure interval rules of src/sync/progress: quarantine-excluded minutes, the last moment known
// complete, fill and catch-up-and-poll targets, the completion test and step planning.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const progressModule = () => import('../../src/sync/progress');
const db = () => import('../../src/db/index');

interface Iv {
  startAt: number;
  endAt: number;
}

// Half-open [a, b).
const iv = (a: number, b: number): Iv => ({ startAt: a, endAt: b });

const H = 3_600_000;

describe('sync/progress', () => {
  test('last known complete and forward target', async () => {
    const { lastKnownComplete, forwardTarget, SETTLE_MS } = await progressModule();
    expect(SETTLE_MS).toBe(86_400_000);
    expect(SETTLE_MS).toBe(24 * H);

    // 1. The gap at 100H keeps the moment back, though more is covered after it.
    expect(lastKnownComplete([iv(0, 100 * H), iv(150 * H, 390 * H)], [], 50 * H)).toBe(100 * H);

    // 2. No interval contains the origin: the origin itself.
    expect(lastKnownComplete([iv(100, 200)], [], 50)).toBe(50);

    // 3. The uncovered stretches after the origin plus the last 24 hours, normalised.
    expect(forwardTarget([iv(0, 100 * H), iv(150 * H, 390 * H)], [], 50 * H, 400 * H)).toEqual([
      iv(100 * H, 150 * H),
      iv(400 * H - SETTLE_MS, 400 * H),
    ]);
    expect(400 * H - SETTLE_MS).toBe(376 * H);

    // 4. Nothing uncovered after the origin: the settle stretch is still there, reaching before it.
    expect(forwardTarget([iv(0, 60 * H)], [], 50 * H, 60 * H)).toEqual([iv(36 * H, 60 * H)]);

    // 5. Excluded minutes count as covered; the settle stretch merges into the uncovered one.
    expect(forwardTarget([iv(0, 100 * H)], [iv(100 * H, 120 * H)], 0, 200 * H)).toEqual([
      iv(120 * H, 200 * H),
    ]);
  });

  test('quarantine exclusion and fill rules', async () => {
    const { excludedMinutes, fillIsComplete, lastKnownComplete, fillTarget } = await progressModule();
    const e1 = { occurredAt: 37_062_000 } as any; // 11:17:42
    const e2 = { occurredAt: null } as any;
    const e3 = { occurredAt: 100_000_000 } as any;
    const rec = {
      sourceId: 'stub',
      anchorAt: 36_000_000, // 10:00
      firstStartAt: 43_200_000, // 12:00
      completedAt: null,
    };
    const covered = [iv(36_000_000, 37_020_000), iv(37_080_000, 43_200_000)];

    // 1. The minute of e1; e3 sits exactly at the bound and is not before it; e2 excludes nothing.
    const ex = excludedMinutes([e1, e2, e3], 100_000_000);
    expect(ex).toEqual([iv(37_020_000, 37_080_000)]);

    // 2. The excluded minute closes the gap at 11:17.
    expect(fillIsComplete(covered, ex, rec)).toBe(true);
    expect(fillIsComplete(covered, [], rec)).toBe(false);

    // 3. The same for the last moment known complete.
    expect(lastKnownComplete(covered, ex, 36_000_000)).toBe(43_200_000);
    expect(lastKnownComplete(covered, [], 36_000_000)).toBe(37_020_000);

    // 4. The fill target is the anchor to start minus what is covered; no settle refetch.
    expect(fillTarget(covered, [], rec, 50_400_000)).toEqual([
      iv(37_020_000, 37_080_000),
      iv(43_200_000, 50_400_000),
    ]);
    expect(fillTarget(covered, ex, rec, 50_400_000)).toEqual([iv(43_200_000, 50_400_000)]);
  });

  test('planSteps', async () => {
    const { planSteps, StepPlanError } = await progressModule();

    // 1. Oldest first: cut from the start, the partial step at the right end.
    expect(planSteps([iv(0, 250)], 100, 'oldest_first')).toEqual([
      iv(0, 100),
      iv(100, 200),
      iv(200, 250),
    ]);

    // 2. Newest first: cut from the end, the partial step at the interval's start.
    expect(planSteps([iv(0, 250)], 100, 'newest_first')).toEqual([
      iv(150, 250),
      iv(50, 150),
      iv(0, 50),
    ]);

    // 3. Unordered input, steps listed by ascending startAt.
    expect(planSteps([iv(300, 350), iv(0, 250)], 100, 'oldest_first')).toEqual([
      iv(0, 100),
      iv(100, 200),
      iv(200, 250),
      iv(300, 350),
    ]);

    // 4. Steps cut per interval, listed by descending startAt; none spans the gap.
    expect(planSteps([iv(0, 250), iv(300, 350)], 100, 'newest_first')).toEqual([
      iv(300, 350),
      iv(150, 250),
      iv(50, 150),
      iv(0, 50),
    ]);

    // 5. Overlapping intervals merge to [0, 250) first.
    expect(planSteps([iv(0, 150), iv(100, 250)], 100, 'oldest_first')).toEqual([
      iv(0, 100),
      iv(100, 200),
      iv(200, 250),
    ]);

    // 6. Nothing to plan.
    expect(planSteps([], 100, 'oldest_first')).toEqual([]);

    // 7. A step length that is not a whole number >= 1.
    const x = [iv(0, 250)];
    for (const order of ['oldest_first', 'newest_first'] as const) {
      expect(() => planSteps(x, 0, order)).toThrow(StepPlanError);
      expect(() => planSteps(x, 1.5, order)).toThrow(StepPlanError);
      expect(() => planSteps(x, -1, order)).toThrow(StepPlanError);
    }
  });

  test('first-fill record', async () => {
    const {
      ensureFirstFillSchema,
      readFirstFill,
      createFirstFill,
      markFirstFillComplete,
      DAY_MS,
    } = await progressModule();
    const { openStore, MEMORY_LOCATION } = await db();
    expect(DAY_MS).toBe(86_400_000);

    // The installer twice: it is idempotent.
    const store = openStore(MEMORY_LOCATION, [ensureFirstFillSchema, ensureFirstFillSchema]);
    try {
      const read = (sourceId: string) =>
        store.readSnapshot((snap: any) => readFirstFill(snap, sourceId));

      // 1. Nothing held yet.
      expect(read('stub')).toBeNull();

      // 2. The anchor is 90 whole days before the first start.
      const first = {
        sourceId: 'stub',
        anchorAt: 8_000_000_000 - 90 * DAY_MS,
        firstStartAt: 8_000_000_000,
        completedAt: null,
      };
      expect(first.anchorAt).toBe(224_000_000);
      expect(createFirstFill(store, 'stub', 8_000_000_000, 90)).toEqual(first);
      expect(read('stub')).toEqual(first);

      // 3. A later call with another start and depth returns the held record unchanged.
      expect(createFirstFill(store, 'stub', 9_000_000_000, 30)).toEqual(first);
      expect(read('stub')).toEqual(first);

      // 4. The mark is set only where empty: the second mark leaves the first.
      store.write((tx: any) => markFirstFillComplete(tx, 'stub', 8_100_000_000));
      store.write((tx: any) => markFirstFillComplete(tx, 'stub', 8_200_000_000));
      const marked = { ...first, completedAt: 8_100_000_000 };
      expect(read('stub')).toEqual(marked);

      // 5. Records are per source.
      expect(createFirstFill(store, 'other', 1_000_000_000, 1)).toEqual({
        sourceId: 'other',
        anchorAt: 913_600_000,
        firstStartAt: 1_000_000_000,
        completedAt: null,
      });
      expect(read('other')?.anchorAt).toBe(913_600_000);
      expect(read('stub')).toEqual(marked);
    } finally {
      store.close();
    }
  });
});
