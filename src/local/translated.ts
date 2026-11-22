// Translated transaction (S-138): the one shape every source fills for ingest. A source's
// translation produces these and the ingest step is their only consumer; a source never writes
// rows itself. checkTranslated enforces the shape's rules before a batch's write opens.

import type { HoldingId, Instant, SourceId } from '../core/primitives';
import type { Money } from '../money/money';

export interface TransactionKey {
  readonly sourceId: SourceId;
  readonly bankId: string;
}

// Unambiguous because a SourceId never contains ':'.
export function keyText(k: TransactionKey): string {
  return `${k.sourceId}:${k.bankId}`;
}

// keyText order by UTF-16 code unit, exactly -1, 0 or 1.
export function compareKeys(a: TransactionKey, b: TransactionKey): number {
  const x = keyText(a);
  const y = keyText(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export type CounterpartVia = 'link' | 'jar_top_up' | 'jar_withdrawal';
export interface Counterpart {
  readonly holdingId: HoldingId; // the holder's other account or jar the bank names; need not be registered
  readonly bankId: string | null; // the bank's identifier of the counterpart movement, when it gives one
  readonly via: CounterpartVia;
}

export interface TranslatedTransaction {
  readonly sourceId: SourceId;
  readonly bankId: string; // a pending hold and its settled version carry the same one
  readonly holdingId: HoldingId; // narrowingName(sourceId, 'account' | 'jar', bank's holding id)
  readonly occurredAt: Instant; // the moment the bank states for this version
  readonly amount: Money; // in the holding's currency; outflow < 0, inflow > 0
  readonly originalAmount: Money | null; // the operation's own amount when its currency differs; else null
  readonly cashback: Money | null; // as the bank reports it, in amount's currency, never negative; null when none
  readonly settled: boolean; // false for a pending card hold
  readonly mcc: number | null;
  readonly originalMcc: number | null;
  readonly merchantText: string | null; // verbatim
  readonly description: string; // verbatim ('' when none)
  readonly comment: string | null; // verbatim
  readonly counterpart: Counterpart | null;
}

export class TranslatedShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslatedShapeError';
  }
}

function sign(minor: bigint): number {
  return minor < 0n ? -1 : minor > 0n ? 1 : 0;
}

function isCode(n: number | null): boolean {
  return n === null || (Number.isSafeInteger(n) && n >= 0 && n <= 9999);
}

export function checkTranslated(t: TranslatedTransaction): void {
  const fail = (rule: string): never => {
    throw new TranslatedShapeError(`translated transaction ${keyText(t)}: ${rule}`);
  };
  if (!t.holdingId.startsWith(`${t.sourceId}:`)) fail(`holdingId '${t.holdingId}' does not begin with '${t.sourceId}:'`);
  if (t.bankId === '') fail('bankId is empty');
  if (!Number.isSafeInteger(t.occurredAt)) fail(`occurredAt ${t.occurredAt} is not a whole number`);
  if (t.originalAmount !== null) {
    if (t.originalAmount.currency === t.amount.currency) {
      fail(`originalAmount is in the amount's currency ${t.amount.currency}`);
    }
    if (sign(t.originalAmount.minor) !== sign(t.amount.minor)) fail('originalAmount and amount differ in sign');
  }
  if (t.counterpart !== null && t.counterpart.holdingId === t.holdingId) {
    fail(`counterpart names the transaction's own holding '${t.holdingId}'`);
  }
  if (!isCode(t.mcc)) fail(`mcc ${t.mcc} is not a whole number from 0 to 9999`);
  if (!isCode(t.originalMcc)) fail(`originalMcc ${t.originalMcc} is not a whole number from 0 to 9999`);
  if (t.cashback !== null) {
    if (t.cashback.currency !== t.amount.currency) {
      fail(`cashback currency ${t.cashback.currency} differs from amount currency ${t.amount.currency}`);
    }
    if (t.cashback.minor < 0n) fail('cashback is negative');
  }
}
