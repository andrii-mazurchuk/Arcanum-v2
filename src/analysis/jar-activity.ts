// Jar activity (S-166): the only place report jar figures are computed. The jars in scope by the
// jars capability split, the one has-a-goal predicate, per-jar and total top-ups over a span from
// the period ledger's jar lines (every incoming movement on a jar, own transfer or not, at its own
// instant), the 3-month average window that never holds a partial month, the average monthly
// top-up and the months-to-goal integer rule on exact jar-currency minor units. Read-only.

import type { HoldingId, Instant, LocalDateTime, SourceId } from '../core/primitives';
import type { QuestionContext } from '../core/question';
import { type HoldingRow, partitionByCapability } from '../core/register';
import type { PeriodLedger } from '../analytics/ledger';
import { type AnalysisPeriod, type Span, monthsBefore } from '../analytics/periods';
import { averageMinor } from '../analytics/savings';
import { progressOf } from '../families/jars';
import type { MoneyContext } from '../money/context';
import { type Money, money, sumMoney } from '../money/money';
import { readBalances } from '../sync/balances';

export interface JarScope {
  readonly jars: readonly HoldingRow[]; // kind 'jar', id in ctx.scope.holdings, source in offering; register order
  readonly offering: readonly SourceId[];
  readonly notOffering: readonly SourceId[]; // in-scope sources not offering jars, named, never shown as holding none
}

export function jarScope(ctx: QuestionContext): JarScope {
  const { offering, notOffering } = partitionByCapability(ctx.register, ctx.scope, 'jars');
  const offers = new Set(offering);
  const jars = ctx.register.holdings.filter(
    (h) => h.kind === 'jar' && ctx.scope.holdings.has(h.id) && offers.has(h.sourceId),
  );
  return { jars, offering, notOffering };
}

// The one test of whether a jar's current goal field is set, in every analysis family.
export function hasGoal(goal: Money | null): goal is Money {
  return goal !== null && goal.minor > 0n;
}

export interface JarTopUps {
  readonly jar: HoldingId;
  readonly sourceId: SourceId;
  readonly count: number;
  readonly sum: Money; // the jar's currency: exact sum of the top-ups' originals
  readonly shown: Money; // display currency: sum of the converted top-up figures
  readonly notConverted: readonly Money[]; // originals whose pair has no rate held, in instant order
}

export interface TopUpSection {
  readonly jars: readonly JarTopUps[];
  readonly total: Money; // sumMoney of every jar's shown
  readonly notOffering: readonly SourceId[];
}

function topUpsOf(ledger: PeriodLedger, jar: HoldingRow, s: Span, mc: MoneyContext): JarTopUps {
  const lines = ledger.jarLines(s, jar.id);
  mc.show(lines.map((l) => l.result));
  return {
    jar: jar.id,
    sourceId: jar.sourceId,
    count: lines.length,
    sum: sumMoney(
      lines.map((l) => l.original),
      jar.currency,
    ),
    shown: sumMoney(
      lines.flatMap((l) => (l.figure === null ? [] : [l.figure])),
      ledger.display,
    ),
    notConverted: lines.flatMap((l) => (l.figure === null ? [l.original] : [])),
  };
}

export function topUpsIn(ledger: PeriodLedger, scope: JarScope, s: Span, mc: MoneyContext): TopUpSection {
  const jars = scope.jars.map((j) => topUpsOf(ledger, j, s, mc));
  return {
    jars,
    total: sumMoney(
      jars.map((j) => j.shown),
      ledger.display,
    ),
    notOffering: scope.notOffering,
  };
}

// The 3 complete months ending with a complete report month, or the 3 before a partial one.
export function averageWindow(cal: QuestionContext['calendar'], report: AnalysisPeriod, now: Instant): AnalysisPeriod[] {
  return report.partial ? monthsBefore(cal, report, 3, now) : [...monthsBefore(cal, report, 2, now), report];
}

export type MonthsToGoal =
  | { readonly kind: 'no_goal' } // not shown
  | { readonly kind: 'no_balance' } // no balance held: not shown
  | { readonly kind: 'reached' } // 0, shown as reached
  | { readonly kind: 'not_estimable' } // the 3-month sum is 0
  | { readonly kind: 'months'; readonly months: bigint };

// The smallest m with m * sum >= (goal - balance) * 3, on exact jar-currency minor units.
export function monthsToGoal(goal: Money | null, balance: Money | null, threeMonthSum: bigint): MonthsToGoal {
  if (!hasGoal(goal)) return { kind: 'no_goal' };
  if (balance === null) return { kind: 'no_balance' };
  if (balance.minor >= goal.minor) return { kind: 'reached' };
  if (threeMonthSum === 0n) return { kind: 'not_estimable' };
  const need = (goal.minor - balance.minor) * 3n;
  return { kind: 'months', months: (need + threeMonthSum - 1n) / threeMonthSum };
}

export interface JarOutlook {
  readonly jar: HoldingId;
  readonly sourceId: SourceId;
  readonly balance: Money | null; // HeldBalance.balance, null when none held
  readonly asOf: { instant: Instant; localDateTime: LocalDateTime } | null; // reportedAt, drawn by ctx.calendar
  readonly goal: Money | null; // HeldBalance.goal (the current goal field)
  readonly progress: ReturnType<typeof progressOf> | null; // progressOf(balance, goal); null when no balance held
  readonly month: JarTopUps; // the report month's top-ups
  readonly averageMonthly: Money; // averageMinor(threeMonthSum, 3), jar currency, display only
  readonly monthsToGoal: MonthsToGoal;
}

export interface OutlookSection {
  readonly jars: readonly JarOutlook[];
  readonly total: Money; // sumMoney of each month.shown
  readonly notOffering: readonly SourceId[];
}

export function jarOutlook(
  ctx: QuestionContext,
  ledger: PeriodLedger,
  scope: JarScope,
  report: AnalysisPeriod,
  mc: MoneyContext,
): OutlookSection {
  const held = new Map(readBalances(ctx.snapshot).map((b) => [b.holdingId, b] as const));
  const window = averageWindow(ctx.calendar, report, ctx.now);
  const month = topUpsIn(ledger, scope, report, mc);
  const jars = scope.jars.map((jar, i): JarOutlook => {
    const b = held.get(jar.id);
    const balance = b === undefined ? null : b.balance;
    const goal = b === undefined ? null : b.goal;
    let threeMonthSum = 0n;
    for (const p of window) for (const l of ledger.jarLines(p, jar.id)) threeMonthSum += l.original.minor;
    return {
      jar: jar.id,
      sourceId: jar.sourceId,
      balance,
      asOf: b === undefined ? null : { instant: b.reportedAt, localDateTime: ctx.calendar.localDateTime(b.reportedAt) },
      goal,
      progress: b === undefined ? null : progressOf(b.balance, b.goal),
      month: month.jars[i]!,
      averageMonthly: money(averageMinor(threeMonthSum, 3), jar.currency),
      monthsToGoal: monthsToGoal(goal, balance, threeMonthSum),
    };
  });
  return { jars, total: month.total, notOffering: scope.notOffering };
}
