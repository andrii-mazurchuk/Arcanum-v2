// Period ledger (S-156): the only place an analysis family obtains classified, converted lines. One
// read of the scope's movements over the union of the requested spans from the question's
// snapshot, each classified once by classifyMovement and each counted, cashback and jar line
// converted once at its own local day; per-span views over half-open spans whose sums are of those
// same rounded lines. Read-only, one per answer, never kept past compute; never calls show.

import type { DisplayCurrency, HoldingId, Instant } from '../core/primitives';
import type { QuestionContext } from '../core/question';
import { classifyMovement } from '../families/movement';
import { CATEGORIES, type Category } from '../local/classifier';
import { type StoredTransaction, selectTransactions } from '../local/transactions';
import type { MoneyContext } from '../money/context';
import type { ConversionResult } from '../money/converter';
import { type Money, negateMoney, sumMoney } from '../money/money';
import { type Span, spanUnion } from './periods';

export type CountedKind = 'spending' | 'refund' | 'income';

export interface LedgerLine {
  readonly tx: StoredTransaction;
  readonly kind: CountedKind;
  readonly at: Instant; // tx.occurredAt: the bank's own moment, never the moment of storage
  readonly category: Category; // tx.category
  readonly merchant: string; // tx.merchant
  readonly original: Money; // spending: negateMoney(tx.amount) (its magnitude); refund and income: tx.amount
  readonly result: ConversionResult; // the one conversion of `original` at its own day
  readonly figure: Money | null; // result.line unless result.kind is 'unconverted', then null
}

export interface CashbackLine {
  readonly tx: StoredTransaction;
  readonly at: Instant;
  readonly original: Money; // tx.cashback
  readonly result: ConversionResult;
  readonly figure: Money | null;
}

export interface JarLine {
  readonly tx: StoredTransaction;
  readonly jar: HoldingId;
  readonly at: Instant;
  readonly original: Money; // tx.amount, in the jar's currency
  readonly result: ConversionResult;
  readonly figure: Money | null;
}

export interface SpanTotals {
  readonly spending: Money; // sum of the converted spending figures (gross; refunds never reduce it)
  readonly refunds: Money;
  readonly income: Money;
  readonly cashback: Money;
}

export interface PeriodLedger {
  readonly display: DisplayCurrency;
  readonly read: Span; // spanUnion of the requested spans
  lines(s: Span, kind?: CountedKind): readonly LedgerLine[]; // s.from <= at < s.until, in read order
  cashbackLines(s: Span): readonly CashbackLine[];
  jarLines(s: Span, jar?: HoldingId): readonly JarLine[];
  totals(s: Span): SpanTotals;
  spendingByCategory(s: Span): ReadonlyMap<Category, Money>; // keys in CATEGORIES order
  results(s: Span): ConversionResult[]; // every counted and cashback line's result in s, in read order
}

const figureOf = (r: ConversionResult): Money | null => (r.kind === 'unconverted' ? null : r.line);

const inSpan = (s: Span, at: Instant): boolean => s.from <= at && at < s.until;

export function buildLedger(ctx: QuestionContext, mc: MoneyContext, spans: readonly Span[]): PeriodLedger {
  if (spans.length === 0) throw new RangeError('buildLedger needs at least one span.');
  const read = spanUnion(spans);
  const display = ctx.displayCurrency;
  const jars = new Set(ctx.register.holdings.filter((h) => h.kind === 'jar').map((h) => h.id));
  const txs = selectTransactions(ctx.snapshot.db, {
    holdings: ctx.scope.holdings,
    from: read.from,
    until: read.until,
    order: 'occurred',
  });

  // Counted and cashback lines in read order, one sequence, so results(s) keeps read order.
  type Kept = { readonly line: LedgerLine; readonly cashback?: never } | { readonly cashback: CashbackLine; readonly line?: never };
  const kept: Kept[] = [];
  const counted: LedgerLine[] = [];
  const cashbacks: CashbackLine[] = [];
  const jarLines: JarLine[] = [];

  for (const t of txs) {
    const kind = classifyMovement(t);
    const when = { kind: 'day', day: ctx.calendar.localDay(t.occurredAt) } as const;
    const at = t.occurredAt;
    if (kind === 'spending' || kind === 'refund' || kind === 'income') {
      const original = kind === 'spending' ? negateMoney(t.amount) : t.amount;
      const result = mc.converter.convert(original, when);
      const line: LedgerLine = {
        tx: t,
        kind,
        at,
        category: t.category,
        merchant: t.merchant,
        original,
        result,
        figure: figureOf(result),
      };
      counted.push(line);
      kept.push({ line });
    }
    if (t.cashback !== null && t.cashback.minor !== 0n) {
      const result = mc.converter.convert(t.cashback, when);
      const cashback: CashbackLine = { tx: t, at, original: t.cashback, result, figure: figureOf(result) };
      cashbacks.push(cashback);
      kept.push({ cashback });
    }
    if (jars.has(t.holdingId) && t.amount.minor > 0n) {
      const result = mc.converter.convert(t.amount, when);
      jarLines.push({ tx: t, jar: t.holdingId, at, original: t.amount, result, figure: figureOf(result) });
    }
  }

  const sumFigures = (lines: readonly { readonly figure: Money | null }[]): Money =>
    sumMoney(
      lines.flatMap((l) => (l.figure === null ? [] : [l.figure])),
      display,
    );
  const lines = (s: Span, kind?: CountedKind): LedgerLine[] =>
    counted.filter((l) => inSpan(s, l.at) && (kind === undefined || l.kind === kind));
  const cashbackLines = (s: Span): CashbackLine[] => cashbacks.filter((l) => inSpan(s, l.at));

  return {
    display,
    read,
    lines,
    cashbackLines,
    jarLines: (s, jar) => jarLines.filter((l) => inSpan(s, l.at) && (jar === undefined || l.jar === jar)),
    totals(s) {
      return {
        spending: sumFigures(lines(s, 'spending')),
        refunds: sumFigures(lines(s, 'refund')),
        income: sumFigures(lines(s, 'income')),
        cashback: sumFigures(cashbackLines(s)),
      };
    },
    spendingByCategory(s) {
      const byCategory = new Map<Category, LedgerLine[]>();
      for (const l of lines(s, 'spending')) {
        const group = byCategory.get(l.category);
        if (group === undefined) byCategory.set(l.category, [l]);
        else group.push(l);
      }
      const out = new Map<Category, Money>();
      for (const c of CATEGORIES) {
        const group = byCategory.get(c);
        if (group !== undefined) out.set(c, sumFigures(group));
      }
      return out;
    },
    results(s) {
      const out: ConversionResult[] = [];
      for (const k of kept) {
        if (k.line !== undefined) {
          if (inSpan(s, k.line.at)) out.push(k.line.result);
        } else if (inSpan(s, k.cashback.at)) {
          out.push(k.cashback.result);
        }
      }
      return out;
    },
  };
}
