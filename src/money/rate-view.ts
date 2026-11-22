// Rate view (S-84): per-answer bounded lookups over one rate source's recorded rates, each day drawn
// by the question's Calendar and every read made through the question's one Snapshot; and the choice
// of the rate source of record from the product's built source list, never from a process's settings.

import type { Calendar } from '../analytics/dates';
import type { Instant, LocalDate, SourceId } from '../core/primitives';
import type { Capability } from '../core/register';
import type { Snapshot } from '../db/index';
import type { QuotedPair, RecordedRate } from './recorded-rates';
import { readRecordedRate } from './recorded-rates';

export interface DayRate {
  readonly record: RecordedRate;
  readonly day: LocalDate;
} // day = calendar.localDay(record.heldFrom)

export interface RateView {
  readonly sourceId: SourceId | null; // the rate source of record; null = no source the product is built with offers rates
  hasAny(pair: QuotedPair): boolean; // any record of exactly this quoted pair, at any time
  rateOfDay(pair: QuotedPair, day: LocalDate): DayRate | null; // latest heldFrom with startOfDay(day) <= heldFrom < startOfDay(addDays(day, 1))
  latestBefore(pair: QuotedPair, at: Instant): DayRate | null; // latest heldFrom < at
  earliest(pair: QuotedPair): DayRate | null; // smallest heldFrom
  latest(pair: QuotedPair): DayRate | null; // largest heldFrom
}

export interface BuiltSource {
  readonly id: SourceId;
  readonly capabilities: readonly Capability[];
} // one source the product is built with, its capabilities as the build declares them

// Every lookup is equality on (source_id, base, quote), at most a range on held_from, ordered by
// held_from and limited to one row: served by the table's primary key, never a scan of the history.
const PAIR = 'SELECT * FROM rate_snapshot WHERE source_id = ? AND base = ? AND quote = ?';

export function openRateView(snap: Snapshot, calendar: Calendar, sourceId: SourceId | null): RateView {
  const one = (sql: string, pair: QuotedPair, ...bounds: Instant[]): DayRate | null => {
    if (sourceId === null) return null;
    const row = snap.db.prepare(sql).get(sourceId, pair.base, pair.quote, ...bounds);
    if (row === null || row === undefined) return null;
    const record = readRecordedRate(row);
    return { record, day: calendar.localDay(record.heldFrom) };
  };
  return {
    sourceId,
    hasAny: (pair) => one(PAIR + ' ORDER BY held_from LIMIT 1', pair) !== null,
    rateOfDay: (pair, day) =>
      one(
        PAIR + ' AND held_from >= ? AND held_from < ? ORDER BY held_from DESC LIMIT 1',
        pair,
        calendar.startOfDay(day),
        calendar.startOfDay(calendar.addDays(day, 1)),
      ),
    latestBefore: (pair, at) => one(PAIR + ' AND held_from < ? ORDER BY held_from DESC LIMIT 1', pair, at),
    earliest: (pair) => one(PAIR + ' ORDER BY held_from ASC LIMIT 1', pair),
    latest: (pair) => one(PAIR + ' ORDER BY held_from DESC LIMIT 1', pair),
  };
}

export function chooseRateSource(built: readonly BuiltSource[]): SourceId | null {
  const first = built.find((s) => s.capabilities.includes('rates'));
  return first === undefined ? null : first.id;
}
