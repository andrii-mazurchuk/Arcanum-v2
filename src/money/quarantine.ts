// Quarantine (S-83): the per-source set-aside of records that cannot be held exactly. Keyed by
// (source, bank id): a re-fetch replaces the entry, a later exact translation clears it, and each
// quarantined item logs one line. Settlement never fails the sync step for a quarantined item; an
// item under another source's id is a programming error and rolls the write back.

import type { Database } from 'bun:sqlite';
import type { Instant, SourceId } from '../core/primitives';
import type { WriteTx } from '../db/index';
import type { MinorParseFailure } from './money';

export type QuarantineReason = MinorParseFailure; // 'malformed' | 'excess_precision' | 'unknown_currency'

export interface QuarantineEntry {
  readonly sourceId: SourceId;
  readonly bankId: string; // the source's own transaction identifier
  readonly raw: string; // the record's figures as the bank wrote them, verbatim
  readonly reason: QuarantineReason;
  readonly detail: string; // from MinorParse.detail
  readonly seenAt: Instant;
  readonly occurredAt: Instant | null; // the record's own moment as the bank stated it; null when unreadable
}

export type Translated<T> =
  | { kind: 'held'; sourceId: SourceId; bankId: string; record: T }
  | { kind: 'quarantined'; entry: QuarantineEntry };

export class QuarantineSourceMismatchError extends Error {
  constructor(expected: SourceId, found: SourceId, bankId: string) {
    super(`Item ${bankId} of source "${found}" was settled under source "${expected}".`);
    this.name = 'QuarantineSourceMismatchError';
  }
}

export function ensureQuarantineSchema(db: Database): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS quarantine (' +
      'source_id TEXT NOT NULL, bank_id TEXT NOT NULL, raw TEXT NOT NULL, reason TEXT NOT NULL, ' +
      'detail TEXT NOT NULL, seen_at INTEGER NOT NULL, occurred_at INTEGER, ' +
      'PRIMARY KEY (source_id, bank_id))',
  );
}

export function settleQuarantine(
  tx: WriteTx,
  sourceId: SourceId,
  batch: readonly Translated<unknown>[],
  log: (line: string) => void,
): { quarantined: number; cleared: number } {
  // Every item is checked before anything is written or logged, so a mismatch logs nothing.
  for (const item of batch) {
    const found = item.kind === 'held' ? item.sourceId : item.entry.sourceId;
    if (found !== sourceId) {
      const bankId = item.kind === 'held' ? item.bankId : item.entry.bankId;
      throw new QuarantineSourceMismatchError(sourceId, found, bankId);
    }
  }

  const replace = tx.db.query(
    'INSERT OR REPLACE INTO quarantine ' +
      '(source_id, bank_id, raw, reason, detail, seen_at, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const clear = tx.db.query('DELETE FROM quarantine WHERE source_id = ? AND bank_id = ?');

  let quarantined = 0;
  let cleared = 0;
  for (const item of batch) {
    if (item.kind === 'quarantined') {
      const e = item.entry;
      replace.run(e.sourceId, e.bankId, e.raw, e.reason, e.detail, e.seenAt, e.occurredAt);
      quarantined += 1;
      log(
        `quarantined source=${e.sourceId} bank_id=${e.bankId} reason=${e.reason} detail=${e.detail}`,
      );
    } else {
      cleared += clear.run(item.sourceId, item.bankId).changes;
    }
  }
  return { quarantined, cleared };
}

export function listQuarantine(db: Database, sourceId?: SourceId): QuarantineEntry[] {
  const rows = (
    sourceId === undefined
      ? db
          .query(
            'SELECT source_id, bank_id, raw, reason, detail, seen_at, occurred_at FROM quarantine ' +
              'ORDER BY source_id, bank_id',
          )
          .all()
      : db
          .query(
            'SELECT source_id, bank_id, raw, reason, detail, seen_at, occurred_at FROM quarantine ' +
              'WHERE source_id = ? ORDER BY source_id, bank_id',
          )
          .all(sourceId)
  ) as {
    source_id: string;
    bank_id: string;
    raw: string;
    reason: QuarantineReason;
    detail: string;
    seen_at: number;
    occurred_at: number | null;
  }[];
  return rows.map((r) => ({
    sourceId: r.source_id,
    bankId: r.bank_id,
    raw: r.raw,
    reason: r.reason,
    detail: r.detail,
    seenAt: r.seen_at,
    occurredAt: r.occurred_at,
  }));
}
