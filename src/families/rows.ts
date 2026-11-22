// Listed transaction row (S-147): the one row shape search and new-since-last-asked both list.
// Pure over its inputs; reads nothing from the store itself. The row carries no storage position
// and no listed mark: a family listing rows for the 'new' question hands back the listed positions
// separately, as its pending outcome.

import type { CurrencyCode, DisplayCurrency, HoldingId, Instant, LocalDateTime, SourceId } from '../core/primitives';
import type { QuestionContext } from '../core/question';
import type { Category } from '../local/classifier';
import type { StoredTransaction } from '../local/transactions';
import type { MoneyContext } from '../money/context';
import type { ConversionResult } from '../money/converter';
import type { Money } from '../money/money';

export interface TransactionRow {
  readonly sourceId: SourceId;
  readonly bankId: string; // with sourceId, the row's identity; a row is never identified by position alone
  readonly holdingId: HoldingId; // the account or jar, by narrowing name
  readonly occurredAt: Instant;
  readonly localDateTime: LocalDateTime; // ctx.calendar.localDateTime(occurredAt)
  readonly amount: Money; // as the account moved it, signed (outflow < 0)
  readonly originalAmount: Money | null;
  readonly shown: Money | null; // amount in the display currency, signed; null when unconverted
  readonly notConverted: { readonly from: CurrencyCode; readonly to: DisplayCurrency } | null; // exactly when shown is null
  readonly settled: boolean;
  readonly category: Category;
  readonly merchant: string;
  readonly description: string;
  readonly ownTransfer: { readonly direction: 'out' | 'in'; readonly otherHolding: HoldingId } | null; // from t.transfer
}

// Converts the amount the account moved at the transaction's local day and copies every other
// field. Never calls m.show: the family shows exactly the results of the rows it lists.
export function convertRow(
  ctx: QuestionContext,
  m: MoneyContext,
  t: StoredTransaction,
): { row: TransactionRow; result: ConversionResult } {
  const result = m.converter.convert(t.amount, { kind: 'day', day: ctx.calendar.localDay(t.occurredAt) });
  const row: TransactionRow = {
    sourceId: t.sourceId,
    bankId: t.bankId,
    holdingId: t.holdingId,
    occurredAt: t.occurredAt,
    localDateTime: ctx.calendar.localDateTime(t.occurredAt),
    amount: t.amount,
    originalAmount: t.originalAmount,
    shown: result.kind === 'unconverted' ? null : result.line,
    notConverted: result.kind === 'unconverted' ? { from: result.pair.from, to: result.pair.to } : null,
    settled: t.settled,
    category: t.category,
    merchant: t.merchant,
    description: t.description,
    ownTransfer: t.transfer ? { direction: t.transfer.direction, otherHolding: t.transfer.otherHolding } : null,
  };
  return { row, result };
}
