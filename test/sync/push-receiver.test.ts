// Push receiver (S-218): the one listener. handlePush routes by each source's exact secret path,
// answers the address check, refuses other methods and not-well-formed readings, acknowledges an
// unknown account without storing it, and acknowledges a notification only after the ingest write
// holding its transaction and its balance (stamped with the transaction's moment) has committed.
// startPushReceiver refuses duplicate secret paths before listening, and its stop closes the
// listener and waits for in-flight notifications. From src/sync/push-receiver.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Store } from '../../src/db/index';
import type { TranslatedTransaction } from '../../src/local/translated';

const receiverModule = () => import('../../src/sync/push-receiver');
const storeModule = () => import('../../src/db/index');
const balancesModule = () => import('../../src/sync/balances');
const progress = () => import('../../src/sync/progress');
const rateGate = () => import('../../src/sync/rate-gate');
const transactions = () => import('../../src/local/transactions');
const covered = () => import('../../src/local/covered');
const quarantine = () => import('../../src/money/quarantine');
const registerModule = () => import('../../src/core/register');
const moneyModule = () => import('../../src/money/money');

const T0 = Date.parse('2026-11-21T09:00:00Z');
const SECRET = 'abcdefghijklmnop';
const BASE = 'http://local.test';

// The body the fixture translator reads. moment null with quarantined set gives a quarantined item
// whose moment is unreadable; currency gives the balance's currency (PLN when absent).
interface Body {
  holding: string;
  key: string;
  moment: number | null;
  balanceMinor: number;
  itemHolding?: string;
  quarantined?: boolean;
  currency?: string;
}

// An in-memory store with every sync table installed, source 'stub' and its PLN account A
// registered, the fixture translator, the deps and the readers the checks use.
async function arrange(now: () => number = () => T0) {
  const { openStore, MEMORY_LOCATION } = await storeModule();
  const balances = await balancesModule();
  const { ensureFirstFillSchema } = await progress();
  const { ensureRateLedgerSchema } = await rateGate();
  const { ensureTransactionSchema, getTransaction } = await transactions();
  const { ensureCoverageSchema } = await covered();
  const { ensureQuarantineSchema, listQuarantine } = await quarantine();
  const { narrowingName } = await registerModule();
  const { money } = await moneyModule();

  const store: Store = openStore(MEMORY_LOCATION, [
    ensureCoverageSchema,
    ensureTransactionSchema,
    ensureQuarantineSchema,
    balances.ensureBalanceSchema,
    ensureFirstFillSchema,
    ensureRateLedgerSchema,
  ]);
  store.write((tx) => {
    tx.registerSource({ id: 'stub', capabilities: [] });
    tx.registerHolding({ kind: 'account', sourceId: 'stub', bankId: 'a1', currency: 'PLN' });
  });
  const A = narrowingName('stub', 'account', 'a1');
  const P = (x: number) => money(BigInt(Math.round(x * 100)), 'PLN');

  let readCalls = 0;
  const translator = {
    addressCheck: { method: 'GET' as const, status: 202 },
    read(body: string, _contentType: string | null, ctx: { now: number }): any {
      readCalls += 1;
      let b: Body;
      try {
        b = JSON.parse(body);
      } catch {
        return { kind: 'not_well_formed', reason: 'bad json' };
      }
      const item = b.quarantined
        ? {
            kind: 'quarantined',
            entry: {
              sourceId: 'stub',
              bankId: b.key,
              raw: body,
              reason: 'malformed',
              detail: 'x',
              seenAt: ctx.now,
              occurredAt: b.moment,
            },
          }
        : {
            kind: 'held',
            sourceId: 'stub',
            bankId: b.key,
            record: {
              sourceId: 'stub',
              bankId: b.key,
              holdingId: b.itemHolding ?? b.holding,
              occurredAt: b.moment as number,
              amount: money(-100n, 'PLN'),
              originalAmount: null,
              cashback: null,
              settled: true,
              mcc: null,
              originalMcc: null,
              merchantText: null,
              description: '',
              comment: null,
              counterpart: null,
            } satisfies TranslatedTransaction,
          };
      return {
        kind: 'notification',
        holdingId: b.holding,
        holdingKind: 'account',
        item,
        balance: {
          holdingId: b.holding,
          balance: money(BigInt(b.balanceMinor), b.currency ?? 'PLN'),
          creditLimit: null,
        },
      };
    },
  };
  const route = (sourceId: string, secretPath: string) => ({ sourceId, secretPath, translator });

  const lines: string[] = [];
  const deps = {
    port: 0,
    routes: [route('stub', SECRET)],
    store,
    now,
    log: (line: string) => {
      lines.push(line);
    },
  };

  const read = {
    calls: () => readCalls,
    position: () => store.readSnapshot((s) => s.position()),
    rowCount: () =>
      store.readSnapshot((s) => (s.db.query('SELECT COUNT(*) AS n FROM held_transaction').get() as { n: number }).n),
    held: (bankId: string) => store.readSnapshot((s) => getTransaction(s.db, { sourceId: 'stub', bankId })),
    quarantine: () => store.readSnapshot((s) => listQuarantine(s.db, 'stub')),
    balances: () => store.readSnapshot((s) => balances.readBalances(s)),
  };

  const req = (method: string, path: string, body?: string) =>
    new Request(`${BASE}${path}`, body === undefined ? { method } : { method, body });
  const json = (b: Body) => JSON.stringify(b);

  return { ...balances, store, A, P, money, narrowingName, translator, route, deps, lines, read, req, json };
}

describe('sync/push-receiver', () => {
  test('routing and refusals', async () => {
    const { handlePush } = await receiverModule();
    const { store, A, narrowingName, deps, lines, read, req, json } = await arrange();
    try {
      const call = async (r: Request) => {
        const res = await handlePush(deps, r);
        expect(await res.text()).toBe('');
        return res.status;
      };

      // 1. An unknown path: 404, the body not read, one line logged.
      expect(await call(req('POST', '/other', '{}'))).toBe(404);
      expect(read.calls()).toBe(0);
      expect(lines).toEqual(['push refused: unknown path']);

      // 2. The secret path with a trailing slash is not the secret path.
      expect(await call(req('GET', `/${SECRET}/`))).toBe(404);
      expect(read.calls()).toBe(0);

      // 3. The address check answers the translator's status.
      expect(await call(req('GET', `/${SECRET}`))).toBe(202);
      expect(read.calls()).toBe(0);

      // 4. Another method: 405 before the body is read.
      expect(await call(req('PUT', `/${SECRET}`, '{}'))).toBe(405);
      expect(read.calls()).toBe(0);

      // 5. Not well formed: 400, logged.
      expect(await call(req('POST', `/${SECRET}`, 'nope'))).toBe(400);
      expect(read.calls()).toBe(1);
      expect(lines).toContain('push rejected source=stub: bad json');

      // 6. The item names a holding other than the reading's.
      const a9 = narrowingName('stub', 'account', 'a9');
      expect(
        await call(req('POST', `/${SECRET}`, json({ holding: A, itemHolding: a9, key: 'k0', moment: T0, balanceMinor: 1 }))),
      ).toBe(400);

      // 7. An account the register does not hold: acknowledged, logged, nothing stored.
      const zz = narrowingName('stub', 'account', 'zz');
      expect(await call(req('POST', `/${SECRET}`, json({ holding: zz, key: 'k1', moment: T0, balanceMinor: 1 })))).toBe(200);
      expect(lines).toContain(`push for unknown account source=stub holding=${zz}; nothing stored`);

      expect(read.position()).toBe(0);
      expect(read.rowCount()).toBe(0);
      expect(read.quarantine()).toEqual([]);
      expect(read.balances()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('balance stamped with the transaction moment', async () => {
    const { handlePush } = await receiverModule();
    const { store, A, P, deps, read, req, json, recordBalances } = await arrange(() => T0 + 300_000);
    try {
      store.write((tx) =>
        recordBalances(tx, 'stub', [{ holdingId: A, balance: P(100), creditLimit: P(50) }], T0, 'restated'),
      );
      const send = async (b: Body) => {
        const res = await handlePush(deps, req('POST', `/${SECRET}`, json(b)));
        expect(await res.text()).toBe('');
        return res.status;
      };
      const post = (key: string, sec: number, bal: number) =>
        send({ holding: A, key, moment: T0 + sec * 1000, balanceMinor: bal * 100 });
      const bal = () => read.balances()[0];

      // 1. Stamped with the transaction's moment; the limit the push does not state is kept.
      expect(await post('k1', 3, 90)).toBe(200);
      let b = bal();
      expect(b.balance).toEqual(P(90));
      expect(b.reportedAt).toBe(T0 + 3000);
      expect(b.creditLimit).toEqual(P(50));
      expect(b.creditLimitAt).toBe(T0);
      expect(read.held('k1')).not.toBeNull();

      // 2. The same notification again: acknowledged, held once, nothing changed.
      expect(await post('k1', 3, 90)).toBe(200);
      expect(read.rowCount()).toBe(1);
      expect(bal()).toEqual(b);

      // 3. A late notification: its transaction is stored, the balance kept.
      expect(await post('k2', 2, 95)).toBe(200);
      expect(read.held('k2')).not.toBeNull();
      b = bal();
      expect(b.balance).toEqual(P(90));
      expect(b.reportedAt).toBe(T0 + 3000);

      // 4. Another transaction at the same moment with another balance replaces it.
      expect(await post('k3', 3, 80)).toBe(200);
      expect(read.held('k3')).not.toBeNull();
      b = bal();
      expect(b.balance).toEqual(P(80));
      expect(b.reportedAt).toBe(T0 + 3000);

      // 5. A quarantined reading whose moment is unreadable records no balance.
      expect(await send({ holding: A, key: 'k4', moment: null, balanceMinor: 7000, quarantined: true })).toBe(200);
      expect(read.quarantine().map((e) => e.bankId)).toEqual(['k4']);
      expect(bal().balance).toEqual(P(80));
    } finally {
      store.close();
    }
  });

  test('failing write answers 500', async () => {
    const { handlePush } = await receiverModule();
    const { store, A, P, deps, lines, read, req, json, recordBalances } = await arrange(() => T0 + 300_000);
    try {
      store.write((tx) =>
        recordBalances(tx, 'stub', [{ holdingId: A, balance: P(100), creditLimit: P(50) }], T0, 'restated'),
      );
      const linesBefore = lines.length;
      const positionBefore = read.position();

      // A USD balance on the PLN holding fails inside the ingest write.
      const res = await handlePush(
        deps,
        req('POST', `/${SECRET}`, json({ holding: A, key: 'k5', moment: T0 + 5000, balanceMinor: 9000, currency: 'USD' })),
      );
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('');
      expect(lines.length).toBe(linesBefore + 1);
      expect(read.held('k5')).toBeNull();
      expect(read.position()).toBe(positionBefore);
      let b = read.balances()[0];
      expect(b.balance).toEqual(P(100));
      expect(b.reportedAt).toBe(T0);

      // The receiver stays usable after a 500.
      const ok = await handlePush(
        deps,
        req('POST', `/${SECRET}`, json({ holding: A, key: 'k6', moment: T0 + 6000, balanceMinor: 7700 })),
      );
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe('');
      expect(read.held('k6')).not.toBeNull();
      b = read.balances()[0];
      expect(b.balance).toEqual(P(77));
      expect(b.reportedAt).toBe(T0 + 6000);
    } finally {
      store.close();
    }
  });

  test('listener lifecycle', async () => {
    const { startPushReceiver, PushRouteConflictError } = await receiverModule();
    const { store, A, route, deps, read, json } = await arrange();
    try {
      // 1. Duplicate secret paths are refused before listening: the port asked stays free.
      const probe = Bun.serve({ port: 0, fetch: () => new Response(null) });
      const freePort = probe.port;
      await probe.stop(true);
      expect(() =>
        startPushReceiver({
          ...deps,
          port: freePort!,
          routes: [route('stub', SECRET), route('stub2', SECRET)],
        }),
      ).toThrow(PushRouteConflictError);
      const again = Bun.serve({ port: freePort, fetch: () => new Response(null) });
      await again.stop(true);

      // 2. Port 0 takes a free port and reports it.
      let signalRead: () => void = () => {};
      const received = new Promise<void>((resolve) => {
        signalRead = resolve;
      });
      const watched: Store = {
        location: store.location,
        readSnapshot: (body) => {
          signalRead();
          return store.readSnapshot(body);
        },
        write: (body) => store.write(body),
        close: () => store.close(),
      };
      const r = startPushReceiver({ ...deps, store: watched });
      expect(r.port).toBeGreaterThan(0);
      const url = `http://127.0.0.1:${r.port}/${SECRET}`;

      // 3. A notification whose body arrives in two halves.
      const text = json({ holding: A, key: 'k1', moment: T0, balanceMinor: 100 });
      const half = Math.floor(text.length / 2);
      let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
        },
      });
      ctl?.enqueue(new TextEncoder().encode(text.slice(0, half)));
      const pending = fetch(url, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);

      // 4. Once the server holds the request, stop does not settle while it is in flight.
      await Promise.race([received, Bun.sleep(1000)]);
      let settled = false;
      const s = r.stop();
      s.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Bun.sleep(50);
      expect(settled).toBe(false);

      // 5. The rest of the body: written and replied, then stop resolves.
      ctl?.enqueue(new TextEncoder().encode(text.slice(half)));
      ctl?.close();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      await s;
      expect(read.held('k1')).not.toBeNull();

      // 6. After the listener closed, a new notification is refused and stores nothing.
      const positionAfter = read.position();
      let refused = false;
      try {
        await fetch(url, {
          method: 'POST',
          body: json({ holding: A, key: 'k2', moment: T0, balanceMinor: 100 }),
          keepalive: false,
        });
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      expect(read.held('k2')).toBeNull();
      expect(read.position()).toBe(positionAfter);
    } finally {
      store.close();
    }
  });
});
