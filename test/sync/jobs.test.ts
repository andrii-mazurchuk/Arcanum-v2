// Job runner (S-145): the holdings refresh (register, balances stamped before the request, rates,
// push address) under the job's signal, the rate-refusal retry, one step as a whole fetch closed by
// one ingest write holding its covered part and the first-fill mark, forward jobs oldest first
// stopping at the first failure, the start-job choice, the poll, backfill steps newest first or
// walking back, and a failed job's exact not-fetched part. From src/sync/jobs, over the store of
// src/db and a real rate gate from src/sync/rate-gate.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const jobsModule = () => import('../../src/sync/jobs');
const db = () => import('../../src/db/index');
const covered = () => import('../../src/local/covered');
const transactions = () => import('../../src/local/transactions');
const translated = () => import('../../src/local/translated');
const quarantine = () => import('../../src/money/quarantine');
const recordedRates = () => import('../../src/money/recorded-rates');
const moneyModule = () => import('../../src/money/money');
const progress = () => import('../../src/sync/progress');
const rateGate = () => import('../../src/sync/rate-gate');
const balances = () => import('../../src/sync/balances');
const contract = () => import('../../src/sync/source-contract');

interface Iv {
  startAt: number;
  endAt: number;
}

// Half-open [a, b).
const iv = (a: number, b: number): Iv => ({ startAt: a, endAt: b });
const same = (a: Iv, b: Iv): boolean => a.startAt === b.startAt && a.endAt === b.endAt;

const D = 86_400_000;
const H = 3_600_000;

const H1 = 'stub:account:a1';
const H2 = 'stub:account:a2';

const OPTS = { recordRates: false, pushAddress: null, registerWhenUnread: false };

interface Setup {
  capabilities?: string[];
  limits?: { windows: { callClass: string | null; calls: number; windowMs: number }[]; marginMs: number; refusalCooldownMs: number };
  maxWindowMs: number;
  push?: boolean;
  clock?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const noSleep = (): Promise<void> => {
  throw new Error('sleep must not be called');
};

// An in-memory store with every sync table, a real gate over it, the stub definition, a settable
// clock, the log and the step events, and the readers the checks use.
const arrange = async (o: Setup) => {
  const { openStore, MEMORY_LOCATION } = await db();
  const { ensureCoverageSchema, readCovered } = await covered();
  const { ensureTransactionSchema, selectTransactions } = await transactions();
  const { ensureQuarantineSchema } = await quarantine();
  const { ensureRateSchema } = await recordedRates();
  const { ensureFirstFillSchema, readFirstFill } = await progress();
  const { ensureRateLedgerSchema, createRateGate } = await rateGate();
  const { ensureBalanceSchema, readBalances } = await balances();
  const { money } = await moneyModule();

  const store = openStore(MEMORY_LOCATION, [
    ensureCoverageSchema,
    ensureTransactionSchema,
    ensureQuarantineSchema,
    ensureRateSchema,
    ensureFirstFillSchema,
    ensureRateLedgerSchema,
    ensureBalanceSchema,
  ]);
  const capabilities = o.capabilities ?? [];
  const limits = o.limits ?? { windows: [], marginMs: 200, refusalCooldownMs: 0 };
  const time = { now: o.clock ?? 0 };
  const now = () => time.now;
  const gate = createRateGate({ store, limits: new Map([['stub', limits]]), now, sleep: o.sleep ?? noSleep });
  const definition: any = {
    id: 'stub',
    capabilities,
    settingsGroup: { sourceId: 'stub', enabledByDefault: false, needsCredential: false, extras: [] },
    balanceConvention: 'own_money_as_reported',
    limits,
    maxWindowMs: o.maxWindowMs,
    open: () => {
      throw new Error('open is not used');
    },
  };
  if (o.push === true) {
    definition.push = {
      read: () => ({ kind: 'not_well_formed', reason: 'stub' }),
      addressCheck: { method: null, status: 200 },
    };
  }

  const lines: string[] = [];
  const events: any[] = [];
  const deps = (client: any, signal: AbortSignal = new AbortController().signal): any => ({
    store,
    definition,
    client,
    gate,
    now,
    log: (line: string) => {
      lines.push(line);
    },
    signal,
    onStep: (e: any) => {
      events.push(e);
    },
  });

  const register = (...bankIds: string[]) =>
    store.write((tx: any) => {
      tx.registerSource({ id: 'stub', capabilities });
      for (const bankId of bankIds) {
        tx.registerHolding({ kind: 'account', sourceId: 'stub', bankId, currency: 'PLN' });
      }
    });

  const read = {
    covered: (): Iv[] => store.readSnapshot((s: any) => readCovered(s, 'stub')),
    firstFill: () => store.readSnapshot((s: any) => readFirstFill(s, 'stub')),
    register: () => store.readSnapshot((s: any) => s.register()),
    balances: () => store.readSnapshot((s: any) => readBalances(s)),
    held: (): any[] =>
      store.readSnapshot((s: any) => selectTransactions(s.db, { holdings: new Set([H1, H2]), order: 'position' })),
    position: (): number => store.readSnapshot((s: any) => s.position()),
  };

  const P = (major: number) => money(BigInt(major * 100), 'PLN');

  return { store, gate, time, definition, lines, events, deps, register, read, P };
};

// One held transaction of the stub source, PLN, settled, no codes.
const heldItem = (bankId: string, holdingId: string, occurredAt: number) => {
  const record = {
    sourceId: 'stub',
    bankId,
    holdingId,
    occurredAt,
    amount: { minor: -100n, currency: 'PLN' },
    originalAmount: null,
    cashback: null,
    settled: true,
    mcc: null,
    originalMcc: null,
    merchantText: null,
    description: '',
    comment: null,
    counterpart: null,
  };
  return { kind: 'held' as const, sourceId: 'stub', bankId, record };
};

// A client whose fetchWindow records (holding, window) and answers through `answer`; its
// refreshHoldings lists one account a1 in PLN with balance P(1). `order` names every call in turn.
const recordingClient = (P: (n: number) => unknown, answer: (h: any, w: Iv) => any) => {
  const calls: { holding: string; window: Iv }[] = [];
  const order: string[] = [];
  const count = { refreshHoldings: 0, fetchWindow: 0 };
  const client = {
    async refreshHoldings(_signal: AbortSignal) {
      count.refreshHoldings += 1;
      order.push('refreshHoldings');
      return {
        holdings: [{ kind: 'account', sourceId: 'stub', bankId: 'a1', currency: 'PLN' }],
        balances: [{ holdingId: H1, balance: P(1), creditLimit: null }],
      };
    },
    async fetchWindow(h: any, w: Iv, _signal: AbortSignal) {
      count.fetchWindow += 1;
      order.push('fetchWindow');
      calls.push({ holding: h.id, window: iv(w.startAt, w.endAt) });
      return answer(h, w);
    },
  };
  return { client, calls, order, count };
};

const failingAt = (SourceCallError: any, failing: Iv | null, kind: string) => (_h: any, w: Iv) => {
  if (failing !== null && same(w, failing)) throw new SourceCallError(kind, 'boom');
  return { items: [], next: null };
};

describe('sync/jobs', () => {
  test('range backfill not fetched', async () => {
    const { runBackfillJob } = await jobsModule();
    const { SourceCallError } = await contract();

    // Case 1: [100, 200) fails after [200, 300) completed.
    {
      const a = await arrange({ maxWindowMs: 100 });
      try {
        a.register('a1');
        const c = recordingClient(a.P, failingAt(SourceCallError, iv(100, 200), 'other'));
        const o = await runBackfillJob(a.deps(c.client), { kind: 'range', target: [iv(0, 300)] });
        expect(o.status).toBe('failed');
        expect(o.stepsDone).toBe(1);
        expect(o.added).toBe(0);
        expect(o.failed).toEqual({ notFetched: [iv(0, 200)], reason: 'boom' });
        expect(c.calls.map((x) => x.window)).toEqual([iv(200, 300), iv(100, 200)]);
        expect(c.calls.every((x) => x.holding === H1)).toBe(true);
        expect(a.events).toEqual([
          { kind: 'step_done', window: iv(200, 300), added: 0, rows: 0, covered: true },
          { kind: 'step_failed', window: iv(100, 200), reason: 'boom' },
        ]);
        expect(a.read.covered()).toEqual([iv(200, 300)]);
        expect(c.count.refreshHoldings).toBe(0);
      } finally {
        a.store.close();
      }
    }

    // Case 2: a target of two intervals, [150, 200) failing.
    {
      const a = await arrange({ maxWindowMs: 100 });
      try {
        a.register('a1');
        const c = recordingClient(a.P, failingAt(SourceCallError, iv(150, 200), 'other'));
        const o = await runBackfillJob(a.deps(c.client), { kind: 'range', target: [iv(0, 100), iv(150, 300)] });
        expect(o.status).toBe('failed');
        expect(c.calls.map((x) => x.window)).toEqual([iv(200, 300), iv(150, 200)]);
        expect(o.failed).toEqual({ notFetched: [iv(0, 100), iv(150, 200)], reason: 'boom' });
      } finally {
        a.store.close();
      }
    }

    // Case 3: a date refusal completes the job.
    {
      const a = await arrange({ maxWindowMs: 100 });
      try {
        a.register('a1');
        const c = recordingClient(a.P, failingAt(SourceCallError, iv(100, 200), 'date_refused'));
        const o = await runBackfillJob(a.deps(c.client), { kind: 'range', target: [iv(0, 300)] });
        expect(o.status).toBe('completed');
        expect(o.failed).toBeNull();
        expect(o.refusedBefore).toBe(200);
        expect(o.stepsDone).toBe(1);
      } finally {
        a.store.close();
      }
    }
  });

  test('step is whole or nothing', async () => {
    const { runBackfillJob } = await jobsModule();
    const { SourceCallError } = await contract();
    const { checkTranslated } = await translated();
    const x1 = heldItem('x1', H1, 10);
    const x2 = heldItem('x2', H1, 60);
    checkTranslated(x1.record as any);
    checkTranslated(x2.record as any);

    // H1 answers [0, 100) in two pages; H2 by `h2`. A runaway H2 loop is cut off after 5 calls.
    const answer = (h2: () => any) => {
      let h2Calls = 0;
      return (h: any, w: Iv) => {
        if (h.id === H1 && same(w, iv(0, 100))) return { items: [x1], next: iv(50, 100) };
        if (h.id === H1 && same(w, iv(50, 100))) return { items: [x2], next: null };
        if (h.id === H2) {
          h2Calls += 1;
          if (h2Calls > 5) throw new Error('fetchWindow called again and again');
          return h2();
        }
        throw new Error(`unexpected window ${h.id} [${w.startAt}, ${w.endAt})`);
      };
    };
    const plan = { kind: 'range' as const, target: [iv(0, 100)] };

    // Case A: H2 fails after H1 came back whole in two pages.
    {
      const a = await arrange({ maxWindowMs: 100 });
      try {
        a.register('a1', 'a2');
        const c = recordingClient(
          a.P,
          answer(() => {
            throw new SourceCallError('other', 'boom');
          }),
        );
        const o = await runBackfillJob(a.deps(c.client), plan);
        expect(c.calls).toEqual([
          { holding: H1, window: iv(0, 100) },
          { holding: H1, window: iv(50, 100) },
          { holding: H2, window: iv(0, 100) },
        ]);
        expect(o.status).toBe('failed');
        expect(o.failed?.notFetched).toEqual([iv(0, 100)]);
        expect(a.read.held()).toEqual([]);
        expect(a.read.covered()).toEqual([]);
        expect(a.read.position()).toBe(0);
      } finally {
        a.store.close();
      }
    }

    // Case B: H2's continuation is not shorter than its part.
    {
      const a = await arrange({ maxWindowMs: 100 });
      try {
        a.register('a1', 'a2');
        const c = recordingClient(a.P, answer(() => ({ items: [], next: iv(0, 100) })));
        const o = await runBackfillJob(a.deps(c.client), plan);
        expect(o.status).toBe('failed');
        expect(o.failed?.reason).toBe('row cap not resolvable');
        expect(a.read.held()).toEqual([]);
        expect(a.read.covered()).toEqual([]);
      } finally {
        a.store.close();
      }
    }

    // Case C: every holding whole: one write holds both rows and the coverage.
    {
      const a = await arrange({ maxWindowMs: 100 });
      try {
        a.register('a1', 'a2');
        const c = recordingClient(a.P, answer(() => ({ items: [], next: null })));
        const o = await runBackfillJob(a.deps(c.client), plan);
        expect(o.status).toBe('completed');
        expect(o.added).toBe(2);
        expect(o.stepsDone).toBe(1);
        expect(a.read.held().map((r) => r.bankId).sort()).toEqual(['x1', 'x2']);
        expect(a.read.covered()).toEqual([iv(0, 100)]);
      } finally {
        a.store.close();
      }
    }
  });

  test('refresh failure before any step', async () => {
    const { runPoll } = await jobsModule();
    const { SourceCallError } = await contract();
    const { createFirstFill, markFirstFillComplete, SETTLE_MS } = await progress();
    const { mergeCovered } = await covered();
    expect(1000 * H - SETTLE_MS).toBe(976 * H);

    const a = await arrange({ maxWindowMs: 100 * H, clock: 1000 * H });
    try {
      expect(createFirstFill(a.store, 'stub', 24 * H, 1).anchorAt).toBe(0);
      a.store.write((tx: any) => markFirstFillComplete(tx, 'stub', 24 * H));
      const seeded = [iv(0, 500 * H), iv(600 * H, 1000 * H)];
      a.store.write((tx: any) => mergeCovered(tx, 'stub', seeded));

      let fetches = 0;
      const client = {
        async refreshHoldings(_signal: AbortSignal) {
          throw new SourceCallError('other', 'boom');
        },
        async fetchWindow() {
          fetches += 1;
          return { items: [], next: null };
        },
      };

      const o = await runPoll(a.deps(client), 1, OPTS);
      expect(o.kind).toBe('poll');
      expect(o.status).toBe('failed');
      expect(o.stepsDone).toBe(0);
      expect(o.added).toBe(0);
      expect(o.failed).toEqual({ notFetched: [iv(500 * H, 600 * H), iv(976 * H, 1000 * H)], reason: 'boom' });
      expect(fetches).toBe(0);
      expect(a.lines).toContain('sync failed source=stub kind=poll before any step: boom');
      expect(a.read.covered()).toEqual(seeded);
    } finally {
      a.store.close();
    }
  });

  test('refresh stamp and rate retry', async () => {
    const { refreshHoldings } = await jobsModule();
    const { SourceCallError } = await contract();

    const a = await arrange({
      maxWindowMs: 100,
      limits: { windows: [], marginMs: 200, refusalCooldownMs: 60000 },
      clock: 1000,
    });
    try {
      let calls = 0;
      const client = {
        async refreshHoldings(_signal: AbortSignal) {
          calls += 1;
          if (calls === 1) {
            a.time.now = 3000;
            throw new SourceCallError('rate_refused');
          }
          a.time.now = 4000;
          return {
            holdings: [{ sourceId: 'stub', kind: 'account', bankId: 'a1', currency: 'PLN' }],
            balances: [{ holdingId: H1, balance: a.P(100), creditLimit: null }],
          };
        },
        async fetchWindow() {
          throw new Error('fetchWindow is not called by a refresh');
        },
      };

      await refreshHoldings(a.deps(client), OPTS);

      expect(calls).toBe(2);
      expect(a.lines.filter((l) => l === 'rate refused source=stub; retrying').length).toBe(1);
      expect(a.lines.filter((l) => l.startsWith('rate refused')).length).toBe(1);
      const reg = a.read.register();
      expect(reg.sources.map((s: any) => s.id)).toEqual(['stub']);
      expect(reg.holdings.map((h: any) => h.id)).toEqual([H1]);
      const b = a.read.balances()[0];
      expect(b.balance).toEqual(a.P(100));
      expect(b.reportedAt).toBe(3000);
      expect(a.time.now).toBe(4000);
      expect(a.gate.reserve('stub', 'statement')).toBe(63000);
    } finally {
      a.store.close();
    }
  });

  test('backfill opening', async () => {
    const { runBackfillJob } = await jobsModule();

    // Counts every client method, in call order.
    const countingClient = (P: (n: number) => unknown) => {
      const order: string[] = [];
      const windows: { holding: string; window: Iv }[] = [];
      const client = {
        async refreshHoldings(_signal: AbortSignal) {
          order.push('refreshHoldings');
          return {
            holdings: [{ kind: 'account', sourceId: 'stub', bankId: 'a1', currency: 'PLN' }],
            balances: [{ holdingId: H1, balance: P(1), creditLimit: null }],
          };
        },
        async fetchWindow(h: any, w: Iv, _signal: AbortSignal) {
          order.push('fetchWindow');
          windows.push({ holding: h.id, window: iv(w.startAt, w.endAt) });
          return { items: [], next: null };
        },
        async fetchRates(_signal: AbortSignal) {
          order.push('fetchRates');
          return [];
        },
        async registerPush(_address: string, _signal: AbortSignal) {
          order.push('registerPush');
        },
      };
      return { client, order, windows };
    };
    const setup = { capabilities: ['rates'], maxWindowMs: 100, push: true };

    // 1. An empty range.
    {
      const a = await arrange(setup);
      try {
        const c = countingClient(a.P);
        const o = await runBackfillJob(a.deps(c.client), { kind: 'range', target: [] });
        expect(o.status).toBe('completed');
        expect(o.stepsDone).toBe(0);
        expect(c.order).toEqual([]);
        expect(a.read.firstFill()).toBeNull();
      } finally {
        a.store.close();
      }
    }

    // 2. A walk already at its floor.
    {
      const a = await arrange(setup);
      try {
        const c = countingClient(a.P);
        const o = await runBackfillJob(a.deps(c.client), { kind: 'walk', from: 500, floor: 500 });
        expect(o.status).toBe('completed');
        expect(o.refusedBefore).toBe(500);
        expect(c.order).toEqual([]);
        expect(a.read.firstFill()).toBeNull();
      } finally {
        a.store.close();
      }
    }

    // 3 and 4. No holding of the source, then the same store with H registered.
    {
      const a = await arrange(setup);
      try {
        const c = countingClient(a.P);
        const o3 = await runBackfillJob(a.deps(c.client), { kind: 'range', target: [iv(0, 100)] });
        expect(c.order).toEqual(['refreshHoldings', 'fetchWindow']);
        expect(c.windows).toEqual([{ holding: H1, window: iv(0, 100) }]);
        expect(o3.status).toBe('completed');

        const c4 = countingClient(a.P);
        await runBackfillJob(a.deps(c4.client), { kind: 'range', target: [iv(100, 200)] });
        expect(c4.order).toEqual(['fetchWindow']);
        expect(c4.windows).toEqual([{ holding: H1, window: iv(100, 200) }]);

        // 5. A backfill never touches the first-fill record.
        expect(a.read.firstFill()).toBeNull();
      } finally {
        a.store.close();
      }
    }
  });

  // The interrupted-fill arrangement through its step 1: clock 10D, [9D + 12H, 10D) failing.
  const interruptedFill = async () => {
    const { runStartJob } = await jobsModule();
    const { SourceCallError } = await contract();
    const a = await arrange({ maxWindowMs: 12 * H, clock: 10 * D });
    const failAt: { w: Iv | null } = { w: iv(9 * D + 12 * H, 10 * D) };
    const c = recordingClient(a.P, (_h, w) => {
      if (failAt.w !== null && same(w, failAt.w)) throw new SourceCallError('other', 'boom');
      return { items: [], next: null };
    });
    const o = await runStartJob(a.deps(c.client), 1, OPTS);
    return { a, c, failAt, o };
  };

  test('interrupted first fill resumes', async () => {
    const { runStartJob } = await jobsModule();
    const { a, c, failAt, o } = await interruptedFill();
    try {
      // 1. The second step fails.
      expect(o.kind).toBe('first_fill');
      expect(o.status).toBe('failed');
      expect(o.stepsDone).toBe(1);
      expect(o.failed?.notFetched).toEqual([iv(9 * D + 12 * H, 10 * D)]);
      expect(c.calls.map((x) => x.window)).toEqual([iv(9 * D, 9 * D + 12 * H), iv(9 * D + 12 * H, 10 * D)]);
      expect(a.read.firstFill()).toEqual({ sourceId: 'stub', anchorAt: 9 * D, firstStartAt: 10 * D, completedAt: null });
      expect(a.read.covered()).toEqual([iv(9 * D, 9 * D + 12 * H)]);
      expect(a.lines).toContain(
        `sync failed source=stub kind=first_fill from=${new Date(9 * D + 12 * H).toISOString()}: boom`,
      );

      // 2. Resumed over only the uncovered stretch; the mark is set.
      a.time.now = 10 * D + H;
      failAt.w = null;
      c.calls.length = 0;
      const o2 = await runStartJob(a.deps(c.client), 1, OPTS);
      expect(o2.kind).toBe('first_fill');
      expect(o2.status).toBe('completed');
      expect(o2.stepsDone).toBe(2);
      expect(c.calls.map((x) => x.window)).toEqual([iv(9 * D + 12 * H, 10 * D), iv(10 * D, 10 * D + H)]);
      expect(a.read.firstFill()?.completedAt).toBe(10 * D + H);
      expect(a.read.covered()).toEqual([iv(9 * D, 10 * D + H)]);

      // 3. A later start catches up; another depth moves nothing.
      a.time.now = 10 * D + 2 * H;
      c.calls.length = 0;
      const o3 = await runStartJob(a.deps(c.client), 30, OPTS);
      expect(o3.kind).toBe('catch_up');
      expect(c.calls.map((x) => x.window)).toEqual([
        iv(9 * D + 2 * H, 9 * D + 14 * H),
        iv(9 * D + 14 * H, 10 * D + 2 * H),
      ]);
      expect(a.read.firstFill()?.anchorAt).toBe(9 * D);
    } finally {
      a.store.close();
    }
  });

  test('poll completes a fill', async () => {
    const { runPoll, runStartJob } = await jobsModule();
    const { a, c, failAt, o } = await interruptedFill();
    try {
      expect(o.status).toBe('failed');
      expect(a.read.covered()).toEqual([iv(9 * D, 9 * D + 12 * H)]);
      expect(a.read.firstFill()?.completedAt).toBeNull();

      a.time.now = 10 * D + H;
      failAt.w = null;
      c.calls.length = 0;
      const p = await runPoll(a.deps(c.client), 1, OPTS);
      expect(p.kind).toBe('poll');
      expect(p.status).toBe('completed');
      expect(p.stepsDone).toBe(2);
      expect(c.calls.map((x) => x.window)).toEqual([iv(9 * D + H, 9 * D + 13 * H), iv(9 * D + 13 * H, 10 * D + H)]);
      expect(a.read.firstFill()?.completedAt).toBe(10 * D + H);

      a.time.now = 10 * D + 2 * H;
      const s = await runStartJob(a.deps(c.client), 1, OPTS);
      expect(s.kind).toBe('catch_up');
    } finally {
      a.store.close();
    }
  });

  test('backfill walk', async () => {
    const { runBackfillJob } = await jobsModule();
    const { SourceCallError } = await contract();
    const { checkTranslated } = await translated();

    // One held transaction at startAt + 1 for each window listed with items; `refused` is refused.
    const walkClient = (P: (n: number) => unknown, withItems: Iv[], refused: Iv | null) =>
      recordingClient(P, (h, w) => {
        if (refused !== null && same(w, refused)) throw new SourceCallError('date_refused', 'boom');
        if (withItems.some((x) => same(x, w))) {
          const item = heldItem(`t${w.startAt}`, h.id, w.startAt + 1);
          checkTranslated(item.record as any);
          return { items: [item], next: null };
        }
        return { items: [], next: null };
      });

    // Case 1: the first empty step ends the walk.
    {
      const a = await arrange({ maxWindowMs: 10 * D });
      try {
        a.register('a1');
        const c = walkClient(a.P, [iv(90 * D, 100 * D), iv(80 * D, 90 * D)], null);
        const o = await runBackfillJob(a.deps(c.client), { kind: 'walk', from: 100 * D, floor: null });
        expect(c.calls.map((x) => x.window)).toEqual([iv(90 * D, 100 * D), iv(80 * D, 90 * D), iv(70 * D, 80 * D)]);
        expect(o.status).toBe('completed');
        expect(o.stepsDone).toBe(3);
        expect(o.added).toBe(2);
        expect(o.earliestReached).toBe(70 * D);
        expect(o.refusedBefore).toBeNull();
        expect(a.read.covered()).toEqual([iv(70 * D, 100 * D)]);
      } finally {
        a.store.close();
      }
    }

    // Case 2: clipped to the floor, then the floor is reached.
    {
      const a = await arrange({ maxWindowMs: 10 * D });
      try {
        a.register('a1');
        const c = walkClient(a.P, [iv(90 * D, 100 * D), iv(85 * D, 90 * D)], null);
        const o = await runBackfillJob(a.deps(c.client), { kind: 'walk', from: 100 * D, floor: 85 * D });
        expect(c.calls.map((x) => x.window)).toEqual([iv(90 * D, 100 * D), iv(85 * D, 90 * D)]);
        expect(o.status).toBe('completed');
        expect(o.refusedBefore).toBe(85 * D);
        expect(o.earliestReached).toBe(85 * D);
        expect(o.stepsDone).toBe(2);
      } finally {
        a.store.close();
      }
    }

    // Case 3: a date refusal completes at the cursor.
    {
      const a = await arrange({ maxWindowMs: 10 * D });
      try {
        a.register('a1');
        const c = walkClient(a.P, [iv(90 * D, 100 * D)], iv(80 * D, 90 * D));
        const o = await runBackfillJob(a.deps(c.client), { kind: 'walk', from: 100 * D, floor: null });
        expect(o.status).toBe('completed');
        expect(o.refusedBefore).toBe(90 * D);
        expect(o.earliestReached).toBe(90 * D);
        expect(o.stepsDone).toBe(1);
        expect(a.read.covered()).toEqual([iv(90 * D, 100 * D)]);
      } finally {
        a.store.close();
      }
    }
  });

  test('stop during the rates fetch', async () => {
    const { runStartJob } = await jobsModule();
    const { gatedHttp } = await rateGate();

    const sleep = (_ms: number, signal: AbortSignal): Promise<void> =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const a = await arrange({
      capabilities: ['rates'],
      limits: { windows: [{ callClass: 'rates', calls: 1, windowMs: 60000 }], marginMs: 2000, refusalCooldownMs: 0 },
      maxWindowMs: 100,
      clock: 0,
      sleep,
    });
    try {
      expect(a.gate.reserve('stub', 'rates')).toBe(0);

      const controller = new AbortController();
      let fetched = 0;
      const fetchImpl = async (): Promise<Response> => {
        fetched += 1;
        return new Response('[]');
      };
      const notices: any[] = [];
      const onWait = (w: any) => {
        notices.push(w);
        if (w.until === 62000 && w.waitMs === 62000) controller.abort(new Error('stopped'));
      };
      const http = gatedHttp(a.gate, 'stub', fetchImpl, onWait);
      const c = recordingClient(a.P, () => ({ items: [], next: null }));
      const client = {
        ...c.client,
        async fetchRates(signal: AbortSignal) {
          await http.request('rates', 'http://bank.test/rates', {}, signal);
          return [];
        },
      };

      const o = await runStartJob(a.deps(client, controller.signal), 1, { ...OPTS, recordRates: true });
      expect(notices.length).toBe(1);
      expect(notices[0]).toMatchObject({ until: 62000, waitMs: 62000 });
      expect(o.status).toBe('stopped');
      expect(o.failed).toBeNull();
      expect(o.stepsDone).toBe(0);
      expect(fetched).toBe(0);
      expect(a.read.register().holdings.map((h: any) => h.id)).toEqual([H1]);
      expect(a.read.balances().map((b: any) => [b.holdingId, b.balance])).toEqual([[H1, a.P(1)]]);
      expect(c.calls).toEqual([]);
      expect(a.read.covered()).toEqual([]);
    } finally {
      a.store.close();
    }
  });
});
