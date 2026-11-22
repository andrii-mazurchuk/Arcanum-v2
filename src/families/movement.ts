// Movement classifier (S-128): one pure function from a stored transaction's sign, settlement,
// transfer link, category, description and reported cashback to exactly one kind. Every answer
// that counts money takes kinds only from classifyMovement; no family classifies for itself and no
// kind is stored. The comment and merchant never take part.

import { foldCase } from '../answers/text';
import type { CurrencyCode } from '../core/primitives';
import { type Category, UNCATEGORIZED } from '../local/classifier';
import type { TransferView } from '../local/transactions';
import { exponentOf } from '../money/currencies';
import type { Money } from '../money/money';

export const MOVEMENT_KINDS = [
  'spending',
  'refund',
  'cashback',
  'income',
  'other_incoming',
  'own_transfer',
  'pending',
  'none',
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export const INCOME_STEMS = ['зарплат', 'salary', 'оклад', 'виплата', 'нарахування', 'dividend', 'дивіденд'] as const; // already folded
export const INCOME_THRESHOLD_UNITS = 50000n; // whole units of the account's own currency

export function incomeThreshold(currency: CurrencyCode): bigint {
  return INCOME_THRESHOLD_UNITS * 10n ** BigInt(exponentOf(currency));
}

export interface MovementFacts {
  readonly amount: Money;
  readonly settled: boolean;
  readonly category: Category;
  readonly description: string;
  readonly transfer: TransferView | null;
  readonly cashback: Money | null; // the cashback the bank reported on the transaction, in its holding's currency, or null
}

// The first rule that holds decides: own transfer, outgoing (pending included), zero, incoming
// hold, then settled incoming as cashback, income, refund, other incoming.
export function classifyMovement(t: MovementFacts): MovementKind {
  if (t.transfer !== null) return 'own_transfer';
  if (t.amount.minor < 0n) return 'spending';
  if (t.amount.minor === 0n) return 'none';
  if (!t.settled) return 'pending';
  if (t.cashback !== null && t.cashback.currency === t.amount.currency && t.cashback.minor === t.amount.minor) {
    return 'cashback';
  }
  const folded = foldCase(t.description);
  if (INCOME_STEMS.some((stem) => folded.includes(stem)) || t.amount.minor >= incomeThreshold(t.amount.currency)) {
    return 'income';
  }
  if (t.category !== UNCATEGORIZED) return 'refund';
  return 'other_incoming';
}
