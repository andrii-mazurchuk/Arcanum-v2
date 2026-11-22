// The one currency table (S-21): each currency's exponent and its ISO 4217 numeric code.
// No other module keeps an exponent or a numeric code of its own; every exponent read goes
// through exponentOf or currencyByCode, every numeric lookup through currencyByNumeric.

import type { CurrencyCode } from '../core/primitives';

export interface CurrencyInfo {
  readonly code: CurrencyCode;
  readonly numeric: number;
  readonly exponent: 0 | 2 | 3;
}

export class UnknownCurrencyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`unknown currency: ${code}`);
    this.name = 'UnknownCurrencyError';
    this.code = code;
  }
}

// Growing the table is adding a member here; a record in a currency absent from it is
// quarantined by its source's translation, never given a guessed exponent.
export const CURRENCIES: readonly CurrencyInfo[] = Object.freeze([
  { code: 'UAH', numeric: 980, exponent: 2 },
  { code: 'PLN', numeric: 985, exponent: 2 },
  { code: 'USD', numeric: 840, exponent: 2 },
  { code: 'EUR', numeric: 978, exponent: 2 },
  { code: 'GBP', numeric: 826, exponent: 2 },
  { code: 'CHF', numeric: 756, exponent: 2 },
  { code: 'CZK', numeric: 203, exponent: 2 },
  { code: 'HUF', numeric: 348, exponent: 2 },
  { code: 'JPY', numeric: 392, exponent: 0 },
  { code: 'KRW', numeric: 410, exponent: 0 },
  { code: 'KWD', numeric: 414, exponent: 3 },
  { code: 'BHD', numeric: 48, exponent: 3 },
].map((c) => Object.freeze(c as CurrencyInfo)));

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));
const BY_NUMERIC = new Map(CURRENCIES.map((c) => [c.numeric, c]));

// Exact, case-sensitive match on the alphabetic code.
export function currencyByCode(code: string): CurrencyInfo | undefined {
  return BY_CODE.get(code);
}

export function currencyByNumeric(n: number): CurrencyInfo | undefined {
  return BY_NUMERIC.get(n);
}

export function exponentOf(code: CurrencyCode): number {
  const info = BY_CODE.get(code);
  if (info === undefined) throw new UnknownCurrencyError(code);
  return info.exponent;
}
