// The one currency table (S-21): the 12 declared members with their ISO 4217 numerics and
// exponents, exact lookups by code and numeric, and exponentOf throwing UnknownCurrencyError,
// all from src/money/currencies.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const currencies = () => import('../../src/money/currencies');
const primitives = () => import('../../src/core/primitives');

describe('money/currencies', () => {
  test('currency table is exactly the declared members', async () => {
    const { CURRENCIES, currencyByCode, currencyByNumeric, exponentOf, UnknownCurrencyError } =
      await currencies();
    const { DISPLAY_CURRENCIES } = await primitives();

    const rows = CURRENCIES.map((c) => [c.code, c.numeric, c.exponent] as const)
      .slice()
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    expect(rows).toEqual([
      ['BHD', 48, 3],
      ['CHF', 756, 2],
      ['CZK', 203, 2],
      ['EUR', 978, 2],
      ['GBP', 826, 2],
      ['HUF', 348, 2],
      ['JPY', 392, 0],
      ['KRW', 410, 0],
      ['KWD', 414, 3],
      ['PLN', 985, 2],
      ['UAH', 980, 2],
      ['USD', 840, 2],
    ]);
    expect(rows).toHaveLength(12);

    expect(new Set(CURRENCIES.map((c) => c.code)).size).toBe(12);
    expect(new Set(CURRENCIES.map((c) => c.numeric)).size).toBe(12);

    expect(currencyByNumeric(985)?.code).toBe('PLN');
    expect(currencyByNumeric(980)?.code).toBe('UAH');
    expect(currencyByNumeric(48)?.code).toBe('BHD');
    expect(currencyByNumeric(999)).toBeUndefined();

    expect(currencyByCode('PLN')?.numeric).toBe(985);
    expect(currencyByCode('pln')).toBeUndefined();
    expect(currencyByCode('XYZ')).toBeUndefined();

    expect(exponentOf('JPY')).toBe(0);
    expect(exponentOf('KWD')).toBe(3);
    expect(exponentOf('UAH')).toBe(2);

    for (const d of DISPLAY_CURRENCIES) {
      expect(exponentOf(d)).toBe(2);
    }

    let thrown: unknown;
    try {
      exponentOf('XYZ');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnknownCurrencyError);
    expect((thrown as InstanceType<typeof UnknownCurrencyError>).code).toBe('XYZ');
  });
});
