// Trends (S-159): the complete window months oldest first plus the month in progress, all from one
// period ledger; per month the spending by category, income, net savings and savings rate, and the
// tier flags against its own 3 months before (the month in progress included); per category the
// average over complete months only and the direction from its first window month with spending
// to the last complete month; the month count and unknown options refused before any read. From
// src/analysis/trends over the period ledger of src/analytics/ledger, the periods of
// src/analytics/periods and the money part of src/money/context.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { QuestionContext, Settings } from '../../src/core/question';
import type { WriteTx } from '../../src/db/index';
import type { Category } from '../../src/local/classifier';
import type { Money } from '../../src/money/money';

const trends = () => import('../../src/analysis/trends');
const context = () => import('../../src/money/context');
const compose = () => import('../../src/core/compose');
const recordedRates = () => import('../../src/money/recorded-rates');
const transactions = () => import('../../src/local/transactions');
const classifierModule = () => import('../../src/local/classifier');
const movement = () => import('../../src/families/movement');
const registerModule = () => import('../../src/core/register');
const primitives = () => import('../../src/core/primitives');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const moneyModule = () => import('../../src/money/money');

const FAMILY = 'trends';
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const ZONE = 'Europe/Warsaw';
const NOW = Date.parse('2026-11-21T12:00:00+01:00');

const settings = (): Settings => ({ timeZone: ZONE, sources: [] });
const render = (a: unknown) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

// A settled line on account A, stored at the next position.
interface Tx {
  bankId: string;
  at: number;
  amount: Money;
  category: Category;
  description?: string;
}

// Composes the core at NOW over a fresh in-memory store with the trends family built over a money
// part of Monobank, registers Monobank and its UAH account A and stores the lines; no rate is
// recorded. Returns an asker for 'trends' in UAH, the family, the money part and the closer.
async function composed(txs: Tx[]) {
  const { createTrendsFamily } = await trends();
  const { createMoneyPart } = await context();
  const { composeAnswering } = await compose();
  const { ensureRateSchema } = await recordedRates();
  const { ensureTransactionSchema, insertTransaction } = await transactions();
  const { narrowingName } = await registerModule();
  const { MEMORY_LOCATION } = await db();

  const part = createMoneyPart([MONO] as never);
  const family = createTrendsFamily(part);
  const c = composeAnswering({
    location: MEMORY_LOCATION,
    schemas: [ensureRateSchema, ensureTransactionSchema],
    now: () => NOW,
    settings,
    families: [family as never],
    contributors: [part.ratesUsedContributor],
  });
  c.store.write((tx: WriteTx) => {
    tx.registerSource(MONO as never);
    tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'A', currency: 'UAH' } as never);
    for (const t of txs) {
      insertTransaction(
        tx,
        {
          sourceId: 'monobank',
          bankId: t.bankId,
          holdingId: narrowingName('monobank', 'account', 'A'),
          occurredAt: t.at,
          amount: t.amount,
          originalAmount: null,
          cashback: null,
          settled: true,
          mcc: null,
          originalMcc: null,
          merchantText: null,
          description: t.description ?? `${t.bankId} description`,
          comment: null,
          counterpart: null,
        } as never,
        tx.claimPosition(),
        { category: t.category, merchant: 'Shop' } as never,
      );
    }
  });
  const ask = async (options: Record<string, unknown>): Promise<any> =>
    (
      await c.core.serve(
        { asker: 'command_line', family: FAMILY, displayCurrency: 'UAH', options },
        render,
        channel(),
      )
    ).answer;
  return { family, part, ask, store: c.store, close: () => c.store.close() };
}

// The body of an answered envelope, failing loudly on anything else.
function bodyOf(answer: any): any {
  expect(answer.kind).toBe('envelope');
  expect(answer.outcome.kind).toBe('answered');
  return answer.outcome.body;
}

const categoryOf = async (name: string): Promise<Category> => {
  const { CATEGORIES } = await classifierModule();
  const c = CATEGORIES.find((k) => k === name);
  expect(c).toBeDefined();
  return c as Category;
};

describe('analysis/trends', () => {
  test('trends: worked window', async () => {
    const { CATEGORIES, UNCATEGORIZED } = await classifierModule();
    const { classifyMovement } = await movement();
    const { money } = await moneyModule();
    const G = await categoryOf('Groceries & Supermarkets');
    const F = await categoryOf('Fast Food');
    const S = await categoryOf('Shopping');
    const E = await categoryOf('Entertainment');
    const R = await categoryOf('Restaurants & Cafes');
    const uah = (minor: bigint) => money(minor, 'UAH');

    // The 15th of each month at 12:00 local (Warsaw is +02:00 up to 2026-10-25); November's on
    // the 20th.
    const at: Record<string, number> = {
      '05': Date.parse('2026-05-15T12:00:00+02:00'),
      '08': Date.parse('2026-08-15T12:00:00+02:00'),
      '09': Date.parse('2026-09-15T12:00:00+02:00'),
      '10': Date.parse('2026-10-15T12:00:00+02:00'),
      '11': Date.parse('2026-11-20T12:00:00+01:00'),
    };
    const spend = (category: Category, month: string, minor: bigint): Tx => ({
      bankId: `${category}-${month}`,
      at: at[month]!,
      amount: uah(-minor),
      category,
    });
    const salary: Tx = {
      bankId: 'salary',
      at: Date.parse('2026-10-25T12:00:00+01:00'),
      amount: uah(100000n),
      category: UNCATEGORIZED,
      description: 'Salary',
    };

    // Precondition: the salary line is income by the shared movement classifier.
    expect(
      classifyMovement({
        amount: salary.amount,
        settled: true,
        category: salary.category,
        description: salary.description!,
        transfer: null,
        cashback: null,
      }),
    ).toBe('income');

    const s = await composed([
      spend(G, '08', 10000n),
      spend(G, '09', 13000n),
      spend(G, '10', 10400n),
      spend(F, '08', 10000n),
      spend(F, '09', 13000n),
      spend(F, '10', 9400n),
      spend(S, '09', 10000n),
      spend(S, '10', 10200n),
      spend(E, '05', 30000n),
      spend(E, '08', 25000n),
      spend(R, '08', 1000n),
      spend(R, '09', 1000n),
      spend(R, '10', 1000n),
      spend(R, '11', 3000n),
      salary,
    ]);
    try {
      const body = bodyOf(await s.ask({}));

      // Catches a window of 3 months including the month in progress (['2026-09', ..., '2026-11']).
      expect(body.months.map((m: any) => m.period.label)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
      expect(body.months.map((m: any) => m.period.partial)).toEqual([false, false, false, true]);

      // Catches n counting only baseline months with spending: n = 1 judges 25000 against 30000
      // and gives no flag. With n = 3: 25000 x 3 = 75000 >= 2 x 30000, < 3 x 30000, so high.
      expect(body.months[0].flags).toEqual([
        { category: E, tier: 'high', spending: uah(25000n), baselineAverage: uah(10000n) },
      ]);
      // Catches the month in progress left unflagged: against August to October,
      // 3000 x 3 = 9000 >= 3 x 3000, a spike.
      expect(body.months[3].flags).toEqual([
        { category: R, tier: 'spike', spending: uah(3000n), baselineAverage: uah(1000n) },
      ]);

      // Catches net savings or the rate from net spending of another month, or a rate over
      // spending instead of income ('222.6%').
      const oct = body.months[2];
      expect(oct.spending).toEqual(uah(31000n));
      expect(oct.income).toEqual(uah(100000n));
      expect(oct.netSavings).toEqual(uah(69000n));
      expect(oct.savingsRate.tenths).toBe(690n);
      expect(oct.savingsRate.text).toBe('69.0%');

      // Catches a month with no income given netSavings 0 or a rate of '-100.0%'.
      const sep = body.months[1];
      expect(sep.income).toEqual(uah(0n));
      expect(sep.spending).toEqual(uah(37000n));
      expect(sep.netSavings).toEqual(uah(-37000n));
      expect(sep.savingsRate.text).toBe('0.0%');

      // Catches: Shopping's direction taken from August (0) instead of its first month with
      // spending (10000 then 10200, within 5%: stable); Restaurants & Cafes with November as an
      // average member (1500) or as the direction end (rising); Entertainment averaged over its
      // months with spending only (25000 instead of 25000 / 3 = 8333); Fast Food
      // 9400 against 10000 is below 95%, falling.
      const expected = [
        { category: G, average: uah(11133n), direction: 'stable' },
        { category: F, average: uah(10800n), direction: 'falling' },
        { category: S, average: uah(6733n), direction: 'stable' },
        { category: E, average: uah(8333n), direction: 'falling' },
        { category: R, average: uah(1000n), direction: 'stable' },
      ].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
      expect(body.categories).toEqual(expected);
    } finally {
      s.close();
    }
  });

  test('trends: refusals before any read', async () => {
    const { createTrendsFamily } = await trends();
    const { createMoneyPart } = await context();
    const { refuse } = await primitives();
    const { resolveScope } = await registerModule();
    const { openCalendar } = await dates();

    const part = createMoneyPart([MONO] as never);
    const family = createTrendsFamily(part);

    // The store must not be touched: any property access on its db throws.
    const poisoned = new Proxy(
      {},
      {
        get(_t, key) {
          throw new Error(`the store was read (${String(key)})`);
        },
        has(_t, key) {
          throw new Error(`the store was read (${String(key)})`);
        },
      },
    );

    const e = await composed([]);
    try {
      const computeBad = (options: Record<string, unknown>): any =>
        e.store.readSnapshot((snap) => {
          const cal = openCalendar(ZONE) as Calendar;
          const reg = snap.register();
          const ctxBad = {
            snapshot: { db: poisoned },
            now: NOW,
            settings: { timeZone: ZONE, sources: ['monobank'] },
            calendar: cal,
            displayCurrency: 'UAH',
            position: snap.position(),
            register: reg,
            scope: resolveScope(reg, undefined),
            period: null,
            asker: 'command_line',
            options,
          } as unknown as QuestionContext;
          let out: any;
          expect(() => {
            out = family.compute(ctxBad);
          }).not.toThrow();
          return out;
        });

      // Catches the count checked after the ledger is built: the proxy would throw first.
      expect(computeBad({ months: 25 })).toEqual(
        refuse('bad_option', 'months', 'The number of months must be a whole number from 1 to 24; "25" is not.', '25'),
      );
      // Catches a numeric string accepted as a count.
      const six = computeBad({ months: '6' });
      expect([six.kind, six.subject, six.value]).toEqual(['refused', 'months', '6']);
      expect(six.message).toContain('6');
      // Catches an unknown option ignored, or refused only after reading.
      const depth = computeBad({ depth: 1 });
      expect([depth.kind, depth.reason, depth.subject]).toEqual(['refused', 'bad_option', 'depth']);

      // Catches a window of 24 months including the month in progress: 24 entries from '2024-12'.
      const body = bodyOf(await e.ask({ months: 24 }));
      expect(body.months.length).toBe(25);
      expect(body.months[0].period.label).toBe('2024-11');
      expect(body.months[0].period.partial).toBe(false);
      expect(body.months[24].period.label).toBe('2026-11');
      expect(body.months[24].period.partial).toBe(true);
      for (const m of body.months) expect(m.flags).toEqual([]);
      expect(body.categories).toEqual([]);

      expect(family.name).toBe(FAMILY);
      expect(family.period).toBe('none');
      expect(family.movesPoint).toBe(false);
      expect(family.capability).toBeUndefined();
    } finally {
      e.close();
    }
  });
});
