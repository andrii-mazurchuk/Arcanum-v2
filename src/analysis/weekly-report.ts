// Weekly report (S-163): one ledger over the week and the 4 weeks before it; spending, cashback and
// the top 5 merchants from the breakdown, foreign spending and balances from their own families
// through section contexts; and the comparison with the previous week, the per-day average, the top
// day, the tiers and the jar top-ups. The report computes only what S-162 owns; every other figure
// is the owning family's over the same lines, in the question's one money context.

import type { SourceId } from '../core/primitives';
import { isRefusal, refuse } from '../core/primitives';
import type { Family } from '../core/question';
import { buildLedger } from '../analytics/ledger';
import { type AnalysisPeriod, BASELINE_WEEKS, localDaysIn, reportPeriod, weeksBefore } from '../analytics/periods';
import { createSectionMoney, sectionPeriod } from '../analytics/sections';
import { type BalanceBody, type BalanceConvention, createBalanceFamily } from '../families/balance';
import { type BreakdownBody, type BreakdownGroup, createBreakdownFamily } from '../families/breakdown';
import { type ForeignBody, createForeignSpendingFamily } from '../families/foreign';
import type { MoneyPart } from '../money/context';
import type { Money } from '../money/money';
import { type TopUpSection, jarScope, topUpsIn } from './jar-activity';
import { type Comparison, type TopDay, averagePerDay, compareSpending, topDay } from './report-parts';
import { type TierFlag, tierFlags } from './trends';

export const WEEKLY_TOP_MERCHANTS = 5;

export interface WeeklyReportBody {
  readonly week: AnalysisPeriod;
  readonly spending: BreakdownBody; // category grouping: groups, totalSpending, refundsTotal, netSpending, cashbackEarned, notConverted
  readonly averagePerDay: Money | null;
  readonly topMerchants: readonly BreakdownGroup[]; // the breakdown's merchant groups, its own order, capped at 5
  readonly merchantsOmitted: number;
  readonly topDay: TopDay | null;
  readonly comparison: Comparison; // against the previous week
  readonly unusuallyHigh: readonly TierFlag[]; // against the 4 weeks before
  readonly jars: TopUpSection;
  readonly foreign: ForeignBody;
  readonly balances: BalanceBody; // net position and per-holding balances as currently reported, each with its as-of moment
}

export function createWeeklyReportFamily(
  money: MoneyPart,
  conventions: ReadonlyMap<SourceId, BalanceConvention>,
): Family<WeeklyReportBody> {
  // Private section families, never registered with the core.
  const sm = createSectionMoney(money);
  const breakdown = createBreakdownFamily(sm.part);
  const foreignFamily = createForeignSpendingFamily(sm.part);
  const balance = createBalanceFamily(sm.part, conventions);

  return {
    name: 'weekly_report',
    period: 'optional',
    defaultPeriod: 'last-week',
    movesPoint: false,
    compute(ctx) {
      const [key] = Object.keys(ctx.options);
      if (key !== undefined) return refuse('bad_option', key, `The weekly report takes no option "${key}".`);
      const cal = ctx.calendar;
      const week = reportPeriod(cal, ctx.period!, 'week', ctx.now);
      if (isRefusal(week)) return week;

      const mc = money.moneyFor(ctx);
      const baseline = weeksBefore(cal, week, BASELINE_WEEKS, ctx.now);
      const previous = baseline[BASELINE_WEEKS - 1]!;
      const ledger = buildLedger(ctx, mc, [week, ...baseline]);

      const rp = sectionPeriod(ctx, week);
      const spending = breakdown.compute(sm.open(ctx, rp, {}));
      if (isRefusal(spending)) return spending;
      const merchants = breakdown.compute(
        sm.open(ctx, rp, { grouping: 'merchant', merchantCap: WEEKLY_TOP_MERCHANTS }),
      );
      if (isRefusal(merchants)) return merchants;
      const foreign = foreignFamily.compute(sm.open(ctx, rp, {}));
      if (isRefusal(foreign)) return foreign;
      const balances = balance.compute(sm.open(ctx, null, {}));
      if (isRefusal(balances)) return balances;

      // Week and baseline lines enter the comparison and decide tiers, so each is shown.
      for (const s of [week, ...baseline]) mc.show(ledger.lines(s).map((l) => l.result));

      return {
        kind: 'body',
        body: {
          week,
          spending: spending.body,
          averagePerDay: averagePerDay(spending.body.totalSpending, localDaysIn(cal, week, ctx.now)),
          topMerchants: merchants.body.groups,
          merchantsOmitted: merchants.body.groupsOmitted,
          topDay: topDay(ledger, cal, week),
          comparison: compareSpending(ledger, week, previous),
          unusuallyHigh: tierFlags(ledger, week, baseline),
          jars: topUpsIn(ledger, jarScope(ctx), week, mc),
          foreign: foreign.body,
          balances: balances.body,
        },
      };
    },
  };
}
