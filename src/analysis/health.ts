// Health family (S-167): signals and score over one measured month and its as-at instant (the
// month's end, or the moment of asking for a month in progress). Five signals, each with severity,
// figure, threshold, explanation and recommendation, and the fixed deduction table floored at 0.
// The standalone family and the monthly report both call healthOf; nothing else varies between
// them but (month, as-at). Thresholds are compared exactly on minor-unit sums.

import type { HoldingId, Instant, LocalDateTime, SourceId } from '../core/primitives';
import { refuse } from '../core/primitives';
import type { Family, QuestionContext } from '../core/question';
import { type PeriodLedger, buildLedger } from '../analytics/ledger';
import { type AnalysisPeriod, BASELINE_MONTHS, type Span, lastCompleteMonth, monthsBefore } from '../analytics/periods';
import { lowSavingsSeverity } from '../analytics/savings';
import { STAGNANT_WINDOW_MS, isStagnant } from '../analytics/signals';
import { fractionText } from '../answers/text';
import type { Category } from '../local/classifier';
import type { MoneyContext, MoneyPart } from '../money/context';
import { fraction } from '../money/exact';
import { readBalances } from '../sync/balances';
import { hasGoal, jarScope } from './jar-activity';
import { monthFigures, tierFlags } from './trends';

export const DISCRETIONARY_CATEGORIES: readonly Category[] = [
  'Restaurants & Cafes',
  'Fast Food',
  'Entertainment',
  'Fitness & Sport',
  'Clothing & Apparel',
  'Shopping',
];
export const CASH_CATEGORY: Category = 'ATM & Cash';
export const SIGNAL_NAMES = [
  'low_savings_rate',
  'high_discretionary_spending',
  'unusually_high_category',
  'high_cash_use',
  'stagnant_jar',
] as const;
export type SignalName = (typeof SIGNAL_NAMES)[number];
export type Severity = 'info' | 'warning' | 'alert';
export const DEDUCTIONS = {
  low_savings_alert: 30,
  low_savings_warning: 15,
  high_discretionary_spending: 10,
  spike_category: 10,
  high_category: 5,
  high_cash_use: 5,
  stagnant_jar: 5,
} as const;

export interface HealthSignal {
  readonly name: SignalName;
  readonly severity: Severity;
  readonly subject: Category | HoldingId | null; // the category or the jar; null for the others
  readonly figure: string; // the measured figure
  readonly threshold: string; // the threshold crossed
  readonly explanation: string;
  readonly recommendation: string;
  readonly deduction: number; // from DEDUCTIONS
}

export interface HealthBody {
  readonly month: { readonly label: string; readonly firstDay: string; readonly lastDay: string; readonly partial: boolean };
  readonly asAt: { readonly instant: Instant; readonly localDateTime: LocalDateTime };
  readonly signals: readonly HealthSignal[]; // SIGNAL_NAMES order; categories in CATEGORIES order; jars in register order
  readonly score: number; // max(0, 100 - sum of deductions)
  readonly jarsNotOffered: readonly SourceId[];
}

// One fixed line per signal name; the category or jar is named where there is a subject.
const ADVICE: Record<SignalName, (subject: string) => { explanation: string; recommendation: string }> = {
  low_savings_rate: () => ({
    explanation: "Less of this month's income was kept than the threshold.",
    recommendation: 'Look for categories to trim or move money to savings first.',
  }),
  high_discretionary_spending: () => ({
    explanation: "Discretionary categories took a large share of this month's spending.",
    recommendation: 'Set a monthly limit for eating out, entertainment and shopping.',
  }),
  unusually_high_category: (c) => ({
    explanation: `Spending on ${c} was well above its average of the 3 months before.`,
    recommendation: `Check whether the spending on ${c} was a one-off or a new habit.`,
  }),
  high_cash_use: () => ({
    explanation: "Cash withdrawals took a large share of this month's spending.",
    recommendation: 'Pay by card where you can, so the spending stays visible.',
  }),
  stagnant_jar: (j) => ({
    explanation: `The jar ${j} has a goal but received no top-up in the last 30 days.`,
    recommendation: `Set up a regular top-up for ${j} to keep it moving toward its goal.`,
  }),
};

function signal(
  name: SignalName,
  severity: Severity,
  subject: Category | HoldingId | null,
  figure: string,
  threshold: string,
  deduction: number,
): HealthSignal {
  return { name, severity, subject, figure, threshold, ...ADVICE[name](subject ?? ''), deduction };
}

const percentText = (part: bigint, total: bigint): string => fractionText(fraction(part * 100n, total), 1) + '%';

export function healthSpans(cal: QuestionContext['calendar'], month: AnalysisPeriod, now: Instant): Span[] {
  const asAt = month.until;
  return [
    month,
    ...monthsBefore(cal, month, BASELINE_MONTHS, now),
    { from: asAt - STAGNANT_WINDOW_MS, until: asAt + 1 },
  ];
}

export function healthOf(ctx: QuestionContext, mc: MoneyContext, ledger: PeriodLedger, month: AnalysisPeriod): HealthBody {
  const asAt = month.until;
  const asAtText = ctx.calendar.localDateTime(asAt);
  const f = monthFigures(ledger, month);
  const t = f.spending.minor;
  const spent = (c: Category): bigint => f.byCategory.find((b) => b.category === c)?.spending.minor ?? 0n;
  const signals: HealthSignal[] = [];

  // 1. Low savings rate, judged on the shown tenths.
  const sev = lowSavingsSeverity(f.savingsRate);
  if (sev === 'alert') {
    signals.push(signal('low_savings_rate', 'alert', null, f.savingsRate.text, '10.0%', DEDUCTIONS.low_savings_alert));
  } else if (sev === 'warning') {
    signals.push(signal('low_savings_rate', 'warning', null, f.savingsRate.text, '20.0%', DEDUCTIONS.low_savings_warning));
  }

  // 2. Discretionary share strictly above 40%.
  let d = 0n;
  for (const c of DISCRETIONARY_CATEGORIES) d += spent(c);
  if (t > 0n && d * 5n > t * 2n) {
    signals.push(
      signal('high_discretionary_spending', 'warning', null, percentText(d, t), '40%', DEDUCTIONS.high_discretionary_spending),
    );
  }

  // 3. Unusually high categories against the 3 months before; elevated raises nothing.
  const baseline = monthsBefore(ctx.calendar, month, 3, ctx.now);
  for (const flag of tierFlags(ledger, month, baseline)) {
    if (flag.tier === 'elevated') continue;
    let s = 0n;
    for (const p of baseline) s += ledger.spendingByCategory(p).get(flag.category)?.minor ?? 0n;
    const figure = fractionText(fraction(flag.spending.minor * 3n, s), 2) + ' times';
    if (flag.tier === 'spike') {
      signals.push(signal('unusually_high_category', 'alert', flag.category, figure, '3 times', DEDUCTIONS.spike_category));
    } else {
      signals.push(signal('unusually_high_category', 'warning', flag.category, figure, '2 times', DEDUCTIONS.high_category));
    }
  }

  // 4. Cash share strictly above 10%.
  const c = spent(CASH_CATEGORY);
  if (t > 0n && c * 10n > t) {
    signals.push(signal('high_cash_use', 'info', null, percentText(c, t), '10%', DEDUCTIONS.high_cash_use));
  }

  // 5. Stagnant jars: only jars whose held goal passes hasGoal, at a source offering jars.
  const scope = jarScope(ctx);
  const goals = new Map(readBalances(ctx.snapshot).map((b) => [b.holdingId, b.goal] as const));
  const stretch: Span = { from: asAt - STAGNANT_WINDOW_MS, until: asAt + 1 };
  for (const jar of scope.jars) {
    if (!hasGoal(goals.get(jar.id) ?? null)) continue;
    const topUps = ledger.jarLines(stretch, jar.id).map((l) => l.at);
    if (isStagnant(topUps, asAt)) {
      signals.push(
        signal('stagnant_jar', 'warning', jar.id, 'no top-up in the 30 days to ' + asAtText, '30 days', DEDUCTIONS.stagnant_jar),
      );
    }
  }

  // The month's and its 3 months before's counted lines decide signals; jar lines show no figure.
  const from = baseline.length > 0 ? baseline[0]!.from : month.from;
  mc.show(ledger.lines({ from, until: month.until }).map((l) => l.result));

  const total = signals.reduce((sum, s) => sum + s.deduction, 0);
  return {
    month: { label: month.label, firstDay: month.firstDay, lastDay: month.lastDay, partial: month.partial },
    asAt: { instant: asAt, localDateTime: asAtText },
    signals,
    score: Math.max(0, 100 - total),
    jarsNotOffered: scope.notOffering,
  };
}

export function createHealthFamily(money: MoneyPart): Family<HealthBody> {
  return {
    name: 'health_signals',
    period: 'none',
    movesPoint: false,
    compute(ctx) {
      for (const key of Object.keys(ctx.options)) {
        return refuse('bad_option', key, `The health answer takes no option "${key}".`);
      }
      const month = lastCompleteMonth(ctx.calendar, ctx.now);
      const mc = money.moneyFor(ctx);
      const ledger = buildLedger(ctx, mc, healthSpans(ctx.calendar, month, ctx.now));
      return { kind: 'body', body: healthOf(ctx, mc, ledger, month) };
    },
  };
}
