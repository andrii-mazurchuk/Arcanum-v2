// The Money value (S-22): a bigint count of minor units plus a currency code. Same-currency
// addition is exact; adding two currencies throws. parseMinorUnits converts a decimal figure as
// written, digit by digit, and formatMoney is the only formatter of amounts in the product.

import type { CurrencyCode } from '../core/primitives';
import { currencyByCode, exponentOf, UnknownCurrencyError } from './currencies';
import { parseExactDecimal } from './exact';

export interface Money {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  readonly left: string;
  readonly right: string;

  constructor(left: string, right: string) {
    super(`currency mismatch: ${left} and ${right}`);
    this.name = 'CurrencyMismatchError';
    this.left = left;
    this.right = right;
  }
}

export function money(minor: bigint, currency: CurrencyCode): Money {
  if (currencyByCode(currency) === undefined) throw new UnknownCurrencyError(currency);
  return { minor, currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function sumMoney(items: readonly Money[], currency: CurrencyCode): Money {
  let total = money(0n, currency);
  for (const item of items) total = addMoney(total, item);
  return total;
}

export function negateMoney(m: Money): Money {
  return { minor: -m.minor, currency: m.currency };
}

export type MinorParseFailure = 'malformed' | 'excess_precision' | 'unknown_currency';
export type MinorParse =
  | { ok: true; money: Money }
  | { ok: false; reason: MinorParseFailure; detail: string };

// Currency first, then the grammar, then the precision: digits beyond the exponent are dropped
// only when they are all zeros.
export function parseMinorUnits(text: string, currency: string): MinorParse {
  const info = currencyByCode(currency);
  if (info === undefined) {
    return {
      ok: false,
      reason: 'unknown_currency',
      detail: `${text} ${currency}: currency not in the table`,
    };
  }
  const d = parseExactDecimal(text);
  if (d === null) {
    return { ok: false, reason: 'malformed', detail: `${text} ${currency}: not a decimal figure` };
  }
  const e = info.exponent;
  if (d.scale <= e) {
    return { ok: true, money: { minor: d.digits * 10n ** BigInt(e - d.scale), currency } };
  }
  const drop = 10n ** BigInt(d.scale - e);
  if (d.digits % drop !== 0n) {
    return {
      ok: false,
      reason: 'excess_precision',
      detail: `${text} ${currency}: non-zero digit beyond the currency's ${e} decimal places`,
    };
  }
  return { ok: true, money: { minor: d.digits / drop, currency } };
}

export function formatMoney(m: Money): string {
  const e = exponentOf(m.currency);
  const neg = m.minor < 0n;
  const abs = (neg ? -m.minor : m.minor).toString();
  let body: string;
  if (e === 0) {
    body = abs;
  } else {
    const padded = abs.padStart(e + 1, '0');
    const cut = padded.length - e;
    body = `${padded.slice(0, cut)}.${padded.slice(cut)}`;
  }
  return `${neg ? '-' : ''}${body} ${m.currency}`;
}
