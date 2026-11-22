// Service run (S-215): after the start gate passed, one rate gate, one client and one worker per
// switched-on source, registration switched off and logged where the push pair is incomplete, a
// route made only from a complete pair, the receiver listening, and the stop sequence — listener
// first, workers aborted, store closed once after they have stopped, 'service stopped', 0 — run once
// however many signals arrive. An unbuilt source fails before anything starts. From src/sync/service,
// over the real Monobank settings group, the settings loader of src/config/settings, the start gate
// of src/start-gate and an in-memory store of src/db.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load. The type import is erased at run time.

import { describe, expect, test } from 'bun:test';
import type { Store } from '../../src/db/index';

const serviceModule = () => import('../../src/sync/service');
const monobank = () => import('../../src/sources/monobank/source');
const settings = () => import('../../src/config/settings');
const startGate = () => import('../../src/start-gate');
const db = () => import('../../src/db/index');
const covered = () => import('../../src/local/covered');
const transactions = () => import('../../src/local/transactions');
const quarantine = () => import('../../src/money/quarantine');
const recordedRates = () => import('../../src/money/recorded-rates');
const progress = () => import('../../src/sync/progress');
const rateGate = () => import('../../src/sync/rate-gate');
const balances = () => import('../../src/sync/balances');

const S = Date.parse('2026-11-21T09:00:00Z');
const SECRET = 'abcdefghijklmnop';
const LIMITS = { windows: [], marginMs: 200, refusalCooldownMs: 0 };
const D = 86_400_000;

// Lets real macrotasks run until `done` holds, at most `rounds` times.
const until = async (done: () => boolean, rounds = 400): Promise<void> => {
  for (let i = 0; i < rounds && !done(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

// 'resolved' when `p` resolves within `ms` real milliseconds, else 'timeout'.
const within = (p: Promise<unknown>, ms: number): Promise<'resolved' | 'timeout'> =>
  Promise.race([
    p.then(() => 'resolved' as const),
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms)),
  ]);

// Fake timers recording every handle armed and every handle cleared.
const fakeTimers = () => {
  const armed: { cb: () => void; ms: number; handle: { id: number } }[] = [];
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
  return { timers, armed, cleared };
};

// An in-memory store with every sync table installed.
async function syncStore(): Promise<Store> {
  const { openStore, MEMORY_LOCATION } = await db();
  const { ensureCoverageSchema } = await covered();
  const { ensureTransactionSchema } = await transactions();
  const { ensureQuarantineSchema } = await quarantine();
  const { ensureRateSchema } = await recordedRates();
  const { ensureFirstFillSchema } = await progress();
  const { ensureRateLedgerSchema } = await rateGate();
  const { ensureBalanceSchema } = await balances();
  return openStore(MEMORY_LOCATION, [
    ensureCoverageSchema,
    ensureTransactionSchema,
    ensureQuarantineSchema,
    ensureRateSchema,
    ensureFirstFillSchema,
    ensureRateLedgerSchema,
    ensureBalanceSchema,
  ]);
}

// The settings record over the Monobank group, the credential named as the group declares it, the
// push port and storage given, plus `push`; checked to be one the start gate accepts for the service.
async function serviceRecord(push: Record<string, string>, port = '0') {
  const { settingsGroup } = await monobank();
  const { loadSettings, sourceSettingName, SHARED_NAMES } = await settings();
  const { checkStart } = await startGate();
  const { MEMORY_LOCATION } = await db();
  const env: Record<string, string> = {
    [sourceSettingName(settingsGroup.sourceId, 'TOKEN')]: 'test-token',
    ...push,
    [SHARED_NAMES.pushPort]: port,
    [SHARED_NAMES.storage]: MEMORY_LOCATION,
  };
  const record = loadSettings(env, [settingsGroup]);
  expect(checkStart({ kind: 'service' }, record)).toEqual({ ok: true, sources: ['monobank'] });
  return record;
}

// The fixture translator: every body is not well formed; the address check is GET -> 200.
const fixtureTranslator = () => {
  const count = { read: 0 };
  const translator = {
    addressCheck: { method: 'GET' as const, status: 200 },
    read(): any {
      count.read += 1;
      return { kind: 'not_well_formed', reason: 'x' };
    },
  };
  return { translator, count };
};

const stubDefinition = async (translator: unknown, open: (cfg: unknown) => unknown): Promise<any> => {
  const { settingsGroup } = await monobank();
  return {
    id: 'monobank',
    capabilities: [],
    settingsGroup,
    balanceConvention: 'own_money_as_reported',
    limits: LIMITS,
    maxWindowMs: D,
    push: translator,
    open,
  };
};

const noFetch = async (): Promise<Response> => {
  throw new Error('the network is never reached');
};

const noSleep = (): Promise<void> => Promise.reject(new Error('sleep must not be called'));

const STARTED = /^service started; push receiver on port (\d+); sources monobank$/;

const startedPort = (lines: readonly string[]): number | null => {
  for (const l of lines) {
    const m = STARTED.exec(l);
    if (m !== null) return Number(m[1]);
  }
  return null;
};

// A request on a fresh connection, so a closed listener cannot be reached through a pooled one.
const send = (url: string, init: RequestInit = {}) => fetch(url, { ...init, keepalive: false });

describe('sync/service', () => {
  test('start and stop sequence', async () => {
    const { runService } = await serviceModule();
    const record = await serviceRecord({ ARCANUM_MONOBANK_PUSH_SECRET: SECRET });

    const { translator, count } = fixtureTranslator();
    const events: string[] = [];
    const signals: AbortSignal[] = [];
    const calls = { registerPush: 0, close: 0 };
    const client = {
      refreshHoldings(signal: AbortSignal): Promise<any> {
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          const aborted = () => {
            events.push('abort');
            reject(signal.reason);
          };
          if (signal.aborted) aborted();
          else signal.addEventListener('abort', aborted, { once: true });
        });
      },
      async fetchWindow(): Promise<any> {
        return { items: [], next: null };
      },
      async registerPush(): Promise<void> {
        calls.registerPush += 1;
      },
    };
    const def = await stubDefinition(translator, () => client);

    const inner = await syncStore();
    const store: Store = {
      location: inner.location,
      readSnapshot: (body) => inner.readSnapshot(body),
      write: (body) => inner.write(body),
      close() {
        calls.close += 1;
        events.push('close');
        if (calls.close === 1) inner.close();
      },
    };
    const t = fakeTimers();
    let handler: (() => void) | null = null;
    const lines: string[] = [];
    const log = (line: string) => {
      lines.push(line);
    };

    const p = runService({
      record,
      sources: ['monobank'],
      store,
      built: [def],
      now: () => S,
      log,
      fetchImpl: noFetch,
      sleep: noSleep,
      timers: t.timers,
      onStopSignal: (h) => {
        handler = h;
      },
    });
    let result: number | null = null;
    const settled = p.then((r) => {
      result = r;
    });
    try {
      // 1. Registration off, naming the missing half only; then the started line with a real port.
      await until(() => startedPort(lines) !== null && handler !== null);
      const offAt = lines.findIndex((l) => l.startsWith('push registration off for source monobank:'));
      expect(offAt).toBeGreaterThanOrEqual(0);
      expect(lines[offAt]).toContain('PUSH_URL');
      expect(lines[offAt]).not.toContain('PUSH_SECRET');
      const n = startedPort(lines)!;
      expect(n).toBeGreaterThan(0);
      expect(lines.findIndex((l) => STARTED.test(l))).toBeGreaterThan(offAt);

      // 2. No route from the secret alone: POST and GET on its path are both unknown.
      const url = `http://127.0.0.1:${n}/${SECRET}`;
      const post = await send(url, { method: 'POST', body: 'nope' });
      expect(post.status).toBe(404);
      expect(count.read).toBe(0);
      const get = await send(url, { method: 'GET' });
      expect(get.status).toBe(404);

      // 3. Two signals in a row: one stop sequence, workers aborted before the store's one close.
      await until(() => signals.length >= 1);
      expect(signals.length).toBe(1);
      expect(t.armed.length).toBeGreaterThanOrEqual(1);
      const armed = t.armed[0]!.handle;
      expect(handler).not.toBeNull();
      handler!();
      handler!();
      expect(await within(settled, 3000)).toBe('resolved');
      expect(result).toBe(0);
      expect(lines[lines.length - 1]).toBe('service stopped');
      expect(lines.filter((l) => l === 'service stopped').length).toBe(1);
      expect(signals[0]!.aborted).toBe(true);
      expect(events.indexOf('abort')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('abort')).toBeLessThan(events.indexOf('close'));
      expect(calls.close).toBe(1);
      expect(t.cleared).toContain(armed);
      expect(calls.registerPush).toBe(0);

      // 4. The listener is closed.
      let refused = false;
      try {
        await send(url, { method: 'POST', body: 'nope' });
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    } finally {
      if (result === null && handler !== null) {
        (handler as () => void)();
        await within(settled, 1000);
      }
      if (calls.close === 0) inner.close();
    }
  });

  test('push route and unbuilt source', async () => {
    const { runService, UnbuiltSourceError } = await serviceModule();
    const push = { ARCANUM_MONOBANK_PUSH_URL: 'https://h.example/hook', ARCANUM_MONOBANK_PUSH_SECRET: SECRET };
    const record = await serviceRecord(push);

    const { translator } = fixtureTranslator();
    const registered: string[] = [];
    const client = {
      async refreshHoldings(_signal: AbortSignal): Promise<any> {
        return { holdings: [], balances: [] };
      },
      async fetchWindow(): Promise<any> {
        return { items: [], next: null };
      },
      async registerPush(address: string, _signal: AbortSignal): Promise<void> {
        registered.push(address);
      },
    };
    const def = await stubDefinition(translator, () => client);
    const store = await syncStore();
    const t = fakeTimers();
    let handler: (() => void) | null = null;
    const stopSignals = { calls: 0 };
    const lines: string[] = [];
    const log = (line: string) => {
      lines.push(line);
    };
    const params = {
      record,
      sources: ['monobank'],
      store,
      built: [def],
      now: () => S,
      log,
      fetchImpl: noFetch,
      sleep: noSleep,
      timers: t.timers,
      onStopSignal: (h: () => void) => {
        stopSignals.calls += 1;
        handler = h;
      },
    };

    // Case 1: a complete pair routes the secret path to the translator and the start job registers.
    let result: number | null = null;
    const p = runService(params);
    const settled = p.then((r) => {
      result = r;
    });
    try {
      await until(() => startedPort(lines) !== null && handler !== null);
      const n = startedPort(lines);
      expect(n).not.toBeNull();
      const post = await send(`http://127.0.0.1:${n}/${SECRET}`, { method: 'POST', body: 'nope' });
      expect(post.status).toBe(400);

      await until(() => lines.some((l) => l.startsWith('sync first_fill source=monobank ')));
      expect(lines.some((l) => l.startsWith('sync first_fill source=monobank '))).toBe(true);
      expect(registered).toEqual([`https://h.example/hook/${SECRET}`]);
      expect(lines.some((l) => l.startsWith('push registration off'))).toBe(false);

      expect(stopSignals.calls).toBe(1);
      handler!();
      expect(await within(settled, 3000)).toBe('resolved');
      expect(result).toBe(0);
    } finally {
      if (result === null && handler !== null) {
        (handler as () => void)();
        await within(settled, 1000);
      }
      if (result === null) store.close();
    }

    // Case 2: a switched-on source with no built definition fails before anything starts. The push
    // port is one just seen free, so a listener left behind would hold it.
    const probe = Bun.serve({ port: 0, fetch: () => new Response(null) });
    const port = probe.port!;
    await probe.stop(true);
    const record2 = await serviceRecord(push, String(port));
    const fresh = await syncStore();
    const lines2: string[] = [];
    const stopSignals2 = { calls: 0 };
    try {
      let thrown: unknown = null;
      try {
        await runService({
          ...params,
          record: record2,
          store: fresh,
          built: [],
          log: (line: string) => {
            lines2.push(line);
          },
          onStopSignal: () => {
            stopSignals2.calls += 1;
          },
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(UnbuiltSourceError);
      expect(lines2.some((l) => l.startsWith('service started'))).toBe(false);
      expect(stopSignals2.calls).toBe(0);
      const again = Bun.serve({ port, fetch: () => new Response(null) });
      await again.stop(true);
    } finally {
      fresh.close();
    }
  });
});
