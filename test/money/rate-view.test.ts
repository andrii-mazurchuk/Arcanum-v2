// Rate view (S-84): bounded per-answer lookups over one rate source's recorded rates, days drawn by
// the question's Calendar, and the choice of the rate source of record from the built source list,
// from src/money/rate-view over the recorded rates of src/money/recorded-rates and the store of
// src/db.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const rateView = () => import('../../src/money/rate-view');
const recordedRates = () => import('../../src/money/recorded-rates');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const exact = () => import('../../src/money/exact');
const primitives = () => import('../../src/core/primitives');

describe('money/rate-view', () => {
  test('chooseRateSource follows build order', async () => {
    const { chooseRateSource } = await rateView();

    const mono = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
    const second = { id: 'second', capabilities: [] } as const;
    const other = { id: 'other', capabilities: ['rates'] } as const;

    expect(chooseRateSource([mono, second] as any)).toBe('monobank');
    expect(chooseRateSource([second, mono] as any)).toBe('monobank');
    expect(chooseRateSource([second] as any)).toBe(null);
    expect(chooseRateSource([])).toBe(null);
    expect(chooseRateSource([mono, other] as any)).toBe('monobank');
    expect(chooseRateSource([other, mono] as any)).toBe('other');
    expect(chooseRateSource([mono, other, second] as any)).toBe('monobank');

    expect(chooseRateSource.length).toBe(1);
  });

  test('rate view lookups by Warsaw day', async () => {
    const { openRateView } = await rateView();
    const { ensureRateSchema, recordRates } = await recordedRates();
    const { openStore, MEMORY_LOCATION } = await db();
    const { openCalendar } = await dates();
    const { parseExactDecimal, decimalToString } = await exact();
    const { isRefusal } = await primitives();

    const opened = openCalendar(undefined);
    expect(isRefusal(opened)).toBe(false);
    const cal = opened as any;

    const store = openStore(MEMORY_LOCATION, [ensureRateSchema]);
    const cross = (rate: string, at: string) => ({
      pair: { base: 'PLN', quote: 'UAH' },
      statedFrom: Date.parse(at),
      figures: { kind: 'cross' as const, rate: parseExactDecimal(rate)! },
    });
    const R = Date.parse('2026-11-21T12:00:00Z');

    store.write((tx) => {
      recordRates(
        tx,
        'monobank',
        [
          cross('10.00', '2026-11-18T12:00:00Z'), // Warsaw 2026-11-18 13:00
          cross('10.10', '2026-11-19T23:30:00Z'), // Warsaw 2026-11-20 00:30
          cross('10.20', '2026-11-20T12:00:00Z'), // Warsaw 2026-11-20 13:00
          cross('10.30', '2026-11-20T23:00:00Z'), // Warsaw 2026-11-21 00:00
        ],
        R,
      );
      recordRates(tx, 'second', [cross('10.99', '2026-11-19T12:00:00Z')], R);
    });

    store.readSnapshot((snap) => {
      const v = openRateView(snap, cal, 'monobank');
      const pair = { base: 'PLN', quote: 'UAH' };
      const returned: any[] = [];
      const seen = (dr: any) => {
        expect(dr).not.toBeNull();
        returned.push(dr);
        return dr;
      };
      const val = (dr: any) => decimalToString(dr.record.figures.rate);

      expect(v.sourceId).toBe('monobank');

      const day20 = seen(v.rateOfDay(pair, '2026-11-20'));
      expect(val(day20)).toBe('10.20');
      expect(day20.day).toBe('2026-11-20');

      expect(v.rateOfDay(pair, '2026-11-19')).toBe(null);

      const day21 = seen(v.rateOfDay(pair, '2026-11-21'));
      expect(val(day21)).toBe('10.30');
      expect(day21.day).toBe('2026-11-21');

      const beforeDay20 = seen(v.latestBefore(pair, cal.startOfDay('2026-11-20')));
      expect(val(beforeDay20)).toBe('10.00');
      expect(beforeDay20.day).toBe('2026-11-18');

      const beforeR2 = seen(v.latestBefore(pair, Date.parse('2026-11-19T23:30:00Z')));
      expect(val(beforeR2)).toBe('10.00');

      const first = seen(v.earliest(pair));
      expect(val(first)).toBe('10.00');
      expect(first.day).toBe('2026-11-18');

      const last = seen(v.latest(pair));
      expect(val(last)).toBe('10.30');
      expect(last.day).toBe('2026-11-21');

      expect(v.hasAny(pair)).toBe(true);
      expect(v.hasAny({ base: 'UAH', quote: 'PLN' })).toBe(false);
      expect(v.hasAny({ base: 'USD', quote: 'PLN' })).toBe(false);

      for (const dr of returned) expect(dr.record.sourceId).toBe('monobank');

      const w = openRateView(snap, cal, null);
      expect(w.sourceId).toBe(null);
      expect(w.hasAny(pair)).toBe(false);
      expect(w.rateOfDay(pair, '2026-11-20')).toBe(null);
      expect(w.latestBefore(pair, Date.parse('2026-11-21T00:00:00Z'))).toBe(null);
      expect(w.earliest(pair)).toBe(null);
      expect(w.latest(pair)).toBe(null);
    });

    store.close();
  });
});
