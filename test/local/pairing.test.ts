// Own-transfer pairing (S-78): the inclusive windows, the counterpart-compatibility rule, the pure
// four-tier planner (explicit links, completion of open one-sided transfers, closest-in-time amount
// matches, one-sided recording) and pairInWrite applying it inside the ingest write. From
// src/local/pairing.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { WriteTx } from '../../src/db/index';
import type { Money } from '../../src/money/money';
import type { Counterpart } from '../../src/local/translated';

const pairing = () => import('../../src/local/pairing');
const transactions = () => import('../../src/local/transactions');
const storeModule = () => import('../../src/db/index');
const moneyModule = () => import('../../src/money/money');

const A = 'monobank:account:a';
const B = 'monobank:account:b';
const U = 'monobank:account:u';
const J = 'monobank:jar:j';
const C = 'second:account:c';

const at = (s: string): number => Date.parse(`2026-11-21T${s}Z`);
const key = (bankId: string, sourceId = 'monobank') => ({ sourceId, bankId });

interface Mv {
  key: { sourceId: string; bankId: string };
  holdingId: string;
  occurredAt: number;
  amount: Money;
  originalAmount: Money | null;
  counterpart: Counterpart | null;
  fresh: boolean;
}

// The movement builder of the window test: key source is the holding's source, UAH, fresh.
const movements = async () => {
  const { sourceOfHolding } = await pairing();
  const { money } = await moneyModule();
  const mv = (
    bankId: string,
    holding: string,
    when: number,
    minor: bigint,
    counterpart: Counterpart | null = null,
  ): Mv => ({
    key: { sourceId: sourceOfHolding(holding as never), bankId },
    holdingId: holding,
    occurredAt: when,
    amount: money(minor, 'UAH'),
    originalAmount: null,
    counterpart,
    fresh: true,
  });
  return { mv, money };
};

describe('local/pairing', () => {
  test('window boundaries', async () => {
    const { SAME_SOURCE_WINDOW_MS, CROSS_SOURCE_WINDOW_MS, sourceOfHolding, windowFor, planPairings } =
      await pairing();
    const { mv } = await movements();
    const T0 = Date.parse('2026-11-21T12:00:00Z');
    const plan = (ms: Mv[]) => planPairings(ms as never, []);

    expect(SAME_SOURCE_WINDOW_MS).toBe(600_000);
    expect(CROSS_SOURCE_WINDOW_MS).toBe(3 * 86_400_000);
    expect(sourceOfHolding(J as never)).toBe('monobank');
    expect(windowFor(A as never, J as never)).toBe(SAME_SOURCE_WINDOW_MS);
    expect(windowFor(A as never, C as never)).toBe(CROSS_SOURCE_WINDOW_MS);

    // One source: exactly ten minutes pairs, one second more does not.
    expect(plan([mv('x', A, T0, -10000n), mv('y', B, T0 + SAME_SOURCE_WINDOW_MS, 10000n)])).toEqual([
      { kind: 'pair', tier: 3, out: key('x'), in: key('y'), outHolding: A, inHolding: B },
    ]);
    expect(plan([mv('x', A, T0, -10000n), mv('y', B, T0 + SAME_SOURCE_WINDOW_MS + 1000, 10000n)])).toEqual(
      [],
    );

    // Across sources: exactly three days pairs, one second more does not.
    expect(plan([mv('x', A, T0, -10000n), mv('c', C, T0 + CROSS_SOURCE_WINDOW_MS, 10000n)])).toEqual([
      { kind: 'pair', tier: 3, out: key('x'), in: key('c', 'second'), outHolding: A, inHolding: C },
    ]);
    expect(plan([mv('x', A, T0, -10000n), mv('c', C, T0 + CROSS_SOURCE_WINDOW_MS + 1000, 10000n)])).toEqual(
      [],
    );
  });

  test('closest then earliest', async () => {
    const { planPairings } = await pairing();
    const { mv } = await movements();
    const plan = (ms: Mv[]) => planPairings(ms as never, []);

    // Case 1: gaps 300_000 for o1 and 180_000 for o2; the closer o2 pairs though o1 comes first.
    expect(
      plan([
        mv('o1', A, at('12:00:00'), -10000n),
        mv('o2', A, at('12:08:00'), -10000n),
        mv('i1', B, at('12:05:00'), 10000n),
      ]),
    ).toEqual([{ kind: 'pair', tier: 3, out: key('o2'), in: key('i1'), outHolding: A, inHolding: B }]);

    // Case 2: both gaps 180_000; the earlier moment (12:02 against 12:05) wins before key order,
    // which would pick a2.
    const case2 = [
      mv('z1', A, at('12:02:00'), -10000n),
      mv('a2', A, at('12:08:00'), -10000n),
      mv('i1', B, at('12:05:00'), 10000n),
    ];
    const expected = [{ kind: 'pair', tier: 3, out: key('z1'), in: key('i1'), outHolding: A, inHolding: B }];
    expect<any>(plan(case2)).toEqual(expected);
    expect<any>(plan([...case2].reverse())).toEqual(expected);
  });

  test('links, one-sided and completion', async () => {
    const { planPairings } = await pairing();
    const { mv } = await movements();

    // Links: tier 1 pairs a with b1 ten days later, before b2 sixty seconds away can match by amount.
    const a = mv('a', A, at('12:00:00'), -10000n, { holdingId: B as never, bankId: 'b1', via: 'link' });
    const b1 = mv('b1', B, Date.parse('2026-12-01T12:00:00Z'), 10000n);
    const b2 = mv('b2', B, at('12:01:00'), 10000n);
    expect(planPairings([a, b1, b2] as never, [])).toEqual([
      { kind: 'pair', tier: 1, out: key('a'), in: key('b1'), outHolding: A, inHolding: B },
    ]);

    // Marked: t names the jar, so it is not compatible with b and stays one-sided toward J.
    const t = mv('t', A, at('12:00:00'), -50000n, { holdingId: J as never, bankId: null, via: 'jar_top_up' });
    const b = mv('b', B, at('12:03:00'), 50000n);
    expect(planPairings([t, b] as never, [])).toEqual([
      { kind: 'one_sided', key: key('t'), outHolding: A, inHolding: J },
    ]);

    // Completion: the jar side arrives in a later write and completes the open transfer.
    const j = mv('j', J, at('12:02:00'), 50000n);
    expect(
      planPairings([{ ...b, fresh: false }, j] as never, [
        { id: 7, recorded: { ...t, fresh: false }, namedHolding: J } as never,
      ]),
    ).toEqual([{ kind: 'complete', transferId: 7, key: key('j') }]);

    // Same batch: the jar side is present, so tier 3 pairs t with j two-sided and b stays free.
    expect(planPairings([t, b, j] as never, [])).toEqual([
      { kind: 'pair', tier: 3, out: key('t'), in: key('j'), outHolding: A, inHolding: J },
    ]);

    // Inflow marked: a positive movement records the named holding as the out side.
    const w = mv('w', A, at('13:00:00'), 20000n, { holdingId: J as never, bankId: null, via: 'jar_withdrawal' });
    expect(planPairings([w] as never, [])).toEqual([
      { kind: 'one_sided', key: key('w'), outHolding: J, inHolding: A },
    ]);
  });

  test('figures, signs, zero and freshness', async () => {
    const { sameAmount, compatible, planPairings } = await pairing();
    const { money } = await moneyModule();
    const plan = (ms: Mv[]) => planPairings(ms as never, []);
    const make = (
      bankId: string,
      holding: string,
      when: number,
      amount: Money,
      originalAmount: Money | null = null,
      counterpart: Counterpart | null = null,
      fresh = true,
    ): Mv => ({ key: key(bankId), holdingId: holding, occurredAt: when, amount, originalAmount, counterpart, fresh });

    // A PLN card topping up a USD account: the original amount carries the match.
    const p = make('p', A, at('12:00:00'), money(-40000n, 'PLN'), money(-10000n, 'USD'));
    const u = make('u', U, at('12:01:00'), money(10000n, 'USD'));
    expect(sameAmount(p as never, u as never)).toBe(true);
    expect(plan([p, u])).toEqual([
      { kind: 'pair', tier: 3, out: key('p'), in: key('u'), outHolding: A, inHolding: U },
    ]);

    // Without the original amount the two share no currency.
    const pBare = { ...p, originalAmount: null };
    expect(sameAmount(pBare as never, u as never)).toBe(false);
    expect(plan([pBare, u])).toEqual([]);

    // Two outflows of equal size are not a transfer.
    expect(
      plan([
        make('x', A, at('12:00:00'), money(-10000n, 'UAH')),
        make('y', B, at('12:01:00'), money(-10000n, 'UAH')),
      ]),
    ).toEqual([]);

    // A zero movement neither pairs nor records, even with a counterpart.
    expect(
      plan([
        make('z', A, at('12:00:00'), money(0n, 'UAH'), null, { holdingId: B as never, bankId: null, via: 'link' }),
        make('q', B, at('12:00:30'), money(0n, 'UAH')),
      ]),
    ).toEqual([]);

    // Neither movement fresh: no candidate is formed; one fresh side is enough.
    const x = make('x', A, at('12:00:00'), money(-10000n, 'UAH'), null, null, false);
    const y = make('y', B, at('12:01:00'), money(10000n, 'UAH'), null, null, false);
    expect(plan([x, y])).toEqual([]);
    expect(plan([x, { ...y, fresh: true }])).toEqual([
      { kind: 'pair', tier: 3, out: key('x'), in: key('y'), outHolding: A, inHolding: B },
    ]);

    // u2 names B, not p's holding A: incompatible in both argument orders.
    const u2 = { ...u, counterpart: { holdingId: B as never, bankId: null, via: 'link' as const } };
    expect(compatible(p as never, u2 as never)).toBe(false);
    expect(compatible(u2 as never, p as never)).toBe(false);
  });

  test('pairInWrite stable', async () => {
    const { pairInWrite } = await pairing();
    const { ensureTransactionSchema, insertTransaction, getTransaction, getTransfer } = await transactions();
    const { openStore, MEMORY_LOCATION } = await storeModule();
    const { money } = await moneyModule();

    const CLASSIFIED = { category: 'Uncategorized', merchant: '' } as const;
    const ins = (tx: WriteTx, bankId: string, holding: string, when: number, minor: bigint) => {
      const t = {
        sourceId: 'monobank',
        bankId,
        holdingId: holding,
        occurredAt: when,
        amount: money(minor, 'UAH'),
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
      insertTransaction(tx, t as never, tx.claimPosition(), CLASSIFIED as never);
      return key(bankId);
    };
    const transferOf = (n: string) => store.readSnapshot((s) => getTransaction(s.db, key(n))?.transfer);

    const store = openStore(MEMORY_LOCATION, [ensureTransactionSchema]);
    try {
      // 1. X at 12:00 and Y at 12:08 pair; W at 11:00 has no partner.
      const d1 = store.write((tx: WriteTx) => {
        const keys = [
          ins(tx, 'W', A, at('11:00:00'), -5000n),
          ins(tx, 'X', A, at('12:00:00'), -10000n),
          ins(tx, 'Y', B, at('12:08:00'), 10000n),
        ];
        return pairInWrite(tx, keys as never);
      });
      expect(d1).toEqual([{ kind: 'pair', tier: 3, out: key('X'), in: key('Y'), outHolding: A, inHolding: B }]);
      const xTransfer = transferOf('X');
      expect(xTransfer?.complete).toBe(true);
      expect(xTransfer?.otherHolding).toBe(B);
      expect(transferOf('W')).toBeNull();
      const id1 = xTransfer?.id as number;

      // 2. Z at 12:01 is closer to X than Y was, but a stored pairing is never re-paired.
      const d2 = store.write((tx: WriteTx) => pairInWrite(tx, [ins(tx, 'Z', B, at('12:01:00'), 10000n)] as never));
      expect(d2).toEqual([]);
      expect(transferOf('X')?.id).toBe(id1);
      expect(store.readSnapshot((s) => getTransfer(s.db, id1))?.sides).toEqual([key('X'), key('Y')]);
      expect(transferOf('Z')).toBeNull();

      // 3. V finds W, stored in an earlier write, through the moment window.
      const d3 = store.write((tx: WriteTx) => pairInWrite(tx, [ins(tx, 'V', B, at('11:05:00'), 5000n)] as never));
      expect(d3).toEqual([{ kind: 'pair', tier: 3, out: key('W'), in: key('V'), outHolding: A, inHolding: B }]);

      // 4. V again, already linked: nothing forms.
      const d4 = store.write((tx: WriteTx) => pairInWrite(tx, [key('V')] as never));
      expect(d4).toEqual([]);
      const count = store.readSnapshot(
        (s) => (s.db.query('SELECT COUNT(*) AS n FROM own_transfer').get() as { n: number }).n,
      );
      expect(count).toBe(2);
    } finally {
      store.close();
    }
  });
});
