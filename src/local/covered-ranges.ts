// Covered-range statement (S-77): the envelope contributor that reads each in-scope source's covered
// set from the question's snapshot and draws each interval inward to the minute in the question's
// zone, so a shown range never claims a moment the local copy does not hold.

import type { Calendar } from '../analytics/dates';
import type { EnvelopeContributor, QuestionContext } from '../core/question';
import type { Instant, LocalDateTime, SourceId } from '../core/primitives';
import { type Interval, MINUTE_MS, readCovered } from './covered';

export const COVERED_RANGES_KEY = 'coveredRanges';

export interface ShownRange {
  readonly startAt: Instant; // rounded up to the minute
  readonly endAt: Instant; // rounded down to the minute
  readonly start: LocalDateTime; // calendar.localDateTime(startAt)
  readonly end: LocalDateTime; // calendar.localDateTime(endAt)
}

export interface SourceCoverage {
  readonly sourceId: SourceId;
  readonly ranges: readonly ShownRange[]; // empty: the source covers no dates
}

export type CoveredRangesStatement = readonly SourceCoverage[];

export function drawInward(interval: Interval, calendar: Calendar): ShownRange | null {
  const startAt = Math.ceil(interval.startAt / MINUTE_MS) * MINUTE_MS;
  const endAt = Math.floor(interval.endAt / MINUTE_MS) * MINUTE_MS;
  if (endAt - startAt < MINUTE_MS) return null;
  return {
    startAt,
    endAt,
    start: calendar.localDateTime(startAt),
    end: calendar.localDateTime(endAt),
  };
}

export const coveredRangesContributor: EnvelopeContributor = {
  key: COVERED_RANGES_KEY,
  contribute(ctx: QuestionContext): CoveredRangesStatement {
    const { snapshot, calendar, scope } = ctx;
    return scope.sources.map((sourceId) => ({
      sourceId,
      ranges: readCovered(snapshot, sourceId)
        .map((x) => drawInward(x, calendar))
        .filter((r): r is ShownRange => r !== null),
    }));
  },
};
