// New-since-last-asked family (S-148): lists the unmarked held transactions in scope, in storage
// order up to the snapshot's position, at most the cap the question names (1 to 100, default 20),
// states the cap and how many remain, and hands back as pending exactly the positions it listed.
// The family marks nothing; 'marking a page' here is what the core does after delivery: take the
// store-held ask claim and release it with that answer's pending list (S-242). From
// src/families/new over the money part of src/money/context.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { Family, QuestionContext } from '../../src/core/question';
import type { Store, WriteTx } from '../../src/db/index';
import type { Money } from '../../src/money/money';

const newFamily = () => import('../../src/families/new');
const context = () => import('../../src/money/context');
const register = () => import('../../src/core/register');
const recordedRates = () => import('../../src/money/recorded-rates');
const transactions = () => import('../../src/local/transactions');
const classifierModule = () => import('../../src/local/classifier');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');

const FAMILY = 'new_since_last_asked';
const CAP_MESSAGE = 'The cap must be a whole number from 1 to 100.';
const NOW = Date.parse('2026-11-21T12:00:00Z');
const BASE_AT = Date.parse('2026-11-20T09:00:00Z');

// Monobank as built: the source offering rates.
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// One held transaction to store: its bank id names the position it is expected to take.
interface Ingest {
  bankId: string;
  sourceId: string;
  holdingBankId: string; // the account's bank id; the holding is `${sourceId}:account:${holdingBankId}`
  occurredAt: number;
}

interface Harness {
  store: Store;
  cal: Calendar;
  ingest(items: readonly Ingest[]): void;
  mark(pending: readonly number[]): void;
  ask(family: Family<any>, opts: { narrowing?: string; display?: string; options?: Record<string, unknown> }): any;
  positionOf(row: { sourceId: string; bankId: string }): number;
}

// Opens a fresh in-memory store with the given sources and one UAH account per (source, account
// bank id) pair, PLN-in-UAH cross 10.00 recorded for 'monobank' at 2026-11-20 08:00Z.
async function openHarness(
  sources: readonly { id: string; capabilities: readonly string[] }[],
  accounts: readonly { sourceId: string; bankId: string }[],
): Promise<Harness> {
  const { ensureRateSchema, recordRates } = await recordedRates();
  const { ensureTransactionSchema, insertTransaction, selectTransactions } = await transactions();
  const { UNCATEGORIZED } = await classifierModule();
  const { openStore, MEMORY_LOCATION } = await db();
  const { openCalendar } = await dates();
  const { parseExactDecimal } = await exact();
  const { money } = await moneyModule();
  const { resolveScope } = await register();

  const cal = openCalendar(undefined) as Calendar;
  const store = openStore(MEMORY_LOCATION, [ensureRateSchema, ensureTransactionSchema]);
  store.write((tx: WriteTx) => {
    for (const s of sources) tx.registerSource({ id: s.id, capabilities: s.capabilities as never });
    for (const a of accounts) {
      tx.registerHolding({ kind: 'account', sourceId: a.sourceId, bankId: a.bankId, currency: 'UAH' });
    }
    if (sources.some((s) => s.id === 'monobank')) {
      recordRates(
        tx,
        'monobank',
        [{ pair: { base: 'PLN', quote: 'UAH' }, figures: { kind: 'cross', rate: parseExactDecimal('10.00')! } }],
        Date.parse('2026-11-20T08:00:00Z'),
      );
    }
  });

  const positions = new Map<string, number>();
  const amount: Money = money(-10000n, 'UAH');

  return {
    store,
    cal,
    ingest(items) {
      store.write((tx: WriteTx) => {
        for (const it of items) {
          const position = tx.claimPosition();
          insertTransaction(
            tx,
            {
              sourceId: it.sourceId,
              bankId: it.bankId,
              holdingId: `${it.sourceId}:account:${it.holdingBankId}`,
              occurredAt: it.occurredAt,
              amount,
              originalAmount: null,
              cashback: null,
              settled: true,
              mcc: null,
              originalMcc: null,
              merchantText: null,
              description: `${it.bankId} description`,
              comment: null,
              counterpart: null,
            } as never,
            position,
            { category: UNCATEGORIZED, merchant: 'Shop' } as never,
          );
          positions.set(`${it.sourceId}/${it.bankId}`, position);
        }
      });
      // Each bank id took the position it names.
      store.readSnapshot((snap) => {
        const held = selectTransactions(snap.db, { order: 'position' });
        for (const it of items) {
          expect(held.find((t) => t.sourceId === it.sourceId && t.bankId === it.bankId)?.position).toBe(
            Number(it.bankId.slice(1)),
          );
        }
      });
    },
    // As the core does after delivery: take the store-held ask claim and release it, token-checked,
    // with the answer's pending list.
    mark(pending) {
      store.write((tx: WriteTx) => {
        const token = `token-${pending.join('-')}`;
        expect(tx.takeClaim(FAMILY, token, NOW, NOW + 60_000)).toBe(true);
        expect(tx.releaseClaim(FAMILY, token, pending)).toEqual({ released: true, marked: pending.length });
      });
    },
    // One answer over a fresh snapshot, through a hand-built question context.
    ask(family, { narrowing, display = 'UAH', options = {} }) {
      return store.readSnapshot((snap) => {
        const reg = snap.register();
        const scope = resolveScope(reg, narrowing);
        expect((scope as { kind?: string }).kind).not.toBe('refused');
        const ctx = {
          snapshot: snap,
          now: NOW,
          settings: { timeZone: undefined, sources: sources.map((s) => s.id) },
          calendar: cal,
          displayCurrency: display,
          position: snap.position(),
          register: reg,
          scope,
          period: null,
          asker: 'assistant',
          options,
        } as unknown as QuestionContext;
        return family.compute(ctx);
      });
    },
    positionOf(row) {
      const p = positions.get(`${row.sourceId}/${row.bankId}`);
      expect(p).toBeDefined();
      return p!;
    },
  };
}

// The positions of an answer's rows, in the order listed.
const rowPositions = (h: Harness, outcome: any): number[] => outcome.body.rows.map((r: any) => h.positionOf(r));

const monoItem = (k: number, occurredAt: number = BASE_AT + k * 60_000): Ingest => ({
  bankId: `p${k}`,
  sourceId: 'monobank',
  holdingBankId: 'uah',
  occurredAt,
});

describe('families/new', () => {
  test('paging with cap 100', async () => {
    const { createMoneyPart } = await context();

    const h = await openHarness([MONO], [{ sourceId: 'monobank', bankId: 'uah' }]);
    try {
      h.ingest(range(1, 150).map((k) => monoItem(k)));
      const { createNewFamily } = await newFamily();
      const family = createNewFamily(createMoneyPart([MONO]));
      const opts = { options: { cap: 100 } };

      // 1. The first 100 by position; remaining counts only the 50 not listed; pending the positions.
      const a1 = h.ask(family, opts);
      expect(a1.kind).toBe('body');
      expect(rowPositions(h, a1)).toEqual(range(1, 100));
      expect(a1.body.remaining).toBe(50);
      expect(a1.body.cap).toBe(100);
      expect(a1.pending).toEqual(range(1, 100));

      // 2. Not marked: the same page is listed again.
      const a1b = h.ask(family, opts);
      expect(a1b.kind).toBe('body');
      expect(rowPositions(h, a1b)).toEqual(range(1, 100));
      expect(a1b.body.remaining).toBe(50);
      expect(a1b.pending).toEqual(range(1, 100));

      // The family wrote no mark.
      h.store.readSnapshot((snap) => {
        expect(range(1, 150).filter((p) => snap.isListed(p))).toEqual([]);
      });

      // 3. Marked: the next page.
      h.mark(a1b.pending);
      const a2 = h.ask(family, opts);
      expect(a2.kind).toBe('body');
      expect(rowPositions(h, a2)).toEqual(range(101, 150));
      expect(a2.body.remaining).toBe(0);
      expect(a2.body.cap).toBe(100);
      expect(a2.pending).toEqual(range(101, 150));

      // 4. Everything marked: nothing listed.
      h.mark(a2.pending);
      const a3 = h.ask(family, opts);
      expect(a3.kind).toBe('body');
      expect(a3.body.rows).toEqual([]);
      expect(a3.body.remaining).toBe(0);
      expect(a3.pending).toEqual([]);

      // 5. Five more stored: exactly those.
      h.ingest(range(151, 155).map((k) => monoItem(k)));
      const a4 = h.ask(family, opts);
      expect(a4.kind).toBe('body');
      expect(rowPositions(h, a4)).toEqual(range(151, 155));
      expect(a4.body.remaining).toBe(0);
      expect(a4.pending).toEqual(range(151, 155));
    } finally {
      h.store.close();
    }
  });

  test('cap refusals and declaration', async () => {
    const { createMoneyPart } = await context();

    const h = await openHarness([MONO], [{ sourceId: 'monobank', bankId: 'uah' }]);
    try {
      h.ingest(range(1, 5).map((k) => monoItem(k)));
      const { createNewFamily } = await newFamily();

      // The money part with show counted: every result handed to any money context's show.
      const part = createMoneyPart([MONO]);
      let shown = 0;
      const counted = {
        ...part,
        moneyFor: (ctx: QuestionContext) => {
          const m = part.moneyFor(ctx);
          return Object.create(m, {
            show: {
              value: (results: Iterable<unknown>) => {
                const list = [...results];
                shown += list.length;
                return m.show(list as never);
              },
            },
          });
        },
      };
      const family = createNewFamily(counted as never);

      expect(family.name).toBe(FAMILY);
      expect(family.period).toBe('none');
      expect(family.capability).toBeUndefined();
      expect(family.movesPoint).toBe(true);

      // Refused naming 'cap': zero, above 100, not whole, a numeric string.
      for (const cap of [0, 101, 2.5, '10']) {
        const r = h.ask(family, { display: 'PLN', options: { cap } });
        expect([cap, r.kind, r.reason, r.subject, r.message]).toEqual([cap, 'refused', 'bad_option', 'cap', CAP_MESSAGE]);
      }
      const foo = h.ask(family, { display: 'PLN', options: { foo: 1 } });
      expect([foo.kind, foo.reason, foo.subject]).toEqual(['refused', 'bad_option', 'foo']);
      expect(shown).toBe(0);

      // cap 1: one row, the rest counted but not shown.
      const one = h.ask(family, { display: 'PLN', options: { cap: 1 } });
      expect(one.kind).toBe('body');
      expect(rowPositions(h, one)).toEqual([1]);
      expect(one.body.remaining).toBe(4);
      expect(one.body.cap).toBe(1);
      expect(shown).toBe(1);

      // cap 100, the inclusive upper bound: all five listed and shown.
      shown = 0;
      const all = h.ask(family, { display: 'PLN', options: { cap: 100 } });
      expect(all.kind).toBe('body');
      expect(rowPositions(h, all)).toEqual(range(1, 5));
      expect(all.body.remaining).toBe(0);
      expect(all.body.cap).toBe(100);
      expect(shown).toBe(5);
    } finally {
      h.store.close();
    }
  });

  test('order, default cap and narrowing', async () => {
    const { createMoneyPart } = await context();

    // Arrange A: each later-stored transaction occurred earlier.
    const a = await openHarness([MONO], [{ sourceId: 'monobank', bankId: 'uah' }]);
    try {
      const top = Date.parse('2026-11-20T12:00:00Z');
      a.ingest(range(1, 30).map((k) => monoItem(k, top - k * 60_000)));
      const { createNewFamily } = await newFamily();
      const family = createNewFamily(createMoneyPart([MONO]));

      const r = a.ask(family, {});
      expect(r.kind).toBe('body');
      expect(rowPositions(a, r)).toEqual(range(1, 20));
      expect(r.body.cap).toBe(20);
      expect(r.body.remaining).toBe(10);
      expect(r.pending).toEqual(range(1, 20));
    } finally {
      a.store.close();
    }

    // Arrange B: positions 3, 5, 8, 9 on X's account, the rest on Y's.
    const X = { id: 'xbank', capabilities: [] } as const;
    const Y = { id: 'ybank', capabilities: [] } as const;
    const b = await openHarness(
      [X, Y],
      [
        { sourceId: 'xbank', bankId: 'acc' },
        { sourceId: 'ybank', bankId: 'acc' },
      ],
    );
    try {
      const atX = new Set([3, 5, 8, 9]);
      b.ingest(
        range(1, 10).map((k) => ({
          bankId: `p${k}`,
          sourceId: atX.has(k) ? 'xbank' : 'ybank',
          holdingBankId: 'acc',
          occurredAt: BASE_AT + k * 60_000,
        })),
      );
      const { createNewFamily } = await newFamily();
      const family = createNewFamily(createMoneyPart([X, Y]));

      // 1. Narrowed to X with cap 2: filtered before the cap; pending only the listed.
      const n1 = b.ask(family, { narrowing: 'xbank', options: { cap: 2 } });
      expect(n1.kind).toBe('body');
      expect(rowPositions(b, n1)).toEqual([3, 5]);
      expect(n1.body.remaining).toBe(2);
      expect(n1.body.cap).toBe(2);
      expect(n1.pending).toEqual([3, 5]);

      // 2. Narrowed to X, default cap: X's four only.
      const n2 = b.ask(family, { narrowing: 'xbank' });
      expect(n2.kind).toBe('body');
      expect(rowPositions(b, n2)).toEqual([3, 5, 8, 9]);
      expect(n2.body.remaining).toBe(0);
      expect(n2.pending).toEqual([3, 5, 8, 9]);

      // 3. X's marked: an unnarrowed ask lists the other six.
      b.mark(n2.pending);
      const all = b.ask(family, {});
      expect(all.kind).toBe('body');
      expect(rowPositions(b, all)).toEqual([1, 2, 4, 6, 7, 10]);
      expect(all.body.remaining).toBe(0);
      expect(all.pending).toEqual([1, 2, 4, 6, 7, 10]);
    } finally {
      b.store.close();
    }
  });
});
