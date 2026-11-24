// Store (S-257): the one gateway to the local copy. One process-wide store, opened creating or
// existing-only, with every table installer in one write; synchronous read-only snapshots; whole
// immediate write transactions; storage positions claimed inside the storing write; register rows;
// the per-transaction listed mark and the store-held ask claim.

import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CurrencyCode, HoldingId, Instant, Position, SourceId } from '../core/primitives';
import type { Capability, HoldingKind, HoldingRow, RegisterView, SourceRow } from '../core/register';
import { narrowingName } from '../core/register';

export const MEMORY_LOCATION = ':memory:';
export const STORE_LOCK_WAIT_MS = 5000; // longest a file store's transaction waits for another process's lock
export const LISTED_MARKS_TABLE = 'listed_marks'; // position INTEGER PRIMARY KEY, one row per transaction the assistant has been shown
export type SchemaInstaller = (db: Database) => void; // idempotent: creates its own tables and indexes only if absent, never drops or alters
export type OpenMode = 'create' | 'existing';

export class SnapshotAwaitError extends Error {
  constructor() {
    super('A snapshot body returned a promise or thenable; snapshots are synchronous.');
    this.name = 'SnapshotAwaitError';
  }
}

export class StoreLocationError extends Error {
  readonly location: string;
  readonly why: string;
  constructor(location: string, why: string) {
    super(`The store at "${location}" cannot be used: ${why}.`);
    this.name = 'StoreLocationError';
    this.location = location;
    this.why = why;
  }
}

export class StoreSchemaError extends Error {
  readonly location: string;
  readonly underlying: unknown;
  constructor(location: string, underlying: unknown) {
    super(`The tables of the store at "${location}" could not be installed.`);
    this.name = 'StoreSchemaError';
    this.location = location;
    this.underlying = underlying;
  }
}

export class NoLocalCopyError extends Error {
  readonly location: string;
  readonly why: 'no_folder' | 'no_file' | 'empty_file';
  constructor(location: string, why: 'no_folder' | 'no_file' | 'empty_file') {
    super(`No local copy exists at "${location}"; the service or a backfill creates one.`);
    this.name = 'NoLocalCopyError';
    this.location = location;
    this.why = why;
  }
}

export class ListedPositionError extends Error {
  constructor(listed: unknown) {
    super(`Listed position ${String(listed)} is not a whole number from 1 to the store's position.`);
    this.name = 'ListedPositionError';
  }
}

export interface Store {
  readonly location: string;
  readSnapshot<T>(body: (snap: Snapshot) => T): T; // one read-only transaction around body; body is synchronous
  write<T>(body: (tx: WriteTx) => T): T; // one whole write transaction; rolled back if body throws; on a file store, durable when it returns
  close(): void; // synchronous: finalises every statement this store prepared, then closes the connection (bun:sqlite close(true)); when it returns, the process holds no handle on the location
}

export interface AskClaim {
  token: string;
  deadline: Instant;
} // who holds a point-moving family's ask, and until when

export interface Snapshot {
  readonly db: Database; // reads only; the connection is query-only for the snapshot's length
  position(): Position; // highest position claimed so far, 0 when none
  register(): RegisterView;
  isListed(p: Position): boolean; // true iff p has a row in LISTED_MARKS_TABLE
  claim(family: string): AskClaim | null; // the family's ask claim as held, expired or not; null when empty
}

export interface WriteTx {
  readonly db: Database;
  claimPosition(): Position; // previous high-water mark + 1, recorded in this same transaction
  register(): RegisterView; // the register as this transaction sees it, including rows it registered itself
  registerSource(row: SourceRow): void; // insert, or replace capabilities of an existing id
  registerHolding(h: Omit<HoldingRow, 'id'>): HoldingRow; // id = narrowingName(h.sourceId, h.kind, h.bankId)
  takeClaim(family: string, token: string, now: Instant, deadline: Instant): boolean;
  releaseClaim(
    family: string,
    token: string,
    listed: readonly Position[] | null,
  ): { released: boolean; marked: number | null };
}

export interface TransactionHead {
  // fields every stored transaction row carries, whatever else its slice adds
  sourceId: SourceId;
  bankId: string; // the bank's own identifier for the transaction; (sourceId, bankId) is unique
  holdingId: HoldingId;
  occurredAt: Instant; // the transaction's moment; no local date is stored
  position: Position; // the storage sequence number: from claimPosition() in the write that first stores the row; never changed
}

export interface RecordedRateHead {
  // fields every recorded exchange rate row carries
  sourceId: SourceId;
  base: CurrencyCode;
  quote: CurrencyCode;
  heldFrom: Instant; // rateInstant(statedFrom, recordedAt); no local date is stored
}

export function rateInstant(statedFrom: Instant | undefined, recordedAt: Instant): Instant {
  return statedFrom ?? recordedAt;
}

// The store's own tables: positions, register rows, listed marks, ask claims.
function installOwnTables(db: Database): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS store_position (' +
      'id INTEGER PRIMARY KEY CHECK (id = 1), high INTEGER NOT NULL)',
  );
  db.run('INSERT OR IGNORE INTO store_position (id, high) VALUES (1, 0)');
  db.run(
    'CREATE TABLE IF NOT EXISTS register_sources (id TEXT PRIMARY KEY, capabilities TEXT NOT NULL)',
  );
  db.run(
    'CREATE TABLE IF NOT EXISTS register_holdings (' +
      'id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_id TEXT NOT NULL, ' +
      'bank_id TEXT NOT NULL, currency TEXT NOT NULL)',
  );
  db.run(`CREATE TABLE IF NOT EXISTS ${LISTED_MARKS_TABLE} (position INTEGER PRIMARY KEY)`);
  db.run(
    'CREATE TABLE IF NOT EXISTS ask_claims (' +
      'family TEXT PRIMARY KEY, token TEXT NOT NULL, deadline INTEGER NOT NULL)',
  );
}

function readPosition(db: Database): Position {
  const row = db.query('SELECT high FROM store_position WHERE id = 1').get() as { high: number } | null;
  return row === null ? 0 : row.high;
}

function readRegister(db: Database): RegisterView {
  const sources = (
    db.query('SELECT id, capabilities FROM register_sources ORDER BY id').all() as {
      id: string;
      capabilities: string;
    }[]
  ).map((r) => ({ id: r.id, capabilities: JSON.parse(r.capabilities) as Capability[] }));
  const holdings = (
    db
      .query(
        'SELECT id, kind, source_id, bank_id, currency FROM register_holdings ORDER BY id',
      )
      .all() as { id: string; kind: HoldingKind; source_id: string; bank_id: string; currency: string }[]
  ).map(holdingFromRow);
  return { sources, holdings };
}

function holdingFromRow(r: {
  id: string;
  kind: HoldingKind;
  source_id: string;
  bank_id: string;
  currency: string;
}): HoldingRow {
  return { id: r.id, kind: r.kind, sourceId: r.source_id, bankId: r.bank_id, currency: r.currency };
}

function readClaim(db: Database, family: string): AskClaim | null {
  const row = db.query('SELECT token, deadline FROM ask_claims WHERE family = ?').get(family) as
    | { token: string; deadline: number }
    | null;
  return row === null ? null : { token: row.token, deadline: row.deadline };
}

function isListed(db: Database, p: Position): boolean {
  return db.query(`SELECT 1 AS one FROM ${LISTED_MARKS_TABLE} WHERE position = ?`).get(p) !== null;
}

function isThenable(x: unknown): boolean {
  return (
    x !== null &&
    (typeof x === 'object' || typeof x === 'function') &&
    typeof (x as { then?: unknown }).then === 'function'
  );
}

// Existing-only mode for a file location: decided from file-system reads alone, then a read-only
// look at the schema that switches nothing.
function checkLocalCopy(location: string): void {
  const folder = statSync(dirname(location), { throwIfNoEntry: false });
  if (folder === undefined || !folder.isDirectory()) throw new NoLocalCopyError(location, 'no_folder');
  const file = statSync(location, { throwIfNoEntry: false });
  if (file === undefined) throw new NoLocalCopyError(location, 'no_file');
  if (file.size === 0) throw new NoLocalCopyError(location, 'empty_file');

  let ro: Database;
  try {
    ro = new Database(location, { readonly: true });
  } catch {
    throw new StoreLocationError(location, 'cannot open');
  }
  let found: boolean;
  try {
    found =
      ro
        .query("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(LISTED_MARKS_TABLE) !== null;
  } catch {
    ro.close();
    throw new StoreLocationError(location, 'not a database');
  }
  ro.close();
  if (!found) throw new StoreLocationError(location, 'holds no store tables');
}

export function openStore(
  location: string,
  schemas: readonly SchemaInstaller[] = [],
  mode: OpenMode = 'create',
): Store {
  const isFile = location !== MEMORY_LOCATION;
  if (isFile && mode === 'existing') checkLocalCopy(location);

  let db: Database;
  try {
    db = new Database(location);
  } catch {
    throw new StoreLocationError(location, 'cannot open');
  }

  if (isFile) {
    try {
      db.run('PRAGMA journal_mode = WAL');
      db.run(`PRAGMA busy_timeout = ${STORE_LOCK_WAIT_MS}`);
      db.run('PRAGMA synchronous = FULL');
    } catch {
      db.close();
      throw new StoreLocationError(location, 'not a database');
    }
  }

  try {
    db.run('BEGIN IMMEDIATE');
  } catch (e) {
    db.close();
    throw new StoreSchemaError(location, e);
  }
  try {
    installOwnTables(db);
    for (const install of schemas) install(db);
    db.run('COMMIT');
  } catch (e) {
    try {
      db.run('ROLLBACK');
    } catch {
      // the transaction is already gone
    }
    db.close();
    throw new StoreSchemaError(location, e);
  }

  // Every statement prepared through this connection (by the store or by a slice through snap.db
  // or tx.db) is remembered weakly, so close can finalise those still alive; db.query's cached
  // statements are finalised by bun:sqlite's own close, and collected ones finalise themselves.
  type Prepared = ReturnType<Database['prepare']>;
  const prepared = new Set<WeakRef<Prepared>>();
  const forget = new FinalizationRegistry<WeakRef<Prepared>>((ref) => prepared.delete(ref));
  const prepare = db.prepare.bind(db);
  db.prepare = ((...args: Parameters<Database['prepare']>) => {
    const stmt = prepare(...args);
    const ref = new WeakRef(stmt);
    prepared.add(ref);
    forget.register(stmt, ref);
    return stmt;
  }) as Database['prepare'];

  const snap: Snapshot = {
    db,
    position: () => readPosition(db),
    register: () => readRegister(db),
    isListed: (p) => isListed(db, p),
    claim: (family) => readClaim(db, family),
  };

  const tx: WriteTx = {
    db,
    claimPosition() {
      const row = db
        .query('UPDATE store_position SET high = high + 1 WHERE id = 1 RETURNING high')
        .get() as { high: number };
      return row.high;
    },
    register: () => readRegister(db),
    registerSource(row) {
      db.run(
        'INSERT INTO register_sources (id, capabilities) VALUES (?, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET capabilities = excluded.capabilities',
        [row.id, JSON.stringify(row.capabilities)],
      );
    },
    registerHolding(h) {
      const id = narrowingName(h.sourceId, h.kind, h.bankId);
      db.run(
        'INSERT INTO register_holdings (id, kind, source_id, bank_id, currency) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET currency = excluded.currency',
        [id, h.kind, h.sourceId, h.bankId, h.currency],
      );
      return { id, kind: h.kind, sourceId: h.sourceId, bankId: h.bankId, currency: h.currency };
    },
    takeClaim(family, token, now, deadline) {
      const held = readClaim(db, family);
      if (held !== null && held.deadline > now) return false;
      db.run('INSERT OR REPLACE INTO ask_claims (family, token, deadline) VALUES (?, ?, ?)', [
        family,
        token,
        deadline,
      ]);
      return true;
    },
    releaseClaim(family, token, listed) {
      const held = readClaim(db, family);
      if (held === null || held.token !== token) return { released: false, marked: null };
      let marked: number | null = null;
      if (listed !== null) {
        const high = readPosition(db);
        for (const p of listed) {
          if (!Number.isInteger(p) || p < 1 || p > high) throw new ListedPositionError(p);
        }
        marked = 0;
        const insert = db.query(`INSERT OR IGNORE INTO ${LISTED_MARKS_TABLE} (position) VALUES (?)`);
        for (const p of listed) marked += insert.run(p).changes;
      }
      db.run('DELETE FROM ask_claims WHERE family = ?', [family]);
      return { released: true, marked };
    },
  };

  let closed = false;
  return {
    location,
    readSnapshot<T>(body: (snap: Snapshot) => T): T {
      db.run('BEGIN DEFERRED');
      let result: T;
      try {
        db.run('PRAGMA query_only = ON');
        result = body(snap);
      } finally {
        try {
          db.run('COMMIT');
        } finally {
          db.run('PRAGMA query_only = OFF');
        }
      }
      if (isThenable(result)) {
        if (result instanceof Promise) result.catch(() => {});
        throw new SnapshotAwaitError();
      }
      return result;
    },
    write<T>(body: (tx: WriteTx) => T): T {
      db.run('BEGIN IMMEDIATE');
      let result: T;
      try {
        result = body(tx);
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      }
      try {
        db.run('COMMIT');
      } catch (e) {
        if (db.inTransaction) db.run('ROLLBACK');
        throw e;
      }
      return result;
    },
    // Synchronous: finalises every statement prepared on the connection (bun:sqlite finalises the
    // cached ones itself), then close(true) closes it or throws, so no handle on the location remains.
    // A statement already collected but not yet swept still holds the connection busy: a full
    // synchronous collection sweeps it (finalising it), and the second close(true) throws if it fails.
    close() {
      if (closed) return;
      for (const ref of prepared) ref.deref()?.finalize();
      prepared.clear();
      try {
        db.close(true);
      } catch {
        // bun:sqlite reports the busy close as a plain Error ('database is locked'), so any failure is retried once
        Bun.gc(true);
        db.close(true);
      }
      closed = true;
    },
  };
}
