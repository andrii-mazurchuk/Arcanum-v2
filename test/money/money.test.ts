// The Money value (S-22): a bigint count of minor units plus a currency code, exact
// same-currency arithmetic, the decimal-text-to-minor-units parser and the one formatter,
// all from src/money/money.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const moneyModule = () => import('../../src/money/money');
const currencies = () => import('../../src/money/currencies');

describe('money/money', () => {
  test('parseMinorUnits translates exactly or says why not', async () => {
    const { parseMinorUnits } = await moneyModule();

    const ok: readonly (readonly [string, string, bigint])[] = [
      ['12.34', 'PLN', 1234n],
      ['0.1', 'UAH', 10n],
      ['1.230', 'PLN', 123n],
      ['5', 'JPY', 5n],
      ['-2.35', 'PLN', -235n],
      ['1.5', 'KWD', 1500n],
    ];
    for (const [text, currency, minor] of ok) {
      expect(parseMinorUnits(text, currency)).toEqual({ ok: true, money: { minor, currency } });
    }

    const failures: readonly (readonly [string, string, string])[] = [
      ['1.235', 'PLN', 'excess_precision'],
      ['5.5', 'JPY', 'excess_precision'],
      ['1.5', 'XYZ', 'unknown_currency'],
      ['1.5', 'pln', 'unknown_currency'],
      ['1e3', 'PLN', 'malformed'],
      ['1,50', 'PLN', 'malformed'],
      // Currency is checked before the grammar and before the precision.
      ['1e3', 'XYZ', 'unknown_currency'],
      ['1.235', 'XYZ', 'unknown_currency'],
    ];
    for (const [text, currency, reason] of failures) {
      const result = parseMinorUnits(text, currency);
      expect({ text, currency, ok: result.ok }).toEqual({ text, currency, ok: false });
      if (result.ok) continue;
      expect({ text, currency, reason: result.reason }).toEqual({ text, currency, reason });
      expect(result.detail).toContain(text);
      expect(result.detail).toContain(currency);
    }
  });

  test('formatMoney formats every exponent and sign', async () => {
    const { formatMoney, money, sumMoney } = await moneyModule();

    const cases: readonly (readonly [bigint, string, string])[] = [
      [100n, 'UAH', '1.00 UAH'],
      [-235n, 'PLN', '-2.35 PLN'],
      [5n, 'USD', '0.05 USD'],
      [-5n, 'USD', '-0.05 USD'],
      [1234n, 'JPY', '1234 JPY'],
      [1234n, 'KWD', '1.234 KWD'],
      [0n, 'EUR', '0.00 EUR'],
      [123456789n, 'PLN', '1234567.89 PLN'],
    ];
    for (const [minor, code, text] of cases) {
      expect(formatMoney(money(minor, code))).toBe(text);
    }

    const ten = Array.from({ length: 10 }, () => money(10n, 'UAH'));
    const total = sumMoney(ten, 'UAH');
    expect(total).toEqual({ minor: 100n, currency: 'UAH' });
    expect(formatMoney(total)).toBe('1.00 UAH');
  });

  test('money arithmetic stays in one currency', async () => {
    const { money, addMoney, sumMoney, negateMoney, CurrencyMismatchError } = await moneyModule();
    const { UnknownCurrencyError } = await currencies();

    expect(() => money(1n, 'XYZ')).toThrow(UnknownCurrencyError);

    expect(addMoney(money(150n, 'PLN'), money(250n, 'PLN'))).toEqual({
      minor: 400n,
      currency: 'PLN',
    });
    expect(negateMoney(money(150n, 'PLN'))).toEqual({ minor: -150n, currency: 'PLN' });

    let thrown: unknown;
    try {
      addMoney(money(1n, 'PLN'), money(1n, 'UAH'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CurrencyMismatchError);
    const mismatch = thrown as InstanceType<typeof CurrencyMismatchError>;
    expect(mismatch.left).toBe('PLN');
    expect(mismatch.right).toBe('UAH');

    expect(sumMoney([], 'EUR')).toEqual({ minor: 0n, currency: 'EUR' });

    expect(() => sumMoney([money(1n, 'PLN'), money(1n, 'UAH')], 'PLN')).toThrow(
      CurrencyMismatchError,
    );
    expect(() => sumMoney([money(1n, 'UAH')], 'PLN')).toThrow(CurrencyMismatchError);
  });
});
