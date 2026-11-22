// Trends family (S-159): the complete window months oldest first plus the month in progress, all
// from one period ledger; per month the spending by category, income, net savings and savings
// rate, and the tier flags against its own 3 months before (the month in progress included); per
// category the average over complete months only and the direction from its first window month
// with spending to the last complete month. monthFigures and tierFlags are also what the health
// family and both reports call, so a month's figures agree everywhere.

import type { CurrencyCode, DisplayCurrency } from '../core/primitives';
import { isRefusal, refuse } from '../core/primitives';
import type { Family } from '../core/question';
import { type CountedKind, type PeriodLedger, buildLedger } from '../analytics/ledger';
import { type AnalysisPeriod, BASELINE_MONTHS, type Span, monthsBefore, trendsMonths, trendsWindow } from '../analytics/periods';
import { type Direction, type SavingsRate, averageMinor, directionOf, savingsRate } from '../analytics/savings';
import { type Tier, tierOf } from '../analytics/trends';
import { CATEGORIES, type Category } from '../local/classifier';
import type { MoneyContext, MoneyPart } from '../money/context';
import { type Money, money, sumMoney } from '../money/money';

export interface CategorySpend {
  readonly category: Category;
  readonly spending: Money;
}

export interface MonthFigures {
  readonly period: AnalysisPeriod; // carries label, firstDay, lastDay and partial
  readonly byCategory: readonly CategorySpend[]; // keys of spendingByCategory, CATEGORIES order
  readonly spending: Money; // gross total spending (ledger totals)
  readonly income: Money;
  readonly netSavings: Money; // income - spending, display currency
  readonly savingsRate: SavingsRate; // savingsRate(income.minor, spending.minor)
}

export function monthFigures(ledger: PeriodLedger, p: AnalysisPeriod): MonthFigures {
  const totals = ledger.totals(p);
  const byCategory = [...ledger.spendingByCategory(p)].map(([category, spending]) => ({ category, spending }));
  return {
    period: p,
    byCategory,
    spending: totals.spending,
    income: totals.income,
    netSavings: money(totals.income.minor - totals.spending.minor, ledger.display),
    savingsRate: savingsRate(totals.income.minor, totals.spending.minor),
  };
}

export interface TierFlag {
  readonly category: Category;
  readonly tier: Tier;
  readonly spending: Money;
  readonly baselineAverage: Money; // averageMinor(S, n), display only
}

export function tierFlags(ledger: PeriodLedger, judged: Span, baseline: readonly Span[]): TierFlag[] {
  const n = baseline.length;
  const current = ledger.spendingByCategory(judged);
  const before = baseline.map((s) => ledger.spendingByCategory(s));
  const flags: TierFlag[] = [];
  for (const category of CATEGORIES) {
    if (!current.has(category) && !before.some((m) => m.has(category))) continue;
    const x = current.get(category)?.minor ?? 0n;
    let sum = 0n;
    for (const m of before) sum += m.get(category)?.minor ?? 0n;
    const tier = tierOf(x, sum, n);
    if (tier === null) continue;
    flags.push({
      category,
      tier,
      spending: money(x, ledger.display),
      baselineAverage: money(averageMinor(sum, n), ledger.display),
    });
  }
  return flags;
}

export interface TrendsMonth extends MonthFigures {
  readonly flags: readonly TierFlag[];
}

export interface CategoryTrend {
  readonly category: Category;
  readonly average: Money;
  readonly direction: Direction;
}

export interface TrendsBody {
  readonly months: readonly TrendsMonth[]; // the complete window months oldest first, then the month in progress (partial) last
  readonly categories: readonly CategoryTrend[]; // CATEGORIES order
  readonly notConverted: readonly {
    readonly kind: CountedKind;
    readonly original: Money;
    readonly pair: { readonly from: CurrencyCode; readonly to: DisplayCurrency };
  }[];
}

export function trendsOf(
  ledger: PeriodLedger,
  window: { complete: readonly AnalysisPeriod[]; inProgress: AnalysisPeriod },
  baselines: ReadonlyMap<string, readonly AnalysisPeriod[]>,
  mc: MoneyContext,
): TrendsBody {
  const months: TrendsMonth[] = [...window.complete, window.inProgress].map((p) => ({
    ...monthFigures(ledger, p),
    flags: tierFlags(ledger, p, baselines.get(p.label) ?? []),
  }));

  // Complete months only: the month in progress is never an average member or a direction end.
  const complete = months.slice(0, window.complete.length);
  const categories: CategoryTrend[] = [];
  for (const category of CATEGORIES) {
    const totals = complete.map((m) => m.byCategory.find((c) => c.category === category)?.spending.minor ?? 0n);
    const first = totals.find((t) => t > 0n);
    if (first === undefined) continue;
    const last = totals[totals.length - 1]!;
    const sum = totals.reduce((a, b) => a + b, 0n);
    categories.push({
      category,
      average: money(averageMinor(sum, totals.length), ledger.display),
      direction: directionOf(first, last),
    });
  }

  // Baseline lines decide shown flags, so every counted line over the read span is shown.
  mc.show(ledger.lines(ledger.read).map((l) => l.result));
  const windowSpan: Span = { from: (window.complete[0] ?? window.inProgress).from, until: window.inProgress.until };
  const notConverted: TrendsBody['notConverted'][number][] = [];
  for (const l of ledger.lines(windowSpan)) {
    if (l.figure === null && l.result.kind === 'unconverted') {
      notConverted.push({ kind: l.kind, original: l.original, pair: l.result.pair });
    }
  }

  return { months, categories, notConverted };
}

const KNOWN_OPTIONS: ReadonlySet<string> = new Set(['months']);

export function createTrendsFamily(part: MoneyPart): Family<TrendsBody> {
  return {
    name: 'trends',
    period: 'none',
    movesPoint: false,
    compute(ctx) {
      for (const key of Object.keys(ctx.options)) {
        if (!KNOWN_OPTIONS.has(key)) {
          return refuse('bad_option', key, `The trends answer takes no option "${key}".`);
        }
      }
      const n = trendsMonths(ctx.options.months);
      if (isRefusal(n)) return n;

      const window = trendsWindow(ctx.calendar, ctx.now, n);
      const all = [...window.complete, window.inProgress];
      const baselines = new Map<string, AnalysisPeriod[]>();
      for (const p of all) baselines.set(p.label, monthsBefore(ctx.calendar, p, BASELINE_MONTHS, ctx.now));
      const mc = part.moneyFor(ctx);
      const ledger = buildLedger(ctx, mc, [...all, ...[...baselines.values()].flat()]);
      return { kind: 'body', body: trendsOf(ledger, window, baselines, mc) };
    },
  };
}
