// Jars family (S-150): per in-scope jar of a source offering jars the latest reported balance with
// its as-of moment, its held goal and progress as the exact share reached, the balance converted at
// the latest recorded rate and rounded once; the jars' total is the sum of those shown lines.
// Progress is rounded only for display. Nothing derived is stored.

import { fractionText } from '../answers/text';
import type { CurrencyCode, DisplayCurrency, HoldingId, Instant, LocalDateTime, SourceId } from '../core/primitives';
import { refuse } from '../core/primitives';
import type { Family } from '../core/question';
import type { MoneyPart } from '../money/context';
import { type Fraction, fraction } from '../money/exact';
import { type Money, sumMoney } from '../money/money';
import { readBalances } from '../sync/balances';

export const PROGRESS_PERCENT_DECIMALS = 1;

export interface JarLine {
  readonly name: HoldingId; // the jar's narrowing name
  readonly sourceId: SourceId;
  readonly balance: Money;
  readonly asOf: { instant: Instant; localDateTime: LocalDateTime };
  readonly goal: Money | null;
  readonly progress: null | { readonly share: Fraction; readonly percentText: string; readonly reached: boolean };
  readonly shown: Money | null; // balance in the display currency at the latest rate; null when unconverted
  readonly notConverted: { readonly from: CurrencyCode; readonly to: DisplayCurrency } | null;
}

export interface JarsBody {
  readonly jars: readonly JarLine[]; // register order
  readonly withoutBalance: readonly HoldingId[]; // in-scope jars with no reported balance held
  readonly total: Money; // display currency: sum of the shown lines
}

// Exact share of a positive goal reached, in the jar's one currency; null without a positive goal.
export function progressOf(balance: Money, goal: Money | null): JarLine['progress'] {
  if (goal === null || goal.minor <= 0n) return null;
  const share = fraction(balance.minor, goal.minor);
  const percent = fraction(share.num * 100n, share.den);
  return {
    share,
    percentText: `${fractionText(percent, PROGRESS_PERCENT_DECIMALS)}%`,
    reached: balance.minor >= goal.minor,
  };
}

export function createJarsFamily(moneyPart: MoneyPart): Family<JarsBody> {
  return {
    name: 'jars',
    period: 'none',
    capability: 'jars',
    movesPoint: false,
    compute(ctx) {
      const [key] = Object.keys(ctx.options);
      if (key !== undefined) return refuse('bad_option', key, `The jars question takes no option "${key}".`);
      const held = new Map(readBalances(ctx.snapshot).map((b) => [b.holdingId, b] as const));
      const m = moneyPart.moneyFor(ctx);
      const jars: JarLine[] = [];
      const withoutBalance: HoldingId[] = [];
      for (const h of ctx.register.holdings) {
        if (h.kind !== 'jar' || !ctx.scope.holdings.has(h.id)) continue;
        const b = held.get(h.id);
        if (b === undefined) {
          withoutBalance.push(h.id);
          continue;
        }
        const r = m.converter.convert(b.balance, { kind: 'latest' });
        m.show([r]);
        jars.push({
          name: h.id,
          sourceId: h.sourceId,
          balance: b.balance,
          asOf: { instant: b.reportedAt, localDateTime: ctx.calendar.localDateTime(b.reportedAt) },
          goal: b.goal,
          progress: progressOf(b.balance, b.goal),
          shown: r.kind === 'unconverted' ? null : r.line,
          notConverted: r.kind === 'unconverted' ? r.pair : null,
        });
      }
      const shown = jars.flatMap((l) => (l.shown === null ? [] : [l.shown]));
      return { kind: 'body', body: { jars, withoutBalance, total: sumMoney(shown, ctx.displayCurrency) } };
    },
  };
}
