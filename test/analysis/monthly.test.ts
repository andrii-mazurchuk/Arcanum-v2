// Monthly report (S-171): one ledger over the month, its 3 months before, the jar average window and
// the health spans; spending, the top 10 merchants, foreign spending (its share of all spending
// included) and balances from their own families through section contexts; savings figures,
// patterns, health and jar activity from their owning computations over the report month; and the
// report's own comparison with the previous month, per-day average over the month's local days,
// largest transaction, tiers over 3 baseline months and the no-budgets section; the report period
// checked and option keys refused as answers. From src/analysis/monthly-report over the periods of
// src/analytics/periods, the sections of src/analytics/sections and the money part of
// src/money/context.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { Settings } from '../../src/core/question';
import type { WriteTx } from '../../src/db/index';
import type { Category } from '../../src/local/classifier';
import type { Money } from '../../src/money/money';

const monthlyReport = () => import('../../src/analysis/monthly-report');
const healthModule = () => import('../../src/analysis/health');
const patternsModule = () => import('../../src/analysis/patterns');
const reportParts = () => import('../../src/analysis/report-parts');
const balance = () => import('../../src/families/balance');
const breakdown = () => import('../../src/families/breakdown');
const foreign = () => import('../../src/families/foreign');
const context = () => import('../../src/money/context');
const compose = () => import('../../src/core/compose');
const recordedRates = () => import('../../src/money/recorded-rates');
const transactions = () => import('../../src/local/transactions');
const balancesModule = () => import('../../src/sync/balances');
const classifierModule = () => import('../../src/local/classifier');
const registerModule = () => import('../../src/core/register');
const primitives = () => import('../../src/core/primitives');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const moneyModule = () => import('../../src/money/money');

const FAMILY = 'monthly_report';
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const ZONE = 'Europe/Warsaw';
const NOW = Date.parse('2026-11-21T12:00:00+01:00');
const REPORTED_AT = '2026-11-20T08:00:00+01:00';

const settings = (): Settings => ({ timeZone: ZONE, sources: ['monobank'] });
const render = (a: unknown) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

// A settled monobank line, stored at the next position.
interface Tx {
  bankId: string;
  holding: string; // the monobank holding's bankId
  at: string; // ISO instant
  amount: Money;
  originalAmount?: Money; // a foreign purchase's amount in its own currency
  category?: Category; // default Uncategorized
  description?: string;
}

interface Held {
  jar: string; // the monobank jar's bankId
  balance: Money;
  goal: Money | null;
}

interface Arrange {
  holdings: { kind: 'account' | 'jar'; bankId: string; currency: string }[];
  txs: Tx[]; // stored in this order, each at the next position, in one write
  transfers?: [outBankId: string, inBankId: string][]; // linked as one own transfer each
  balances?: Held[]; // reported by monobank at REPORTED_AT
}

// Composes the core at NOW over a fresh in-memory store with the monthly report and the families
// it must agree with (balance, health, patterns, breakdown, foreign spending), all over one money
// part and one conventions map; registers monobank and its holdings, stores the lines settled and
// linked, and the held balances; no rate is recorded. Returns an asker in UAH and the closer.
async function composed(a: Arrange) {
  const { createMonthlyReportFamily } = await monthlyReport();
  const { createHealthFamily } = await healthModule();
  const { createPatternsFamily } = await patternsModule();
  const { createBalanceFamily } = await balance();
  const { createBreakdownFamily } = await breakdown();
  const { createForeignSpendingFamily } = await foreign();
  const { createMoneyPart } = await context();
  const { composeAnswering } = await compose();
  const { ensureRateSchema } = await recordedRates();
  const { ensureTransactionSchema, insertTransaction, createTransfer } = await transactions();
  const { ensureBalanceSchema, recordBalances } = await balancesModule();
  const { narrowingName } = await registerModule();
  const { UNCATEGORIZED } = await classifierModule();
  const { MEMORY_LOCATION } = await db();

  const part = createMoneyPart([MONO] as never);
  const conventions = new Map([['monobank', 'includes_credit_limit']]) as never;
  const c = composeAnswering({
    location: MEMORY_LOCATION,
    schemas: [ensureRateSchema, ensureTransactionSchema, ensureBalanceSchema],
    now: () => NOW,
    settings,
    families: [
      createMonthlyReportFamily(part, conventions) as never,
      createBalanceFamily(part, conventions) as never,
      createHealthFamily(part) as never,
      createPatternsFamily(part) as never,
      createBreakdownFamily(part) as never,
      createForeignSpendingFamily(part) as never,
    ],
    contributors: [part.ratesUsedContributor],
  });
  const kindOf = new Map(a.holdings.map((h) => [h.bankId, h.kind]));
  const holdingOf = (bankId: string) => narrowingName('monobank', kindOf.get(bankId)!, bankId);
  c.store.write((tx: WriteTx) => {
    tx.registerSource(MONO as never);
    for (const h of a.holdings) {
      tx.registerHolding({ kind: h.kind, sourceId: 'monobank', bankId: h.bankId, currency: h.currency } as never);
    }
    for (const t of a.txs) {
      insertTransaction(
        tx,
        {
          sourceId: 'monobank',
          bankId: t.bankId,
          holdingId: holdingOf(t.holding),
          occurredAt: Date.parse(t.at),
          amount: t.amount,
          originalAmount: t.originalAmount ?? null,
          cashback: null,
          settled: true,
          mcc: null,
          originalMcc: null,
          merchantText: null,
          description: t.description ?? '',
          comment: null,
          counterpart: null,
        } as never,
        tx.claimPosition(),
        { category: t.category ?? UNCATEGORIZED, merchant: t.description || 'Test' } as never,
      );
    }
    for (const [outId, inId] of a.transfers ?? []) {
      const out = a.txs.find((t) => t.bankId === outId)!;
      const inn = a.txs.find((t) => t.bankId === inId)!;
      createTransfer(tx, holdingOf(out.holding), holdingOf(inn.holding), 1, [
        { sourceId: 'monobank', bankId: outId },
        { sourceId: 'monobank', bankId: inId },
      ]);
    }
    for (const b of a.balances ?? []) {
      const reported = { holdingId: holdingOf(b.jar), balance: b.balance, creditLimit: null, goal: b.goal };
      recordBalances(tx, 'monobank', [reported as never], Date.parse(REPORTED_AT), 'restated');
    }
  });
  const ask = async (family: string, q: { period?: string; options?: Record<string, unknown> } = {}): Promise<any> =>
    (
      await c.core.serve(
        {
          asker: 'command_line',
          family,
          displayCurrency: 'UAH',
          ...(q.period === undefined ? {} : { period: q.period }),
          options: q.options ?? {},
        },
        render,
        channel(),
      )
    ).answer;
  return { ask, close: () => c.store.close() };
}

// The body of an answered envelope, failing loudly on anything else.
function bodyOf(answer: any): any {
  expect(answer.kind).toBe('envelope');
  expect(answer.outcome.kind).toBe('answered');
  return answer.outcome.body;
}

const calendar = async (): Promise<Calendar> => {
  const { openCalendar } = await dates();
  return openCalendar(ZONE) as Calendar;
};

// The 10th of each month at 12:00 Warsaw time (summer time until 2026-10-25).
const OFFSETS: Record<string, string> = { '07': '+02:00', '08': '+02:00', '09': '+02:00', '10': '+02:00', '11': '+01:00' };
const tenth = (month: string) => `2026-${month}-10T12:00:00${OFFSETS[month]}`;

// One own transfer from A to `jar` at `at`: the A side out, the jar side in.
const topUp = (
  txs: Tx[],
  transfers: [string, string][],
  jar: string,
  tag: string,
  at: string,
  amount: (minor: bigint) => Money,
  minor: bigint,
) => {
  txs.push({ bankId: `${jar}-${tag}-o`, holding: 'A', at, amount: amount(-minor) });
  txs.push({ bankId: `${jar}-${tag}-i`, holding: jar, at, amount: amount(minor) });
  transfers.push([`${jar}-${tag}-o`, `${jar}-${tag}-i`]);
};

describe('analysis/monthly-report', () => {
  test('monthly report: past month health and foreign share', async () => {
    const { money } = await moneyModule();
    const cal = await calendar();
    const uah = (minor: bigint) => money(minor, 'UAH');

    const s = await composed({
      holdings: [{ kind: 'account', bankId: 'A', currency: 'UAH' }],
      txs: [
        {
          bankId: 'groceries',
          holding: 'A',
          at: '2026-03-10T12:00:00+01:00',
          amount: uah(-115800n),
          category: 'Groceries & Supermarkets',
          description: 'Market',
        },
        {
          bankId: 'abroad',
          holding: 'A',
          at: '2026-03-12T12:00:00+01:00',
          amount: uah(-4200n),
          originalAmount: money(-10000n, 'USD'),
          category: 'Shopping',
          description: 'Abroad',
        },
      ],
    });
    try {
      const march = bodyOf(await s.ask(FAMILY, { period: 'month:2026-03' }));

      // The report month's health, as at the month's end. Catches a report reusing the standalone
      // health computation, which measures the last complete month: '2026-10'.
      expect(march.health.month.label).toBe('2026-03');
      const asAt = Date.parse('2026-04-01T00:00:00+02:00');
      expect(march.health.asAt.instant).toBe(asAt);
      expect(march.health.asAt.localDateTime).toBe(cal.localDateTime(asAt));
      const standalone = bodyOf(await s.ask('health_signals'));
      expect(standalone.month.label).toBe('2026-10');

      // 4200 x 100 / 120000 = 3.5. Catches a share over another spending total (net of refunds, or
      // without the foreign line: 4200 / 115800 = 3.63%).
      expect(march.spending.totalSpending).toEqual(uah(120000n));
      expect(march.foreign.spendingTotal).toEqual(march.spending.totalSpending);
      expect(march.foreign.share.text).toBe('3.50%');
      const foreignMarch = bodyOf(await s.ask('foreign_spending', { period: 'month:2026-03' }));
      expect(march.foreign).toEqual(foreignMarch);

      // A month without spending: no share, no largest line, and a per-day average of exact 0 over
      // its 28 days. Catches a null average for a month with days but no spending.
      const february = bodyOf(await s.ask(FAMILY, { period: 'month:2026-02' }));
      expect(february.month.label).toBe('2026-02');
      expect(february.foreign.share).toBeNull();
      expect(february.spending.totalSpending).toEqual(uah(0n));
      expect(february.largest).toBeNull();
      expect(february.averagePerDay).toEqual(uah(0n));
    } finally {
      s.close();
    }
  });

  test('monthly report: this month so far', async () => {
    const { createMonthlyReportFamily, MONTHLY_TOP_MERCHANTS } = await monthlyReport();
    const { createMoneyPart } = await context();
    const { refuse } = await primitives();
    const { narrowingName } = await registerModule();
    const { money } = await moneyModule();
    const uah = (minor: bigint) => money(minor, 'UAH');
    const J = narrowingName('monobank', 'jar', 'J');

    const txs: Tx[] = [
      {
        bankId: 'nov',
        holding: 'A',
        at: '2026-11-20T12:00:00+01:00',
        amount: uah(-21000n),
        category: 'Groceries & Supermarkets',
        description: 'Market',
      },
    ];
    const transfers: [string, string][] = [];
    topUp(txs, transfers, 'J', '08', tenth('08'), uah, 30000n);
    topUp(txs, transfers, 'J', '09', tenth('09'), uah, 30000n);
    topUp(txs, transfers, 'J', '10', tenth('10'), uah, 30000n);
    topUp(txs, transfers, 'J', '11', tenth('11'), uah, 90000n);

    const s = await composed({
      holdings: [
        { kind: 'account', bankId: 'A', currency: 'UAH' },
        { kind: 'jar', bankId: 'J', currency: 'UAH' },
      ],
      txs,
      transfers,
      balances: [{ jar: 'J', balance: uah(400000n), goal: uah(1000000n) }],
    });
    try {
      const body = bodyOf(await s.ask(FAMILY, { period: 'this-month' }));

      // November so far: 2026-11-01 to now, 21 local days. Catches dividing by the month's 30
      // days: 700.
      expect(body.month.label).toBe('2026-11');
      expect(body.month.partial).toBe(true);
      expect(body.month.until).toBe(NOW);
      expect(body.spending.totalSpending).toEqual(uah(21000n));
      expect(body.averagePerDay).toEqual(uah(1000n));

      // Health on the month so far, as at the moment of asking. Catches an as-at instant at the
      // month's natural end (2026-12-01).
      expect(body.health.month.partial).toBe(true);
      expect(body.health.asAt.instant).toBe(NOW);

      // The average window is August to October: 90000 / 3 = 30000; (1000000 - 400000) x 3 =
      // 1800000 = 20 x 90000. Catches a window of September to November (150000): 50000 and 12.
      expect(body.jars.jars.length).toBe(1);
      const jar = body.jars.jars[0];
      expect(jar.jar).toBe(J);
      expect(jar.month.sum).toEqual(uah(90000n));
      expect(jar.averageMonthly).toEqual(uah(30000n));
      expect(jar.monthsToGoal).toEqual({ kind: 'months', months: 20n });

      // Catches a report of zeros for a month not yet begun.
      const future = await s.ask(FAMILY, { period: 'month:2026-12' });
      expect([future.kind, future.reason, future.subject]).toEqual(['refused', 'bad_period', 'future']);
      expect(future.message).toContain('month:2026-12');

      // A range that is not one calendar month is refused as the answer.
      expect(await s.ask(FAMILY, { period: 'last-7-days' })).toEqual(
        refuse(
          'bad_period',
          'form',
          'A monthly report covers one calendar month or this month so far; "last-7-days" is not one.',
          'last-7-days',
        ),
      );

      // Catches an unknown option ignored.
      const opt = await s.ask(FAMILY, { options: { x: 1 } });
      expect([opt.kind, opt.reason, opt.subject]).toEqual(['refused', 'bad_option', 'x']);
    } finally {
      s.close();
    }

    // The family's declaration.
    const family = createMonthlyReportFamily(createMoneyPart([MONO] as never), new Map() as never);
    expect(family.name).toBe(FAMILY);
    expect(family.period).toBe('optional');
    expect(family.defaultPeriod).toBe('last-month');
    expect(family.movesPoint).toBe(false);
    expect(family.capability).toBeUndefined();
    expect(MONTHLY_TOP_MERCHANTS).toBe(10);
  });

  test('monthly report: October agrees with the families', async () => {
    const { NO_BUDGETS } = await reportParts();
    const { narrowingName } = await registerModule();
    const { CATEGORIES } = await classifierModule();
    const { money } = await moneyModule();
    const cal = await calendar();
    const uah = (minor: bigint) => money(minor, 'UAH');
    const FF = 'Fast Food' as Category;
    const ATM = 'ATM & Cash' as Category;
    const G = 'Groceries & Supermarkets' as Category;
    const jarIds = ['J1', 'J2', 'J3', 'J4', 'J5'].map((j) => narrowingName('monobank', 'jar', j));

    // The worked-October store of the health family's test.
    const txs: Tx[] = [];
    const spend = (month: string, category: Category, minor: bigint) =>
      txs.push({ bankId: `${month}-${category}`, holding: 'A', at: tenth(month), amount: uah(-minor), category });
    spend('07', FF, 12000n);
    spend('07', ATM, 4000n);
    spend('07', G, 30000n);
    for (const m of ['08', '09']) {
      spend(m, ATM, 4000n);
      spend(m, G, 30000n);
    }
    spend('10', FF, 36003n);
    spend('10', ATM, 9001n);
    spend('10', G, 45001n);
    txs.push({ bankId: 'salary', holding: 'A', at: tenth('10'), amount: uah(100000n), description: 'Salary' });
    const transfers: [string, string][] = [];
    topUp(txs, transfers, 'J1', '1', '2026-09-20T12:00:00+02:00', uah, 10000n);
    topUp(txs, transfers, 'J2', '1', '2026-10-15T12:00:00+02:00', uah, 10000n);

    const s = await composed({
      holdings: [
        { kind: 'account', bankId: 'A', currency: 'UAH' },
        { kind: 'jar', bankId: 'J1', currency: 'UAH' },
        { kind: 'jar', bankId: 'J2', currency: 'UAH' },
        { kind: 'jar', bankId: 'J3', currency: 'UAH' },
        { kind: 'jar', bankId: 'J4', currency: 'UAH' },
        { kind: 'jar', bankId: 'J5', currency: 'UAH' },
      ],
      txs,
      transfers,
      balances: [
        { jar: 'J1', balance: uah(300000n), goal: uah(1000000n) },
        { jar: 'J2', balance: uah(100000n), goal: uah(500000n) },
        { jar: 'J3', balance: uah(50000n), goal: uah(0n) },
        { jar: 'J4', balance: uah(0n), goal: uah(200000n) },
      ],
    });
    try {
      const period = 'month:2026-10';
      const body = bodyOf(await s.ask(FAMILY, { period }));
      expect(body.month.label).toBe('2026-10');
      expect(body.month.partial).toBe(false);

      // Every section is its owning family's own body over the same month. Catches a report
      // computing its health, patterns, spending or foreign figures by a second path.
      const health = bodyOf(await s.ask('health_signals'));
      expect(health.score).toBe(45);
      expect(body.health).toEqual(health);
      expect(body.patterns).toEqual(bodyOf(await s.ask('behaviour_patterns', { period })));
      expect(body.spending).toEqual(bodyOf(await s.ask('spending_breakdown', { period })));
      expect(body.foreign).toEqual(bodyOf(await s.ask('foreign_spending', { period })));

      // T = 90005 against income 100000.
      expect(body.savings.income).toEqual(uah(100000n));
      expect(body.savings.netSavings).toEqual(uah(9995n));
      expect(body.savings.savingsRate.text).toBe('10.0%');

      // Against September (4000 + 30000). Catches comparing with the first baseline month (July:
      // 46000), difference 44005.
      expect(body.comparison.current).toEqual(uah(90005n));
      expect(body.comparison.previous).toEqual(uah(34000n));
      expect(body.comparison.difference).toEqual(uah(56005n));

      // 90005 / 31 = 2903.39. Catches an average over 30 days: 3000.
      expect(body.averagePerDay).toEqual(uah(2903n));

      // The single largest spending line, not a category's sum.
      expect(body.largest.line.tx.bankId).toBe('10-Groceries & Supermarkets');
      expect(body.largest.line.figure).toEqual(uah(45001n));
      expect(body.largest.localDateTime).toBe(cal.localDateTime(body.largest.line.at));

      // n = 3, in CATEGORIES order. Groceries: 2 x 45001 x 3 = 270006 >= 270000 and 135003 <
      // 180000, elevated; Fast Food: 108009 >= 36000, a spike; ATM: 27003 >= 24000 and < 36000,
      // high. Catches a section filtered like the health signal (high and spike only), which drops
      // the elevated Groceries row.
      expect([CATEGORIES.indexOf(G), CATEGORIES.indexOf(FF), CATEGORIES.indexOf(ATM)]).toEqual([0, 2, 20]);
      expect(body.unusuallyHigh).toEqual([
        { category: G, tier: 'elevated', spending: uah(45001n), baselineAverage: uah(30000n) },
        { category: FF, tier: 'spike', spending: uah(36003n), baselineAverage: uah(4000n) },
        { category: ATM, tier: 'high', spending: uah(9001n), baselineAverage: uah(4000n) },
      ]);

      expect(body.budget).toEqual(NO_BUDGETS);

      // Every jar in scope in register order. Catches a section listing only jars with a held
      // balance, which drops J5.
      expect(body.jars.jars.map((j: any) => j.jar)).toEqual(jarIds);
      expect(body.jars.jars[4].balance).toBeNull();
    } finally {
      s.close();
    }
  });
});
