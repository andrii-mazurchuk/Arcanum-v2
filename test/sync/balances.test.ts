// Reported balances (S-243): each holding's balance, credit limit and jar goal as separate fields,
// each with its own as-of moment and optional finer order, decided field by field by
// recordBalances and read by readBalances, from src/sync/balances over the store of src/db.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const balancesModule = () => import('../../src/sync/balances');
const db = () => import('../../src/db/index');
const registerModule = () => import('../../src/core/register');
const moneyModule = () => import('../../src/money/money');

const T0 = Date.parse('2026-11-21T09:00:00Z');
const s = (n: number): number => T0 + n * 1000;

interface Holding {
  kind: 'account' | 'jar';
  bankId: string;
}

// An in-memory store with the balance record installed, and one write registering source 'stub'
// with the given capabilities and PLN holdings.
async function setUp(capabilities: string[], holdings: Holding[]) {
  const balances = await balancesModule();
  const { openStore, MEMORY_LOCATION } = await db();
  const { narrowingName } = await registerModule();
  const { money } = await moneyModule();

  const store = openStore(MEMORY_LOCATION, [balances.ensureBalanceSchema]);
  store.write((tx: any) => {
    tx.registerSource({ id: 'stub', capabilities });
    for (const h of holdings) {
      tx.registerHolding({ kind: h.kind, sourceId: 'stub', bankId: h.bankId, currency: 'PLN' });
    }
  });
  const P = (x: number) => money(BigInt(x * 100), 'PLN');
  const record = (list: any[], stamp: number, mode: 'restated' | 'if_given') =>
    store.write((tx: any) => balances.recordBalances(tx, 'stub', list, stamp, mode));
  const read = (sourceId?: string): any[] =>
    store.readSnapshot((snap: any) =>
      sourceId === undefined
        ? balances.readBalances(snap)
        : balances.readBalances(snap, sourceId),
    );
  return { ...balances, store, narrowingName, money, P, record, read };
}

describe('sync/balances', () => {
  test('account fields follow the worked sequence', async () => {
    const { store, narrowingName, P, record, read } = await setUp([], [
      { kind: 'account', bankId: 'a1' },
    ]);
    try {
      const A = narrowingName('stub', 'account', 'a1');
      const rb = (bal: number, limit: number | null) => ({
        holdingId: A,
        balance: P(bal),
        creditLimit: limit === null ? null : P(limit),
      });
      const h = () => read('stub')[0];

      // 1. A refresh at 0 writes balance and limit, both as of 0.
      expect(record([rb(100, 50)], s(0), 'restated')).toEqual({ written: 1, kept: 0 });
      let held = h();
      expect(held.holdingId).toBe(A);
      expect(held.sourceId).toBe('stub');
      expect(held.balance).toEqual(P(100));
      expect(held.reportedAt).toBe(s(0));
      expect(held.creditLimit).toEqual(P(50));
      expect(held.creditLimitAt).toBe(s(0));

      // 2. A push at 3 with no limit replaces the balance and leaves the limit: if_given does not
      // read a null limit as 'none stated'.
      expect(record([rb(90, null)], s(3), 'if_given')).toEqual({ written: 1, kept: 0 });
      held = h();
      expect(held.balance).toEqual(P(90));
      expect(held.reportedAt).toBe(s(3));
      expect(held.creditLimit).toEqual(P(50));
      expect(held.creditLimitAt).toBe(s(0));

      // 3. The same push again: equal moment, equal value, so nothing is written.
      const before = h();
      expect(record([rb(90, null)], s(3), 'if_given')).toEqual({ written: 0, kept: 1 });
      expect(h()).toEqual(before);

      // 4. A late push at 2 is kept out.
      expect(record([rb(95, null)], s(2), 'if_given')).toEqual({ written: 0, kept: 1 });
      held = h();
      expect(held.balance).toEqual(P(90));
      expect(held.reportedAt).toBe(s(3));

      // 5. A refresh at 1 committed after them: the balance (as of 3) is kept, the limit (as of 0)
      // is replaced, so the fields are decided one by one.
      expect(record([rb(100, 50)], s(1), 'restated')).toEqual({ written: 1, kept: 0 });
      held = h();
      expect(held.balance).toEqual(P(90));
      expect(held.reportedAt).toBe(s(3));
      expect(held.creditLimit).toEqual(P(50));
      expect(held.creditLimitAt).toBe(s(1));

      // 6. Pushes at 4 with no finer order: 85, then 80 replaces it as the later arrival, and a
      // redelivered 85 replaces again (the accepted residual).
      record([rb(85, null)], s(4), 'if_given');
      expect(h().balance).toEqual(P(85));
      record([rb(80, null)], s(4), 'if_given');
      expect(h().balance).toEqual(P(80));
      record([rb(85, null)], s(4), 'if_given');
      held = h();
      expect(held.balance).toEqual(P(85));
      expect(held.reportedAt).toBe(s(4));

      // 7. A refresh at 5 with no limit restates it as none: the held limit is cleared as of 5.
      expect(record([rb(90, null)], s(5), 'restated').written).toBe(1);
      held = h();
      expect(held.balance).toEqual(P(90));
      expect(held.reportedAt).toBe(s(5));
      expect(held.creditLimit).toBeNull();
      expect(held.creditLimitAt).toBe(s(5));
    } finally {
      store.close();
    }
  });

  test('order, uncarried fields and jar goals', async () => {
    const { store, narrowingName, P, record, read } = await setUp(['jars'], [
      { kind: 'account', bankId: 'a2' },
      { kind: 'jar', bankId: 'j1' },
    ]);
    try {
      const A2 = narrowingName('stub', 'account', 'a2');
      const J = narrowingName('stub', 'jar', 'j1');
      const held = (id: string) => read('stub').find((b) => b.holdingId === id);

      // 1. A push-first holding: no report ever carried the limit, so it has no limit moment.
      record([{ holdingId: A2, balance: P(85), creditLimit: null, order: 1 }], s(4), 'if_given');
      let a = held(A2);
      expect(a.balance).toEqual(P(85));
      expect(a.reportedAt).toBe(s(4));
      expect(a.creditLimit).toBeNull();
      expect(a.creditLimitAt).toBeNull();

      // 2. The higher finer order at the same moment replaces.
      record([{ holdingId: A2, balance: P(80), creditLimit: null, order: 2 }], s(4), 'if_given');
      expect(held(A2).balance).toEqual(P(80));

      // 3. The redelivered lower order is kept out.
      expect(
        record([{ holdingId: A2, balance: P(85), creditLimit: null, order: 1 }], s(4), 'if_given'),
      ).toEqual({ written: 0, kept: 1 });
      expect(held(A2).balance).toEqual(P(80));

      // 4. A jar refreshed at 0 with a goal.
      record([{ holdingId: J, balance: P(10), creditLimit: null, goal: P(4000) }], s(0), 'restated');
      let j = held(J);
      expect(j.goal).toEqual(P(4000));
      expect(j.goalAt).toBe(s(0));
      expect(j.creditLimit).toBeNull();

      // 5. A refresh at 6 with no goal property does not carry the goal: it is kept.
      record([{ holdingId: J, balance: P(11), creditLimit: null }], s(6), 'restated');
      j = held(J);
      expect(j.goal).toEqual(P(4000));
      expect(j.goalAt).toBe(s(0));
      expect(j.balance).toEqual(P(11));
      expect(j.reportedAt).toBe(s(6));

      // 6. A refresh at 7 carrying goal null removes it.
      record([{ holdingId: J, balance: P(11), creditLimit: null, goal: null }], s(7), 'restated');
      j = held(J);
      expect(j.goal).toBeNull();
      expect(j.goalAt).toBe(s(7));

      // 7. A push at 8 with no goal keeps it removed.
      record([{ holdingId: J, balance: P(12), creditLimit: null }], s(8), 'if_given');
      j = held(J);
      expect(j.goal).toBeNull();
      expect(j.goalAt).toBe(s(7));

      // 8. Ordered by holdingId; another source holds nothing.
      expect(read().map((b) => b.holdingId)).toEqual([A2, J]);
      expect(read('other')).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('exact minor units', async () => {
    const { store, narrowingName, money, record, read } = await setUp([], [
      { kind: 'account', bankId: 'a1' },
    ]);
    try {
      const A = narrowingName('stub', 'account', 'a1');
      record(
        [
          {
            holdingId: A,
            balance: money(9007199254740993n, 'PLN'),
            creditLimit: money(-9007199254740995n, 'PLN'),
          },
        ],
        T0,
        'restated',
      );
      const held = read()[0];
      // Through binary64 these read back as 9007199254740992 and -9007199254740996.
      expect(typeof held.balance.minor).toBe('bigint');
      expect(held.balance.minor === 9007199254740993n).toBe(true);
      expect(held.balance).toEqual(money(9007199254740993n, 'PLN'));
      expect(typeof held.creditLimit.minor).toBe('bigint');
      expect(held.creditLimit.minor === -9007199254740995n).toBe(true);
      expect(held.creditLimit).toEqual(money(-9007199254740995n, 'PLN'));
    } finally {
      store.close();
    }
  });

  test('shape rules roll back', async () => {
    const { store, narrowingName, money, P, read, recordBalances, BalanceShapeError } = await setUp(
      ['jars'],
      [
        { kind: 'account', bankId: 'a1' },
        { kind: 'jar', bankId: 'j1' },
      ],
    );
    try {
      const A = narrowingName('stub', 'account', 'a1');
      const J = narrowingName('stub', 'jar', 'j1');
      const good = { holdingId: A, balance: P(100), creditLimit: null };
      const bad: any[] = [
        { holdingId: 'other:account:a1', balance: P(1), creditLimit: null },
        { holdingId: narrowingName('stub', 'account', 'zz'), balance: P(1), creditLimit: null },
        { holdingId: A, balance: money(100n, 'USD'), creditLimit: null },
        { holdingId: J, balance: P(1), creditLimit: P(5) },
        { holdingId: A, balance: P(1), creditLimit: null, goal: P(5) },
        { holdingId: A, balance: P(1), creditLimit: money(500n, 'USD') },
        { holdingId: A, balance: P(1), creditLimit: null, order: 1.5 },
        { holdingId: A, balance: P(1), creditLimit: null, order: 2 ** 53 },
      ];

      for (const b of bad) {
        // 1. The error escapes the write: it rolls back.
        let thrown: unknown;
        try {
          store.write((tx: any) => recordBalances(tx, 'stub', [good, b], T0, 'restated'));
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(BalanceShapeError);
        expect((thrown as Error).message).toContain(b.holdingId);
        expect(read()).toEqual([]);

        // 2. The error is caught inside a write that commits: good was never written, because
        // every balance is checked before any is written.
        let caught: unknown;
        store.write((tx: any) => {
          try {
            recordBalances(tx, 'stub', [good, b], T0, 'restated');
          } catch (e) {
            caught = e;
          }
        });
        expect(caught).toBeInstanceOf(BalanceShapeError);
        expect(read()).toEqual([]);
      }

      // A stamp that is not a safe integer.
      expect(() =>
        store.write((tx: any) => recordBalances(tx, 'stub', [good], T0 + 0.5, 'restated')),
      ).toThrow(BalanceShapeError);
      expect(read()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
