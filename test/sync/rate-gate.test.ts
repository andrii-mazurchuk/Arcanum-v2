// Rate gate (S-232): the per-source declaration with its lateness margin, the reservation ledger
// and cool-downs in the shared store, reserve in one short write, wait-and-grant with the late
// re-reserve, refusal recording, pruning and the gated HTTP wrapper, from src/sync/rate-gate over
// the store of src/db.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rateGate = () => import('../../src/sync/rate-gate');
const db = () => import('../../src/db/index');

const neverSleep = (): Promise<void> => {
  throw new Error('sleep must not be called');
};

const ledgerRows = (store: any, sourceId: string): { at: number; call_class: string }[] =>
  store.readSnapshot((snap: any) =>
    snap.db
      .query('SELECT at, call_class FROM rate_reservation WHERE source_id = ? ORDER BY seq')
      .all(sourceId),
  );

const ledgerCount = (store: any): number =>
  store.readSnapshot(
    (snap: any) => (snap.db.query('SELECT count(*) AS n FROM rate_reservation').get() as { n: number }).n,
  );

const cooldownUntil = (store: any, sourceId: string): number | null =>
  store.readSnapshot((snap: any) => {
    const row = snap.db.query('SELECT until FROM rate_cooldown WHERE source_id = ?').get(sourceId) as {
      until: number;
    } | null;
    return row === null ? null : row.until;
  });

// mulberry32: a small seeded generator, so every seed replays the same interleaving.
const seeded = (seed: number) => {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe('sync/rate-gate', () => {
  test('declaration rules and unknown source', async () => {
    const { createRateGate, ensureRateLedgerSchema, MIN_MARGIN_MS, RateLimitDeclError, UnknownRateSourceError } =
      await rateGate();
    const { openStore, MEMORY_LOCATION } = await db();
    const store = openStore(MEMORY_LOCATION, [ensureRateLedgerSchema]);
    const now = () => 0;

    const base = {
      windows: [{ callClass: null, calls: 1, windowMs: 1000 }],
      marginMs: MIN_MARGIN_MS,
      refusalCooldownMs: 0,
    };
    const withWindow = (change: object) => ({ ...base, windows: [{ ...base.windows[0], ...change }] });
    const create = (decl: any) =>
      createRateGate({ store, limits: new Map([['stub', decl]]), now, sleep: neverSleep });

    const broken: [string, any][] = [
      ['marginMs = MIN_MARGIN_MS - 1', { ...base, marginMs: MIN_MARGIN_MS - 1 }],
      ['marginMs = MIN_MARGIN_MS + 0.5', { ...base, marginMs: MIN_MARGIN_MS + 0.5 }],
      ['calls = 0', withWindow({ calls: 0 })],
      ['calls = 1.5', withWindow({ calls: 1.5 })],
      ['windowMs = 0', withWindow({ windowMs: 0 })],
      ['windowMs = 1.5', withWindow({ windowMs: 1.5 })],
      ['refusalCooldownMs = -1', { ...base, refusalCooldownMs: -1 }],
      ['refusalCooldownMs = 0.5', { ...base, refusalCooldownMs: 0.5 }],
    ];
    for (const [label, decl] of broken) {
      let thrown: unknown = null;
      try {
        create(decl);
      } catch (e) {
        thrown = e;
      }
      expect({ label, isDeclError: thrown instanceof RateLimitDeclError }).toEqual({ label, isDeclError: true });
      expect({ label, message: (thrown as Error).message }).toEqual({
        label,
        message: expect.stringContaining('stub'),
      });
    }

    // The boundaries are accepted.
    expect(() => create(base)).not.toThrow();
    expect(() => create({ ...base, windows: [] })).not.toThrow();
    expect(() => create({ ...base, refusalCooldownMs: 0 })).not.toThrow();

    const gate = create(base);
    expect(() => gate.reserve('other', 'statement')).toThrow(UnknownRateSourceError);
    await expect(gate.acquire('other', 'statement', new AbortController().signal)).rejects.toBeInstanceOf(
      UnknownRateSourceError,
    );
    expect(ledgerCount(store)).toBe(0);
    store.close();
  });

  test('late wake re-reserves', async () => {
    const { createRateGate, ensureRateLedgerSchema } = await rateGate();
    const { openStore, MEMORY_LOCATION } = await db();
    const store = openStore(MEMORY_LOCATION, [ensureRateLedgerSchema]);

    let clock = 0;
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
      clock = slept.length === 1 ? 1301 : clock + ms + 100;
    };
    const notices: unknown[] = [];
    const onWait = (w: unknown) => {
      notices.push(w);
    };
    const gate = createRateGate({
      store,
      limits: new Map([
        ['stub', { windows: [{ callClass: null, calls: 1, windowMs: 1000 }], marginMs: 200, refusalCooldownMs: 0 }],
      ]),
      now: () => clock,
      sleep,
    });
    const signal = new AbortController().signal;

    await gate.acquire('stub', 'x', signal, onWait);
    expect(notices).toEqual([]);
    expect(slept).toEqual([]);

    await gate.acquire('stub', 'x', signal, onWait);
    expect(slept).toEqual([1200, 1099]);
    expect(notices).toEqual([
      { sourceId: 'stub', callClass: 'x', until: 1200, waitMs: 1200 },
      { sourceId: 'stub', callClass: 'x', until: 2400, waitMs: 1099 },
    ]);
    expect(clock).toBe(2500);
    expect(ledgerRows(store, 'stub').map((r) => r.at)).toEqual([1200, 2400]);
    store.close();
  });

  test('gatedHttp and abort', async () => {
    const { createRateGate, ensureRateLedgerSchema, gatedHttp } = await rateGate();
    const { openStore, MEMORY_LOCATION } = await db();
    const store = openStore(MEMORY_LOCATION, [ensureRateLedgerSchema]);

    const sleep = (_ms: number, signal: AbortSignal): Promise<void> =>
      new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const gate = createRateGate({
      store,
      limits: new Map([
        ['stub', { windows: [{ callClass: null, calls: 1, windowMs: 1000 }], marginMs: 200, refusalCooldownMs: 0 }],
      ]),
      now: () => 0,
      sleep,
    });
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response('ok');
    };
    const notices: any[] = [];
    let noticed: () => void = () => {};
    const firstNotice = new Promise<void>((resolve) => {
      noticed = resolve;
    });
    const onWait = (w: any) => {
      notices.push(w);
      noticed();
    };
    const http = gatedHttp(gate, 'stub', fetchImpl, onWait);

    // 1. Granted at once: dispatched with the caller's init and signal.
    const c1 = new AbortController();
    const r = await http.request('statement', 'http://bank.test/a', { method: 'GET', headers: { a: '1' } }, c1.signal);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('http://bank.test/a');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers).toEqual({ a: '1' });
    expect(calls[0]!.init.signal).toBe(c1.signal);
    expect(await r.text()).toBe('ok');

    // 2. Aborted while waiting: rejects with the reason and never fetches.
    const c2 = new AbortController();
    const p = http.request('statement', 'http://bank.test/b', {}, c2.signal);
    p.catch(() => {});
    await firstNotice;
    expect(notices.length).toBe(1);
    expect(notices[0].until).toBe(1200);
    c2.abort('stop');
    await expect(p).rejects.toBe('stop');
    expect(calls.length).toBe(1);

    // 3. The abandoned reservation still counts.
    expect(gate.reserve('stub', 'statement')).toBe(2400);
    store.close();
  });

  test(
    'two processes keep one limit',
    async () => {
      const { createRateGate, ensureRateLedgerSchema } = await rateGate();
      const { openStore } = await db();
      const limits = new Map([
        [
          'stub',
          {
            windows: [
              { callClass: null, calls: 3, windowMs: 1000 },
              { callClass: 'statement', calls: 1, windowMs: 5000 },
            ],
            marginMs: 200,
            refusalCooldownMs: 0,
          },
        ],
      ]);

      for (let seed = 1; seed <= 20; seed++) {
        const dir = mkdtempSync(join(tmpdir(), 'arcanum-rate-gate-'));
        const path = join(dir, 'copy.sqlite');
        const opened: { close(): void }[] = [];
        try {
          const storeA = openStore(path, [ensureRateLedgerSchema]);
          opened.push(storeA);
          const storeB = openStore(path, [ensureRateLedgerSchema]);
          opened.push(storeB);
          let clock = 0;
          const now = () => clock;
          const gateA = createRateGate({ store: storeA, limits, now, sleep: neverSleep });
          const gateB = createRateGate({ store: storeB, limits, now, sleep: neverSleep });
          const random = seeded(seed);

          const list: { cls: string; t: number; at: number }[] = [];
          for (let i = 0; i < 200; i++) {
            clock += Math.floor(random() * 301);
            const gate = random() < 0.5 ? gateA : gateB;
            const cls = random() < 0.5 ? 'statement' : 'client';
            list.push({ cls, t: gate.reserve('stub', cls), at: clock });
          }

          const faults: string[] = [];
          for (let i = 0; i < list.length; i++) {
            if (i > 0 && list[i]!.t < list[i - 1]!.t) faults.push(`order at ${i}`);
            if (i + 3 < list.length && list[i + 3]!.t - list[i]!.t < 1200) faults.push(`null window at ${i}`);
            if (list[i]!.t < list[i]!.at) faults.push(`before now at ${i}`);
          }
          const statements = list.filter((x) => x.cls === 'statement');
          for (let j = 0; j + 1 < statements.length; j++) {
            if (statements[j + 1]!.t - statements[j]!.t < 5200) faults.push(`statement window at ${j}`);
          }
          expect({ seed, faults }).toEqual({ seed, faults: [] });

          // Deterministic tail over the same stores.
          const C = Math.max(...list.map((x) => x.t)) + 10000;
          clock = C;
          expect(gateA.reserve('stub', 'statement')).toBe(C);
          clock = C + 1300;
          expect(gateB.reserve('stub', 'client')).toBe(C + 1300);
          clock = C + 1400;
          expect(gateA.reserve('stub', 'statement')).toBe(C + 5200);
        } finally {
          for (const s of opened) s.close();
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
    600000,
  );

  test('reserve follows the worked case', async () => {
    const { createRateGate, ensureRateLedgerSchema } = await rateGate();
    const { openStore, MEMORY_LOCATION } = await db();
    const store = openStore(MEMORY_LOCATION, [ensureRateLedgerSchema]);

    let clock = 0;
    const now = () => clock;
    const gate = createRateGate({
      store,
      limits: new Map([
        [
          'stub',
          {
            windows: [{ callClass: 'statement', calls: 1, windowMs: 60000 }],
            marginMs: 2000,
            refusalCooldownMs: 60000,
          },
        ],
      ]),
      now,
      sleep: neverSleep,
    });
    // Another process declaring a shorter cool-down; createRateGate writes nothing.
    const gateShort = createRateGate({
      store,
      limits: new Map([
        [
          'stub',
          {
            windows: [{ callClass: 'statement', calls: 1, windowMs: 60000 }],
            marginMs: 2000,
            refusalCooldownMs: 1000,
          },
        ],
      ]),
      now,
      sleep: neverSleep,
    });

    clock = 0;
    expect(gate.reserve('stub', 'statement')).toBe(0);
    clock = 10;
    expect(gate.reserve('stub', 'statement')).toBe(62000);

    clock = 100;
    gate.recordRefusal('stub');
    expect(cooldownUntil(store, 'stub')).toBe(60100);
    expect(ledgerCount(store)).toBe(2);

    clock = 150;
    gateShort.recordRefusal('stub');
    expect(cooldownUntil(store, 'stub')).toBe(60100);
    expect(ledgerCount(store)).toBe(2);

    clock = 200;
    expect(gate.reserve('stub', 'statement')).toBe(124000);
    clock = 300;
    expect(gate.reserve('stub', 'client')).toBe(124000);

    expect(ledgerRows(store, 'stub').map((r) => r.at)).toEqual([0, 62000, 124000, 124000]);
    store.close();
  });
});
