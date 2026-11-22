// Listed transaction row (S-147): convertRow converts the amount the account moved at the
// transaction's Warsaw day, copies every other field from the stored transaction, marks own
// transfers and unconverted pairs, and never calls the money context's show. From
// src/families/rows over the money context of src/money/context.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { QuestionContext } from '../../src/core/question';
import type { Snapshot, WriteTx } from '../../src/db/index';
import type { Category } from '../../src/local/classifier';
import type { StoredTransaction } from '../../src/local/transactions';
import type { Money } from '../../src/money/money';

const rows = () => import('../../src/families/rows');
const context = () => import('../../src/money/context');
const recordedRates = () => import('../../src/money/recorded-rates');
const transactions = () => import('../../src/local/transactions');
const classifierModule = () => import('../../src/local/classifier');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');

const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const NOW = Date.parse('2026-11-21T12:00:00Z');
const T1_AT = Date.parse('2026-11-01T23:30:00Z'); // Warsaw 2026-11-02 00:30
const T2_AT = Date.parse('2026-11-02T09:00:00Z');
const T3_AT = Date.parse('2026-11-02T09:05:00Z');

// A translated transaction with no cashback, mcc, comment or counterpart unless stated.
const translated = (
  bankId: string,
  holdingId: string,
  occurredAt: number,
  amount: Money,
  originalAmount: Money | null = null,
) => ({
  sourceId: 'monobank',
  bankId,
  holdingId,
  occurredAt,
  amount,
  originalAmount,
  cashback: null,
  settled: true,
  mcc: null,
  originalMcc: null,
  merchantText: null,
  description: `${bankId} description`,
  comment: null,
  counterpart: null,
});

interface Held {
  t1: StoredTransaction;
  t2: StoredTransaction;
  t3: StoredTransaction;
}

// Opens a fresh in-memory store holding, for 'monobank' only, PLN-in-UAH cross 10.00 recorded at
// 2026-11-01 08:00Z and cross 8.00 recorded at 2026-11-02 08:00Z (no GBP rate), and t1-t3 on the
// UAH account 'card', the UAH jar 'jar' and the GBP account 'gbp'; t2 is an own transfer out of
// 'card' into 'jar'. Runs `body` inside one snapshot on the Warsaw calendar.
async function withStore(body: (snap: Snapshot, cal: Calendar, held: Held, G: Category) => void): Promise<void> {
  const { ensureRateSchema, recordRates } = await recordedRates();
  const { ensureTransactionSchema, insertTransaction, createTransfer, getTransaction } = await transactions();
  const { CATEGORIES, UNCATEGORIZED } = await classifierModule();
  const { openStore, MEMORY_LOCATION } = await db();
  const { openCalendar } = await dates();
  const { parseExactDecimal } = await exact();
  const { money } = await moneyModule();

  const G = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
  const cal = openCalendar(undefined) as Calendar;
  const store = openStore(MEMORY_LOCATION, [ensureRateSchema, ensureTransactionSchema]);
  try {
    store.write((tx: WriteTx) => {
      const cross = (rate: string, recordedAt: string) =>
        recordRates(
          tx,
          'monobank',
          [{ pair: { base: 'PLN', quote: 'UAH' }, figures: { kind: 'cross', rate: parseExactDecimal(rate)! } }],
          Date.parse(recordedAt),
        );
      expect(cross('10.00', '2026-11-01T08:00:00Z').added).toBe(1);
      expect(cross('8.00', '2026-11-02T08:00:00Z').added).toBe(1);

      insertTransaction(
        tx,
        translated('t1', 'card', T1_AT, money(-41200n, 'UAH'), money(-1000n, 'USD')) as never,
        tx.claimPosition(),
        { category: G, merchant: 'Amazon' } as never,
      );
      insertTransaction(
        tx,
        translated('t2', 'card', T2_AT, money(-50000n, 'UAH')) as never,
        tx.claimPosition(),
        { category: UNCATEGORIZED, merchant: 'Jar' } as never,
      );
      insertTransaction(
        tx,
        translated('t3', 'gbp', T3_AT, money(-1000n, 'GBP')) as never,
        tx.claimPosition(),
        { category: UNCATEGORIZED, merchant: 'Shop' } as never,
      );
      createTransfer(tx, 'card', 'jar', 1, [{ sourceId: 'monobank', bankId: 't2' }]);
    });

    store.readSnapshot((snap) => {
      const get = (bankId: string) => getTransaction(snap.db, { sourceId: 'monobank', bankId })!;
      body(snap, cal, { t1: get('t1'), t2: get('t2'), t3: get('t3') }, G);
    });
  } finally {
    store.close();
  }
}

// A hand-built question context displaying `display`; a fresh object on every call.
const ctxFor = (snap: Snapshot, cal: Calendar, display: string): QuestionContext =>
  ({
    snapshot: snap,
    now: NOW,
    settings: { timeZone: undefined, sources: [] },
    calendar: cal,
    displayCurrency: display,
    position: 0,
    register: {},
    scope: { narrowing: { kind: 'all' }, sources: [], holdings: new Set() },
    period: null,
    asker: 'command_line',
    options: {},
  }) as unknown as QuestionContext;

describe('families/rows', () => {
  test('convertRow', async () => {
    const { convertRow } = await rows();
    const { createMoneyPart } = await context();
    const { money } = await moneyModule();

    const part = createMoneyPart([MONO]);
    let showCalls = 0;
    // The money context with show shadowed by a counter; everything else is the real context's.
    const counted = (m: any) =>
      Object.create(m, {
        show: {
          value: (...args: unknown[]) => {
            showCalls++;
            return m.show(...args);
          },
        },
      });

    await withStore((snap, cal, { t1, t2, t3 }, G) => {
      const pln = ctxFor(snap, cal, 'PLN');
      const uah = ctxFor(snap, cal, 'UAH');
      const mPln = counted(part.moneyFor(pln));
      const mUah = counted(part.moneyFor(uah));

      // t1 is late on 1 November in UTC but already 2 November in Warsaw.
      expect(cal.localDay(t1.occurredAt)).toBe('2026-11-02');

      // At the Warsaw day's cross 8.00: 41200 / 8.00 = 5150, not 4120 at the UTC day's 10.00; and
      // from the amount the account moved, not the USD original, which has no rate here.
      const r1 = convertRow(pln, mPln, t1);
      expect(r1.result.kind).toBe('converted');
      expect(r1.row).toEqual({
        sourceId: t1.sourceId,
        bankId: t1.bankId,
        holdingId: 'card',
        occurredAt: t1.occurredAt,
        localDateTime: cal.localDateTime(t1.occurredAt),
        amount: money(-41200n, 'UAH'),
        originalAmount: money(-1000n, 'USD'),
        shown: money(-5150n, 'PLN'),
        notConverted: null,
        settled: t1.settled,
        category: G,
        merchant: 'Amazon',
        description: t1.description,
        ownTransfer: null,
      });
      expect(r1.row.category).toBe(t1.category);
      expect(r1.row.merchant).toBe(t1.merchant);

      // Display UAH: the account's own currency, so the figure is unchanged.
      const u1 = convertRow(uah, mUah, t1);
      expect(u1.result.kind).toBe('same');
      expect(u1.row.shown).toEqual(money(-41200n, 'UAH'));
      expect(u1.row.notConverted).toBeNull();

      // An own transfer keeps its direction and the holding on the other end.
      const r2 = convertRow(pln, mPln, t2);
      expect(r2.row.ownTransfer).toMatchObject({ direction: 'out', otherHolding: 'jar' });

      // No GBP rate: no figure, and the pair that could not be converted.
      const r3 = convertRow(pln, mPln, t3);
      expect(r3.result.kind).toBe('unconverted');
      expect(r3.row.shown).toBeNull();
      expect(r3.row.notConverted).toEqual({ from: 'GBP', to: 'PLN' });

      // The family shows the results of the rows it lists; convertRow shows nothing itself.
      expect(showCalls).toBe(0);
    });
  });
});
