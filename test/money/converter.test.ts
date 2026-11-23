// Converter (S-85): one per answer, the route chosen by whether the direct pair is held at all,
// each leg's record the rate of some held day with substitution marked, exact fractions, one
// half-away-from-zero rounding per line and provenance on every result, from src/money/converter
// over the rate view of src/money/rate-view and the recorded rates of src/money/recorded-rates.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const converter = () => import('../../src/money/converter');
const rateView = () => import('../../src/money/rate-view');
const recordedRates = () => import('../../src/money/recorded-rates');
const ratesUsed = () => import('../../src/money/rates-used');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');
const primitives = () => import('../../src/core/primitives');

const RECORDED_AT = Date.parse('2026-11-21T12:00:00Z');
const STATED = '2026-11-20T10:00:00Z';

type Rec =
  | { base: string; quote: string; at: string; cross: string }
  | { base: string; quote: string; at: string; buy: string; sell: string };

// Opens a fresh in-memory store holding `records` for 'monobank', and runs `body` with a converter
// for `display` over a rate view opened inside one snapshot, on the Warsaw calendar.
async function withConverter(
  records: readonly Rec[],
  display: string,
  body: (c: any, cal: any) => void,
): Promise<void> {
  const { createConverter } = await converter();
  const { openRateView } = await rateView();
  const { ensureRateSchema, recordRates } = await recordedRates();
  const { openStore, MEMORY_LOCATION } = await db();
  const { openCalendar } = await dates();
  const { parseExactDecimal } = await exact();
  const { isRefusal } = await primitives();

  const opened = openCalendar(undefined);
  expect(isRefusal(opened)).toBe(false);
  const cal = opened as any;

  const stated = records.map((r) => ({
    pair: { base: r.base, quote: r.quote },
    statedFrom: Date.parse(r.at),
    figures:
      'cross' in r
        ? { kind: 'cross' as const, rate: parseExactDecimal(r.cross)! }
        : { kind: 'buy_sell' as const, buy: parseExactDecimal(r.buy)!, sell: parseExactDecimal(r.sell)! },
  }));

  const store = openStore(MEMORY_LOCATION, [ensureRateSchema]);
  store.write((tx) => {
    const res = recordRates(tx, 'monobank', stated, RECORDED_AT);
    expect(res.added).toBe(records.length);
  });
  store.readSnapshot((snap) => {
    const c = createConverter(openRateView(snap, cal, 'monobank'), cal, display as any);
    expect<any>(c.display).toBe(display);
    body(c, cal);
  });
  store.close();
}

describe('money/converter', () => {
  test('converter worked cases', async () => {
    const { decimalToString, fraction, fractionsEqual } = await exact();
    const { money, sumMoney, formatMoney } = await moneyModule();
    const d = '2026-11-20';
    const day = { kind: 'day' as const, day: d };

    // 1. a buy/sell pair converts at its midpoint, rounded once.
    await withConverter([{ base: 'USD', quote: 'UAH', at: STATED, buy: '41.10', sell: '41.311' }], 'UAH', (c) => {
      const r = c.convert(money(100n, 'USD'), day);
      expect(r.kind).toBe('converted');
      expect(r.original).toEqual(money(100n, 'USD'));
      expect(r.line).toEqual(money(4121n, 'UAH')); // 100 x 41.2055 = 4120.55 -> 4121, not 4110 at buy
      expect(r.legs.length).toBe(1);
      expect(r.legs[0].applied).toEqual({ from: 'USD', to: 'UAH' });
      expect(r.legs[0].quoted).toEqual({ base: 'USD', quote: 'UAH' });
      expect(decimalToString(r.legs[0].quotedValue)).toBe('41.2055');
      expect(r.legs[0].recordDate).toBe(d);
      expect(r.legs[0].substituted).toBe(false);

      const lines = [1, 2, 3].map(() => c.convert(money(100n, 'USD'), day).line);
      expect(formatMoney(sumMoney(lines, 'UAH'))).toBe('123.63 UAH');
    });

    // 2. built through the hryvnia: no rounding between legs, midpoint trailing zero removed.
    await withConverter(
      [
        { base: 'USD', quote: 'UAH', at: STATED, buy: '41.20', sell: '41.2902' },
        { base: 'PLN', quote: 'UAH', at: STATED, cross: '10.00' },
      ],
      'PLN',
      (c) => {
        const r = c.convert(money(100n, 'USD'), day);
        expect(r.kind).toBe('converted');
        expect(r.line).toEqual(money(412n, 'PLN')); // 412.451 -> 412; rounding the UAH leg first gives 413
        expect(r.legs.length).toBe(2);
        expect(r.legs[0].applied).toEqual({ from: 'USD', to: 'UAH' });
        expect(r.legs[0].quoted).toEqual({ base: 'USD', quote: 'UAH' });
        expect(decimalToString(r.legs[0].quotedValue)).toBe('41.2451'); // not '41.24510'
        expect(r.legs[1].applied).toEqual({ from: 'UAH', to: 'PLN' });
        expect(r.legs[1].quoted).toEqual({ base: 'PLN', quote: 'UAH' });
        expect(decimalToString(r.legs[1].quotedValue)).toBe('10.00');
        expect(fractionsEqual(r.legs[1].appliedValue, fraction(1n, 10n))).toBe(true);
      },
    );

    // 3. each line rounded on its own; the total is the sum of the lines.
    await withConverter([{ base: 'USD', quote: 'PLN', at: STATED, cross: '3.6555' }], 'PLN', (c) => {
      const lines = [1, 2, 3].map(() => c.convert(money(100n, 'USD'), day).line);
      for (const line of lines) expect(line).toEqual(money(366n, 'PLN'));
      const total = sumMoney(lines, 'PLN');
      expect(total).toEqual(money(1098n, 'PLN')); // converting 300 gives 1096.65 -> 1097
      expect(formatMoney(total)).toBe('10.98 PLN');
    });

    // 4. the exponent difference between the currencies is applied.
    await withConverter(
      [
        { base: 'JPY', quote: 'UAH', at: STATED, cross: '0.28' },
        { base: 'PLN', quote: 'UAH', at: STATED, cross: '10.00' },
      ],
      'PLN',
      (c) => {
        const r = c.convert(money(1234n, 'JPY'), day);
        expect(r.kind).toBe('converted');
        expect(r.line).toEqual(money(3455n, 'PLN')); // 1234 x 10^2 x 0.28 / 10 = 3455.2; without 10^2, 35
      },
    );

    // 5. no record of the currency at all: unconverted.
    await withConverter([{ base: 'PLN', quote: 'UAH', at: STATED, cross: '10.00' }], 'PLN', (c) => {
      expect(c.convert(money(5000n, 'GBP'), day)).toEqual({
        kind: 'unconverted',
        original: money(5000n, 'GBP'),
        pair: { from: 'GBP', to: 'PLN' },
      });
    });

    // 6. already in the display currency: same.
    await withConverter([{ base: 'PLN', quote: 'UAH', at: STATED, cross: '10.00' }], 'PLN', (c) => {
      expect(c.convert(money(123n, 'PLN'), day)).toEqual({
        kind: 'same',
        original: money(123n, 'PLN'),
        line: money(123n, 'PLN'),
      });
    });
  });

  test('converter substitution', async () => {
    const { decimalToString, fraction, fractionsEqual } = await exact();
    const { money } = await moneyModule();
    await converter(); // the converter's absence is this test's first failure, before rates-used's
    const { assembleRatesUsed } = await ratesUsed();

    await withConverter(
      [
        { base: 'PLN', quote: 'UAH', at: '2026-11-16T08:00:00Z', cross: '10.00' }, // Warsaw 09:00
        { base: 'PLN', quote: 'UAH', at: '2026-11-16T14:00:00Z', cross: '10.10' }, // Warsaw 15:00
        { base: 'PLN', quote: 'UAH', at: '2026-11-20T11:00:00Z', cross: '10.50' },
      ],
      'PLN',
      (c) => {
        const a = money(1000n, 'UAH');
        const leg = (r: any) => r.legs[0];
        const on = (day: string) => c.convert(a, { kind: 'day', day });

        // before the first held day: the earliest day's last record, marked.
        const r15 = on('2026-11-15');
        expect(r15.line).toEqual(money(99n, 'PLN')); // 1000 / 10.10 = 99.0099; '10.00' gives 100
        expect(decimalToString(leg(r15).quotedValue)).toBe('10.10');
        expect(leg(r15).recordDate).toBe('2026-11-16');
        expect(leg(r15).substituted).toBe(true);
        expect(fractionsEqual(leg(r15).appliedValue, fraction(10n, 101n))).toBe(true); // not 1000 x 10.10

        const r16 = on('2026-11-16');
        expect(r16.line).toEqual(money(99n, 'PLN'));
        expect(decimalToString(leg(r16).quotedValue)).toBe('10.10');
        expect(leg(r16).recordDate).toBe('2026-11-16');
        expect(leg(r16).substituted).toBe(false);

        // no record that day: the nearest earlier day, not the later or latest one, marked.
        const r18 = on('2026-11-18');
        expect(r18.line).toEqual(money(99n, 'PLN')); // '10.50' gives 95
        expect(decimalToString(leg(r18).quotedValue)).toBe('10.10');
        expect(leg(r18).recordDate).toBe('2026-11-16');
        expect(leg(r18).substituted).toBe(true);

        const r20 = on('2026-11-20');
        expect(r20.line).toEqual(money(95n, 'PLN')); // 1000 / 10.50 = 95.238
        expect(leg(r20).recordDate).toBe('2026-11-20');
        expect(leg(r20).substituted).toBe(false);

        const rLatest = c.convert(a, { kind: 'latest' });
        expect(rLatest.line).toEqual(money(95n, 'PLN'));
        expect(decimalToString(leg(rLatest).quotedValue)).toBe('10.50');
        expect(leg(rLatest).substituted).toBe(false);

        const items = assembleRatesUsed([r15, r16, r18, r20, rLatest]);
        expect(items.length).toBe(2);
        expect(items[0]).toMatchObject({
          kind: 'applied',
          from: 'UAH',
          to: 'PLN',
          quotedValue: '10.10',
          date: '2026-11-16',
          substituted: true,
        });
        expect(items[1]).toMatchObject({
          kind: 'applied',
          from: 'UAH',
          to: 'PLN',
          quotedValue: '10.50',
          date: '2026-11-20',
          substituted: false,
        });
      },
    );
  });

  test('converter route and reverse direction', async () => {
    const { fraction, fractionsEqual } = await exact();
    const { money } = await moneyModule();

    // A. a held direct pair is used even substituted, before the hryvnia legs held that day.
    await withConverter(
      [
        { base: 'USD', quote: 'PLN', at: '2026-11-20T11:00:00Z', cross: '3.6555' },
        { base: 'USD', quote: 'UAH', at: '2026-11-18T11:00:00Z', cross: '41.00' },
        { base: 'PLN', quote: 'UAH', at: '2026-11-18T11:00:00Z', cross: '10.00' },
      ],
      'PLN',
      (c) => {
        const r = c.convert(money(100n, 'USD'), { kind: 'day', day: '2026-11-18' });
        expect(r.line).toEqual(money(366n, 'PLN')); // the hryvnia route gives 410 with two legs
        expect(r.legs.length).toBe(1);
        expect(r.legs[0].quoted).toEqual({ base: 'USD', quote: 'PLN' });
        expect(r.legs[0].recordDate).toBe('2026-11-20');
        expect(r.legs[0].substituted).toBe(true);
      },
    );

    // B. the reverse direction of a quoted pair at its exact reciprocal.
    await withConverter([{ base: 'USD', quote: 'UAH', at: '2026-11-20T11:00:00Z', cross: '40.00' }], 'USD', (c) => {
      const r = c.convert(money(4000n, 'UAH'), { kind: 'day', day: '2026-11-20' });
      expect(r.line).toEqual(money(100n, 'USD')); // 4000 x 40 gives 160000
      expect(r.legs[0].applied).toEqual({ from: 'UAH', to: 'USD' });
      expect(r.legs[0].quoted).toEqual({ base: 'USD', quote: 'UAH' });
      expect(fractionsEqual(r.legs[0].appliedValue, fraction(1n, 40n))).toBe(true);
      expect(r.legs[0].substituted).toBe(false);
    });

    // C. no route through another currency when the amount is in the hryvnia.
    await withConverter(
      [
        { base: 'USD', quote: 'UAH', at: '2026-11-20T11:00:00Z', cross: '41.00' },
        { base: 'USD', quote: 'PLN', at: '2026-11-20T11:00:00Z', cross: '3.70' },
      ],
      'PLN',
      (c) => {
        expect(c.convert(money(1000n, 'UAH'), { kind: 'day', day: '2026-11-20' })).toEqual({
          kind: 'unconverted',
          original: money(1000n, 'UAH'),
          pair: { from: 'UAH', to: 'PLN' }, // UAH -> USD -> PLN would give 90
        });
      },
    );
  });
});
