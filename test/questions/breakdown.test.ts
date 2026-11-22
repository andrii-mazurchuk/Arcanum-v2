// Spending breakdown family (S-126): each period transaction classified once by the movement
// classifier of S-128, each counted line converted once at its local day, groups by category,
// merchant, day, week or month, the merchant cap, and total spending, refunds, net spending and
// cashback earned all as sums of those same rounded lines. From src/families/breakdown over the
// money context of src/money/context and the held transactions of src/local/transactions.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { QuestionContext } from '../../src/core/question';
import type { Snapshot, WriteTx } from '../../src/db/index';
import type { Category } from '../../src/local/classifier';
import type { Money } from '../../src/money/money';

const breakdown = () => import('../../src/families/breakdown');
const context = () => import('../../src/money/context');
const transactions = () => import('../../src/local/transactions');
const recordedRates = () => import('../../src/money/recorded-rates');
const registerModule = () => import('../../src/core/register');
const classifierModule = () => import('../../src/local/classifier');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');

const NOW = Date.parse('2026-11-22T12:00:00Z');
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;

interface Holding {
  kind: 'account' | 'jar';
  bankId: string;
  currency: string;
}

interface Tx {
  bankId: string;
  holding: string; // the holding's bankId
  at: string; // ISO instant
  amount: Money;
  category: Category;
  merchant?: string; // default: the description, else 'Test'
  description?: string;
  settled?: boolean; // default true
  cashback?: Money;
}

interface Arrange {
  holdings: Holding[];
  txs: Tx[]; // stored in this order, each at the next position
  transfers?: [outBankId: string, inBankId: string][]; // linked as one own transfer each
  crosses?: [rate: string, recordedAt: string][]; // PLN-in-UAH, under monobank
}

// Opens a fresh in-memory store with monobank and its holdings registered, the transactions stored
// and linked, and the crosses recorded; runs `body` inside one snapshot on the Warsaw calendar.
async function withStore(a: Arrange, body: (snap: Snapshot, cal: Calendar) => void): Promise<void> {
  const { ensureTransactionSchema, insertTransaction, createTransfer } = await transactions();
  const { ensureRateSchema, recordRates } = await recordedRates();
  const { narrowingName } = await registerModule();
  const { openStore, MEMORY_LOCATION } = await db();
  const { openCalendar } = await dates();
  const { parseExactDecimal } = await exact();

  const cal = openCalendar(undefined) as Calendar;
  const store = openStore(MEMORY_LOCATION, [ensureTransactionSchema, ensureRateSchema]);
  const kindOf = new Map(a.holdings.map((h) => [h.bankId, h.kind]));
  const holdingOf = (bankId: string) => narrowingName('monobank', kindOf.get(bankId)!, bankId);
  try {
    store.write((tx: WriteTx) => {
      tx.registerSource(MONO as never);
      for (const h of a.holdings) {
        tx.registerHolding({ kind: h.kind, sourceId: 'monobank', bankId: h.bankId, currency: h.currency } as never);
      }
      for (const t of a.txs) {
        const translated = {
          sourceId: 'monobank',
          bankId: t.bankId,
          holdingId: holdingOf(t.holding),
          occurredAt: Date.parse(t.at),
          amount: t.amount,
          originalAmount: null,
          cashback: t.cashback ?? null,
          settled: t.settled ?? true,
          mcc: null,
          originalMcc: null,
          merchantText: null,
          description: t.description ?? '',
          comment: null,
          counterpart: null,
        };
        const classified = { category: t.category, merchant: t.merchant ?? (t.description || 'Test') };
        insertTransaction(tx, translated as never, tx.claimPosition(), classified as never);
      }
      for (const [outId, inId] of a.transfers ?? []) {
        const out = a.txs.find((t) => t.bankId === outId)!;
        const inn = a.txs.find((t) => t.bankId === inId)!;
        createTransfer(tx, holdingOf(out.holding), holdingOf(inn.holding), 1, [
          { sourceId: 'monobank', bankId: outId },
          { sourceId: 'monobank', bankId: inId },
        ]);
      }
      for (const [rate, recordedAt] of a.crosses ?? []) {
        const res = recordRates(
          tx,
          'monobank',
          [{ pair: { base: 'PLN', quote: 'UAH' }, figures: { kind: 'cross', rate: parseExactDecimal(rate)! } }],
          Date.parse(recordedAt),
        );
        expect(res.added).toBe(1);
      }
    });
    store.readSnapshot((snap) => body(snap, cal));
  } finally {
    store.close();
  }
}

// A hand-built question context over the whole register; a fresh object on every call. Takes
// resolveScope from the register module, already imported, so that it can run inside the
// synchronous snapshot body.
const ctxFor = (
  resolveScope: (reg: any, narrowing: string | undefined) => unknown,
  snap: Snapshot,
  cal: Calendar,
  display: string,
  period: string,
  options: Record<string, unknown>,
): QuestionContext => {
  const reg = snap.register();
  return {
    snapshot: snap,
    now: NOW,
    settings: { timeZone: undefined, sources: ['monobank'] },
    calendar: cal,
    displayCurrency: display,
    position: snap.position(),
    register: reg,
    scope: resolveScope(reg, undefined),
    period: cal.resolvePeriod(period, NOW),
    asker: 'command_line',
    options,
  } as unknown as QuestionContext;
};

describe('families/breakdown', () => {
  test('worked case and merchant cap', async () => {
    const { createBreakdownFamily } = await breakdown();
    const { createMoneyPart } = await context();
    const { resolveScope } = await registerModule();
    const { CATEGORIES, UNCATEGORIZED } = await classifierModule();
    const { money } = await moneyModule();

    const G = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
    const C = CATEGORIES.find((c) => c === 'Taxi & Rideshare') as Category;
    const U = UNCATEGORIZED;
    const uah = (minor: bigint) => money(minor, 'UAH');
    const at = (time: string) => `2026-11-10T${time}Z`;
    const PERIOD = '2026-11-01..2026-11-30';

    // Arrange A.
    const familyA = createBreakdownFamily(createMoneyPart([MONO] as never));
    await withStore(
      {
        holdings: [
          { kind: 'account', bankId: 'card', currency: 'UAH' },
          { kind: 'jar', bankId: 'jar', currency: 'UAH' },
        ],
        txs: [
          { bankId: 's1', holding: 'card', at: at('08:00:00'), amount: uah(-10000n), category: G, merchant: 'Silpo' },
          {
            bankId: 's2',
            holding: 'card',
            at: at('09:00:00'),
            amount: uah(-5000n),
            category: G,
            merchant: 'Silpo',
            settled: false,
          },
          { bankId: 'u1', holding: 'card', at: at('10:00:00'), amount: uah(-20000n), category: C, merchant: 'Uber' },
          { bankId: 'r1', holding: 'card', at: at('11:00:00'), amount: uah(3000n), category: G, description: 'refund' },
          {
            bankId: 'c1',
            holding: 'card',
            at: at('12:00:00'),
            amount: uah(1550n),
            category: U,
            description: 'Кешбек',
            cashback: uah(1550n),
          },
          { bankId: 'o1', holding: 'card', at: at('13:00:00'), amount: uah(-50000n), category: U },
          { bankId: 'o2', holding: 'jar', at: at('13:00:30'), amount: uah(50000n), category: U },
          { bankId: 'i1', holding: 'card', at: at('16:00:00'), amount: uah(500000n), category: U, description: 'salary' },
        ],
        transfers: [['o1', 'o2']],
      },
      (snap, cal) => {
        const outM = familyA.compute(ctxFor(resolveScope, snap, cal, 'UAH', PERIOD, { grouping: 'merchant' })) as any;
        expect(outM.kind).toBe('body');
        const m = outM.body;
        expect(m.grouping).toBe('merchant');
        // Catches (a): the pending hold left out gives Silpo 10000 with 1 visit.
        expect(m.groups).toEqual([
          { key: 'Uber', spending: uah(20000n), count: 1 },
          { key: 'Silpo', spending: uah(15000n), count: 2 },
        ]);
        expect(m.merchantCap).toBe(10);
        expect(m.groupsOmitted).toBe(0);
        // Catches (a) 30000 and (b) the own transfer as spending, 85000.
        expect(m.totalSpending).toEqual(uah(35000n));
        // Catches (c): cashback counted as a refund gives 4550 and 30450.
        expect(m.refundsTotal).toEqual(uah(3000n));
        expect(m.netSpending).toEqual(uah(32000n));
        // Catches (d): only the cashback field of the one transaction reporting it.
        expect(m.cashbackEarned).toEqual(uah(1550n));
        expect(m.notConverted).toEqual([]);

        const outC = familyA.compute(ctxFor(resolveScope, snap, cal, 'UAH', PERIOD, {})) as any;
        expect(outC.kind).toBe('body');
        const c = outC.body;
        expect(c.grouping).toBe('category');
        expect(c.groups).toEqual([
          { key: C, spending: uah(20000n), count: 1 },
          { key: G, spending: uah(15000n), count: 2 },
        ]);
        expect(c.merchantCap).toBeNull();
        expect(c.groupsOmitted).toBe(0);
        expect(c.totalSpending).toEqual(uah(35000n));
        expect(c.refundsTotal).toEqual(uah(3000n));
        expect(c.netSpending).toEqual(uah(32000n));
        expect(c.cashbackEarned).toEqual(uah(1550n));
        expect(c.notConverted).toEqual([]);
      },
    );

    // Arrange B: the cap, with a tie at the top.
    const familyB = createBreakdownFamily(createMoneyPart([MONO] as never));
    await withStore(
      {
        holdings: [{ kind: 'account', bankId: 'card', currency: 'UAH' }],
        txs: [
          { bankId: 'b1', holding: 'card', at: at('08:00:00'), amount: uah(-7000n), category: G, merchant: 'Novus' },
          { bankId: 'b2', holding: 'card', at: at('09:00:00'), amount: uah(-7000n), category: G, merchant: 'ATB' },
          { bankId: 'b3', holding: 'card', at: at('10:00:00'), amount: uah(-1000n), category: G, merchant: 'Lidl' },
        ],
      },
      (snap, cal) => {
        const out = familyB.compute(
          ctxFor(resolveScope, snap, cal, 'UAH', PERIOD, { grouping: 'merchant', merchantCap: 2 }),
        ) as any;
        expect(out.kind).toBe('body');
        const b = out.body;
        // Catches (f): ties by insertion put 'Novus' first.
        expect(b.groups).toEqual([
          { key: 'ATB', spending: uah(7000n), count: 1 },
          { key: 'Novus', spending: uah(7000n), count: 1 },
        ]);
        expect(b.merchantCap).toBe(2);
        expect(b.groupsOmitted).toBe(1);
        // Catches (e): summed over the capped groups only gives 14000.
        expect(b.totalSpending).toEqual(uah(15000n));
      },
    );
  });

  test('time groupings in Warsaw', async () => {
    const { createBreakdownFamily } = await breakdown();
    const { createMoneyPart } = await context();
    const { resolveScope } = await registerModule();
    const { CATEGORIES } = await classifierModule();
    const { money } = await moneyModule();

    const G = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
    const uah = (minor: bigint) => money(minor, 'UAH');
    const PERIOD = '2026-10-01..2026-11-30';
    const family = createBreakdownFamily(createMoneyPart([MONO] as never));

    await withStore(
      {
        holdings: [{ kind: 'account', bankId: 'card', currency: 'UAH' }],
        txs: [
          // Warsaw Mon 2026-11-02 00:30.
          { bankId: 't1', holding: 'card', at: '2026-11-01T23:30:00Z', amount: uah(-10000n), category: G },
          // Warsaw Mon 2026-11-02 11:00.
          { bankId: 't2', holding: 'card', at: '2026-11-02T10:00:00Z', amount: uah(-5000n), category: G },
          // Warsaw Sun 2026-11-01 23:30.
          { bankId: 't3', holding: 'card', at: '2026-11-01T22:30:00Z', amount: uah(-2000n), category: G },
          // Warsaw Sun 2026-11-01 00:30.
          { bankId: 't4', holding: 'card', at: '2026-10-31T23:30:00Z', amount: uah(-1000n), category: G },
        ],
      },
      (snap, cal) => {
        const run = (options: Record<string, unknown>) =>
          family.compute(ctxFor(resolveScope, snap, cal, 'UAH', PERIOD, options)) as any;
        const bodyOf = (grouping: string) => {
          const out = run({ grouping });
          expect(out.kind).toBe('body');
          expect(out.body.grouping).toBe(grouping);
          expect(out.body.totalSpending).toEqual(uah(18000n));
          expect(out.body.merchantCap).toBeNull();
          expect(out.body.groupsOmitted).toBe(0);
          return out.body;
        };

        // Catches (a) UTC days and (d) ordering by spending.
        expect(bodyOf('day').groups).toEqual([
          { key: '2026-11-01', spending: uah(3000n), count: 2 },
          { key: '2026-11-02', spending: uah(15000n), count: 2 },
        ]);
        // Catches (c): Sunday-start weeks key t3 and t4 to '2026-11-01'.
        expect(bodyOf('week').groups).toEqual([
          { key: '2026-10-26', spending: uah(3000n), count: 2 },
          { key: '2026-11-02', spending: uah(15000n), count: 2 },
        ]);
        // Catches (b): UTC months put t4 in '2026-10'.
        expect(bodyOf('month').groups).toEqual([{ key: '2026-11', spending: uah(18000n), count: 4 }]);

        const refusals: [Record<string, unknown>, string][] = [
          [{ grouping: 'Day' }, 'grouping'],
          [{ grouping: 'merchant', merchantCap: 2.5 }, 'merchantCap'],
          [{ grouping: 'merchant', merchantCap: 0 }, 'merchantCap'],
          [{ foo: 1 }, 'foo'],
        ];
        refusals.forEach(([options, subject], i) => {
          const out = run(options);
          expect([i + 1, out.kind, out.reason, out.subject]).toEqual([i + 1, 'refused', 'bad_option', subject]);
        });
      },
    );
  });

  test('per-line conversion', async () => {
    const { createBreakdownFamily } = await breakdown();
    const { createMoneyPart } = await context();
    const { resolveScope } = await registerModule();
    const { CATEGORIES, UNCATEGORIZED } = await classifierModule();
    const { money } = await moneyModule();

    const G = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
    const C = CATEGORIES.find((c) => c === 'Taxi & Rideshare') as Category;
    const U = UNCATEGORIZED;
    const uah = (minor: bigint) => money(minor, 'UAH');
    const pln = (minor: bigint) => money(minor, 'PLN');
    const at = (time: string) => `2026-11-05T${time}Z`;
    const family = createBreakdownFamily(createMoneyPart([MONO] as never));

    await withStore(
      {
        holdings: [
          { kind: 'account', bankId: 'card', currency: 'UAH' },
          { kind: 'account', bankId: 'gbp', currency: 'GBP' },
        ],
        txs: [
          { bankId: 'g1', holding: 'card', at: at('09:10:00'), amount: uah(-10005n), category: G },
          { bankId: 'g2', holding: 'card', at: at('09:20:00'), amount: uah(-10005n), category: G },
          {
            bankId: 'r1',
            holding: 'card',
            at: at('09:30:00'),
            amount: uah(10005n),
            category: G,
            description: 'Повернення',
          },
          { bankId: 'c1', holding: 'card', at: at('09:40:00'), amount: uah(1550n), category: U, cashback: uah(1550n) },
          { bankId: 'x1', holding: 'gbp', at: at('09:50:00'), amount: money(-1000n, 'GBP'), category: C },
        ],
        crosses: [['10.00', '2026-11-05T08:00:00Z']],
      },
      (snap, cal) => {
        const out = family.compute(
          ctxFor(resolveScope, snap, cal, 'PLN', '2026-11-01..2026-11-30', { grouping: 'category' }),
        ) as any;
        expect(out.kind).toBe('body');
        const body = out.body;
        // 10005 / 10.00 = 1000.5 -> 1001 per line, half away from zero. Catches (a) the summed group
        // converted, 2001, (b) truncation or half-to-even, 2000, and (d) the all-unconverted group C
        // dropped.
        expect(body.groups).toEqual([
          { key: G, spending: pln(2002n), count: 2 },
          { key: C, spending: pln(0n), count: 1 },
        ]);
        // Catches (c): the GBP line counted in its own currency gives 3002.
        expect(body.totalSpending).toEqual(pln(2002n));
        expect(body.refundsTotal).toEqual(pln(1001n));
        expect(body.netSpending).toEqual(pln(1001n));
        expect(body.cashbackEarned).toEqual(pln(155n));
        expect(body.notConverted.length).toBe(1);
        const line = body.notConverted[0];
        expect(line).toMatchObject({ kind: 'spending', key: C, pair: { from: 'GBP', to: 'PLN' } });
        expect(line.original.currency).toBe('GBP');
        const minor: bigint = line.original.minor;
        expect(minor < 0n ? -minor : minor).toBe(1000n);
      },
    );
  });
});
