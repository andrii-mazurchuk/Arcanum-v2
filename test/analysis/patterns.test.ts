// Behaviour patterns (S-158): each spending line of the period ledger bucketed by the local hour and
// weekday the calendar draws from its own transaction instant, counts over every line and money
// figures over converted lines only, habits per (category, weekday, hour) at count 3 or more, the
// per-day frequency over local days up to today, and the earliest-wins tie rule. Asked through the
// composed core with the money part's 'ratesUsed' contributor. From src/analytics/patterns over the
// period ledger of src/analytics/ledger and the money part of src/money/context.
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

const patterns = () => import('../../src/analytics/patterns');
const context = () => import('../../src/money/context');
const compose = () => import('../../src/core/compose');
const recordedRates = () => import('../../src/money/recorded-rates');
const transactions = () => import('../../src/local/transactions');
const classifierModule = () => import('../../src/local/classifier');
const registerModule = () => import('../../src/core/register');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');

const FAMILY = 'behaviour_patterns';
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const NOW = Date.parse('2026-11-21T12:00:00+01:00');

const settings = (): Settings => ({ timeZone: undefined, sources: [] });
const render = (a: unknown) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

// A settled spending line on account `holding` (its bank id), stored at the next position.
interface Tx {
  bankId: string;
  holding: string;
  at: number;
  amount: Money;
  category: Category;
}

interface Arrange {
  now: number;
  holdings: { bankId: string; currency: string }[];
  txs: Tx[]; // stored in one write
  later?: Tx[]; // stored afterwards, in a second write: the later moment of storage
}

// Composes the core at `now` over a fresh in-memory store with the patterns family built over a
// money part of Monobank, registers Monobank and its accounts and stores the lines; no rate is
// recorded. Returns an asker for 'behaviour_patterns', a direct compute over a hand-built context,
// the family and the closer.
async function composed(a: Arrange) {
  const { createPatternsFamily } = await patterns();
  const { createMoneyPart } = await context();
  const { composeAnswering } = await compose();
  const { ensureRateSchema } = await recordedRates();
  const { ensureTransactionSchema, insertTransaction } = await transactions();
  const { narrowingName, resolveScope } = await registerModule();
  const { MEMORY_LOCATION } = await db();
  const { openCalendar } = await dates();

  const part = createMoneyPart([MONO] as never);
  const family = createPatternsFamily(part);
  const c = composeAnswering({
    location: MEMORY_LOCATION,
    schemas: [ensureRateSchema, ensureTransactionSchema],
    now: () => a.now,
    settings,
    families: [family as never],
    contributors: [part.ratesUsedContributor],
  });
  const store1 = (tx: WriteTx, t: Tx) =>
    insertTransaction(
      tx,
      {
        sourceId: 'monobank',
        bankId: t.bankId,
        holdingId: narrowingName('monobank', 'account', t.holding),
        occurredAt: t.at,
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
      { category: t.category, merchant: 'Shop' } as never,
    );
  c.store.write((tx: WriteTx) => {
    tx.registerSource(MONO as never);
    for (const h of a.holdings) {
      tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: h.bankId, currency: h.currency } as never);
    }
    for (const t of a.txs) store1(tx, t);
  });
  if (a.later !== undefined) {
    c.store.write((tx: WriteTx) => {
      for (const t of a.later!) store1(tx, t);
    });
  }
  const ask = async (period: string, displayCurrency = 'PLN'): Promise<any> =>
    (
      await c.core.serve(
        { asker: 'command_line', family: FAMILY, period, displayCurrency, options: {} },
        render,
        channel(),
      )
    ).answer;
  // The family's compute over a hand-built question context at `now`.
  const compute = (period: string, options: Record<string, unknown>): any =>
    c.store.readSnapshot((snap) => {
      const cal = openCalendar(undefined) as Calendar;
      const reg = snap.register();
      const ctx = {
        snapshot: snap,
        now: a.now,
        settings: { timeZone: undefined, sources: ['monobank'] },
        calendar: cal,
        displayCurrency: 'PLN',
        position: snap.position(),
        register: reg,
        scope: resolveScope(reg, undefined),
        period: cal.resolvePeriod(period, a.now),
        asker: 'command_line',
        options,
      } as unknown as QuestionContext;
      return family.compute(ctx);
    });
  return { family, ask, compute, close: () => c.store.close() };
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

describe('analysis/patterns', () => {
  test('patterns: counts take all lines, averages converted lines', async () => {
    const { WEEKDAYS } = await patterns();
    const { money } = await moneyModule();
    const G = await categoryOf('Groceries & Supermarkets');
    const S = await categoryOf('Shopping');
    const pln = (minor: bigint) => money(minor, 'PLN');

    // No USD rate held: the USD line stays unconverted.
    const a = await composed({
      now: NOW,
      holdings: [
        { bankId: 'P', currency: 'PLN' },
        { bankId: 'U', currency: 'USD' },
      ],
      txs: [
        { bankId: 'g1', holding: 'P', at: Date.parse('2026-11-10T09:15:00+01:00'), amount: pln(-10000n), category: G },
        { bankId: 'g2', holding: 'P', at: Date.parse('2026-11-17T09:40:00+01:00'), amount: pln(-5001n), category: G },
        {
          bankId: 'u1',
          holding: 'U',
          at: Date.parse('2026-11-10T18:00:00+01:00'),
          amount: money(-2500n, 'USD'),
          category: S,
        },
      ],
    });
    try {
      const answer = await a.ask('this-month');
      const body = bodyOf(answer);

      expect(body.byHour.map((r: any) => r.hour)).toEqual(Array.from({ length: 24 }, (_, h) => h));
      expect(body.byWeekday.map((r: any) => r.weekday)).toEqual([...WEEKDAYS]);
      expect(WEEKDAYS[0]).toBe('Monday');

      // Catches dividing the converted total by all lines (15001 / 3 -> 5000) and dropping
      // unconverted lines from the count (2). 15001 / 2 = 7500.5 -> 7501.
      const tue = body.byWeekday[1];
      expect(tue.weekday).toBe('Tuesday');
      expect([tue.count, tue.total, tue.average]).toEqual([3, pln(15001n), pln(7501n)]);

      const h9 = body.byHour[9];
      expect([h9.count, h9.total, h9.average]).toEqual([2, pln(15001n), pln(7501n)]);
      // Catches an all-unconverted bucket given average 0 instead of null.
      const h18 = body.byHour[18];
      expect([h18.count, h18.total, h18.average]).toEqual([1, pln(0n), null]);

      // Catches unconverted lines dropped from the count (2) and the average over all lines (5000).
      expect(body.transactions).toBe(3);
      expect(body.total).toEqual(pln(15001n));
      expect(body.averageTransaction).toEqual(pln(7501n));
      expect(body.busiestHour).toBe(9);
      expect(body.topWeekday).toBe('Tuesday');

      expect(body.notConverted).toEqual([{ original: money(2500n, 'USD'), pair: { from: 'USD', to: 'PLN' } }]);

      // Every line's result went to the money context's show: the envelope names the pair.
      const items = answer.statements.ratesUsed as any[];
      const usd = items.filter((i) => i.from === 'USD' && i.to === 'PLN');
      expect(usd.length).toBe(1);
      expect(usd[0]).toMatchObject({ kind: 'not_converted', from: 'USD', to: 'PLN' });
    } finally {
      a.close();
    }
  });

  test('patterns: local hour and weekday across the clock change', async () => {
    const { localHour, localWeekday } = await patterns();
    const { openCalendar } = await dates();
    const { money } = await moneyModule();
    const G = await categoryOf('Groceries & Supermarkets');
    const pln = (minor: bigint) => money(minor, 'PLN');

    const cal = openCalendar('Europe/Warsaw') as Calendar;
    const a = Date.parse('2026-10-25T02:30:00+02:00');
    const b = Date.parse('2026-10-25T02:30:00+01:00');
    const c = Date.parse('2026-10-19T23:30:00Z');

    // Catches UTC hours: a in hour 0, b in hour 1, c in hour 23 on a Monday.
    expect(localHour(cal, a)).toBe(2);
    expect(localHour(cal, b)).toBe(2);
    expect(localHour(cal, c)).toBe(1);
    expect(localWeekday(cal, a)).toBe('Sunday');
    expect(localWeekday(cal, c)).toBe('Tuesday');

    // The line at c is stored after the others, in a later write (2026-11-20).
    const s = await composed({
      now: NOW,
      holdings: [{ bankId: 'P', currency: 'PLN' }],
      txs: [
        { bankId: 'a', holding: 'P', at: a, amount: pln(-1000n), category: G },
        { bankId: 'b', holding: 'P', at: b, amount: pln(-1000n), category: G },
      ],
      later: [{ bankId: 'c', holding: 'P', at: c, amount: pln(-1000n), category: G }],
    });
    try {
      const body = bodyOf(await s.ask('month:2026-10'));
      // Catches storage-moment bucketing: c would fall outside October.
      expect(body.transactions).toBe(3);
      expect(body.byHour[2].count).toBe(2);
      expect(body.byHour[1].count).toBe(1);
      expect(body.byHour[0].count).toBe(0);
      expect(body.byHour[23].count).toBe(0);
      expect(body.byWeekday[6].weekday).toBe('Sunday');
      expect(body.byWeekday[6].count).toBe(2);
      expect(body.byWeekday[1].count).toBe(1);
      expect(body.byWeekday[0].count).toBe(0);
      expect(body.busiestHour).toBe(2);
      expect(body.days).toBe(31);
    } finally {
      s.close();
    }
  });

  test('patterns: habits, earliest-wins ties, per day', async () => {
    const { HABIT_MIN_COUNT } = await patterns();
    const { fraction } = await exact();
    const { money } = await moneyModule();
    const F = await categoryOf('Fast Food');
    const G = await categoryOf('Groceries & Supermarkets');
    const S = await categoryOf('Shopping');
    const pln = (minor: bigint) => money(minor, 'PLN');
    // October 2026 in Warsaw is +02:00 up to the 25th.
    const at = (day: string, time: string) => Date.parse(`2026-10-${day}T${time}:00+02:00`);
    const line = (bankId: string, day: string, time: string, minor: bigint, category: Category): Tx => ({
      bankId,
      holding: 'P',
      at: at(day, time),
      amount: pln(-minor),
      category,
    });

    const s = await composed({
      now: NOW,
      holdings: [{ bankId: 'P', currency: 'PLN' }],
      txs: [
        line('f1', '05', '12:10', 3000n, F),
        line('f2', '12', '12:10', 3000n, F),
        line('f3', '19', '12:10', 3000n, F),
        line('g1', '07', '18:00', 3000n, G),
        line('g2', '14', '18:00', 3000n, G),
        line('g3', '21', '18:00', 3000n, G),
        line('s1', '09', '15:00', 1000n, S),
        line('s2', '16', '15:00', 1000n, S),
      ],
    });
    try {
      const body = bodyOf(await s.ask('month:2026-10'));

      // Catches a threshold of > 3 (none) or >= 2 (adds Shopping, Friday, 15), and ordering by
      // hour descending (the 18:00 habit first).
      expect(HABIT_MIN_COUNT).toBe(3);
      expect(body.habits).toEqual([
        { category: F, weekday: 'Monday', hour: 12, count: 3 },
        { category: G, weekday: 'Wednesday', hour: 18, count: 3 },
      ]);

      // Catches a latest-wins scan: busiestHour 18 and topWeekday 'Wednesday'.
      expect(body.byHour[12].count).toBe(3);
      expect(body.byHour[18].count).toBe(3);
      expect(body.busiestHour).toBe(12);
      const day = (w: string) => body.byWeekday.find((r: any) => r.weekday === w);
      expect(day('Monday').total).toEqual(pln(9000n));
      expect(day('Wednesday').total).toEqual(pln(9000n));
      expect(day('Friday').total).toEqual(pln(2000n));
      expect(body.topWeekday).toBe('Monday');

      // Catches a 30-day divisor: '0.27'.
      expect(body.transactions).toBe(8);
      expect(body.days).toBe(31);
      expect(body.perDay.exact).toEqual(fraction(8n, 31n));
      expect(body.perDay.text).toBe('0.26');
      expect(body.total).toEqual(pln(20000n));
      expect(body.averageTransaction).toEqual(pln(2500n));
    } finally {
      s.close();
    }
  });

  test('patterns: days, empty period, refusal, declaration', async () => {
    const { patternDays } = await patterns();
    const { openCalendar } = await dates();
    const { fraction } = await exact();
    const { money } = await moneyModule();
    const G = await categoryOf('Groceries & Supermarkets');
    const pln = (minor: bigint) => money(minor, 'PLN');

    const cal = openCalendar('Europe/Warsaw') as Calendar;
    const now3 = Date.parse('2026-11-03T20:00:00+01:00');

    // Catches the whole month as divisor (30) and today excluded (2).
    expect(patternDays(cal, '2026-11-01', '2026-11-30', now3)).toBe(3);
    expect(patternDays(cal, '2026-11-04', '2026-11-30', now3)).toBe(0);
    expect(patternDays(cal, '2026-10-01', '2026-10-31', now3)).toBe(31);

    const times = [
      '2026-11-01T09:00',
      '2026-11-01T12:00',
      '2026-11-01T15:00',
      '2026-11-02T10:00',
      '2026-11-02T14:00',
      '2026-11-03T08:00',
      '2026-11-03T19:00',
    ];
    const s = await composed({
      now: now3,
      holdings: [{ bankId: 'P', currency: 'PLN' }],
      txs: times.map((t, i) => ({
        bankId: `d${i + 1}`,
        holding: 'P',
        at: Date.parse(`${t}:00+01:00`),
        amount: pln(-1000n),
        category: G,
      })),
    });
    try {
      // Catches '0.23' (30 days) and '3.50' (today excluded).
      const body = bodyOf(await s.ask('this-month'));
      expect(body.days).toBe(3);
      expect(body.transactions).toBe(7);
      expect(body.perDay.exact).toEqual(fraction(7n, 3n));
      expect(body.perDay.text).toBe('2.33');
    } finally {
      s.close();
    }

    const e = await composed({ now: NOW, holdings: [{ bankId: 'P', currency: 'PLN' }], txs: [] });
    try {
      const body = bodyOf(await e.ask('month:2026-09'));
      expect(body.byHour.length).toBe(24);
      expect(body.byWeekday.length).toBe(7);
      for (const r of [...body.byHour, ...body.byWeekday]) {
        expect([r.count, r.total, r.average]).toEqual([0, pln(0n), null]);
      }
      expect(body.habits).toEqual([]);
      expect(body.transactions).toBe(0);
      expect(body.days).toBe(30);
      expect(body.perDay.text).toBe('0.00');
      expect(body.total).toEqual(pln(0n));
      expect(body.averageTransaction).toBeNull();
      // Catches the first row (hour 0, Monday) taken as the leader of an empty period.
      expect(body.busiestHour).toBeNull();
      expect(body.topWeekday).toBeNull();
      expect(body.notConverted).toEqual([]);

      const r = e.compute('month:2026-09', { sort: 'x' });
      expect([r.kind, r.reason, r.subject]).toEqual(['refused', 'bad_option', 'sort']);

      expect(e.family.name).toBe(FAMILY);
      expect(e.family.period).toBe('optional');
      expect(e.family.defaultPeriod).toBe('last-month');
      expect(e.family.movesPoint).toBe(false);
      expect(e.family.capability).toBeUndefined();
    } finally {
      e.close();
    }
  });
});
