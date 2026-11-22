// Covered intervals (S-71): per source, a set of half-open instant intervals the local copy holds
// completely. The covered part of a completed step is its window minus the minute of every record
// it quarantined, or none when a quarantined moment is unreadable; the ingest write merges that part
// into the source's set, which only ever widens; answers read the set from their snapshot.

import type { Database } from 'bun:sqlite';
import type { Instant, SourceId } from '../core/primitives';
import type { Snapshot, WriteTx } from '../db/index';

export const MINUTE_MS = 60_000;

export interface Interval {
  readonly startAt: Instant;
  readonly endAt: Instant;
} // half-open: startAt <= t < endAt

export class CoveredPartError extends Error {
  readonly interval: Interval;
  constructor(interval: Interval) {
    super(
      `Covered interval [${String(interval.startAt)}, ${String(interval.endAt)}) is not ` +
        'two whole instants with start before end.',
    );
    this.name = 'CoveredPartError';
    this.interval = interval;
  }
}

export function normaliseIntervals(xs: readonly Interval[]): Interval[] {
  const sorted = xs.filter((x) => x.startAt < x.endAt).sort((a, b) => a.startAt - b.startAt);
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && last.endAt >= x.startAt) {
      if (x.endAt > last.endAt) out[out.length - 1] = { startAt: last.startAt, endAt: x.endAt };
    } else {
      out.push({ startAt: x.startAt, endAt: x.endAt });
    }
  }
  return out;
}

export function minuteOf(moment: Instant): Interval {
  const startAt = Math.floor(moment / MINUTE_MS) * MINUTE_MS;
  return { startAt, endAt: startAt + MINUTE_MS };
}

export function coveredPart(
  window: Interval,
  quarantinedMoments: readonly (Instant | null)[],
): Interval[] | null {
  if (quarantinedMoments.some((m) => m === null)) return null;
  let left = normaliseIntervals([window]);
  for (const m of quarantinedMoments as readonly Instant[]) {
    const cut = minuteOf(m);
    left = left.flatMap((x) =>
      cut.endAt <= x.startAt || cut.startAt >= x.endAt
        ? [x]
        : [
            { startAt: x.startAt, endAt: cut.startAt },
            { startAt: cut.endAt, endAt: x.endAt },
          ],
    );
  }
  return normaliseIntervals(left);
}

export function ensureCoverageSchema(db: Database): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS covered_interval (' +
      'source_id TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, ' +
      'PRIMARY KEY (source_id, start_at))',
  );
}

function readRows(db: Database, sourceId: SourceId): Interval[] {
  const rows = db
    .query(
      'SELECT start_at, end_at FROM covered_interval WHERE source_id = ? ORDER BY start_at',
    )
    .all(sourceId) as { start_at: number; end_at: number }[];
  return rows.map((r) => ({ startAt: r.start_at, endAt: r.end_at }));
}

export function mergeCovered(tx: WriteTx, sourceId: SourceId, part: readonly Interval[]): void {
  for (const x of part) {
    if (!Number.isSafeInteger(x.startAt) || !Number.isSafeInteger(x.endAt) || x.startAt >= x.endAt) {
      throw new CoveredPartError(x);
    }
  }
  if (part.length === 0) return;

  const merged = normaliseIntervals([...readRows(tx.db, sourceId), ...part]);
  tx.db.run('DELETE FROM covered_interval WHERE source_id = ?', [sourceId]);
  const insert = tx.db.query(
    'INSERT INTO covered_interval (source_id, start_at, end_at) VALUES (?, ?, ?)',
  );
  for (const x of merged) insert.run(sourceId, x.startAt, x.endAt);
}

export function readCovered(snap: Snapshot, sourceId: SourceId): Interval[] {
  return readRows(snap.db, sourceId);
}
