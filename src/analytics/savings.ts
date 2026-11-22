// Exact measures (S-154): trend direction by integer cross-multiplication, the savings rate in
// whole tenths of a percent rounded once half away from zero, its text, the low-savings severity
// judged on those same tenths, and the shown average. Pure over minor-unit bigints; no JS number
// holds an amount or a ratio.

import { fraction, roundHalfAwayFromZero } from '../money/exact';

export type Direction = 'rising' | 'falling' | 'stable';

// f is the first window month with spending, so f > 0n; l may be 0n. Exactly 5% either way is stable.
export function directionOf(first: bigint, last: bigint): Direction {
  if (first <= 0n) throw new RangeError('directionOf: first must be positive');
  if (last * 100n > first * 105n) return 'rising';
  if (last * 100n < first * 95n) return 'falling';
  return 'stable';
}

export interface SavingsRate {
  readonly income: bigint; // sum of the month's converted income lines
  readonly spending: bigint; // the month's gross total spending (refunds do not reduce it)
  readonly net: bigint; // income - spending, exact
  readonly tenths: bigint; // the rate in whole tenths of a percent; 0n when income is 0n
  readonly text: string; // tenthsText(tenths)
}

export function savingsRate(income: bigint, spending: bigint): SavingsRate {
  const net = income - spending;
  const tenths = income === 0n ? 0n : roundHalfAwayFromZero(fraction(net * 1000n, income));
  return { income, spending, net, tenths, text: tenthsText(tenths) };
}

export function tenthsText(tenths: bigint): string {
  const neg = tenths < 0n;
  const abs = neg ? -tenths : tenths;
  return `${neg ? '-' : ''}${abs / 10n}.${abs % 10n}%`;
}

// Judged on the rounded tenths the answer shows, never the exact fraction.
export function lowSavingsSeverity(r: SavingsRate): 'alert' | 'warning' | null {
  if (r.income === 0n) return null;
  if (r.tenths < 100n) return 'alert';
  if (r.tenths < 200n) return 'warning';
  return null;
}

// For display only; no tier or direction reads it.
export function averageMinor(sum: bigint, n: number): bigint {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('averageMinor: n must be a whole number >= 1');
  return roundHalfAwayFromZero(fraction(sum, BigInt(n)));
}
