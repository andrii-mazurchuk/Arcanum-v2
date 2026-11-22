// Report sections (S-165): the money part handed to a report's private section families, which
// resolves any section context, however often opened over, to the question's one money context;
// the section context opener with a period and options of its own; and the section period built
// from an analysis period. Then a weekly report (S-163) asked through the composed core with the
// money part's 'ratesUsed' contributor, so that what its sections show lands in the envelope's one
// list of rates used. From src/analytics/sections and src/analytics/weekly-report over the money
// part of src/money/context.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { QuestionContext, Settings } from '../../src/core/question';
import type { Snapshot, WriteTx } from '../../src/db/index';
import type { Category } from '../../src/local/classifier';
import type { StatedRate } from '../../src/money/recorded-rates';

const sections = () => import('../../src/analytics/sections');
const weeklyReport = () => import('../../src/analytics/weekly-report');
const periods = () => import('../../src/analytics/periods');
const context = () => import('../../src/money/context');
const compose = () => import('../../src/core/compose');
const recordedRates = () => import('../../src/money/recorded-rates');
const transactions = () => import('../../src/local/transactions');
const balancesModule = () => import('../../src/sync/balances');
const classifierModule = () => import('../../src/local/classifier');
const registerModule = () => import('../../src/core/register');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');

const NOW = Date.parse('2026-11-21T12:00:00+01:00');
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const RATE_AT = Date.parse('2026-11-10T08:00:00+01:00');
const REPORTED_AT = Date.parse('2026-11-21T09:00:00+01:00');

const now = () => NOW;
const settings = (): Settings => ({ timeZone: undefined, sources: [] });
const render = (a: unknown) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

// The QuestionContext fields an opened section context carries over by value.
const CARRIED = [
  'snapshot',
  'now',
  'settings',
  'calendar',
  'displayCurrency',
  'position',
  'register',
  'scope',
  'asker',
] as const;

// Opens a fresh in-memory store with monobank registered; runs `body` inside one snapshot on the
// Warsaw calendar.
async function withStore(body: (snap: Snapshot, cal: Calendar) => void): Promise<void> {
  const { ensureRateSchema } = await recordedRates();
  const { openStore, MEMORY_LOCATION } = await db();
  const { openCalendar } = await dates();

  const cal = openCalendar(undefined) as Calendar;
  const store = openStore(MEMORY_LOCATION, [ensureRateSchema]);
  try {
    store.write((tx: WriteTx) => {
      tx.registerSource(MONO as never);
    });
    store.readSnapshot((snap) => body(snap, cal));
  } finally {
    store.close();
  }
}

// A hand-built question context at NOW over the whole register displaying PLN, its period resolved
// from `period` (null: none); a fresh object on every call. Takes resolveScope from the register
// module, already imported, so that it can run inside the synchronous snapshot body.
const ctxFor = (
  resolveScope: (reg: any, narrowing: string | undefined) => unknown,
  snap: Snapshot,
  cal: Calendar,
  period: string | null,
): QuestionContext => {
  const reg = snap.register();
  return {
    snapshot: snap,
    now: NOW,
    settings: { timeZone: undefined, sources: ['monobank'] },
    calendar: cal,
    displayCurrency: 'PLN',
    position: snap.position(),
    register: reg,
    scope: resolveScope(reg, undefined),
    period: period === null ? null : cal.resolvePeriod(period, NOW),
    asker: 'command_line',
    options: {},
  } as unknown as QuestionContext;
};

// The body of an answered envelope, failing loudly on anything else.
function bodyOf(answer: any): any {
  expect(answer.kind).toBe('envelope');
  expect(answer.outcome.kind).toBe('answered');
  return answer.outcome.body;
}

describe('analytics/sections', () => {
  test('sections: owner resolution and section period', async () => {
    const { createSectionMoney, sectionPeriod } = await sections();
    const { lastCompleteWeek, currentMonth } = await periods();
    const { createMoneyPart } = await context();
    const { resolveScope } = await registerModule();

    const money = createMoneyPart([MONO] as never);
    const sm = createSectionMoney(money);

    await withStore((snap, cal) => {
      const ctx = ctxFor(resolveScope, snap, cal, 'last-week');
      const rp2 = sectionPeriod(ctx, lastCompleteWeek(cal, NOW));

      const sc = sm.open(ctx, rp2, { grouping: 'merchant', merchantCap: 5 });
      const sc2 = sm.open(sc, null, {});

      expect(Object.isFrozen(sc)).toBe(true);
      expect(sc).not.toBe(ctx);
      expect(sc.period).toBe(rp2);
      expect(sc.options).toEqual({ grouping: 'merchant', merchantCap: 5 });
      expect(sc2.period).toBeNull();
      for (const f of CARRIED) {
        expect([f, sc[f] === ctx[f], sc2[f] === ctx[f]]).toEqual([f, true, true]);
      }

      // Catches part.moneyFor(c) = money.moneyFor(c): sc would get a fresh money context of its own.
      // Catches ownerOf(new) = the context opened from: sc2 would resolve to sc's own context.
      const own = money.moneyFor(ctx);
      expect(sm.part.moneyFor(sc)).toBe(own);
      expect(sm.part.moneyFor(sc2)).toBe(own);
      expect(sm.part.moneyFor(ctx)).toBe(own);

      expect(sm.part.rateSource).toBe(money.rateSource);
      expect(sm.part.ratesUsedContributor).toBe(money.ratesUsedContributor);

      expect(rp2).toEqual({
        text: 'last-week',
        firstDay: '2026-11-09',
        lastDay: '2026-11-15',
        from: Date.parse('2026-11-09T00:00:00+01:00'),
        until: Date.parse('2026-11-16T00:00:00+01:00'),
      });

      // Catches the partial month ending at its natural last day, '2026-11-30'.
      const ctxNone = ctxFor(resolveScope, snap, cal, null);
      expect(sectionPeriod(ctxNone, currentMonth(cal, NOW))).toEqual({
        text: '2026-11',
        firstDay: '2026-11-01',
        lastDay: '2026-11-21',
        from: Date.parse('2026-11-01T00:00:00+01:00'),
        until: NOW,
      });
    });
  });

  test('sections: one money context across a report', async () => {
    const { createWeeklyReportFamily } = await weeklyReport();
    const { createMoneyPart } = await context();
    const { composeAnswering } = await compose();
    const { ensureRateSchema, recordRates } = await recordedRates();
    const { ensureTransactionSchema, insertTransaction } = await transactions();
    const { ensureBalanceSchema, recordBalances } = await balancesModule();
    const { CATEGORIES } = await classifierModule();
    const { narrowingName } = await registerModule();
    const { MEMORY_LOCATION } = await db();
    const { parseExactDecimal } = await exact();
    const { money } = await moneyModule();

    const S = CATEGORIES.find((c) => c === 'Shopping') as Category;
    const pln = (minor: bigint) => money(minor, 'PLN');
    const d = (t: string) => parseExactDecimal(t)!;
    const U = narrowingName('monobank', 'account', 'U'); // USD; one 10.00 USD spending at 'Shop A'
    const E = narrowingName('monobank', 'account', 'E');

    const part = createMoneyPart([MONO] as never);
    const family = createWeeklyReportFamily(part, new Map([['monobank', 'own_money_as_reported']]) as never);
    const c = composeAnswering({
      location: MEMORY_LOCATION,
      schemas: [ensureRateSchema, ensureTransactionSchema, ensureBalanceSchema],
      now,
      settings,
      families: [family as never],
      contributors: [part.ratesUsedContributor],
    });
    try {
      expect(family.name).toBe('weekly_report');
      expect(family.defaultPeriod).toBe('last-week');

      c.store.write((tx: WriteTx) => {
        tx.registerSource(MONO as never);
        tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'U', currency: 'USD' } as never);
        tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'E', currency: 'EUR' } as never);
        // Midpoints 3.6555 and 4.2500.
        const stated: StatedRate[] = [
          {
            pair: { base: 'USD', quote: 'PLN' },
            statedFrom: RATE_AT,
            figures: { kind: 'buy_sell', buy: d('3.6500'), sell: d('3.6610') },
          },
          {
            pair: { base: 'EUR', quote: 'PLN' },
            statedFrom: RATE_AT,
            figures: { kind: 'buy_sell', buy: d('4.2400'), sell: d('4.2600') },
          },
        ];
        expect(recordRates(tx, 'monobank', stated, RATE_AT).added).toBe(2);
        insertTransaction(
          tx,
          {
            sourceId: 'monobank',
            bankId: 'p1',
            holdingId: U,
            occurredAt: Date.parse('2026-11-10T12:00:00+01:00'),
            amount: money(-1000n, 'USD'),
            originalAmount: null,
            cashback: null,
            settled: true,
            mcc: null,
            originalMcc: null,
            merchantText: null,
            description: 'Shop A',
            comment: null,
            counterpart: null,
          } as never,
          tx.claimPosition(),
          { category: S, merchant: 'Shop A' } as never,
        );
        // E's held balance, 200.00 EUR; E has no transactions.
        const held = { holdingId: E, balance: money(20000n, 'EUR'), creditLimit: null };
        recordBalances(tx, 'monobank', [held], REPORTED_AT, 'restated');
      });

      const answer = (
        await c.core.serve(
          { asker: 'command_line', family: 'weekly_report', period: 'last-week', displayCurrency: 'PLN', options: {} },
          render,
          channel(),
        )
      ).answer as any;
      const body = bodyOf(answer);

      // 1000 x 3.6555 = 3655.5 -> 3656, half away from zero. Catches a section converter apart from
      // the ledger's rounding differently: spending and the comparison would disagree.
      expect(body.spending.totalSpending).toEqual(pln(3656n));
      expect(body.comparison.current).toEqual(pln(3656n));
      expect(body.topMerchants[0].spending).toEqual(pln(3656n));

      // 20000 x 4.25 = 85000.
      const e = body.balances.accounts.find((l: any) => l.holdingId === E);
      expect(e).toBeDefined();
      expect(e.ownMoney.shown).toEqual(pln(85000n));

      // Catches a section money part keying money contexts by the section context: the balance
      // section's EUR item would be missing (the USD item survives through the report's own ledger).
      const items = answer.statements.ratesUsed as any[];
      const usd = items.filter((i) => i.from === 'USD' && i.to === 'PLN');
      const eur = items.filter((i) => i.from === 'EUR' && i.to === 'PLN');
      expect(usd.length).toBe(1);
      expect(usd[0]).toMatchObject({ kind: 'applied', quotedValue: '3.6555', date: '2026-11-10' });
      expect(eur.length).toBe(1);
      expect(eur[0]).toMatchObject({ kind: 'applied' });
    } finally {
      c.store.close();
    }
  });
});
