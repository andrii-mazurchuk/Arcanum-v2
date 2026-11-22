// Rate gate (S-232): per-source rate-limit declarations with a lateness margin, the reservation
// ledger and cool-downs in the shared store, reserve in one short write, wait-and-grant with the
// late re-reserve, refusal recording, pruning, and the gated HTTP wrapper every source client is
// handed. The only writer of the ledger and the cool-down records; it never names the runtime's
// network function, which it receives typed by its own HttpFetch.

import type { Database } from 'bun:sqlite';
import type { Instant, SourceId } from '../core/primitives';
import type { Store, WriteTx } from '../db/index';

export const MIN_MARGIN_MS = 200;
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RateWindow {
  readonly callClass: string | null; // null: every call of the source; else only calls of that class
  readonly calls: number; // N: whole number >= 1
  readonly windowMs: number; // W: whole number >= 1
}

export interface RateLimitDecl {
  readonly windows: readonly RateWindow[]; // may be empty: calls are then only kept in order and behind cool-downs
  readonly marginMs: number; // m: whole number >= MIN_MARGIN_MS; at least twice the longest transit the source expects
  readonly refusalCooldownMs: number; // whole number >= 0
}

export interface WaitNotice {
  readonly sourceId: SourceId;
  readonly callClass: string;
  readonly until: Instant;
  readonly waitMs: number;
}

export interface RateGate {
  reserve(sourceId: SourceId, callClass: string): Instant;
  acquire(sourceId: SourceId, callClass: string, signal: AbortSignal, onWait?: (w: WaitNotice) => void): Promise<void>;
  recordRefusal(sourceId: SourceId): void;
}

export interface RateGateDeps {
  store: Store;
  limits: ReadonlyMap<SourceId, RateLimitDecl>;
  now: () => Instant;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>; // rejects with signal.reason when aborted
}

export interface GatedHttp {
  request(callClass: string, url: string, init: RequestInit, signal: AbortSignal): Promise<Response>;
}

export class RateLimitDeclError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitDeclError';
  }
}

export class UnknownRateSourceError extends Error {
  constructor(sourceId: SourceId) {
    super(`No rate limit is declared for source "${sourceId}".`);
    this.name = 'UnknownRateSourceError';
  }
}

export function ensureRateLedgerSchema(db: Database): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS rate_reservation (' +
      'seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, ' +
      'call_class TEXT NOT NULL, at INTEGER NOT NULL)',
  );
  db.run('CREATE INDEX IF NOT EXISTS rate_reservation_source_at ON rate_reservation (source_id, at)');
  db.run('CREATE TABLE IF NOT EXISTS rate_cooldown (source_id TEXT PRIMARY KEY, until INTEGER NOT NULL)');
}

function isWholeAtLeast(x: unknown, min: number): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= min;
}

function checkDecl(sourceId: SourceId, decl: RateLimitDecl): void {
  const fault = (rule: string): never => {
    throw new RateLimitDeclError(`The rate limit of source "${sourceId}" breaks a rule: ${rule}.`);
  };
  for (const w of decl.windows) {
    if (!isWholeAtLeast(w.calls, 1)) fault('calls must be a whole number >= 1');
    if (!isWholeAtLeast(w.windowMs, 1)) fault('windowMs must be a whole number >= 1');
  }
  if (!isWholeAtLeast(decl.marginMs, MIN_MARGIN_MS)) fault(`marginMs must be a whole number >= ${MIN_MARGIN_MS}`);
  if (!isWholeAtLeast(decl.refusalCooldownMs, 0)) fault('refusalCooldownMs must be a whole number >= 0');
}

export function createRateGate(deps: RateGateDeps): RateGate {
  const { store, limits, now, sleep } = deps;
  for (const [sourceId, decl] of limits) checkDecl(sourceId, decl);

  const declOf = (sourceId: SourceId): RateLimitDecl => {
    const decl = limits.get(sourceId);
    if (decl === undefined) throw new UnknownRateSourceError(sourceId);
    return decl;
  };

  const cooldownOf = (tx: WriteTx, sourceId: SourceId): number => {
    const row = tx.db.query('SELECT until FROM rate_cooldown WHERE source_id = ?').get(sourceId) as {
      until: number;
    } | null;
    return row === null ? 0 : row.until;
  };

  const reserve = (sourceId: SourceId, callClass: string): Instant => {
    const decl = declOf(sourceId);
    return store.write((tx) => {
      const n = now();
      const rows = tx.db
        .query('SELECT call_class, at FROM rate_reservation WHERE source_id = ? ORDER BY at, seq')
        .all(sourceId) as { call_class: string; at: number }[];
      let t = Math.max(n, rows.length === 0 ? 0 : rows[rows.length - 1]!.at, cooldownOf(tx, sourceId));
      let longest = 0;
      for (const w of decl.windows) {
        longest = Math.max(longest, w.windowMs);
        if (w.callClass !== null && w.callClass !== callClass) continue;
        const counted = w.callClass === null ? rows : rows.filter((r) => r.call_class === w.callClass);
        if (counted.length >= w.calls) {
          t = Math.max(t, counted[counted.length - w.calls]!.at + w.windowMs + decl.marginMs);
        }
      }
      tx.db.run('DELETE FROM rate_reservation WHERE source_id = ? AND at < ?', [
        sourceId,
        n - longest - decl.marginMs,
      ]);
      tx.db.run('INSERT INTO rate_reservation (source_id, call_class, at) VALUES (?, ?, ?)', [
        sourceId,
        callClass,
        t,
      ]);
      return t;
    });
  };

  return {
    reserve,
    async acquire(sourceId, callClass, signal, onWait) {
      const decl = declOf(sourceId);
      const lateBound = Math.floor(decl.marginMs / 2);
      for (;;) {
        const t = reserve(sourceId, callClass);
        if (t > now()) {
          onWait?.({ sourceId, callClass, until: t, waitMs: t - now() });
          await sleep(t - now(), signal);
        }
        if (now() <= t + lateBound) return;
      }
    },
    recordRefusal(sourceId) {
      const decl = declOf(sourceId);
      store.write((tx) => {
        const until = Math.max(cooldownOf(tx, sourceId), now() + decl.refusalCooldownMs);
        tx.db.run(
          'INSERT INTO rate_cooldown (source_id, until) VALUES (?, ?) ' +
            'ON CONFLICT (source_id) DO UPDATE SET until = excluded.until',
          [sourceId, until],
        );
      });
    },
  };
}

export function gatedHttp(
  gate: RateGate,
  sourceId: SourceId,
  fetchImpl: HttpFetch,
  onWait: (w: WaitNotice) => void,
): GatedHttp {
  return {
    async request(callClass, url, init, signal) {
      await gate.acquire(sourceId, callClass, signal, onWait);
      return fetchImpl(url, { ...init, signal });
    },
  };
}
