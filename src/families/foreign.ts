// Foreign-spending family (S-170): per original currency, a charged line from the debited amount and
// a market line from the original amount, both at the purchase's own day by the one converter. The
// charged set holds purchases whose charged line converted, the compared set those of it whose
// market line also converted; every total sums rounded lines and every rate is an exact ratio of
// totals over the same purchases. The share of all spending is the one such figure in the product.

import { fractionText } from '../answers/text';
import type { CurrencyCode, DisplayCurrency } from '../core/primitives';
import { refuse } from '../core/primitives';
import type { Family } from '../core/question';
import { selectTransactions } from '../local/transactions';
import type { MoneyPart } from '../money/context';
import type { ConversionResult } from '../money/converter';
import { currencyByCode, exponentOf } from '../money/currencies';
import { type Fraction, fraction } from '../money/exact';
import { type Money, negateMoney, sumMoney } from '../money/money';
import { classifyMovement } from './movement';

export const RATE_DECIMALS = 4;
export const PERCENT_DECIMALS = 2;

export interface RateFigure {
  readonly exact: Fraction;
  readonly text: string;
} // display-currency units per one unit of the original currency; text = fractionText(exact, RATE_DECIMALS)

export interface ForeignCurrencyLine {
  readonly currency: CurrencyCode; // the original currency
  readonly purchases: number; // every spending purchase in this original currency
  readonly charged: {
    readonly count: number; // purchases whose charged line converted
    readonly originalTotal: Money; // their original amounts, in the original currency
    readonly totalCharged: Money; // display currency: sum of their charged lines
    readonly averageRate: RateFigure | null; // totalCharged over originalTotal; null when count is 0
    readonly bestRate: RateFigure | null; // lowest per-purchase rate paid
    readonly worstRate: RateFigure | null; // highest
  };
  readonly compared: {
    readonly count: number; // purchases of the charged set whose market line also converted
    readonly originalTotal: Money;
    readonly marketTotal: Money; // display currency: sum of their market lines
    readonly marketRate: RateFigure | null; // marketTotal over originalTotal; null when count is 0
    readonly excess: Money | null; // their charged lines summed minus marketTotal; null when count is 0
    readonly excessPercent: { readonly exact: Fraction; readonly text: string } | null; // excess / marketTotal x 100, text at PERCENT_DECIMALS; null when count is 0 or marketTotal is 0
  };
  readonly unchargedLines: readonly Money[]; // debited amounts whose charged line did not convert, in their own currency
  readonly missingPairs: readonly { readonly from: CurrencyCode; readonly to: DisplayCurrency }[]; // each pair a charged or market line could not convert, once each
}

export interface ForeignBody {
  readonly currencies: readonly ForeignCurrencyLine[]; // by code
  readonly totalCharged: Money; // display currency: sum of each line's charged.totalCharged
  readonly spendingTotal: Money; // display currency: the period's gross spending in scope, every currency
  readonly share: { readonly exact: Fraction; readonly text: string } | null; // totalCharged x 100 / spendingTotal; null when spendingTotal.minor is 0n
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

export function ratePaid(charged: Money, original: Money): Fraction {
  return fraction(
    abs(charged.minor) * 10n ** BigInt(exponentOf(original.currency)),
    abs(original.minor) * 10n ** BigInt(exponentOf(charged.currency)),
  );
}

const rateFigure = (exact: Fraction): RateFigure => ({ exact, text: fractionText(exact, RATE_DECIMALS) });

// A rate over two totals, or null when the divisor is zero.
const rateOver = (charged: Money, original: Money): RateFigure | null =>
  original.minor === 0n ? null : rateFigure(ratePaid(charged, original));

const asText = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)));

interface Purchase {
  readonly original: Money; // the original amount as spent, sign removed
  readonly charged: ConversionResult;
  readonly market: ConversionResult | null; // asked only when charged converted
}

const lineOf = (r: ConversionResult): Money | null => (r.kind === 'unconverted' ? null : r.line);

function currencyLine(currency: CurrencyCode, display: DisplayCurrency, ps: readonly Purchase[]): ForeignCurrencyLine {
  const missing: { from: CurrencyCode; to: DisplayCurrency }[] = [];
  const noteMissing = (r: ConversionResult) => {
    if (r.kind !== 'unconverted') return;
    if (!missing.some((p) => p.from === r.pair.from && p.to === r.pair.to)) missing.push(r.pair);
  };
  const unchargedLines: Money[] = [];
  const chargedSet: { original: Money; line: Money }[] = [];
  const comparedSet: { original: Money; line: Money; market: Money }[] = [];
  for (const p of ps) {
    noteMissing(p.charged);
    const line = lineOf(p.charged);
    if (line === null) {
      unchargedLines.push(p.charged.original);
      continue;
    }
    chargedSet.push({ original: p.original, line });
    if (p.market === null) continue;
    noteMissing(p.market);
    const market = lineOf(p.market);
    if (market !== null) comparedSet.push({ original: p.original, line, market });
  }

  const originalTotal = sumMoney(
    chargedSet.map((c) => c.original),
    currency,
  );
  const totalCharged = sumMoney(
    chargedSet.map((c) => c.line),
    display,
  );
  const perPurchase = chargedSet.filter((c) => c.original.minor !== 0n).map((c) => ratePaid(c.line, c.original));
  const below = (a: Fraction, b: Fraction) => a.num * b.den < b.num * a.den;
  const best = perPurchase.reduce<Fraction | null>((m, r) => (m === null || below(r, m) ? r : m), null);
  const worst = perPurchase.reduce<Fraction | null>((m, r) => (m === null || below(m, r) ? r : m), null);

  const comparedOriginal = sumMoney(
    comparedSet.map((c) => c.original),
    currency,
  );
  const marketTotal = sumMoney(
    comparedSet.map((c) => c.market),
    display,
  );
  const comparedCharged = sumMoney(
    comparedSet.map((c) => c.line),
    display,
  );
  const compared = comparedSet.length > 0;
  const excess = compared ? sumMoney([comparedCharged, negateMoney(marketTotal)], display) : null;
  let excessPercent: ForeignCurrencyLine['compared']['excessPercent'] = null;
  if (excess !== null && marketTotal.minor !== 0n) {
    const exact = fraction(excess.minor * 100n, marketTotal.minor);
    excessPercent = { exact, text: fractionText(exact, PERCENT_DECIMALS) };
  }

  return {
    currency,
    purchases: ps.length,
    charged: {
      count: chargedSet.length,
      originalTotal,
      totalCharged,
      averageRate: chargedSet.length > 0 ? rateOver(totalCharged, originalTotal) : null,
      bestRate: best === null ? null : rateFigure(best),
      worstRate: worst === null ? null : rateFigure(worst),
    },
    compared: {
      count: comparedSet.length,
      originalTotal: comparedOriginal,
      marketTotal,
      marketRate: compared ? rateOver(marketTotal, comparedOriginal) : null,
      excess,
      excessPercent,
    },
    unchargedLines,
    missingPairs: missing,
  };
}

export function createForeignSpendingFamily(money: MoneyPart): Family<ForeignBody> {
  return {
    name: 'foreign_spending',
    period: 'optional',
    defaultPeriod: 'last-month',
    movesPoint: false,
    compute(ctx) {
      let only: CurrencyCode | null = null;
      for (const key of Object.keys(ctx.options)) {
        if (key !== 'currency') {
          return refuse('bad_option', key, `The foreign-spending question takes no option "${key}".`);
        }
        const value = ctx.options.currency;
        if (typeof value !== 'string' || currencyByCode(value) === undefined) {
          return refuse('bad_option', 'currency', `"${asText(value)}" is not a currency code.`, asText(value));
        }
        only = value;
      }

      const m = money.moneyFor(ctx);
      const c = m.converter;
      const txs = selectTransactions(ctx.snapshot.db, {
        holdings: ctx.scope.holdings,
        from: ctx.period?.from,
        until: ctx.period?.until,
        order: 'occurred',
      });

      const spendingLines: ConversionResult[] = [];
      const marketShown: ConversionResult[] = [];
      const byCurrency = new Map<CurrencyCode, Purchase[]>();
      for (const t of txs) {
        if (classifyMovement(t) !== 'spending') continue;
        const day = { kind: 'day', day: ctx.calendar.localDay(t.occurredAt) } as const;
        const charged = c.convert(negateMoney(t.amount), day);
        spendingLines.push(charged);
        if (t.originalAmount === null) continue;
        const currency = t.originalAmount.currency;
        if (only !== null && currency !== only) continue;
        let market: ConversionResult | null = null;
        if (charged.kind !== 'unconverted') {
          market = c.convert(negateMoney(t.originalAmount), day);
          marketShown.push(market);
        }
        const original = t.originalAmount.minor < 0n ? negateMoney(t.originalAmount) : t.originalAmount;
        const list = byCurrency.get(currency) ?? [];
        list.push({ original, charged, market });
        byCurrency.set(currency, list);
      }
      m.show(spendingLines);
      m.show(marketShown);

      const display = ctx.displayCurrency;
      const currencies = [...byCurrency.keys()]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((code) => currencyLine(code, display, byCurrency.get(code) ?? []));
      const totalCharged = sumMoney(
        currencies.map((l) => l.charged.totalCharged),
        display,
      );
      const spendingTotal = sumMoney(
        spendingLines.flatMap((r) => (r.kind === 'unconverted' ? [] : [r.line])),
        display,
      );
      let share: ForeignBody['share'] = null;
      if (spendingTotal.minor !== 0n) {
        const exact = fraction(totalCharged.minor * 100n, spendingTotal.minor);
        share = { exact, text: `${fractionText(exact, PERCENT_DECIMALS)}%` };
      }
      return { kind: 'body', body: { currencies, totalCharged, spendingTotal, share } };
    },
  };
}
