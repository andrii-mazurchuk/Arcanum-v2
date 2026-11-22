// Money context (S-86): one per question object, built from the question's snapshot, calendar and
// display currency over the rate source of record chosen once from the product's built source list,
// never from the question's settings; it collects the shown results and supplies the 'ratesUsed'
// envelope contributor, which closes it. From src/money/context over the converter of
// src/money/converter, the rate view of src/money/rate-view and the list of src/money/rates-used.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { QuestionContext, Settings } from '../../src/core/question';
import type { Snapshot } from '../../src/db/index';

const context = () => import('../../src/money/context');
const recordedRates = () => import('../../src/money/recorded-rates');
const ratesUsed = () => import('../../src/money/rates-used');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');

const RECORDED_AT = Date.parse('2026-11-21T12:00:00Z');
const STATED_FROM = Date.parse('2026-11-20T10:00:00Z');
const NOW = Date.parse('2026-11-21T12:00:00Z');
const DAY = { kind: 'day' as const, day: '2026-11-20' };

const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const SECOND = { id: 'second', capabilities: [] } as const;
const JARS_ONLY = { id: 'other', capabilities: ['jars'] } as const;

// Opens a fresh in-memory store holding, for 'monobank' only, USD-in-UAH buy '41.20' sell '41.2902'
// and PLN-in-UAH cross '10.00', stated from 2026-11-20 10:00Z; runs `body` inside one snapshot on
// the Warsaw calendar.
async function withRates(body: (snap: Snapshot, cal: Calendar) => void): Promise<void> {
  const { ensureRateSchema, recordRates } = await recordedRates();
  const { openStore, MEMORY_LOCATION } = await db();
  const { openCalendar } = await dates();
  const { parseExactDecimal } = await exact();

  const cal = openCalendar(undefined) as Calendar;
  const store = openStore(MEMORY_LOCATION, [ensureRateSchema]);
  store.write((tx) => {
    const res = recordRates(
      tx,
      'monobank',
      [
        {
          pair: { base: 'USD', quote: 'UAH' },
          statedFrom: STATED_FROM,
          figures: { kind: 'buy_sell', buy: parseExactDecimal('41.20')!, sell: parseExactDecimal('41.2902')! },
        },
        {
          pair: { base: 'PLN', quote: 'UAH' },
          statedFrom: STATED_FROM,
          figures: { kind: 'cross', rate: parseExactDecimal('10.00')! },
        },
      ],
      RECORDED_AT,
    );
    expect(res.added).toBe(2);
  });
  try {
    store.readSnapshot((snap) => body(snap, cal));
  } finally {
    store.close();
  }
}

// A hand-built question context displaying PLN; a fresh object on every call.
const ctxFor = (snap: Snapshot, cal: Calendar, settings: Settings): QuestionContext =>
  ({
    snapshot: snap,
    now: NOW,
    settings,
    calendar: cal,
    displayCurrency: 'PLN',
    position: 0,
    register: {},
    scope: { narrowing: { kind: 'all' }, sources: [], holdings: new Set() },
    period: null,
    asker: 'command_line',
    options: {},
  }) as unknown as QuestionContext;

const NO_SOURCES: Settings = { timeZone: undefined, sources: [] };

describe('money/context', () => {
  test("rate source ignores the question's settings", async () => {
    const { createMoneyPart } = await context();
    const { money } = await moneyModule();

    const part = createMoneyPart([MONO, SECOND]);
    expect(part.rateSource).toBe('monobank');

    await withRates((snap, cal) => {
      const contexts = [
        ctxFor(snap, cal, { timeZone: undefined, sources: [] }),
        ctxFor(snap, cal, { timeZone: undefined, sources: ['monobank', 'second'] }),
        ctxFor(snap, cal, { timeZone: undefined, sources: ['second', 'monobank'] }),
      ];
      for (const ctx of contexts) {
        const m = part.moneyFor(ctx);
        expect(m.rateSource).toBe('monobank'); // not null for [], not 'second' when it is listed first
        expect(m.rates.sourceId).toBe('monobank');
        const r = m.converter.convert(money(100n, 'USD'), DAY);
        expect(r.kind).toBe('converted'); // 'second' holds no record: unconverted
        expect((r as any).line).toEqual(money(412n, 'PLN'));
      }
    });
  });

  test('money context identity and closing', async () => {
    const { createMoneyPart, MoneyContextClosedError } = await context();
    const { assembleRatesUsed } = await ratesUsed();
    const { money } = await moneyModule();

    const part = createMoneyPart([MONO]);
    expect(part.ratesUsedContributor.key).toBe('ratesUsed');

    await withRates((snap, cal) => {
      const ctx1 = ctxFor(snap, cal, NO_SOURCES);
      const ctx2 = ctxFor(snap, cal, NO_SOURCES);

      // one context per question object, none shared between questions.
      expect(part.moneyFor(ctx1)).toBe(part.moneyFor(ctx1));
      expect(part.moneyFor(ctx1)).not.toBe(part.moneyFor(ctx2));
      expect(part.moneyFor(ctx1).converter).not.toBe(part.moneyFor(ctx2).converter);

      const m1 = part.moneyFor(ctx1);
      const shownRes = m1.converter.convert(money(100n, 'USD'), DAY);
      const hidden = m1.converter.convert(money(5000n, 'GBP'), DAY); // converted, never shown
      expect(hidden.kind).toBe('unconverted');
      m1.show([shownRes]);

      // what was shown, not every conversion made: two applied items, no not_converted GBP item.
      const items = part.ratesUsedContributor.contribute(ctx1) as unknown[];
      expect(items).toEqual(assembleRatesUsed([shownRes]));
      expect(items.length).toBe(2);

      // the contributor closed the context.
      expect(() => m1.show([shownRes])).toThrow(MoneyContextClosedError);

      // nothing was shown on ctx2.
      expect(part.ratesUsedContributor.contribute(ctx2)).toEqual([]);
    });
  });

  test('built list composition and the rate source', async () => {
    const { createMoneyPart } = await context();
    const { money } = await moneyModule();

    const partOne = createMoneyPart([MONO]);
    const partTwo = createMoneyPart([MONO, SECOND]);
    const partJars = createMoneyPart([MONO, JARS_ONLY]);
    const partNone = createMoneyPart([SECOND]);

    expect(partOne.rateSource).toBe('monobank');
    expect(partTwo.rateSource).toBe('monobank'); // the last built source gives 'second'
    expect(partJars.rateSource).toBe('monobank'); // the last source declaring anything gives 'other'
    expect(partNone.rateSource).toBeNull(); // falling back to any built source gives 'second'

    await withRates((snap, cal) => {
      const run = (part: any) => {
        const ctx = ctxFor(snap, cal, NO_SOURCES);
        const m = part.moneyFor(ctx);
        const r = m.converter.convert(money(100n, 'USD'), DAY);
        m.show([r]);
        const items = part.ratesUsedContributor.contribute(ctx);
        return { m, r, items };
      };

      const one = run(partOne);
      const two = run(partTwo);
      const jars = run(partJars);

      for (const { r } of [one, two, jars]) {
        expect(r.kind).toBe('converted');
        expect(r.line).toEqual(money(412n, 'PLN')); // 100 x 41.2451 / 10.00 = 412.451 -> 412
      }
      expect(two.items).toEqual(one.items);
      expect(jars.items).toEqual(one.items);
      expect(one.items.length).toBe(2);
      expect(one.items[0]).toMatchObject({
        kind: 'applied',
        from: 'UAH',
        to: 'PLN',
        quotedValue: '10.00',
        date: '2026-11-20',
        substituted: false,
      });
      expect(one.items[1]).toMatchObject({
        kind: 'applied',
        from: 'USD',
        to: 'UAH',
        quotedValue: '41.2451',
        date: '2026-11-20',
        substituted: false,
      });

      // no built source offers rates: nothing converts, nothing falls through to another source.
      const none = run(partNone);
      expect(none.r).toEqual({
        kind: 'unconverted',
        original: money(100n, 'USD'),
        pair: { from: 'USD', to: 'PLN' },
      });
      expect(none.items).toEqual([{ kind: 'not_converted', from: 'USD', to: 'PLN' }]);
      expect(none.m.converter.convert(money(100n, 'PLN'), DAY).kind).toBe('same');
    });
  });
});
