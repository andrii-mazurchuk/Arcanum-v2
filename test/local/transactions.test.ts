// Held transactions (S-141): the transaction and own-transfer tables; selectTransactions with its
// holding, instant and position bounds, both orders and limit; own-transfer rows formed by
// createTransfer and completed once by attachSide; insertTransaction storing every field exactly and
// settleHeld taking only the bank's settled figures. From src/local/transactions.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { WriteTx } from '../../src/db/index';
import type { Money } from '../../src/money/money';

const transactions = () => import('../../src/local/transactions');
const storeModule = () => import('../../src/db/index');
const registerModule = () => import('../../src/core/register');
const moneyModule = () => import('../../src/money/money');

// A full translated transaction: every field present, cashback included.
interface Fixture {
  sourceId: string;
  bankId: string;
  holdingId: string;
  occurredAt: number;
  amount: Money;
  originalAmount: Money | null;
  cashback: Money | null;
  settled: boolean;
  mcc: number | null;
  originalMcc: number | null;
  merchantText: string | null;
  description: string;
  comment: string | null;
  counterpart: null;
}

const plain = (bankId: string, holdingId: string, occurredAt: number, amount: Money): Fixture => ({
  sourceId: 'monobank',
  bankId,
  holdingId,
  occurredAt,
  amount,
  originalAmount: null,
  cashback: null,
  settled: true,
  mcc: null,
  originalMcc: null,
  merchantText: null,
  description: '',
  comment: null,
  counterpart: null,
});

const CLASSIFIED = { category: 'Uncategorized', merchant: 'Test' } as const;

describe('local/transactions', () => {
  test('selectTransactions bounds', async () => {
    const { ensureTransactionSchema, insertTransaction, selectTransactions } = await transactions();
    const { openStore, MEMORY_LOCATION } = await storeModule();
    const { narrowingName } = await registerModule();
    const { money } = await moneyModule();

    const A = narrowingName('monobank', 'account', 'a');
    const B = narrowingName('monobank', 'account', 'b');
    const at = (s: string): number => Date.parse(`2026-11-21T${s}Z`);
    const store = openStore(MEMORY_LOCATION, [ensureTransactionSchema]);
    try {
      store.write((tx: WriteTx) => {
        const rows: [string, string, string][] = [
          ['k1', A, '10:30:00'],
          ['k9', B, '10:10:00'],
          ['k3', A, '10:10:00'],
          ['k4', B, '10:50:00'],
        ];
        for (const [bankId, holding, time] of rows) {
          const t = plain(bankId, holding, at(time), money(-100n, 'UAH'));
          insertTransaction(tx, t as never, tx.claimPosition(), CLASSIFIED as never);
        }
      });

      store.readSnapshot((snap) => {
        const ids = (q: Parameters<typeof selectTransactions>[1]): string[] =>
          selectTransactions(snap.db, q).map((r) => r.bankId);

        expect(ids({ order: 'position' })).toEqual(['k1', 'k9', 'k3', 'k4']);
        // The 10:10 tie goes to the lower position (2 before 3), not to the lower bank id.
        expect(ids({ order: 'occurred' })).toEqual(['k9', 'k3', 'k1', 'k4']);
        // until is exclusive: k1 at exactly 10:30 is left out.
        expect(ids({ order: 'position', from: at('10:10:00'), until: at('10:30:00') })).toEqual([
          'k9',
          'k3',
        ]);
        // afterPosition is exclusive, upToPosition inclusive.
        expect(ids({ order: 'position', afterPosition: 1, upToPosition: 3 })).toEqual(['k9', 'k3']);
        expect(ids({ order: 'occurred', holdings: new Set([B]) })).toEqual(['k9', 'k4']);
        // An empty holdings set selects nothing; it is not "no filter".
        expect(ids({ order: 'position', holdings: new Set() })).toEqual([]);
        expect(ids({ order: 'occurred', limit: 2 })).toEqual(['k9', 'k3']);
      });
    } finally {
      store.close();
    }
  });

  test('own-transfer rows', async () => {
    const {
      ensureTransactionSchema,
      insertTransaction,
      getTransaction,
      createTransfer,
      attachSide,
      getTransfer,
      listOpenTransfers,
    } = await transactions();
    const { openStore, MEMORY_LOCATION } = await storeModule();
    const { narrowingName } = await registerModule();
    const { money } = await moneyModule();

    const A = narrowingName('monobank', 'account', 'a');
    const B = narrowingName('monobank', 'account', 'b');
    const J = narrowingName('monobank', 'jar', 'j'); // never inserted as a holding anywhere
    const key = (n: string) => ({ sourceId: 'monobank', bankId: n });
    const when = Date.parse('2026-11-21T10:00:00Z');
    const store = openStore(MEMORY_LOCATION, [ensureTransactionSchema]);
    try {
      store.write((tx: WriteTx) => {
        const rows: [string, string, bigint][] = [
          ['Y', B, 10000n],
          ['X', A, -10000n],
          ['Z', A, -5000n],
          ['W', J, 5000n],
          ['V', B, 7000n],
          ['U', A, -100n],
        ];
        for (const [bankId, holding, minor] of rows) {
          const t = plain(bankId, holding, when, money(minor, 'UAH'));
          insertTransaction(tx, t as never, tx.claimPosition(), CLASSIFIED as never);
        }
      });
      const view = (n: string) => store.readSnapshot((s) => getTransaction(s.db, key(n))?.transfer);
      const openIds = () => store.readSnapshot((s) => listOpenTransfers(s.db).map((t) => t.id));

      // 1. Two free sides: the sides are listed in position order (Y at 1, X at 2), not argument order.
      const id1 = store.write((tx: WriteTx) => createTransfer(tx, A, B, 3, [key('X'), key('Y')]));
      expect(store.readSnapshot((s) => getTransfer(s.db, id1))).toEqual({
        id: id1,
        outHolding: A,
        inHolding: B,
        tier: 3,
        sides: [key('Y'), key('X')],
      });
      expect(view('X')).toEqual({ id: id1, direction: 'out', otherHolding: B, complete: true });
      expect(view('Y')).toEqual({ id: id1, direction: 'in', otherHolding: A, complete: true });

      // 2. One-sided transfers are open; complete is not set from the tier.
      const [id2, id3] = store.write((tx: WriteTx) => [
        createTransfer(tx, A, J, 4, [key('Z')]),
        createTransfer(tx, A, B, 4, [key('U')]),
      ]);
      expect(id3).toBeGreaterThan(id2);
      expect(view('Z')).toEqual({ id: id2, direction: 'out', otherHolding: J, complete: false });
      expect(openIds()).toEqual([id2, id3]);

      // 3. attachSide completes an open transfer and keeps its tier.
      store.write((tx: WriteTx) => attachSide(tx, id2, key('W')));
      expect(view('Z')).toEqual({ id: id2, direction: 'out', otherHolding: J, complete: true });
      expect(view('W')).toEqual({ id: id2, direction: 'in', otherHolding: A, complete: true });
      expect(store.readSnapshot((s) => getTransfer(s.db, id2))?.tier).toBe(4);
      expect(openIds()).toEqual([id3]);

      // 4. No linked side is ever relinked, and a complete transfer gains no third side.
      expect(() => store.write((tx: WriteTx) => attachSide(tx, id2, key('V')))).toThrow();
      expect(() => store.write((tx: WriteTx) => attachSide(tx, id3, key('X')))).toThrow();
      expect(() =>
        store.write((tx: WriteTx) => createTransfer(tx, B, A, 3, [key('V'), key('Y')])),
      ).toThrow();
      expect(view('X')?.id).toBe(id1);
      expect(view('Y')?.id).toBe(id1);
      expect(view('V')).toBeNull();
      const count = store.readSnapshot(
        (s) => (s.db.query('SELECT COUNT(*) AS n FROM own_transfer').get() as { n: number }).n,
      );
      expect(count).toBe(3);
    } finally {
      store.close();
    }
  });

  test('insert and settleHeld', async () => {
    const {
      ensureTransactionSchema,
      insertTransaction,
      settleHeld,
      selectTransactions,
      getTransaction,
      listOpenTransfers,
      getTransfer,
    } = await transactions();
    const { openStore, MEMORY_LOCATION } = await storeModule();
    const { narrowingName } = await registerModule();
    const { money } = await moneyModule();

    const A = narrowingName('monobank', 'account', 'a');
    const key = { sourceId: 'monobank', bankId: 't1' };
    const classified = { category: 'Groceries & Supermarkets', merchant: 'Silpo' };
    const pending: Fixture = {
      sourceId: 'monobank',
      bankId: 't1',
      holdingId: A,
      occurredAt: Date.parse('2026-11-21T10:00:00Z'),
      amount: money(-10000n, 'UAH'),
      originalAmount: money(-273n, 'USD'),
      cashback: money(100n, 'UAH'),
      settled: false,
      mcc: 5411,
      originalMcc: null,
      merchantText: 'SILPO',
      description: 'SILPO #12 UA',
      comment: 'lunch',
      counterpart: null,
    };
    const settledV: Fixture = {
      ...pending,
      occurredAt: Date.parse('2026-11-22T08:00:00Z'),
      amount: money(-9850n, 'UAH'),
      originalAmount: money(-266n, 'USD'),
      cashback: money(98n, 'UAH'),
      settled: true,
      mcc: 5812,
      merchantText: 'KFC',
      description: 'KFC KYIV',
      comment: 'other',
    };
    const big: Fixture = {
      ...pending,
      bankId: 'big',
      settled: true,
      amount: money(9007199254740993n, 'UAH'),
      originalAmount: null,
      cashback: null,
    };
    const pending2: Fixture = { ...pending, bankId: 't2', cashback: money(300n, 'UAH') };
    const settled2: Fixture = {
      ...pending2,
      settled: true,
      amount: money(-9900n, 'UAH'),
      cashback: null,
    };

    const store = openStore(MEMORY_LOCATION, [ensureTransactionSchema]);
    try {
      const read = <T>(body: (db: Database) => T): T => store.readSnapshot((s) => body(s.db));
      const get = (bankId: string) =>
        read((db) => getTransaction(db, { sourceId: 'monobank', bankId }));
      const col = (bankId: string) =>
        read(
          (db) =>
            (
              db.query('SELECT cashback_minor FROM held_transaction WHERE bank_id = ?').get(bankId) as {
                cashback_minor: unknown;
              }
            ).cashback_minor,
        );

      // Empty store: every reader gives [] or null.
      expect(store.readSnapshot((s) => selectTransactions(s.db, { order: 'position' }))).toEqual([]);
      expect(read((db) => getTransaction(db, key))).toBeNull();
      expect(read((db) => listOpenTransfers(db))).toEqual([]);
      expect(read((db) => getTransfer(db, 1))).toBeNull();

      // 1. Every field stored exactly, cashback as decimal text.
      store.write((tx: WriteTx) =>
        insertTransaction(tx, pending as never, tx.claimPosition(), classified as never),
      );
      expect(get('t1')).toEqual({
        sourceId: 'monobank',
        bankId: 't1',
        holdingId: A,
        occurredAt: Date.parse('2026-11-21T10:00:00Z'),
        position: 1,
        amount: money(-10000n, 'UAH'),
        originalAmount: money(-273n, 'USD'),
        cashback: money(100n, 'UAH'),
        settled: false,
        mcc: 5411,
        originalMcc: null,
        merchantText: 'SILPO',
        description: 'SILPO #12 UA',
        comment: 'lunch',
        counterpart: null,
        category: 'Groceries & Supermarkets',
        merchant: 'Silpo',
        transfer: null,
      });
      expect(col('t1')).toBe('100');

      // 2. settleHeld takes moment, amounts, cashback and settled; codes, text, category and
      // merchant of first storage are kept.
      store.write((tx: WriteTx) => settleHeld(tx, settledV as never));
      expect(get('t1')).toEqual({
        sourceId: 'monobank',
        bankId: 't1',
        holdingId: A,
        occurredAt: Date.parse('2026-11-22T08:00:00Z'),
        position: 1,
        amount: money(-9850n, 'UAH'),
        originalAmount: money(-266n, 'USD'),
        cashback: money(98n, 'UAH'),
        settled: true,
        mcc: 5411,
        originalMcc: null,
        merchantText: 'SILPO',
        description: 'SILPO #12 UA',
        comment: 'lunch',
        counterpart: null,
        category: 'Groceries & Supermarkets',
        merchant: 'Silpo',
        transfer: null,
      });
      expect(col('t1')).toBe('98');

      // 3. A second row for one key is refused, and the whole write rolls back.
      expect(() =>
        store.write((tx: WriteTx) =>
          insertTransaction(tx, pending as never, tx.claimPosition(), classified as never),
        ),
      ).toThrow();
      const held = read((db) => selectTransactions(db, { order: 'position' }));
      expect(held.filter((r) => r.sourceId === 'monobank' && r.bankId === 't1').length).toBe(1);
      expect(store.readSnapshot((s) => s.position())).toBe(1);

      // 4. A bigint beyond 2^53 survives exactly; a null cashback is stored as NULL, not zero.
      store.write((tx: WriteTx) =>
        insertTransaction(tx, big as never, tx.claimPosition(), classified as never),
      );
      const bigRow = get('big');
      expect(bigRow?.amount.minor).toBe(9007199254740993n);
      expect(bigRow?.amount.currency).toBe('UAH');
      expect(bigRow?.cashback).toBeNull();
      const amountText = read(
        (db) =>
          (
            db.query("SELECT amount_minor FROM held_transaction WHERE bank_id = 'big'").get() as {
              amount_minor: unknown;
            }
          ).amount_minor,
      );
      expect(amountText).toBe('9007199254740993');
      expect(col('big')).toBeNull();

      // 5. A settled version reporting no cashback clears the held one.
      store.write((tx: WriteTx) =>
        insertTransaction(tx, pending2 as never, tx.claimPosition(), classified as never),
      );
      store.write((tx: WriteTx) => settleHeld(tx, settled2 as never));
      const t2 = get('t2');
      expect(t2?.cashback).toBeNull();
      expect(t2?.amount.minor).toBe(-9900n);
      expect(col('t2')).toBeNull();
    } finally {
      store.close();
    }
  });
});
