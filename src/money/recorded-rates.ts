// Recorded rates (S-112): the stated rate as a source states it, the rate table keyed by
// (source, pair, heldFrom), and the insert-if-absent recorder that writes inside the store's one
// write. Figures are held as the decimal text the bank wrote; no local date is stored.

import type { Database } from 'bun:sqlite';
import type { CurrencyCode, Instant, SourceId } from '../core/primitives';
import type { RecordedRateHead, WriteTx } from '../db/index';
import { rateInstant } from '../db/index';
import { currencyByCode } from './currencies';
import type { ExactDecimal } from './exact';
import { decimalToString, parseExactDecimal } from './exact';

export interface QuotedPair {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
} // 1 base costs `rate` quote (Monobank: currencyCodeA priced in currencyCodeB)

export type RateFigures =
  | { kind: 'buy_sell'; buy: ExactDecimal; sell: ExactDecimal }
  | { kind: 'cross'; rate: ExactDecimal };

export interface StatedRate {
  readonly pair: QuotedPair;
  readonly statedFrom?: Instant;
  readonly figures: RateFigures;
} // as the bank wrote it; statedFrom = the bank's own timestamp

export interface RecordedRate extends RecordedRateHead {
  readonly figures: RateFigures;
} // sourceId, base, quote, heldFrom + figures

export function ensureRateSchema(db: Database): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS rate_snapshot (' +
      'source_id TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL, held_from INTEGER NOT NULL, ' +
      'buy TEXT, sell TEXT, cross_rate TEXT, ' +
      'PRIMARY KEY (source_id, base, quote, held_from), ' +
      'CHECK ((buy IS NOT NULL AND sell IS NOT NULL AND cross_rate IS NULL) ' +
      'OR (buy IS NULL AND sell IS NULL AND cross_rate IS NOT NULL))' +
      ') WITHOUT ROWID',
  );
}

function positive(d: ExactDecimal): boolean {
  return d.digits > 0n;
}

function acceptable(s: StatedRate, heldFrom: Instant): boolean {
  const { base, quote } = s.pair;
  if (base === quote) return false;
  if (currencyByCode(base) === undefined || currencyByCode(quote) === undefined) return false;
  if (!Number.isSafeInteger(heldFrom)) return false;
  const f = s.figures;
  return f.kind === 'buy_sell' ? positive(f.buy) && positive(f.sell) : positive(f.rate);
}

export function recordRates(
  tx: WriteTx,
  sourceId: SourceId,
  stated: readonly StatedRate[],
  recordedAt: Instant,
): { added: number; alreadyHeld: number; rejected: number } {
  const insert = tx.db.prepare(
    'INSERT OR IGNORE INTO rate_snapshot (source_id, base, quote, held_from, buy, sell, cross_rate) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let added = 0;
  let alreadyHeld = 0;
  let rejected = 0;
  for (const s of stated) {
    const heldFrom = rateInstant(s.statedFrom, recordedAt);
    if (!acceptable(s, heldFrom)) {
      rejected++;
      continue;
    }
    const f = s.figures;
    const result =
      f.kind === 'buy_sell'
        ? insert.run(sourceId, s.pair.base, s.pair.quote, heldFrom, decimalToString(f.buy), decimalToString(f.sell), null)
        : insert.run(sourceId, s.pair.base, s.pair.quote, heldFrom, null, null, decimalToString(f.rate));
    if (result.changes > 0) added++;
    else alreadyHeld++;
  }
  return { added, alreadyHeld, rejected };
}

function decimalField(row: Record<string, unknown>, name: string): ExactDecimal {
  const text = row[name];
  const d = typeof text === 'string' ? parseExactDecimal(text) : null;
  if (d === null) throw new Error(`rate_snapshot row has no decimal in ${name}: ${String(text)}`);
  return d;
}

export function readRecordedRate(row: unknown): RecordedRate {
  if (typeof row !== 'object' || row === null) throw new Error('rate_snapshot row is not an object');
  const r = row as Record<string, unknown>;
  const figures: RateFigures =
    r.cross_rate === null || r.cross_rate === undefined
      ? { kind: 'buy_sell', buy: decimalField(r, 'buy'), sell: decimalField(r, 'sell') }
      : { kind: 'cross', rate: decimalField(r, 'cross_rate') };
  return {
    sourceId: String(r.source_id),
    base: String(r.base),
    quote: String(r.quote),
    heldFrom: Number(r.held_from),
    figures,
  };
}
