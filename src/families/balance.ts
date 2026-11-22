// Balance family (S-149): per in-scope account and jar the latest reported balance with its as-of
// moment, own money and credit used chosen together by the source's declared balance convention,
// each converted at the latest recorded rate and rounded once; net position and credit used total
// are sums of those shown lines. Nothing derived is stored.

import type { CurrencyCode, DisplayCurrency, HoldingId, Instant, LocalDateTime, SourceId } from '../core/primitives';
import { refuse } from '../core/primitives';
import type { Family } from '../core/question';
import type { HoldingKind } from '../core/register';
import type { ConversionResult } from '../money/converter';
import type { MoneyContext, MoneyPart } from '../money/context';
import { type Money, money, sumMoney } from '../money/money';
import { type HeldBalance, readBalances } from '../sync/balances';
import type { BalanceConvention } from '../sync/source-contract';

export type { BalanceConvention } from '../sync/source-contract';

export interface FigureLine {
  readonly original: Money; // in the holding's currency
  readonly shown: Money | null; // display currency; null when unconverted
  readonly notConverted: { readonly from: CurrencyCode; readonly to: DisplayCurrency } | null;
}

export interface BalanceLine {
  readonly holdingId: HoldingId;
  readonly kind: HoldingKind;
  readonly sourceId: SourceId;
  readonly balance: Money; // as last reported
  readonly creditLimit: Money | null; // accounts only; null for a jar or when none is held
  readonly asOf: { instant: Instant; localDateTime: LocalDateTime }; // reportedAt, drawn by ctx.calendar
  readonly ownMoney: FigureLine;
  readonly creditUsed: FigureLine | null; // null when no credit is in use, and always for a jar
}

export interface BalanceBody {
  readonly accounts: readonly BalanceLine[]; // in register order
  readonly jars: readonly BalanceLine[]; // in register order
  readonly withoutBalance: readonly HoldingId[]; // in-scope holdings with no reported balance held
  readonly netPosition: Money; // display currency: sum of the shown own-money lines
  readonly creditUsedTotal: Money; // display currency: sum of the shown credit-used lines
}

// Exact, in minor units of the holding's currency; no limit held reads as a limit of 0.
export function ownMoneyOf(
  b: Pick<HeldBalance, 'balance' | 'creditLimit'>,
  kind: HoldingKind,
  c: BalanceConvention,
): { ownMoney: Money; creditUsed: Money | null } {
  const { currency } = b.balance;
  const B = b.balance.minor;
  if (kind === 'jar') return { ownMoney: b.balance, creditUsed: null };
  if (c === 'includes_credit_limit') {
    const L = b.creditLimit === null ? 0n : b.creditLimit.minor;
    return { ownMoney: money(B - L, currency), creditUsed: B < L ? money(L - B, currency) : null };
  }
  return { ownMoney: b.balance, creditUsed: B < 0n ? money(-B, currency) : null };
}

// Converts one figure at the latest rate, rounded once by the converter, and declares it shown.
function figureLine(m: MoneyContext, figure: Money): FigureLine {
  const r: ConversionResult = m.converter.convert(figure, { kind: 'latest' });
  m.show([r]);
  return r.kind === 'unconverted'
    ? { original: r.original, shown: null, notConverted: r.pair }
    : { original: r.original, shown: r.line, notConverted: null };
}

export function createBalanceFamily(
  moneyPart: MoneyPart,
  conventions: ReadonlyMap<SourceId, BalanceConvention>,
): Family<BalanceBody> {
  return {
    name: 'balance',
    period: 'none',
    movesPoint: false,
    compute(ctx) {
      const [key] = Object.keys(ctx.options);
      if (key !== undefined) return refuse('bad_option', key, `The balance question takes no option "${key}".`);
      const held = new Map(readBalances(ctx.snapshot).map((b) => [b.holdingId, b] as const));
      const m = moneyPart.moneyFor(ctx);
      const accounts: BalanceLine[] = [];
      const jars: BalanceLine[] = [];
      const withoutBalance: HoldingId[] = [];
      for (const h of ctx.register.holdings) {
        if (!ctx.scope.holdings.has(h.id)) continue;
        const b = held.get(h.id);
        if (b === undefined) {
          withoutBalance.push(h.id);
          continue;
        }
        const convention = conventions.get(h.sourceId) ?? 'own_money_as_reported';
        const figures = ownMoneyOf(b, h.kind, convention);
        const line: BalanceLine = {
          holdingId: h.id,
          kind: h.kind,
          sourceId: h.sourceId,
          balance: b.balance,
          creditLimit: h.kind === 'jar' ? null : b.creditLimit,
          asOf: { instant: b.reportedAt, localDateTime: ctx.calendar.localDateTime(b.reportedAt) },
          ownMoney: figureLine(m, figures.ownMoney),
          creditUsed: figures.creditUsed === null ? null : figureLine(m, figures.creditUsed),
        };
        (h.kind === 'jar' ? jars : accounts).push(line);
      }
      const lines = [...accounts, ...jars];
      const shownOf = (fs: readonly (FigureLine | null)[]): Money[] =>
        fs.flatMap((f) => (f === null || f.shown === null ? [] : [f.shown]));
      return {
        kind: 'body',
        body: {
          accounts,
          jars,
          withoutBalance,
          netPosition: sumMoney(shownOf(lines.map((l) => l.ownMoney)), ctx.displayCurrency),
          creditUsedTotal: sumMoney(shownOf(lines.map((l) => l.creditUsed)), ctx.displayCurrency),
        },
      };
    },
  };
}
