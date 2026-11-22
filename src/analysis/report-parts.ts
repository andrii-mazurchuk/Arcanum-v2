// Report parts (S-162): the only figures a report computes itself; every other report figure comes
// from the owning family. The comparison with the previous period as differences of gross ledger
// spending, in total and per category over the union of both spans' categories; the per-day
// average; the weekly day with the most converted spending on local dates and the single largest
// converted transaction, both with earliest-wins ties; and the fixed no-budgets section.

import type { LocalDate, LocalDateTime } from '../core/primitives';
import type { Calendar } from '../analytics/dates';
import type { LedgerLine, PeriodLedger } from '../analytics/ledger';
import type { Span } from '../analytics/periods';
import { averageMinor } from '../analytics/savings';
import { CATEGORIES, type Category } from '../local/classifier';
import { type Money, money, sumMoney } from '../money/money';

export interface CategoryChange {
  readonly category: Category;
  readonly current: Money;
  readonly previous: Money;
  readonly difference: Money;
}

export interface Comparison {
  readonly current: Money;
  readonly previous: Money;
  readonly difference: Money; // current - previous: positive when more was spent
  readonly byCategory: readonly CategoryChange[]; // union of both spans' categories, CATEGORIES order
}

export function compareSpending(ledger: PeriodLedger, current: Span, previous: Span): Comparison {
  const zero = money(0n, ledger.display);
  const diff = (a: Money, b: Money): Money => money(a.minor - b.minor, a.currency);
  const cur = ledger.totals(current).spending;
  const prev = ledger.totals(previous).spending;
  const curBy = ledger.spendingByCategory(current);
  const prevBy = ledger.spendingByCategory(previous);
  const byCategory: CategoryChange[] = [];
  for (const category of CATEGORIES) {
    if (!curBy.has(category) && !prevBy.has(category)) continue;
    const c = curBy.get(category) ?? zero;
    const p = prevBy.get(category) ?? zero;
    byCategory.push({ category, current: c, previous: p, difference: diff(c, p) });
  }
  return { current: cur, previous: prev, difference: diff(cur, prev), byCategory };
}

// days is localDaysIn of the report's period (S-152); null over no days.
export function averagePerDay(total: Money, days: number): Money | null {
  if (days === 0) return null;
  return money(averageMinor(total.minor, days), total.currency);
}

export interface TopDay {
  readonly day: LocalDate;
  readonly spending: Money;
}

// The dated local day with the largest sum of converted spending lines; a tie goes to the earliest
// date, the same earliest-wins rule as the behaviour patterns' busiest hour and weekday.
export function topDay(ledger: PeriodLedger, cal: Calendar, s: Span): TopDay | null {
  const byDay = new Map<LocalDate, Money[]>();
  for (const line of ledger.lines(s, 'spending')) {
    if (line.figure === null) continue;
    const day = cal.localDay(line.at);
    const figures = byDay.get(day);
    if (figures) figures.push(line.figure);
    else byDay.set(day, [line.figure]);
  }
  let best: TopDay | null = null;
  for (const [day, figures] of byDay) {
    const spending = sumMoney(figures, ledger.display);
    if (
      best === null ||
      spending.minor > best.spending.minor ||
      (spending.minor === best.spending.minor && day < best.day)
    ) {
      best = { day, spending };
    }
  }
  return best;
}

export interface LargestTransaction {
  readonly line: LedgerLine;
  readonly localDateTime: LocalDateTime;
}

// The spending line with the largest converted figure (it groups nothing); a tie goes to the
// earlier instant, then the smaller storage position.
export function largestTransaction(ledger: PeriodLedger, cal: Calendar, s: Span): LargestTransaction | null {
  let best: LedgerLine | null = null;
  for (const line of ledger.lines(s, 'spending')) {
    if (line.figure === null) continue;
    if (best === null || beats(line, best)) best = line;
  }
  return best === null ? null : { line: best, localDateTime: cal.localDateTime(best.at) };
}

const beats = (a: LedgerLine, b: LedgerLine): boolean => {
  const fa = a.figure!.minor;
  const fb = b.figure!.minor;
  if (fa !== fb) return fa > fb;
  if (a.at !== b.at) return a.at < b.at;
  return a.tx.position < b.tx.position;
};

export const NO_BUDGETS: { readonly set: false; readonly text: string } = {
  set: false,
  text: 'No budgets are set; there is no way to set one.',
};
