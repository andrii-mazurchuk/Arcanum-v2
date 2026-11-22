// Answer text helpers (S-118): the one letter-case folding of the answering side, with folded
// equality and substring tests, and fractionText, the only place a rate, share or percentage
// becomes display text. Pure.

import { type Fraction, fraction, mulF, roundHalfAwayFromZero } from '../money/exact';

// Upper-casing first maps characters whose lower case alone would not meet (sharp s -> 'SS');
// lower-casing then gives one form. Both use the runtime's full, locale-independent mappings.
export function foldCase(s: string): string {
  return s.normalize('NFC').toUpperCase().toLowerCase();
}

export function foldedEquals(a: string, b: string): boolean {
  return foldCase(a) === foldCase(b);
}

export function foldedIncludes(haystack: string, needle: string): boolean {
  return foldCase(haystack).includes(foldCase(needle));
}

// n = f x 10^d rounded half away from zero; '-' only when n < 0, so no negative zero; digits of
// |n| padded to d + 1 with '.' before the last d.
export function fractionText(f: Fraction, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new RangeError(`fractionText: decimals must be a whole number from 0 to 12, got ${decimals}`);
  }
  const n = roundHalfAwayFromZero(mulF(f, fraction(10n ** BigInt(decimals), 1n)));
  const digits = (n < 0n ? -n : n).toString().padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  const body = decimals > 0 ? `${digits.slice(0, cut)}.${digits.slice(cut)}` : digits;
  return n < 0n ? `-${body}` : body;
}
