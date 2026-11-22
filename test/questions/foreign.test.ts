// Foreign-spending family (S-170): per original currency, a charged line from the debited amount
// and a market line from the original amount, both at the purchase's day by the one converter; the
// charged set and the nested compared set, every rate an exact ratio of per-line rounded totals
// over the same purchases, and the share of all spending. Asked through the composed core with the
// money part's 'ratesUsed' contributor. From src/families/foreign over the money part of
// src/money/context.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Settings } from '../../src/core/question';
import type { WriteTx } from '../../src/db/index';
import type { Category } from '../../src/local/classifier';
import type { Money } from '../../src/money/money';
import type { StatedRate } from '../../src/money/recorded-rates';

const foreign = () => import('../../src/families/foreign');
const context = () => import('../../src/money/context');
const compose = () => import('../../src/core/compose');
const recordedRates = () => import('../../src/money/recorded-rates');
const transactions = () => import('../../src/local/transactions');
const classifierModule = () => import('../../src/local/classifier');
const registerModule = () => import('../../src/core/register');
const db = () => import('../../src/db/index');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');
const text = () => import('../../src/answers/text');

const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const NOW = Date.parse('2026-11-21T12:00:00Z');
const RATE_AT = Date.parse('2026-11-10T08:00:00Z'); // Warsaw 2026-11-10 09:00
const DAY_AT = (hhmm: string) => Date.parse(`2026-11-10T${hhmm}:00Z`);
const NOVEMBER = '2026-11-01..2026-11-30';

const now = () => NOW;
const settings = (): Settings => ({ timeZone: undefined, sources: [] });
const render = (a: unknown) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

type Rec = { base: string; quote: string } & ({ buy: string; sell: string } | { rate: string });

// A purchase or plain spending on the UAH account 'card', settled, debited `amount` minor UAH.
interface Tx {
  bankId: string;
  at: number;
  amount: bigint;
  original?: [minor: bigint, currency: string];
}

// Composes the core over a fresh in-memory store with the foreign-spending family built over a
// money part of Monobank, registers Monobank and its UAH account 'card', records `rates` stated at
// RATE_AT and inserts `txs` on 'card'; returns an asker for 'foreign_spending' and the closer.
async function composed(rates: readonly Rec[], txs: readonly Tx[]) {
  const { createForeignSpendingFamily } = await foreign();
  const { createMoneyPart } = await context();
  const { composeAnswering } = await compose();
  const { ensureRateSchema, recordRates } = await recordedRates();
  const { ensureTransactionSchema, insertTransaction } = await transactions();
  const { CATEGORIES } = await classifierModule();
  const { narrowingName } = await registerModule();
  const { MEMORY_LOCATION } = await db();
  const { parseExactDecimal } = await exact();
  const { money } = await moneyModule();

  const G = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
  const card = narrowingName('monobank', 'account', 'card');
  const part = createMoneyPart([MONO] as never);
  const family = createForeignSpendingFamily(part);
  const c = composeAnswering({
    location: MEMORY_LOCATION,
    schemas: [ensureRateSchema, ensureTransactionSchema],
    now,
    settings,
    families: [family as never],
    contributors: [part.ratesUsedContributor],
  });
  const d = (t: string) => parseExactDecimal(t)!;
  c.store.write((tx: WriteTx) => {
    tx.registerSource(MONO as never);
    tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'card', currency: 'UAH' });
    if (rates.length > 0) {
      const stated: StatedRate[] = rates.map((r) => ({
        pair: { base: r.base, quote: r.quote },
        statedFrom: RATE_AT,
        figures: 'rate' in r ? { kind: 'cross', rate: d(r.rate) } : { kind: 'buy_sell', buy: d(r.buy), sell: d(r.sell) },
      }));
      expect(recordRates(tx, 'monobank', stated, RATE_AT).added).toBe(stated.length);
    }
    for (const t of txs) {
      const originalAmount: Money | null = t.original === undefined ? null : money(t.original[0], t.original[1]);
      insertTransaction(
        tx,
        {
          sourceId: 'monobank',
          bankId: t.bankId,
          holdingId: card,
          occurredAt: t.at,
          amount: money(t.amount, 'UAH'),
          originalAmount,
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
        { category: G, merchant: 'Shop' } as never,
      );
    }
  });
  const ask = async (q: { period?: string; displayCurrency?: string; options?: Record<string, unknown> }): Promise<any> =>
    (
      await c.core.serve(
        {
          asker: 'command_line',
          family: 'foreign_spending',
          period: q.period,
          displayCurrency: q.displayCurrency,
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

describe('families/foreign', () => {
  test('ratePaid', async () => {
    const { ratePaid, RATE_DECIMALS } = await foreign();
    const { fraction } = await exact();
    const { fractionText } = await text();
    const { money } = await moneyModule();

    expect(RATE_DECIMALS).toBe(4);

    // 42000 minor UAH for 1000 minor USD: 420.00 / 10.00 = 42.
    const r = ratePaid(money(-42000n, 'UAH'), money(-1000n, 'USD'));
    expect(r).toEqual(fraction(42n, 1n));
    expect(fractionText(r, RATE_DECIMALS)).toBe('42.0000');

    // Catches (b): signs are ignored, whichever side carries one (not -42).
    expect(ratePaid(money(-42000n, 'UAH'), money(1000n, 'USD'))).toEqual(fraction(42n, 1n));
    expect(ratePaid(money(42000n, 'UAH'), money(-1000n, 'USD'))).toEqual(fraction(42n, 1n));

    // Catches (a) and (c): JPY has exponent 0, so 27500 x 10^0 / (1000 x 10^2) = 0.275, not 27.5
    // (exponents ignored) nor 2750 (exponents swapped).
    const jpy = ratePaid(money(27500n, 'UAH'), money(1000n, 'JPY'));
    expect(jpy).toEqual(fraction(11n, 40n));
    expect(fractionText(jpy, RATE_DECIMALS)).toBe('0.2750');

    // 461000 / 11000 = 41.90909...
    expect(fractionText(ratePaid(money(461000n, 'UAH'), money(11000n, 'USD')), RATE_DECIMALS)).toBe('41.9091');
  });

  test('worked cases 1, 2 and 6', async () => {
    const { PERCENT_DECIMALS } = await foreign();
    const { fraction } = await exact();
    const { money } = await moneyModule();

    expect(PERCENT_DECIMALS).toBe(2);

    const a = await composed(
      [
        { base: 'USD', quote: 'UAH', buy: '40.50', sell: '41.50' }, // midpoint 41
        { base: 'PLN', quote: 'UAH', rate: '10.00' },
      ],
      [
        { bankId: 'p1', at: DAY_AT('09:00'), amount: -42000n, original: [-1000n, 'USD'] }, // 10.00 USD
        { bankId: 's1', at: DAY_AT('09:10'), amount: -58000n },
      ],
    );
    try {
      expect(a.family.name).toBe('foreign_spending');
      expect(a.family.period).toBe('optional');
      expect(a.family.defaultPeriod).toBe('last-month');
      expect(a.family.capability).toBeUndefined();
      expect(a.family.movesPoint).toBe(false);

      // Display UAH.
      const uah = bodyOf(await a.ask({ period: NOVEMBER, displayCurrency: 'UAH' }));
      expect(uah.currencies.length).toBe(1);
      const u = uah.currencies[0];
      expect(u.currency).toBe('USD');
      expect(u.purchases).toBe(1);
      // Catches (b): charged from the debited 42000, not converted from the original (41000, '41.0000').
      expect(u.charged.count).toBe(1);
      expect(u.charged.originalTotal).toEqual(money(1000n, 'USD'));
      expect(u.charged.totalCharged).toEqual(money(42000n, 'UAH'));
      expect(u.charged.averageRate.text).toBe('42.0000');
      expect(u.charged.averageRate.exact).toEqual(fraction(42n, 1n));
      expect(u.charged.bestRate.text).toBe('42.0000');
      expect(u.charged.worstRate.text).toBe('42.0000');
      // Catches (a): market from the original at the midpoint, not the debited amount (42000,
      // excess 0, '0.00'). Catches (c): 1000 / 41000 x 100 = 2.439, not over the charged '2.38'.
      expect(u.compared.count).toBe(1);
      expect(u.compared.originalTotal).toEqual(money(1000n, 'USD'));
      expect(u.compared.marketTotal).toEqual(money(41000n, 'UAH'));
      expect(u.compared.marketRate.text).toBe('41.0000');
      expect(u.compared.excess).toEqual(money(1000n, 'UAH'));
      expect(u.compared.excessPercent.text).toBe('2.44');
      expect(u.compared.excessPercent.exact).toEqual(fraction(100000n, 41000n));
      expect(u.unchargedLines).toEqual([]);
      expect(u.missingPairs).toEqual([]);
      // Catches (d): the share is over all spending, purchase included (42000 + 58000), not '72.41%'.
      expect(uah.totalCharged).toEqual(money(42000n, 'UAH'));
      expect(uah.spendingTotal).toEqual(money(100000n, 'UAH'));
      expect(uah.share.exact).toEqual(fraction(42n, 1n));
      expect(uah.share.text).toBe('42.00%');

      // Display PLN at cross 10.00: the market line built USD -> UAH -> PLN with no rounding between
      // legs, 1000 x 41 / 10 = 4100.
      const pln = bodyOf(await a.ask({ period: NOVEMBER, displayCurrency: 'PLN' }));
      expect(pln.currencies.map((l: any) => l.currency)).toEqual(['USD']);
      const p = pln.currencies[0];
      expect(p.charged.totalCharged).toEqual(money(4200n, 'PLN'));
      expect(p.charged.averageRate.text).toBe('4.2000');
      expect(p.compared.marketTotal).toEqual(money(4100n, 'PLN'));
      expect(p.compared.marketRate.text).toBe('4.1000');
      expect(p.compared.excess).toEqual(money(100n, 'PLN'));
      expect(p.compared.excessPercent.text).toBe('2.44');
      expect(p.unchargedLines).toEqual([]);
      expect(p.missingPairs).toEqual([]);
      expect(pln.totalCharged).toEqual(money(4200n, 'PLN'));
      expect(pln.spendingTotal).toEqual(money(10000n, 'PLN'));
      expect(pln.share.text).toBe('42.00%');

      // Nothing held in October: no currencies, zero totals, and no share rather than a division.
      const empty = bodyOf(await a.ask({ period: '2026-10-01..2026-10-31', displayCurrency: 'UAH' }));
      expect(empty.currencies).toEqual([]);
      expect(empty.totalCharged).toEqual(money(0n, 'UAH'));
      expect(empty.spendingTotal).toEqual(money(0n, 'UAH'));
      expect(empty.share).toBeNull();
    } finally {
      a.close();
    }
  });

  test('several purchases and the currency option', async () => {
    const { money } = await moneyModule();

    // No CHF rate of any kind.
    const a = await composed(
      [{ base: 'USD', quote: 'UAH', buy: '40.50', sell: '41.50' }],
      [
        { bankId: 'p1', at: DAY_AT('09:00'), amount: -41000n, original: [-1000n, 'USD'] },
        { bankId: 'p2', at: DAY_AT('09:05'), amount: -420000n, original: [-10000n, 'USD'] },
        { bankId: 'p3', at: DAY_AT('09:10'), amount: -480000n, original: [-10000n, 'CHF'] },
        { bankId: 's1', at: DAY_AT('09:15'), amount: -58000n },
      ],
    );
    try {
      const all = bodyOf(await a.ask({ period: NOVEMBER, displayCurrency: 'UAH' }));
      // By code.
      expect(all.currencies.map((l: any) => l.currency)).toEqual(['CHF', 'USD']);

      // Catches (b) and (c): the CHF purchase is charged but not compared, and names its pair.
      const chf = all.currencies[0];
      expect(chf.purchases).toBe(1);
      expect(chf.charged.count).toBe(1);
      expect(chf.charged.originalTotal).toEqual(money(10000n, 'CHF'));
      expect(chf.charged.totalCharged).toEqual(money(480000n, 'UAH'));
      expect(chf.charged.averageRate.text).toBe('48.0000');
      expect(chf.charged.bestRate.text).toBe('48.0000');
      expect(chf.charged.worstRate.text).toBe('48.0000');
      expect(chf.compared.count).toBe(0);
      expect(chf.compared.marketRate).toBeNull();
      expect(chf.compared.excess).toBeNull();
      expect(chf.compared.excessPercent).toBeNull();
      expect(chf.missingPairs).toEqual([{ from: 'CHF', to: 'UAH' }]);
      expect(chf.unchargedLines).toEqual([]);

      // Catches (a): the average is 461000 / 11000 = '41.9091', not the mean of 41 and 42.
      const usd = all.currencies[1];
      const usdExpected = () => {
        expect(usd.purchases).toBe(2);
        expect(usd.charged.count).toBe(2);
        expect(usd.charged.originalTotal).toEqual(money(11000n, 'USD'));
        expect(usd.charged.totalCharged).toEqual(money(461000n, 'UAH'));
        expect(usd.charged.averageRate.text).toBe('41.9091');
        expect(usd.charged.bestRate.text).toBe('41.0000');
        expect(usd.charged.worstRate.text).toBe('42.0000');
        expect(usd.compared.count).toBe(2);
        expect(usd.compared.originalTotal).toEqual(money(11000n, 'USD'));
        expect(usd.compared.marketTotal).toEqual(money(451000n, 'UAH'));
        expect(usd.compared.marketRate.text).toBe('41.0000');
        expect(usd.compared.excess).toEqual(money(10000n, 'UAH'));
        expect(usd.compared.excessPercent.text).toBe('2.22');
        expect(usd.missingPairs).toEqual([]);
      };
      usdExpected();

      // 941000 x 100 / 999000 = 94.19.
      expect(all.totalCharged).toEqual(money(941000n, 'UAH'));
      expect(all.spendingTotal).toEqual(money(999000n, 'UAH'));
      expect(all.share.text).toBe('94.19%');

      // Catches (d): the option narrows the purchases, never the spending total ('100.00%').
      const only = bodyOf(await a.ask({ period: NOVEMBER, displayCurrency: 'UAH', options: { currency: 'USD' } }));
      expect(only.currencies.map((l: any) => l.currency)).toEqual(['USD']);
      expect(only.currencies[0]).toEqual(usd);
      expect(only.totalCharged).toEqual(money(461000n, 'UAH'));
      expect(only.spendingTotal).toEqual(money(999000n, 'UAH'));
      expect(only.share.text).toBe('46.15%');

      // Refused: a lower-case code, a code not in the table, an unknown option key.
      for (const [options, subject] of [
        [{ currency: 'usd' }, 'currency'],
        [{ currency: 'XYZ' }, 'currency'],
        [{ foo: 1 }, 'foo'],
      ] as const) {
        const r = await a.ask({ period: NOVEMBER, displayCurrency: 'UAH', options });
        expect([options, r.kind, r.reason, r.subject]).toEqual([options, 'refused', 'bad_option', subject]);
      }
    } finally {
      a.close();
    }
  });
});
