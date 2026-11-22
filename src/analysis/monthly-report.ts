// Monthly report (S-171): one ledger over the month, its 3 months before, the jar average window and
// the health spans; spending, the top 10 merchants, foreign spending (its share of all spending
// included) and balances from their own families through section contexts; savings, patterns,
// health and jar activity from their owning computations over the report month; and the report's
// own comparison with the previous month, per-day average, largest transaction, tiers and the
// no-budgets section. The report computes only what S-162 owns; every other figure is the owning
// family's over the same lines, in the question's one money context.

import type { SourceId } from '../core/primitives';
import { isRefusal, refuse } from '../core/primitives';
import type { Family } from '../core/question';
import { buildLedger } from '../analytics/ledger';
import { type AnalysisPeriod, BASELINE_MONTHS, localDaysIn, monthsBefore, reportPeriod } from '../analytics/periods';
import type { SavingsRate } from '../analytics/savings';
import { createSectionMoney, sectionPeriod } from '../analytics/sections';
import { type BalanceBody, type BalanceConvention, createBalanceFamily } from '../families/balance';
import { type BreakdownBody, type BreakdownGroup, createBreakdownFamily } from '../families/breakdown';
import { type ForeignBody, createForeignSpendingFamily } from '../families/foreign';
import type { MoneyPart } from '../money/context';
import type { Money } from '../money/money';
import { type HealthBody, healthOf, healthSpans } from './health';
import { type OutlookSection, averageWindow, jarOutlook, jarScope } from './jar-activity';
import { type PatternsBody, patternsOf } from './patterns';
import {
  type Comparison,
  type LargestTransaction,
  NO_BUDGETS,
  averagePerDay,
  compareSpending,
  largestTransaction,
} from './report-parts';
import { type TierFlag, monthFigures, tierFlags } from './trends';

export const MONTHLY_TOP_MERCHANTS = 10;

export interface MonthlyReportBody {
  readonly month: AnalysisPeriod;
  readonly spending: BreakdownBody; // category grouping: groups, totalSpending, refundsTotal, netSpending, cashbackEarned
  readonly averagePerDay: Money | null;
  readonly topMerchants: readonly BreakdownGroup[]; // capped at 10, the breakdown's own order
  readonly merchantsOmitted: number;
  readonly largest: LargestTransaction | null;
  readonly comparison: Comparison; // against the previous month
  readonly unusuallyHigh: readonly TierFlag[]; // against the 3 months before
  readonly savings: { readonly income: Money; readonly netSavings: Money; readonly savingsRate: SavingsRate };
  readonly balances: BalanceBody;
  readonly jars: OutlookSection;
  readonly foreign: ForeignBody; // foreign spending's own body; its share of all spending is foreign.share
  readonly patterns: PatternsBody;
  readonly health: HealthBody; // measured on this month, as at its end (or now, so far)
  readonly budget: typeof NO_BUDGETS;
}

export function createMonthlyReportFamily(
  money: MoneyPart,
  conventions: ReadonlyMap<SourceId, BalanceConvention>,
): Family<MonthlyReportBody> {
  // Private section families, never registered with the core.
  const sm = createSectionMoney(money);
  const breakdown = createBreakdownFamily(sm.part);
  const foreignFamily = createForeignSpendingFamily(sm.part);
  const balance = createBalanceFamily(sm.part, conventions);

  return {
    name: 'monthly_report',
    period: 'optional',
    defaultPeriod: 'last-month',
    movesPoint: false,
    compute(ctx) {
      const [key] = Object.keys(ctx.options);
      if (key !== undefined) return refuse('bad_option', key, `The monthly report takes no option "${key}".`);
      const cal = ctx.calendar;
      const month = reportPeriod(cal, ctx.period!, 'month', ctx.now);
      if (isRefusal(month)) return month;

      const mc = money.moneyFor(ctx);
      const baseline = monthsBefore(cal, month, BASELINE_MONTHS, ctx.now);
      const previous = baseline[BASELINE_MONTHS - 1]!;
      const ledger = buildLedger(ctx, mc, [
        month,
        ...baseline,
        ...averageWindow(cal, month, ctx.now),
        ...healthSpans(cal, month, ctx.now),
      ]);

      const rp = sectionPeriod(ctx, month);
      const spending = breakdown.compute(sm.open(ctx, rp, {}));
      if (isRefusal(spending)) return spending;
      const merchants = breakdown.compute(
        sm.open(ctx, rp, { grouping: 'merchant', merchantCap: MONTHLY_TOP_MERCHANTS }),
      );
      if (isRefusal(merchants)) return merchants;
      const foreign = foreignFamily.compute(sm.open(ctx, rp, {}));
      if (isRefusal(foreign)) return foreign;
      const balances = balance.compute(sm.open(ctx, null, {}));
      if (isRefusal(balances)) return balances;

      // Month and baseline lines enter the comparison and decide tiers, so each is shown.
      for (const s of [month, ...baseline]) mc.show(ledger.lines(s).map((l) => l.result));

      const days = localDaysIn(cal, month, ctx.now);
      const f = monthFigures(ledger, month);
      return {
        kind: 'body',
        body: {
          month,
          spending: spending.body,
          averagePerDay: averagePerDay(spending.body.totalSpending, days),
          topMerchants: merchants.body.groups,
          merchantsOmitted: merchants.body.groupsOmitted,
          largest: largestTransaction(ledger, cal, month),
          comparison: compareSpending(ledger, month, previous),
          unusuallyHigh: tierFlags(ledger, month, baseline),
          savings: { income: f.income, netSavings: f.netSavings, savingsRate: f.savingsRate },
          balances: balances.body,
          jars: jarOutlook(ctx, ledger, jarScope(ctx), month, mc),
          foreign: foreign.body,
          patterns: patternsOf(ledger, month, days, cal, mc),
          health: healthOf(ctx, mc, ledger, month),
          budget: NO_BUDGETS,
        },
      };
    },
  };
}
