// Sync progress (S-90): the first-fill record (anchor, first-start instant, completion mark) and the
// pure interval rules the job runner plans by: subtraction, quarantine-excluded minutes, the last
// moment known complete, the fill and catch-up-and-poll targets, the completion test, and step
// planning oldest or newest first.

import type { Database } from 'bun:sqlite';
import type { Instant, SourceId } from '../core/primitives';
import type { Snapshot, Store, WriteTx } from '../db/index';
import { type Interval, minuteOf, normaliseIntervals } from '../local/covered';
import type { QuarantineEntry } from '../money/quarantine';

export const DAY_MS = 86_400_000;
export const SETTLE_MS = 86_400_000; // the 24 hours every catch-up and poll refetches

export interface FirstFillRecord {
  readonly sourceId: SourceId;
  readonly anchorAt: Instant; // firstStartAt - firstFillDays * DAY_MS; the source's forward origin
  readonly firstStartAt: Instant;
  readonly completedAt: Instant | null; // the completion mark
}

export class StepPlanError extends Error {
  constructor(maxWindowMs: unknown) {
    super(`Step length ${String(maxWindowMs)} is not a whole number of milliseconds >= 1.`);
    this.name = 'StepPlanError';
  }
}

export function ensureFirstFillSchema(db: Database): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS first_fill (' +
      'source_id TEXT PRIMARY KEY, anchor_at INTEGER NOT NULL, ' +
      'first_start_at INTEGER NOT NULL, completed_at INTEGER)',
  );
}

function readRow(db: Database, sourceId: SourceId): FirstFillRecord | null {
  const row = db
    .query('SELECT anchor_at, first_start_at, completed_at FROM first_fill WHERE source_id = ?')
    .get(sourceId) as { anchor_at: number; first_start_at: number; completed_at: number | null } | null;
  if (row === null) return null;
  return {
    sourceId,
    anchorAt: row.anchor_at,
    firstStartAt: row.first_start_at,
    completedAt: row.completed_at,
  };
}

export function readFirstFill(snap: Snapshot, sourceId: SourceId): FirstFillRecord | null {
  return readRow(snap.db, sourceId);
}

export function createFirstFill(
  store: Store,
  sourceId: SourceId,
  firstStartAt: Instant,
  firstFillDays: number,
): FirstFillRecord {
  return store.write((tx) => {
    tx.db.run(
      'INSERT OR IGNORE INTO first_fill (source_id, anchor_at, first_start_at, completed_at) ' +
        'VALUES (?, ?, ?, NULL)',
      [sourceId, firstStartAt - firstFillDays * DAY_MS, firstStartAt],
    );
    return readRow(tx.db, sourceId) as FirstFillRecord;
  });
}

export function markFirstFillComplete(tx: WriteTx, sourceId: SourceId, at: Instant): void {
  tx.db.run(
    'UPDATE first_fill SET completed_at = ? WHERE source_id = ? AND completed_at IS NULL',
    [at, sourceId],
  );
}

export function subtractIntervals(from: readonly Interval[], minus: readonly Interval[]): Interval[] {
  const cuts = normaliseIntervals(minus);
  const out: Interval[] = [];
  for (const x of normaliseIntervals(from)) {
    let at = x.startAt;
    for (const c of cuts) {
      if (c.endAt <= at) continue;
      if (c.startAt >= x.endAt) break;
      if (c.startAt > at) out.push({ startAt: at, endAt: c.startAt });
      at = Math.max(at, c.endAt);
      if (at >= x.endAt) break;
    }
    if (at < x.endAt) out.push({ startAt: at, endAt: x.endAt });
  }
  return normaliseIntervals(out);
}

export function excludedMinutes(quarantine: readonly QuarantineEntry[], before: Instant): Interval[] {
  return normaliseIntervals(
    quarantine
      .filter((e) => e.occurredAt !== null && e.occurredAt < before)
      .map((e) => minuteOf(e.occurredAt as Instant)),
  );
}

export function lastKnownComplete(
  covered: readonly Interval[],
  excluded: readonly Interval[],
  origin: Instant,
): Instant {
  const run = normaliseIntervals([...covered, ...excluded]).find(
    (x) => x.startAt <= origin && origin < x.endAt,
  );
  return run === undefined ? origin : run.endAt;
}

export function fillTarget(
  covered: readonly Interval[],
  excluded: readonly Interval[],
  rec: FirstFillRecord,
  start: Instant,
): Interval[] {
  return subtractIntervals([{ startAt: rec.anchorAt, endAt: start }], [...covered, ...excluded]);
}

export function forwardTarget(
  covered: readonly Interval[],
  excluded: readonly Interval[],
  origin: Instant,
  start: Instant,
): Interval[] {
  return normaliseIntervals([
    ...subtractIntervals([{ startAt: origin, endAt: start }], [...covered, ...excluded]),
    { startAt: start - SETTLE_MS, endAt: start },
  ]);
}

export function fillIsComplete(
  covered: readonly Interval[],
  excluded: readonly Interval[],
  rec: FirstFillRecord,
): boolean {
  return (
    subtractIntervals([{ startAt: rec.anchorAt, endAt: rec.firstStartAt }], [...covered, ...excluded])
      .length === 0
  );
}

export function planSteps(
  target: readonly Interval[],
  maxWindowMs: number,
  order: 'oldest_first' | 'newest_first',
): Interval[] {
  if (!Number.isSafeInteger(maxWindowMs) || maxWindowMs < 1) throw new StepPlanError(maxWindowMs);
  const steps: Interval[] = [];
  for (const x of normaliseIntervals(target)) {
    if (order === 'oldest_first') {
      for (let at = x.startAt; at < x.endAt; at += maxWindowMs) {
        steps.push({ startAt: at, endAt: Math.min(at + maxWindowMs, x.endAt) });
      }
    } else {
      for (let at = x.endAt; at > x.startAt; at -= maxWindowMs) {
        steps.push({ startAt: Math.max(at - maxWindowMs, x.startAt), endAt: at });
      }
    }
  }
  return order === 'oldest_first'
    ? steps.sort((a, b) => a.startAt - b.startAt)
    : steps.sort((a, b) => b.startAt - a.startAt);
}
