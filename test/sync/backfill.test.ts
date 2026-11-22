// Backfill command (S-216): the zone check before the store opens, the argument forms (a date
// range or --all), the refusals of non-dates, start after end and wholly future ranges, the clips
// to now and to the earliest date offered naming the stretch dropped, newest-first progress lines
// with rate waits, the exact stretches not fetched, the count added and the covered ranges read
// afresh. From src/sync/backfill, over the store of src/db, a real rate gate from
// src/sync/rate-gate and the job runner of src/sync/jobs.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const backfill = () => import('../../src/sync/backfill');
const db = () => import('../../src/db/index');
const settings = () => import('../../src/config/settings');
const dates = () => import('../../src/analytics/dates');
const register = () => import('../../src/core/register');
const covered = () => import('../../src/local/covered');
const transactions = () => import('../../src/local/transactions');
const quarantine = () => import('../../src/money/quarantine');
const recordedRates = () => import('../../src/money/recorded-rates');
const progress = () => import('../../src/sync/progress');
const rateGate = () => import('../../src/sync/rate-gate');
const balances = () => import('../../src/sync/balances');
const contract = () => import('../../src/sync/source-contract');
const startGate = () => import('../../src/start-gate');
const monobank = () => import('../../src/sources/monobank');

interface Iv {
  startAt: number;
  endAt: number;
}

// Half-open [a, b).
const iv = (a: number, b: number): Iv => ({ startAt: a, endAt: b });
const same = (a: Iv, b: Iv): boolean => a.startAt === b.startAt && a.endAt === b.endAt;
const at = (text: string): number => Date.parse(text);

const NOW = at('2026-11-21T12:00:00+01:00');
const NO_WAITS = { windows: [], marginMs: 200, refusalCooldownMs: 0 };
const EMPTY_PAGE = { items: [], next: null };

type Limits = { windows: { callClass: string | null; calls: number; windowMs: number }[]; marginMs: number; refusalCooldownMs: number };

interface Setup {
  env?: Record<string, string>; // added to the Monobank-on environment
  limits?: Limits;
  earliestAvailable?: (now: number) => number;
  clock?: number;
  seedCovered?: Iv[];
  // fetchWindow's answer; `http` is the client's cfg.http. Default: an empty page, no network.
  answer?: (h: any, w: Iv, http: any, signal: AbortSignal) => Promise<any> | any;
}

// The settings record with Monobank on, a stub 'monobank' definition over the real Monobank group,
// an in-memory store with every sync table and source 'monobank' and holding H registered, spies on
// every opener, a settable clock whose sleep advances it, and out/err recorders.
const arrange = async (o: Setup = {}) => {
  const { openStore, MEMORY_LOCATION } = await db();
  const { loadSettings } = await settings();
  const { narrowingName } = await register();
  const { ensureCoverageSchema, mergeCovered } = await covered();
  const { ensureTransactionSchema } = await transactions();
  const { ensureQuarantineSchema } = await quarantine();
  const { ensureRateSchema } = await recordedRates();
  const { ensureFirstFillSchema } = await progress();
  const { ensureRateLedgerSchema } = await rateGate();
  const { ensureBalanceSchema } = await balances();
  const { settingsGroup } = await monobank();
  const { runBackfillCommand } = await backfill();

  const record = loadSettings(
    { ARCANUM_STORAGE: MEMORY_LOCATION, ARCANUM_MONOBANK_TOKEN: 't', ...(o.env ?? {}) },
    [settingsGroup],
  );
  const H = narrowingName('monobank', 'account', 'a1');

  const inner = openStore(MEMORY_LOCATION, [
    ensureCoverageSchema,
    ensureTransactionSchema,
    ensureQuarantineSchema,
    ensureRateSchema,
    ensureFirstFillSchema,
    ensureRateLedgerSchema,
    ensureBalanceSchema,
  ]);
  inner.write((tx: any) => {
    tx.registerSource({ id: 'monobank', capabilities: [] });
    tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'a1', currency: 'PLN' });
    if (o.seedCovered !== undefined) mergeCovered(tx, 'monobank', o.seedCovered);
  });
  const count = { open: 0, defOpen: 0, fetchImpl: 0, refreshHoldings: 0, fetchWindow: 0, close: 0 };
  const store = {
    location: inner.location,
    readSnapshot: (body: any) => inner.readSnapshot(body),
    write: (body: any) => inner.write(body),
    close: () => {
      count.close += 1;
      inner.close();
    },
  };
  const open = () => {
    count.open += 1;
    return store;
  };

  const time = { now: o.clock ?? NOW };
  const now = () => time.now;
  const sleep = async (ms: number, _signal: AbortSignal): Promise<void> => {
    time.now += ms;
  };
  const fetchImpl = async (_url: string, _init: RequestInit): Promise<Response> => {
    count.fetchImpl += 1;
    return new Response('');
  };

  const windows: { holding: string; window: Iv }[] = [];
  const answer = o.answer ?? (() => EMPTY_PAGE);
  const limits = o.limits ?? NO_WAITS;
  const definition: any = {
    id: 'monobank',
    capabilities: [],
    settingsGroup,
    balanceConvention: 'own_money_as_reported',
    limits,
    maxWindowMs: 86_400_000,
    open: (cfg: any) => {
      count.defOpen += 1;
      return {
        async refreshHoldings(_signal: AbortSignal) {
          count.refreshHoldings += 1;
          return { holdings: [], balances: [] };
        },
        async fetchWindow(h: any, w: Iv, signal: AbortSignal) {
          count.fetchWindow += 1;
          windows.push({ holding: h.id, window: iv(w.startAt, w.endAt) });
          return answer(h, w, cfg.http, signal);
        },
      };
    },
  };
  if (o.earliestAvailable !== undefined) definition.earliestAvailable = o.earliestAvailable;

  const out: string[] = [];
  const err: string[] = [];
  const run = (args: string[], overrides: Record<string, unknown> = {}): Promise<number> =>
    runBackfillCommand({
      record,
      sourceId: 'monobank',
      args,
      built: [definition],
      open,
      now,
      fetchImpl,
      sleep,
      signal: new AbortController().signal,
      out: (line: string) => {
        out.push(line);
      },
      err: (line: string) => {
        err.push(line);
      },
      ...overrides,
    } as any);

  // Closes the store when the command did not.
  const dispose = () => {
    if (count.close === 0) inner.close();
  };

  return { record, H, time, count, windows, out, err, run, dispose };
};

describe('sync/backfill', () => {
  test('refusals before the store', async () => {
    const { BACKFILL_REFUSED_EXIT } = await backfill();
    const { SETTINGS_REFUSAL_EXIT } = await startGate();
    const { openCalendar } = await dates();

    // Exit, err lines; nothing opened or fetched, out empty.
    const refused = async (setup: Setup, args: string[], overrides: Record<string, unknown> = {}) => {
      const a = await arrange(setup);
      try {
        const code = await a.run(args, overrides);
        expect(a.count.open).toBe(0);
        expect(a.count.defOpen).toBe(0);
        expect(a.count.fetchImpl).toBe(0);
        expect(a.count.fetchWindow).toBe(0);
        expect(a.out).toEqual([]);
        return { code, err: a.err, record: a.record };
      } finally {
        a.dispose();
      }
    };

    // 1. A bad zone refuses both forms with the start gate's wording; no fallback zone.
    for (const args of [['2026-11-01..2026-11-02'], ['--all']]) {
      const r = await refused({ env: { ARCANUM_TIME_ZONE: 'Mars/Olympus' } }, args);
      expect(r.code).toBe(SETTINGS_REFUSAL_EXIT);
      expect(r.err.length).toBe(1);
      expect(r.err[0]!.startsWith((r.record as any).shared.timeZone.name)).toBe(true);
      expect(r.err[0]).toContain(' is bad: "Mars/Olympus": ');
    }

    // 2. Anything but one range or exactly --all is the usage line.
    for (const args of [
      [],
      ['--all', 'x'],
      ['2026-11-01'],
      ['2026-11-01..2026-11-3'],
      ['2026-11-01..2026-11-02', '--all'],
    ]) {
      const r = await refused({}, args);
      expect(r.code).toBe(BACKFILL_REFUSED_EXIT);
      expect(r.err).toEqual(['usage: backfill <source> <YYYY-MM-DD..YYYY-MM-DD> | --all']);
    }

    const calendar: any = openCalendar('Europe/Warsaw');

    // 3. Not a real date: the calendar's form refusal.
    {
      const text = '2026-02-30..2026-03-01';
      const refusal = calendar.resolvePeriod(text, NOW);
      expect(refusal.kind).toBe('refused');
      expect(refusal.subject).toBe('form');
      const r = await refused({}, [text]);
      expect(r.code).toBe(BACKFILL_REFUSED_EXIT);
      expect(r.err).toEqual([refusal.message]);
    }

    // 4. Start after end: the calendar's start_after_end refusal.
    {
      const text = '2026-03-05..2026-03-01';
      const refusal = calendar.resolvePeriod(text, NOW);
      expect(refusal.kind).toBe('refused');
      expect(refusal.subject).toBe('start_after_end');
      const r = await refused({}, [text]);
      expect(r.code).toBe(BACKFILL_REFUSED_EXIT);
      expect(r.err).toEqual([refusal.message]);
    }

    // 5. Wholly in the future.
    {
      const r = await refused({}, ['2026-11-22..2026-11-30']);
      expect(r.code).toBe(BACKFILL_REFUSED_EXIT);
      expect(r.err).toEqual(['the range lies wholly in the future']);
    }

    // 6. from equals now is wholly in the future.
    const midnight = at('2026-11-22T00:00:00+01:00');
    {
      const r = await refused({ clock: midnight }, ['2026-11-22..2026-11-22']);
      expect(r.code).toBe(BACKFILL_REFUSED_EXIT);
      expect(r.err).toEqual(['the range lies wholly in the future']);
    }

    // 6b. One millisecond after from is accepted and fetches that millisecond only.
    {
      const a = await arrange({ clock: midnight + 1 });
      try {
        const code = await a.run(['2026-11-22..2026-11-22']);
        expect(code).toBe(0);
        expect(a.err).toEqual([]);
        expect(a.count.open).toBe(1);
        expect(a.count.refreshHoldings).toBe(0);
        expect(a.count.fetchWindow).toBe(1);
        expect(a.windows).toEqual([{ holding: a.H, window: iv(midnight, midnight + 1) }]);
        expect(a.count.fetchImpl).toBe(0);
        expect(a.out[0]!.startsWith('clipped ')).toBe(true);
        expect(a.out[0]!.endsWith(': in the future')).toBe(true);
        expect(a.out).toContain('added 0 transactions');
      } finally {
        a.dispose();
      }
    }
  });

  test('future clip and progress', async () => {
    const a = await arrange({
      limits: { windows: [{ callClass: 'statement', calls: 1, windowMs: 58000 }], marginMs: 2000, refusalCooldownMs: 0 },
      answer: async (_h, _w, http, signal) => {
        await http.request('statement', 'http://bank.test/s', {}, signal);
        return EMPTY_PAGE;
      },
    });
    try {
      const code = await a.run(['2026-11-20..2026-11-22']);
      expect(code).toBe(0);
      expect(a.err).toEqual([]);
      expect(a.out).toEqual([
        'clipped 2026-11-21 12:00 .. 2026-11-23 00:00: in the future',
        'fetched 2026-11-20 12:00 .. 2026-11-21 12:00: 0 new of 0',
        "waiting 60 s for monobank's rate limit, until 2026-11-21 12:01",
        'fetched 2026-11-20 00:00 .. 2026-11-20 12:00: 0 new of 0',
        'added 0 transactions',
        'covered monobank: 2026-11-20 00:00 .. 2026-11-21 12:00',
      ]);
      expect(a.count.close).toBe(1);
    } finally {
      a.dispose();
    }
  });

  test('earliest clip', async () => {
    const earliest = at('2026-08-23T12:00:00+02:00');
    const end = at('2026-09-01T00:00:00+02:00');
    const a = await arrange({ earliestAvailable: () => earliest });
    try {
      const code = await a.run(['2026-08-01..2026-08-31']);
      expect(code).toBe(0);
      expect(a.out[0]).toBe('clipped 2026-08-01 00:00 .. 2026-08-23 12:00: before the earliest date monobank offers');
      expect(a.out.some((l) => l.includes('in the future'))).toBe(false);

      const ws = a.windows.map((x) => x.window);
      expect(ws[0]).toEqual(iv(at('2026-08-31T00:00:00+02:00'), end));
      // Disjoint, and their union is exactly [earliest, end).
      const sorted = [...ws].sort((x, y) => x.startAt - y.startAt);
      expect(sorted[0]!.startAt).toBe(earliest);
      expect(sorted[sorted.length - 1]!.endAt).toBe(end);
      for (let i = 1; i < sorted.length; i += 1) expect(sorted[i]!.startAt).toBe(sorted[i - 1]!.endAt);

      expect(a.out.filter((l) => l.startsWith('fetched ')).length).toBe(9);
      expect(a.out[a.out.length - 1]).toBe('covered monobank: 2026-08-23 12:00 .. 2026-09-01 00:00');
    } finally {
      a.dispose();
    }
  });

  test('failed range', async () => {
    const { BACKFILL_FAILED_EXIT } = await backfill();
    const { SourceCallError } = await contract();
    const failing = iv(at('2026-11-02T00:00:00+01:00'), at('2026-11-03T00:00:00+01:00'));
    const a = await arrange({
      answer: (_h, w) => {
        if (same(w, failing)) throw new SourceCallError('other', 'boom');
        return EMPTY_PAGE;
      },
    });
    try {
      const code = await a.run(['2026-11-01..2026-11-03']);
      expect(code).toBe(BACKFILL_FAILED_EXIT);
      expect(a.out).toEqual([
        'fetched 2026-11-03 00:00 .. 2026-11-04 00:00: 0 new of 0',
        'added 0 transactions',
        'covered monobank: 2026-11-03 00:00 .. 2026-11-04 00:00',
      ]);
      expect(a.err).toEqual([
        'not fetched 2026-11-02 00:00 .. 2026-11-03 00:00: boom',
        'stopped: 2026-11-01 00:00 .. 2026-11-03 00:00 not fetched: boom',
      ]);
      const nov1 = at('2026-11-01T00:00:00+01:00');
      expect(a.windows.some((x) => x.window.startAt < failing.startAt && x.window.endAt > nov1)).toBe(false);
      expect(a.count.close).toBe(1);
    } finally {
      a.dispose();
    }
  });

  test('entire history', async () => {
    // Nothing covered: the walk starts at now; its first step comes back empty and ends it.
    {
      const a = await arrange();
      try {
        const code = await a.run(['--all']);
        expect(code).toBe(0);
        expect(a.err).toEqual([]);
        expect(a.out).toEqual([
          'fetched 2026-11-20 12:00 .. 2026-11-21 12:00: 0 new of 0',
          'added 0 transactions',
          'earliest date reached: 2026-11-20 12:00',
          'covered monobank: 2026-11-20 12:00 .. 2026-11-21 12:00',
        ]);
      } finally {
        a.dispose();
      }
    }

    // History covered: the walk starts at the first covered interval's start.
    {
      const a = await arrange({ seedCovered: [iv(at('2026-11-10T00:00:00+01:00'), NOW)] });
      try {
        await a.run(['--all']);
        expect(a.windows[0]!.window).toEqual(iv(at('2026-11-09T00:00:00+01:00'), at('2026-11-10T00:00:00+01:00')));
        expect(a.out).toContain('earliest date reached: 2026-11-09 00:00');
      } finally {
        a.dispose();
      }
    }
  });
});
