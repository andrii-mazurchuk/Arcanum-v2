// Recorded rates (S-112): the rate table keyed by (source, pair, heldFrom), filled by the
// insert-if-absent recorder inside the store's one write, from src/money/recorded-rates over the
// store of src/db.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const recordedRates = () => import('../../src/money/recorded-rates');
const db = () => import('../../src/db/index');
const exact = () => import('../../src/money/exact');

describe('money/recorded-rates', () => {
  test('recordRates is insert-if-absent and exact', async () => {
    const { ensureRateSchema, recordRates, readRecordedRate } = await recordedRates();
    const { openStore, MEMORY_LOCATION } = await db();
    const { parseExactDecimal, decimalToString } = await exact();
    const p = (text: string) => parseExactDecimal(text)!;

    const store = openStore(MEMORY_LOCATION, [ensureRateSchema]);
    expect(() => store.write((tx) => ensureRateSchema(tx.db))).not.toThrow();

    const T1 = Date.parse('2026-11-20T08:00:00Z');
    const R = Date.parse('2026-11-20T10:00:00Z');

    const first = store.write((tx) =>
      recordRates(
        tx,
        'monobank',
        [
          {
            pair: { base: 'USD', quote: 'UAH' },
            statedFrom: T1,
            figures: { kind: 'buy_sell', buy: p('41.10'), sell: p('41.311') },
          },
          { pair: { base: 'PLN', quote: 'UAH' }, figures: { kind: 'cross', rate: p('10.00') } },
          {
            pair: { base: 'UAH', quote: 'UAH' },
            statedFrom: T1,
            figures: { kind: 'cross', rate: p('1') },
          },
          {
            pair: { base: 'XYZ', quote: 'UAH' },
            statedFrom: T1,
            figures: { kind: 'cross', rate: p('1') },
          },
          {
            pair: { base: 'EUR', quote: 'UAH' },
            statedFrom: T1,
            figures: { kind: 'cross', rate: p('0') },
          },
          {
            pair: { base: 'EUR', quote: 'UAH' },
            statedFrom: R,
            figures: { kind: 'buy_sell', buy: p('-1'), sell: p('2') },
          },
        ],
        R,
      ),
    );
    expect(first).toEqual({ added: 2, alreadyHeld: 0, rejected: 4 });

    const second = store.write((tx) =>
      recordRates(
        tx,
        'monobank',
        [
          {
            pair: { base: 'USD', quote: 'UAH' },
            statedFrom: T1,
            figures: { kind: 'buy_sell', buy: p('50.00'), sell: p('50.10') },
          },
        ],
        R + 60000,
      ),
    );
    expect(second).toEqual({ added: 0, alreadyHeld: 1, rejected: 0 });

    const held = store.readSnapshot((snap) =>
      snap.db.query('SELECT * FROM rate_snapshot ORDER BY base').all().map(readRecordedRate),
    );
    expect(held).toHaveLength(2);

    const [pln, usd] = held;
    expect(pln!.sourceId).toBe('monobank');
    expect(pln!.base).toBe('PLN');
    expect(pln!.quote).toBe('UAH');
    expect(pln!.heldFrom).toBe(R);
    expect(pln!.figures.kind).toBe('cross');
    if (pln!.figures.kind !== 'cross') throw new Error('PLN row is not a cross rate');
    expect(decimalToString(pln!.figures.rate)).toBe('10.00');

    expect(usd!.sourceId).toBe('monobank');
    expect(usd!.base).toBe('USD');
    expect(usd!.quote).toBe('UAH');
    expect(usd!.heldFrom).toBe(T1);
    expect(usd!.figures.kind).toBe('buy_sell');
    if (usd!.figures.kind !== 'buy_sell') throw new Error('USD row is not a buy/sell rate');
    expect(decimalToString(usd!.figures.buy)).toBe('41.10');
    expect(decimalToString(usd!.figures.sell)).toBe('41.311');

    store.close();
  });

  test("recordRates commits only with the caller's write", async () => {
    const { ensureRateSchema, recordRates } = await recordedRates();
    const { openStore, MEMORY_LOCATION } = await db();
    const { parseExactDecimal } = await exact();

    const store = openStore(MEMORY_LOCATION, [ensureRateSchema]);
    const R = Date.parse('2026-11-20T10:00:00Z');
    const stated = [
      {
        pair: { base: 'USD', quote: 'UAH' },
        statedFrom: R,
        figures: { kind: 'cross' as const, rate: parseExactDecimal('41.00')! },
      },
    ];

    let caught: unknown;
    try {
      store.write((tx) => {
        recordRates(tx, 'monobank', stated, R);
        throw new Error('later step failed');
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('later step failed');

    const count = store.readSnapshot(
      (snap) => snap.db.query('SELECT COUNT(*) AS n FROM rate_snapshot').get() as { n: number },
    );
    expect(count.n).toBe(0);

    const again = store.write((tx) => recordRates(tx, 'monobank', stated, R));
    expect(again).toEqual({ added: 1, alreadyHeld: 0, rejected: 0 });

    store.close();
  });
});
