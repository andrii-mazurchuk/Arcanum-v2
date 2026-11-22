// Rates used (S-29): the list assembled from the provenance of the conversion results an answer
// shows, one item per (applied pair and direction, record date), substituted marks ORed, one
// not-converted item per pair. The caller passes exactly the results that contribute to some
// rendered figure; nothing here sees a result the answer computed but does not render.

import type { CurrencyCode, DisplayCurrency, LocalDate } from '../core/primitives';
import type { ConversionResult } from './converter';
import type { Fraction } from './exact';
import { decimalToString, fractionsEqual } from './exact';
import type { QuotedPair } from './recorded-rates';

export type RateUsedItem =
  | { kind: 'applied'; from: CurrencyCode; to: CurrencyCode; quoted: QuotedPair; quotedValue: string; appliedValue: Fraction; date: LocalDate; substituted: boolean }
  | { kind: 'not_converted'; from: CurrencyCode; to: DisplayCurrency };

// One group carrying two applied values: an invariant breach, thrown, never rendered.
export class RateItemConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateItemConflictError';
  }
}

type AppliedItem = Extract<RateUsedItem, { kind: 'applied' }>;
type NotConvertedItem = Extract<RateUsedItem, { kind: 'not_converted' }>;

// Code-unit order, not locale order.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function assembleRatesUsed(shown: readonly ConversionResult[]): RateUsedItem[] {
  const applied = new Map<string, AppliedItem>();
  const notConverted = new Map<string, NotConvertedItem>();

  for (const result of shown) {
    if (result.kind === 'converted') {
      for (const leg of result.legs) {
        const key = `${leg.applied.from}\u0000${leg.applied.to}\u0000${leg.recordDate}`;
        const existing = applied.get(key);
        if (existing === undefined) {
          applied.set(key, {
            kind: 'applied',
            from: leg.applied.from,
            to: leg.applied.to,
            quoted: leg.quoted,
            quotedValue: decimalToString(leg.quotedValue),
            appliedValue: leg.appliedValue,
            date: leg.recordDate,
            substituted: leg.substituted,
          });
        } else {
          if (!fractionsEqual(existing.appliedValue, leg.appliedValue)) {
            throw new RateItemConflictError(
              `two applied values for ${leg.applied.from}->${leg.applied.to} on ${leg.recordDate}`,
            );
          }
          if (leg.substituted) existing.substituted = true;
        }
      }
    } else if (result.kind === 'unconverted') {
      const key = `${result.pair.from}\u0000${result.pair.to}`;
      if (!notConverted.has(key)) {
        notConverted.set(key, { kind: 'not_converted', from: result.pair.from, to: result.pair.to });
      }
    }
  }

  const appliedItems = [...applied.values()].sort(
    (a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.date, b.date),
  );
  const notConvertedItems = [...notConverted.values()].sort((a, b) => compare(a.from, b.from));
  return [...appliedItems, ...notConvertedItems];
}
