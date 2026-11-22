// Weekly report (S-163): one ledger over the week and the 4 weeks before it; spending, cashback and
// the top 5 merchants from the breakdown, foreign spending and balances from their own families
// through section contexts; the comparison with the immediately previous week, the per-day average
// over the week's local days, the top day, the tiers over 4 baseline weeks with empty weeks counted
// and the jar top-ups by the jars capability split; the report period checked and option keys
// refused as answers. From src/analysis/weekly-report over the periods of src/analytics/periods,
// the sections of src/analytics/sections and the money part of src/money/context.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Settings } from '../../src/core/question';
import type { WriteTx } from '../../src/db/index';
import type { Category } from '../../src/local/classifier';
import type { Money } from '../../src/money/money';

const weeklyReport = () => import('../../src/analysis/weekly-report');
const balance = () => import('../../src/families/balance');
const context = () => import('../../src/money/context');
const compose = () => import('../../src/core/compose');
const recordedRates = () => import('../../src/money/recorded-rates');
const transactions = () => import('../../src/local/transactions');
const balancesModule = () => import('../../src/sync/balances');
const classifierModule = () => import('../../src/local/classifier');
const registerModule = () => import('../../src/core/register');
const primitives = () => import('../../src/core/primitives');
const db = () => import('../../src/db/index');
const moneyModule = () => import('../../src/money/money');

const FAMILY = 'weekly_report';
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const S2 = { id: 's2', capabilities: [] } as const; // declares no 'jars' capability
const ZONE = 'Europe/Warsaw';
const NOW = Date.parse('2026-11-21T12:00:00+01:00');

const settings = (): Settings => ({ timeZone: ZONE, sources: ['monobank', 's2'] });
const render = (a: unknown) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

// A settled line on Monobank account A, stored at the next position.
interface Tx {
  bankId: string;
  at: string; // ISO instant
  amount: Money;
  category: Category;
  merchant: string;
}

interface Arrange {
  sources: readonly { id: string; capabilities: readonly string[] }[];
  s2Account?: boolean; // registers the second source's UAH account X
  txs: Tx[];
  balanceA?: Money; // reported by monobank for A at 2026-11-20T08:00:00+01:00
}

// Composes the core at NOW over a fresh in-memory store with the weekly report and the balance
// family, both over one money part and one conventions map; registers the sources, Monobank's UAH
// account A (and X when asked), stores the lines and A's balance; no rate is recorded. Returns an
// asker in UAH, the weekly family and the closer.
async function composed(a: Arrange) {
  const { createWeeklyReportFamily } = await weeklyReport();
  const { createBalanceFamily } = await balance();
  const { createMoneyPart } = await context();
  const { composeAnswering } = await compose();
  const { ensureRateSchema } = await recordedRates();
  const { ensureTransactionSchema, insertTransaction } = await transactions();
  const { ensureBalanceSchema, recordBalances } = await balancesModule();
  const { narrowingName } = await registerModule();
  const { MEMORY_LOCATION } = await db();

  const part = createMoneyPart(a.sources as never);
  const conventions = new Map([['monobank', 'includes_credit_limit']]) as never;
  const family = createWeeklyReportFamily(part, conventions);
  const balanceFamily = createBalanceFamily(part, conventions);
  const c = composeAnswering({
    location: MEMORY_LOCATION,
    schemas: [ensureRateSchema, ensureTransactionSchema, ensureBalanceSchema],
    now: () => NOW,
    settings,
    families: [family as never, balanceFamily as never],
    contributors: [part.ratesUsedContributor],
  });
  const A = narrowingName('monobank', 'account', 'A');
  c.store.write((tx: WriteTx) => {
    for (const s of a.sources) tx.registerSource(s as never);
    tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'A', currency: 'UAH' } as never);
    if (a.s2Account) tx.registerHolding({ kind: 'account', sourceId: 's2', bankId: 'X', currency: 'UAH' } as never);
    for (const t of a.txs) {
      insertTransaction(
        tx,
        {
          sourceId: 'monobank',
          bankId: t.bankId,
          holdingId: A,
          occurredAt: Date.parse(t.at),
          amount: t.amount,
          originalAmount: null,
          cashback: null,
          settled: true,
          mcc: null,
          originalMcc: null,
          merchantText: null,
          description: `${t.bankId} description`,
          comment: null,
          counterpart: null,
        } as never,
        tx.claimPosition(),
        { category: t.category, merchant: t.merchant } as never,
      );
    }
    if (a.balanceA !== undefined) {
      const reported = { holdingId: A, balance: a.balanceA, creditLimit: null };
      recordBalances(tx, 'monobank', [reported as never], Date.parse('2026-11-20T08:00:00+01:00'), 'restated');
    }
  });
  const ask = async (
    family: string,
    q: { period?: string; narrowing?: string; options?: Record<string, unknown> } = {},
  ): Promise<any> =>
    (
      await c.core.serve(
        {
          asker: 'command_line',
          family,
          displayCurrency: 'UAH',
          ...(q.period === undefined ? {} : { period: q.period }),
          ...(q.narrowing === undefined ? {} : { narrowing: q.narrowing }),
          options: q.options ?? {},
        },
        render,
        channel(),
      )
    ).answer;
  return { family, ask, close: () => c.store.close() };
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

describe('analysis/weekly-report', () => {
  test('weekly report: worked last week', async () => {
    const { money } = await moneyModule();
    const G = await categoryOf('Groceries & Supermarkets');
    const uah = (minor: bigint) => money(minor, 'UAH');
    const spend = (bankId: string, at: string, minor: bigint, merchant: string): Tx => ({
      bankId,
      at,
      amount: uah(-minor),
      category: G,
      merchant,
    });

    // Baseline weeks on their Wednesday at 12:00 local (Warsaw is +02:00 up to 2026-10-25); the
    // week of 2026-10-19 has no spending.
    const s = await composed({
      sources: [MONO],
      txs: [
        spend('b1', '2026-10-14T12:00:00+02:00', 15000n, 'Base'),
        spend('b3', '2026-10-28T12:00:00+01:00', 20000n, 'Base'),
        spend('b4', '2026-11-04T12:00:00+01:00', 5000n, 'Base'),
        spend('alpha', '2026-11-10T12:00:00+01:00', 10000n, 'Alpha'),
        spend('beta', '2026-11-11T12:00:00+01:00', 6000n, 'Beta'),
        spend('gamma', '2026-11-11T12:00:00+01:00', 5000n, 'Gamma'),
        spend('delta', '2026-11-12T12:00:00+01:00', 4000n, 'Delta'),
        spend('epsilon', '2026-11-12T12:00:00+01:00', 3000n, 'Epsilon'),
        spend('zeta', '2026-11-12T12:00:00+01:00', 2000n, 'Zeta'),
      ],
      balanceA: uah(100000n),
    });
    try {
      const body = bodyOf(await s.ask(FAMILY));

      // The default period is the last complete Monday-to-Sunday week.
      expect(body.week.label).toBe('2026-11-09');
      expect(body.week.partial).toBe(false);
      expect(body.week.lastDay).toBe('2026-11-15');

      // 30000 / 7 = 4285.71. Catches a per-day average over 6 days: 5000.
      expect(body.spending.totalSpending).toEqual(uah(30000n));
      expect(body.averagePerDay).toEqual(uah(4286n));

      // Catches ranking merchants inside the report without the cap: six groups, merchantsOmitted 0.
      expect(body.topMerchants).toEqual([
        { key: 'Alpha', spending: uah(10000n), count: 1 },
        { key: 'Beta', spending: uah(6000n), count: 1 },
        { key: 'Gamma', spending: uah(5000n), count: 1 },
        { key: 'Delta', spending: uah(4000n), count: 1 },
        { key: 'Epsilon', spending: uah(3000n), count: 1 },
      ]);
      expect(body.merchantsOmitted).toBe(1);

      // Catches a top day taken from a single merchant (11-10 at 10000) instead of the day's sum.
      expect(body.topDay).toEqual({ day: '2026-11-11', spending: uah(11000n) });

      // Catches comparing with the first baseline week (2026-10-12): previous 15000, difference 15000.
      expect(body.comparison.current).toEqual(uah(30000n));
      expect(body.comparison.previous).toEqual(uah(5000n));
      expect(body.comparison.difference).toEqual(uah(25000n));
      // The ledger's week sum agrees with the breakdown's over the same lines.
      expect(body.comparison.current).toEqual(body.spending.totalSpending);

      // S = 40000 over n = 4: 30000 x 4 >= 3 x 40000, a spike. Catches n counting only baseline
      // weeks with spending (n = 3): 90000 >= 80000 but < 120000, 'high' instead.
      expect(body.unusuallyHigh).toEqual([
        { category: G, tier: 'spike', spending: uah(30000n), baselineAverage: uah(10000n) },
      ]);

      // Catches a balance section of its own making (an end-of-week reconstruction, or another
      // money context): it is the balance question's own body at the same moment and display.
      const balances = bodyOf(await s.ask('balance'));
      expect(body.balances).toEqual(balances);

      // Monobank offers jars.
      expect(body.jars.notOffering).toEqual([]);
    } finally {
      s.close();
    }
  });

  test('weekly report: partial week, refusals, sources without jars', async () => {
    const { createWeeklyReportFamily } = await weeklyReport();
    const { createMoneyPart } = await context();
    const { refuse } = await primitives();
    const { money } = await moneyModule();
    const G = await categoryOf('Groceries & Supermarkets');
    const uah = (minor: bigint) => money(minor, 'UAH');

    const s = await composed({
      sources: [MONO, S2],
      s2Account: true,
      txs: [{ bankId: 'w', at: '2026-11-17T12:00:00+01:00', amount: uah(-6000n), category: G, merchant: 'Shop' }],
    });
    try {
      // This week so far: Monday 2026-11-16 to now, 6 local days. Catches dividing by 7: 857.
      const thisWeek = bodyOf(await s.ask(FAMILY, { period: 'this-week' }));
      expect(thisWeek.week.label).toBe('2026-11-16');
      expect(thisWeek.week.partial).toBe(true);
      expect(thisWeek.week.until).toBe(NOW);
      expect(thisWeek.averagePerDay).toEqual(uah(1000n));
      expect(thisWeek.spending.totalSpending).toEqual(uah(6000n));

      // A range that is not one Monday-to-Sunday week is refused as the answer.
      expect(await s.ask(FAMILY, { period: 'last-7-days' })).toEqual(
        refuse(
          'bad_period',
          'form',
          'A weekly report covers one Monday-to-Sunday week or this week so far; "last-7-days" is not one.',
          'last-7-days',
        ),
      );

      // Catches a report of zeros for a week not yet begun.
      const future = await s.ask(FAMILY, { period: 'week:2026-11-23' });
      expect([future.kind, future.reason, future.subject]).toEqual(['refused', 'bad_period', 'future']);
      expect(future.message).toContain('week:2026-11-23');

      // Catches an unknown option ignored.
      const opt = await s.ask(FAMILY, { options: { x: 1 } });
      expect([opt.kind, opt.reason, opt.subject]).toEqual(['refused', 'bad_option', 'x']);

      // Catches a source without jars shown as holding no jars: it is named as not offering.
      const narrowed = bodyOf(await s.ask(FAMILY, { period: 'last-week', narrowing: 's2' }));
      expect(narrowed.jars.jars).toEqual([]);
      expect(narrowed.jars.total).toEqual(uah(0n));
      expect(narrowed.jars.notOffering).toEqual(['s2']);
    } finally {
      s.close();
    }

    // The family's declaration.
    const family = createWeeklyReportFamily(createMoneyPart([MONO] as never), new Map() as never);
    expect(family.name).toBe(FAMILY);
    expect(family.period).toBe('optional');
    expect(family.defaultPeriod).toBe('last-week');
    expect(family.movesPoint).toBe(false);
    expect(family.capability).toBeUndefined();
  });
});
