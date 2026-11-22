// Spending breakdown family (S-126): each period transaction classified once by classifyMovement,
// each counted line converted once at its local day, spending lines grouped by category, merchant,
// day, week or month, merchant groups capped, and total spending, refunds, net spending and
// cashback earned all as sums of those same rounded lines. Converting a sum is never done.

import type { CurrencyCode, DisplayCurrency } from '../core/primitives';
import { refuse } from '../core/primitives';
import type { Family } from '../core/question';
import { selectTransactions } from '../local/transactions';
import type { MoneyPart } from '../money/context';
import type { ConversionResult } from '../money/converter';
import { type Money, negateMoney, sumMoney } from '../money/money';
import { classifyMovement } from './movement';

export const BREAKDOWN_GROUPINGS = ['category', 'merchant', 'day', 'week', 'month'] as const;
export type Grouping = (typeof BREAKDOWN_GROUPINGS)[number];
export const DEFAULT_GROUPING: Grouping = 'category';
export const DEFAULT_MERCHANT_CAP = 10;

export interface BreakdownGroup {
  readonly key: string; // category, merchant, local day 'YYYY-MM-DD', the week's Monday 'YYYY-MM-DD', or 'YYYY-MM'
  readonly spending: Money; // display currency: sum of the group's converted spending lines
  readonly count: number; // spending transactions in the group, converted or not (the merchant visit count)
}

export interface UnconvertedLine {
  readonly kind: 'spending' | 'refund' | 'cashback';
  readonly key: string | null; // the group key for a spending line, else null
  readonly original: Money;
  readonly pair: { readonly from: CurrencyCode; readonly to: DisplayCurrency };
}

export interface BreakdownBody {
  readonly grouping: Grouping;
  readonly groups: readonly BreakdownGroup[];
  readonly merchantCap: number | null; // the cap applied; null unless grouping is 'merchant'
  readonly groupsOmitted: number; // merchant groups beyond the cap; 0 otherwise
  readonly totalSpending: Money; // sum of every converted spending line, capped groups included
  readonly refundsTotal: Money;
  readonly netSpending: Money; // totalSpending - refundsTotal; may be negative
  readonly cashbackEarned: Money;
  readonly notConverted: readonly UnconvertedLine[]; // in the order the transactions were read
}

const KNOWN_OPTIONS: ReadonlySet<string> = new Set(['grouping', 'merchantCap']);

const isGrouping = (v: unknown): v is Grouping => BREAKDOWN_GROUPINGS.some((g) => g === v);

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function createBreakdownFamily(money: MoneyPart): Family<BreakdownBody> {
  return {
    name: 'spending_breakdown',
    period: 'optional',
    defaultPeriod: 'last-month',
    movesPoint: false,
    compute(ctx) {
      for (const key of Object.keys(ctx.options)) {
        if (!KNOWN_OPTIONS.has(key)) {
          return refuse('bad_option', key, `The spending breakdown takes no option "${key}".`);
        }
      }
      const g = ctx.options.grouping;
      if (g !== undefined && !isGrouping(g)) {
        return refuse('bad_option', 'grouping', `grouping must be one of ${BREAKDOWN_GROUPINGS.join(', ')}.`);
      }
      const grouping: Grouping = g ?? DEFAULT_GROUPING;
      let merchantCap: number | null = null;
      if (grouping === 'merchant') {
        const cap = ctx.options.merchantCap;
        if (cap !== undefined && (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 1)) {
          return refuse('bad_option', 'merchantCap', 'merchantCap must be a whole number of at least 1.');
        }
        merchantCap = cap ?? DEFAULT_MERCHANT_CAP;
      }

      const txs = selectTransactions(ctx.snapshot.db, {
        holdings: ctx.scope.holdings,
        ...(ctx.period === null ? {} : { from: ctx.period.from, until: ctx.period.until }),
        order: 'occurred',
      });
      const m = money.moneyFor(ctx);
      const c = m.converter;
      const display = ctx.displayCurrency;
      const keyOf = (t: (typeof txs)[number]): string => {
        switch (grouping) {
          case 'category':
            return t.category;
          case 'merchant':
            return t.merchant;
          case 'day':
            return ctx.calendar.localDay(t.occurredAt);
          case 'week':
            return ctx.calendar.weekOf(t.occurredAt).monday;
          case 'month':
            return ctx.calendar.monthOf(t.occurredAt);
        }
      };

      const results: ConversionResult[] = [];
      const groupLines = new Map<string, { lines: Money[]; count: number }>();
      const spending: Money[] = [];
      const refunds: Money[] = [];
      const cashback: Money[] = [];
      const notConverted: UnconvertedLine[] = [];
      const take = (r: ConversionResult, kind: UnconvertedLine['kind'], key: string | null, into: Money[]) => {
        results.push(r);
        if (r.kind === 'unconverted') notConverted.push({ kind, key, original: r.original, pair: r.pair });
        else into.push(r.line);
      };

      for (const t of txs) {
        const when = { kind: 'day', day: ctx.calendar.localDay(t.occurredAt) } as const;
        const kind = classifyMovement(t);
        if (kind === 'spending') {
          const key = keyOf(t);
          let group = groupLines.get(key);
          if (group === undefined) {
            group = { lines: [], count: 0 };
            groupLines.set(key, group);
          }
          group.count += 1;
          const r = c.convert(negateMoney(t.amount), when);
          take(r, 'spending', key, spending);
          if (r.kind !== 'unconverted') group.lines.push(r.line);
        } else if (kind === 'refund') {
          take(c.convert(t.amount, when), 'refund', null, refunds);
        }
        if (t.cashback !== null && t.cashback.minor !== 0n) {
          take(c.convert(t.cashback, when), 'cashback', null, cashback);
        }
      }
      m.show(results);

      let groups: BreakdownGroup[] = [...groupLines].map(([key, gr]) => ({
        key,
        spending: sumMoney(gr.lines, display),
        count: gr.count,
      }));
      if (grouping === 'category' || grouping === 'merchant') {
        groups.sort((a, b) =>
          a.spending.minor !== b.spending.minor ? (a.spending.minor > b.spending.minor ? -1 : 1) : byCodeUnit(a.key, b.key),
        );
      } else {
        groups.sort((a, b) => byCodeUnit(a.key, b.key));
      }
      let groupsOmitted = 0;
      if (merchantCap !== null && groups.length > merchantCap) {
        groupsOmitted = groups.length - merchantCap;
        groups = groups.slice(0, merchantCap);
      }

      const totalSpending = sumMoney(spending, display);
      const refundsTotal = sumMoney(refunds, display);
      return {
        kind: 'body',
        body: {
          grouping,
          groups,
          merchantCap,
          groupsOmitted,
          totalSpending,
          refundsTotal,
          netSpending: sumMoney([totalSpending, negateMoney(refundsTotal)], display),
          cashbackEarned: sumMoney(cashback, display),
          notConverted,
        },
      };
    },
  };
}
