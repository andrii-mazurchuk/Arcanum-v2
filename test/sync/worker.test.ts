// Sync worker (S-104): the tick arithmetic in bigint, the single-flight worker running its start job
// then a poll on each tick at start plus whole intervals, a busy tick dropped and logged, early timers
// re-armed toward the same tick, late ones skipping missed ticks, delays above the timer limit split,
// every job's failure contained, and a stop that cancels the timer, aborts the job and resolves once
// it has settled. From src/sync/worker, over the jobs of src/sync/jobs, the store of src/db and a real
// rate gate from src/sync/rate-gate.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const workerModule = () => import('../../src/sync/worker');
const db = () => import('../../src/db/index');
const covered = () => import('../../src/local/covered');
const transactions = () => import('../../src/local/transactions');
const quarantine = () => import('../../src/money/quarantine');
const recordedRates = () => import('../../src/money/recorded-rates');
const progress = () => import('../../src/sync/progress');
const rateGate = () => import('../../src/sync/rate-gate');
const balances = () => import('../../src/sync/balances');

const D = 86_400_000;
const I = 3_600_000;
const S = 100 * D;

const EMPTY = { holdings: [], balances: [] };

const noSleep = (): Promise<void> => {
  throw new Error('sleep must not be called');
};

// Lets real macrotasks run until `done` holds, at most `rounds` times; the worker's own timers are
// fake, so this only drains the job's promises.
const until = async (done: () => boolean, rounds = 200): Promise<void> => {
  for (let i = 0; i < rounds && !done(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

const drain = () => until(() => false, 20);

// 'resolved' when `p` resolves within `ms` real milliseconds, else 'timeout'.
const within = (p: Promise<unknown>, ms: number): Promise<'resolved' | 'timeout'> =>
  Promise.race([
    p.then(() => 'resolved' as const),
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms)),
  ]);

interface Armed {
  cb: () => void;
  ms: number;
  handle: { id: number };
}

// Fake timers recording every (cb, ms) armed and every handle cleared.
const fakeTimers = () => {
  const armed: Armed[] = [];
  const cleared: unknown[] = [];
  const timers = {
    setTimeout(cb: () => void, ms: number): unknown {
      const handle = { id: armed.length };
      armed.push({ cb, ms, handle });
      return handle;
    },
    clearTimeout(handle: unknown): void {
      cleared.push(handle);
    },
  };
  const last = (): Armed => armed[armed.length - 1]!;
  return { timers, armed, cleared, last };
};

// An in-memory store with every sync table, a real gate over it, the stub definition, a settable
// clock starting at S and the log.
const arrange = async () => {
  const { openStore, MEMORY_LOCATION } = await db();
  const { ensureCoverageSchema } = await covered();
  const { ensureTransactionSchema } = await transactions();
  const { ensureQuarantineSchema } = await quarantine();
  const { ensureRateSchema } = await recordedRates();
  const { ensureFirstFillSchema, readFirstFill } = await progress();
  const { ensureRateLedgerSchema, createRateGate } = await rateGate();
  const { ensureBalanceSchema } = await balances();

  const store = openStore(MEMORY_LOCATION, [
    ensureCoverageSchema,
    ensureTransactionSchema,
    ensureQuarantineSchema,
    ensureRateSchema,
    ensureFirstFillSchema,
    ensureRateLedgerSchema,
    ensureBalanceSchema,
  ]);
  const limits = { windows: [], marginMs: 200, refusalCooldownMs: 0 };
  const time = { now: S };
  const now = () => time.now;
  const gate = createRateGate({ store, limits: new Map([['stub', limits]]), now, sleep: noSleep });
  const definition: any = {
    id: 'stub',
    capabilities: [],
    settingsGroup: { sourceId: 'stub', enabledByDefault: false, needsCredential: false, extras: [] },
    balanceConvention: 'own_money_as_reported',
    limits,
    maxWindowMs: D,
    open: () => {
      throw new Error('open is not used');
    },
  };
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
  };
  const firstFill = () => store.readSnapshot((s: any) => readFirstFill(s, 'stub'));

  return { store, gate, definition, time, now, lines, log, firstFill };
};

type Arranged = Awaited<ReturnType<typeof arrange>>;

const fetchNever = async () => {
  throw new Error('fetchWindow is never reached');
};

const deps = (a: Arranged, client: any, timers: any, pollMinutes = 60): any => ({
  job: { store: a.store, definition: a.definition, client, gate: a.gate, now: a.now, log: a.log },
  firstFillDays: 1,
  pollMinutes,
  startedAt: S,
  pushAddress: null,
  timers,
});

describe('sync/worker', () => {
  test('nextTickAt', async () => {
    const { nextTickAt, MAX_TIMER_MS } = await workerModule();

    // 1. Strictly after now, truncating division.
    expect(nextTickAt(0, 60, 0)).toBe(3_600_000n);
    expect(nextTickAt(0, 60, 3_600_000)).toBe(7_200_000n);
    expect(nextTickAt(0, 60, 10_000_000)).toBe(10_800_000n);

    // 2. A start that is not a multiple of the interval.
    expect(nextTickAt(1_000_000_000_000, 1, 1_000_000_059_999)).toBe(1_000_000_060_000n);
    expect(nextTickAt(1_000_000_000_000, 1, 1_000_000_060_000)).toBe(1_000_000_120_000n);

    // 3. An odd value above 2^53, exact only in bigint.
    expect(nextTickAt(1001, 150_119_987_579, 1001)).toBe(9_007_199_254_741_001n);

    // 4. The longest delay one timer is given.
    expect(MAX_TIMER_MS).toBe(2_147_483_647);
  });

  test('ticks, busy drop and timers', async () => {
    const { createSyncWorker } = await workerModule();
    const a = await arrange();

    // The first refresh waits for the test; later ones resolve at once.
    const count = { refreshHoldings: 0 };
    let resolveFirst: (v: unknown) => void = () => {};
    const client = {
      refreshHoldings(_signal: AbortSignal): Promise<unknown> {
        count.refreshHoldings += 1;
        if (count.refreshHoldings === 1) return new Promise((r) => (resolveFirst = r));
        return Promise.resolve(EMPTY);
      },
      fetchWindow: fetchNever,
    };
    const t = fakeTimers();
    const worker = createSyncWorker(deps(a, client, t.timers));
    let worker2: any = null;
    try {
      // 1. Start: one timer toward S + I, the start job running.
      worker.start();
      expect(t.armed.length).toBe(1);
      expect(t.last().ms).toBe(3_600_000);
      await until(() => count.refreshHoldings >= 1);
      expect(count.refreshHoldings).toBe(1);
      expect(worker.busy).toBe(true);

      // 2. A tick while busy is dropped and logged, and the next tick is armed.
      a.time.now = S + I;
      t.last().cb();
      await drain();
      expect(worker.ticksDropped).toBe(1);
      expect(a.lines).toContain('poll tick dropped source=stub: busy');
      expect(count.refreshHoldings).toBe(1);
      expect(t.armed.length).toBe(2);
      expect(t.last().ms).toBe(3_600_000);

      // 3. The start job settles; no queued poll follows it.
      resolveFirst(EMPTY);
      await until(() => !worker.busy);
      await drain();
      expect(worker.busy).toBe(false);
      expect(a.lines).toContain('sync first_fill source=stub status=completed steps=1 added=0');
      expect(count.refreshHoldings).toBe(1);
      expect(t.armed.length).toBe(2);

      // 4. An early fire re-arms toward the same tick and runs nothing.
      a.time.now = S + 2 * I - 1000;
      t.last().cb();
      await drain();
      expect(count.refreshHoldings).toBe(1);
      expect(worker.busy).toBe(false);
      expect(t.armed.length).toBe(3);
      expect(t.last().ms).toBe(1000);

      // 5. A late fire runs one poll and arms toward S + 5I, skipping the missed ticks.
      a.time.now = S + 4 * I + 5;
      t.last().cb();
      await until(() => count.refreshHoldings >= 2);
      await until(() => !worker.busy);
      await drain();
      expect(count.refreshHoldings).toBe(2);
      expect(worker.busy).toBe(false);
      expect(a.lines).toContain('sync poll source=stub status=completed steps=1 added=0');
      expect(t.armed.length).toBe(4);
      expect(t.last().ms).toBe(3_599_995);
      await drain();
      expect(count.refreshHoldings).toBe(2);
      expect(a.lines.filter((l) => l.startsWith('sync poll ')).length).toBe(1);
      expect(worker.ticksDropped).toBe(1);

      // 6. A delay above the timer limit is reached through two timers.
      a.time.now = S;
      const count2 = { refreshHoldings: 0 };
      const client2 = {
        async refreshHoldings(_signal: AbortSignal) {
          count2.refreshHoldings += 1;
          return EMPTY;
        },
        fetchWindow: fetchNever,
      };
      const t2 = fakeTimers();
      worker2 = createSyncWorker(deps(a, client2, t2.timers, 40000));
      worker2.start();
      expect(t2.armed.length).toBe(1);
      expect(t2.last().ms).toBe(2_147_483_647);
      await until(() => count2.refreshHoldings >= 1 && !worker2.busy);
      await drain();
      expect(count2.refreshHoldings).toBe(1);

      a.time.now = S + 2_147_483_647;
      t2.last().cb();
      await drain();
      expect(count2.refreshHoldings).toBe(1);
      expect(worker2.busy).toBe(false);
      expect(t2.armed.length).toBe(2);
      expect(t2.last().ms).toBe(252_516_353);
    } finally {
      await within(worker.stop(), 1000);
      if (worker2 !== null) await within(worker2.stop(), 1000);
      a.store.close();
    }
  });

  test('stop', async () => {
    const { createSyncWorker } = await workerModule();
    const a = await arrange();

    // The refresh ends only by rejecting with the signal's reason when the signal aborts.
    const count = { refreshHoldings: 0 };
    const signals: AbortSignal[] = [];
    const client = {
      refreshHoldings(signal: AbortSignal): Promise<unknown> {
        count.refreshHoldings += 1;
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      fetchWindow: fetchNever,
    };
    const t = fakeTimers();
    const worker = createSyncWorker(deps(a, client, t.timers));
    let idle: any = null;
    try {
      // 1. The start job is waiting on the refresh.
      worker.start();
      await until(() => count.refreshHoldings >= 1);
      expect(count.refreshHoldings).toBe(1);
      expect(worker.busy).toBe(true);
      expect(t.armed.length).toBe(1);
      const armed = t.last();

      // 2. Stop clears the armed timer and aborts the job's signal.
      const p = worker.stop();
      expect(t.cleared).toContain(armed.handle);
      expect(signals.length).toBe(1);
      expect(signals[0]!.aborted).toBe(true);

      // 3. It resolves only once the job has settled and been logged.
      let busyAtResolution: boolean | null = null;
      let linesAtResolution: string[] = [];
      const observed = p.then(() => {
        busyAtResolution = worker.busy;
        linesAtResolution = [...a.lines];
      });
      expect(await within(observed, 2000)).toBe('resolved');
      expect(busyAtResolution).toBe(false);
      expect(linesAtResolution).toContain('sync first_fill source=stub status=stopped steps=0 added=0');

      // 4. A stale timer callback runs nothing after stop.
      a.time.now = S + I;
      armed.cb();
      await drain();
      expect(count.refreshHoldings).toBe(1);
      expect(t.armed.length).toBe(1);
      expect(worker.busy).toBe(false);

      // 5. A second stop is harmless.
      expect(await within(worker.stop(), 1000)).toBe('resolved');

      // 6. An idle worker stops at once, waiting for no timer.
      const count2 = { refreshHoldings: 0 };
      const client2 = {
        async refreshHoldings(_signal: AbortSignal) {
          count2.refreshHoldings += 1;
          return EMPTY;
        },
        fetchWindow: fetchNever,
      };
      const t2 = fakeTimers();
      idle = createSyncWorker(deps(a, client2, t2.timers));
      idle.start();
      await until(() => count2.refreshHoldings >= 1 && !idle.busy);
      await drain();
      expect(idle.busy).toBe(false);
      expect(await within(idle.stop(), 1000)).toBe('resolved');
      expect(t2.cleared).toContain(t2.last().handle);
    } finally {
      await within(worker.stop(), 1000);
      if (idle !== null) await within(idle.stop(), 1000);
      a.store.close();
    }
  });

  test('failure contained', async () => {
    const { createSyncWorker } = await workerModule();
    const a = await arrange();

    // The first refresh throws; later ones answer.
    const count = { refreshHoldings: 0 };
    const client = {
      async refreshHoldings(_signal: AbortSignal) {
        count.refreshHoldings += 1;
        if (count.refreshHoldings === 1) throw new Error('boom');
        return EMPTY;
      },
      fetchWindow: fetchNever,
    };
    const t = fakeTimers();
    const worker = createSyncWorker(deps(a, client, t.timers));
    try {
      // 1. The failed start job is logged and leaves the worker idle.
      worker.start();
      await until(() => count.refreshHoldings >= 1 && !worker.busy);
      await drain();
      expect(a.lines).toContain('sync first_fill source=stub status=failed steps=0 added=0');
      expect(worker.busy).toBe(false);
      expect(worker.ticksDropped).toBe(0);

      // 2. The next tick polls over the whole uncovered stretch and completes the fill.
      a.time.now = S + I;
      t.last().cb();
      await until(() => count.refreshHoldings >= 2);
      await until(() => !worker.busy);
      await drain();
      expect(count.refreshHoldings).toBe(2);
      expect(worker.ticksDropped).toBe(0);
      expect(a.lines).toContain('sync poll source=stub status=completed steps=2 added=0');
      expect(a.firstFill()?.completedAt).toBe(S + I);
    } finally {
      await within(worker.stop(), 1000);
      a.store.close();
    }
  });
});
