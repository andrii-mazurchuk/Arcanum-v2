// Store (S-257): storage positions claimed inside the storing write, synchronous read-only
// snapshots, file and memory locations, rateInstant, register rows, the per-transaction listed
// mark, the store-held ask claim and a close that releases the location at once, from src/db/index.
//
// The module is imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const store = () => import('../../src/db/index');

const STORE_URL = pathToFileURL(join(import.meta.dir, '..', '..', 'src', 'db', 'index.ts')).href;

// Every file in dir with its length, sorted by name.
const entries = (dir: string) =>
  readdirSync(dir)
    .sort()
    .map((name) => ({ name, size: statSync(join(dir, name)).size }));

// Reads the child's stdout until it prints `line`.
const waitForLine = async (stdout: ReadableStream<Uint8Array>, line: string) => {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.split(/\r?\n/).includes(line)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`child ended before printing ${line}; printed: ${seen}`);
    seen += decoder.decode(value);
  }
  reader.releaseLock();
};

const F = 'new_since';

// The store does not own transaction rows; this installer stands in for a slice's table, keyed by
// (source_id, bank_id) with the position claimed in the write that first stores the row.
const probeTransactions = (db: any) => {
  db.run(
    'CREATE TABLE IF NOT EXISTS probe_transactions (' +
      'source_id TEXT NOT NULL, bank_id TEXT NOT NULL, amount INTEGER NOT NULL, ' +
      'position INTEGER NOT NULL UNIQUE, PRIMARY KEY (source_id, bank_id))',
  );
};

// Stores one transaction the way ingest does: a row already held keeps its position and claims
// none; a new row claims one. Returns the row's position.
const storeTransaction = (tx: any, bankId: string, amount: number): number => {
  const held = tx.db
    .query('SELECT position FROM probe_transactions WHERE source_id = ? AND bank_id = ?')
    .get('monobank', bankId) as { position: number } | null;
  if (held) {
    tx.db.run('UPDATE probe_transactions SET amount = ? WHERE source_id = ? AND bank_id = ?', [
      amount,
      'monobank',
      bankId,
    ]);
    return held.position;
  }
  const position = tx.claimPosition();
  tx.db.run(
    'INSERT INTO probe_transactions (source_id, bank_id, amount, position) VALUES (?, ?, ?, ?)',
    ['monobank', bankId, amount, position],
  );
  return position;
};

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('store/store', () => {
  test('claimPosition rolls back with its write', async () => {
    const { openStore, MEMORY_LOCATION } = await store();
    const s = openStore(MEMORY_LOCATION);

    expect(s.readSnapshot((snap) => snap.position())).toBe(0);
    expect(s.write((tx) => [tx.claimPosition(), tx.claimPosition()])).toEqual([1, 2]);

    let seen = 0;
    expect(() =>
      s.write((tx) => {
        seen = tx.claimPosition();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(seen).toBe(3);

    expect(s.readSnapshot((snap) => snap.position())).toBe(2);
    expect(s.write((tx) => tx.claimPosition())).toBe(3);
    expect(s.readSnapshot((snap) => snap.position())).toBe(3);
    s.close();
  });

  test('readSnapshot refuses awaiting bodies', async () => {
    const { openStore, MEMORY_LOCATION, SnapshotAwaitError } = await store();
    const s = openStore(MEMORY_LOCATION);

    expect(() => s.readSnapshot(async () => 1)).toThrow(SnapshotAwaitError);
    expect(s.write((tx) => tx.claimPosition())).toBe(1);

    expect(() => s.readSnapshot(() => ({ then() {} }))).toThrow(SnapshotAwaitError);
    expect(s.write((tx) => tx.claimPosition())).toBe(2);

    // A non-callable then is an ordinary value.
    expect(s.readSnapshot(() => ({ then: 5 }))).toEqual({ then: 5 });

    expect(() =>
      s.readSnapshot(() => {
        throw new Error('inside');
      }),
    ).toThrow('inside');

    // The connection is writable again.
    expect(
      s.write((tx) => {
        tx.db.run('CREATE TABLE probe_after (x INTEGER)');
        return tx.claimPosition();
      }),
    ).toBe(3);
    s.close();
  });

  test('snapshot connection is query-only', async () => {
    const { openStore, MEMORY_LOCATION } = await store();
    const s = openStore(MEMORY_LOCATION);
    s.write((tx) => tx.claimPosition());

    const outcome = s.readSnapshot((snap) => {
      try {
        snap.db.run('CREATE TABLE probe_in_snapshot (x INTEGER)');
        return 'wrote';
      } catch {
        return 'refused';
      }
    });

    expect(outcome).toBe('refused');
    expect(
      s.readSnapshot((snap) =>
        snap.db.query("SELECT count(*) AS n FROM sqlite_master WHERE name = 'probe_in_snapshot'").get(),
      ),
    ).toEqual({ n: 0 });
    expect(s.readSnapshot((snap) => snap.position())).toBe(1);
    s.close();
  });

  test('rateInstant', async () => {
    const { rateInstant } = await store();

    expect(rateInstant(undefined, 1000)).toBe(1000);
    expect(rateInstant(500, 1000)).toBe(500);
    expect(rateInstant(0, 1000)).toBe(0);
    // A stated start is used as given.
    expect(rateInstant(2000, 1000)).toBe(2000);
  });

  test('file store and memory store locations', async () => {
    const { openStore, MEMORY_LOCATION, StoreLocationError } = await store();
    const dir = mkdtempSync(join(tmpdir(), 'arcanum-store-'));
    const path = join(dir, 'copy.sqlite');
    const opened: { close(): void }[] = [];
    try {
      const a = openStore(path);
      opened.push(a);
      expect(a.location).toBe(path);
      expect(a.write((tx) => tx.claimPosition())).toBe(1);

      // Stands in for a second process.
      const b = openStore(path);
      opened.push(b);
      expect(b.readSnapshot((snap) => snap.position())).toBe(1);

      expect(a.readSnapshot((snap) => snap.db.query('PRAGMA journal_mode').get())).toEqual({
        journal_mode: 'wal',
      });

      expect(b.write((tx) => tx.claimPosition())).toBe(2);
      expect(a.readSnapshot((snap) => snap.position())).toBe(2);

      // A second in-memory store is a different, empty database.
      const m1 = openStore(MEMORY_LOCATION);
      opened.push(m1);
      const m2 = openStore(MEMORY_LOCATION);
      opened.push(m2);
      m1.write((tx) => tx.claimPosition());
      expect(m2.readSnapshot((snap) => snap.position())).toBe(0);

      expect(() => openStore(join(dir, 'no', 'such', 'dir', 'copy.sqlite'))).toThrow(
        StoreLocationError,
      );
    } finally {
      for (const s of opened) s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('releaseClaim marks exactly the listed positions', async () => {
    const { openStore, MEMORY_LOCATION } = await store();
    const s = openStore(MEMORY_LOCATION, [probeTransactions]);

    const positions = s.write((tx) => range(1, 10).map((i) => storeTransaction(tx, `T${i}`, i * 100)));
    expect(positions).toEqual(range(1, 10));

    expect(s.write((tx) => tx.takeClaim(F, 't', 0, 1000))).toBe(true);
    expect(s.write((tx) => tx.releaseClaim(F, 't', [3, 7, 9]))).toEqual({ released: true, marked: 3 });
    expect(s.readSnapshot((snap) => range(1, 10).filter((p) => snap.isListed(p)))).toEqual([3, 7, 9]);
    expect(s.readSnapshot((snap) => snap.claim(F))).toBeNull();

    // An already-set mark is left and not counted.
    expect(s.write((tx) => tx.takeClaim(F, 't2', 0, 1000))).toBe(true);
    expect(s.write((tx) => tx.releaseClaim(F, 't2', [3, 10]))).toEqual({ released: true, marked: 1 });
    expect(s.readSnapshot((snap) => range(1, 10).filter((p) => snap.isListed(p)))).toEqual([
      3, 7, 9, 10,
    ]);

    // Re-storing a marked transaction keeps its position and its mark.
    expect(s.write((tx) => storeTransaction(tx, 'T3', 999))).toBe(3);
    expect(
      s.readSnapshot((snap) =>
        snap.db
          .query("SELECT position, amount FROM probe_transactions WHERE bank_id = 'T3'")
          .get(),
      ),
    ).toEqual({ position: 3, amount: 999 });
    expect(s.readSnapshot((snap) => snap.isListed(3))).toBe(true);
    expect(s.readSnapshot((snap) => snap.position())).toBe(10);
    s.close();
  });

  test('releaseClaim under a replaced token or a bad list marks nothing', async () => {
    const { openStore, MEMORY_LOCATION, ListedPositionError } = await store();
    const s = openStore(MEMORY_LOCATION);
    s.write((tx) => range(1, 10).map(() => tx.claimPosition()));

    expect(s.write((tx) => tx.takeClaim(F, 't', 0, 1000))).toBe(true);
    expect(s.write((tx) => tx.takeClaim(F, 'u', 1000, 2000))).toBe(true);

    expect(s.write((tx) => tx.releaseClaim(F, 't', [1, 2]))).toEqual({
      released: false,
      marked: null,
    });
    expect(s.readSnapshot((snap) => [snap.isListed(1), snap.isListed(2)])).toEqual([false, false]);
    expect(s.readSnapshot((snap) => snap.claim(F)?.token)).toBe('u');

    expect(() => s.write((tx) => tx.releaseClaim(F, 'u', [11]))).toThrow(ListedPositionError);
    expect(s.readSnapshot((snap) => range(1, 11).filter((p) => snap.isListed(p)))).toEqual([]);
    expect(s.readSnapshot((snap) => snap.claim(F)?.token)).toBe('u');

    expect(s.write((tx) => tx.releaseClaim(F, 'u', null))).toEqual({ released: true, marked: null });
    expect(s.readSnapshot((snap) => snap.claim(F))).toBeNull();
    s.close();
  });

  test('register rows and a fresh store', async () => {
    const { openStore, MEMORY_LOCATION } = await store();
    const s = openStore(MEMORY_LOCATION);

    let h1: any;
    let h2: any;
    const inTx = s.write((tx) => {
      tx.registerSource({ id: 'monobank', capabilities: [] } as any);
      tx.registerSource({ id: 'monobank', capabilities: ['jars'] } as any);
      tx.registerSource({ id: 'altbank', capabilities: [] } as any);
      h1 = tx.registerHolding({ kind: 'jar', sourceId: 'monobank', bankId: 'J1', currency: 'UAH' } as any);
      h2 = tx.registerHolding({ kind: 'jar', sourceId: 'monobank', bankId: 'J1', currency: 'UAH' } as any);
      return tx.register();
    });

    expect(h1).toEqual({
      id: 'monobank:jar:J1',
      kind: 'jar',
      sourceId: 'monobank',
      bankId: 'J1',
      currency: 'UAH',
    });
    expect(h2.id).toBe(h1.id);

    // Read inside the same write, it already holds the rows that write registered, sorted by id.
    expect(inTx).toEqual({
      sources: [
        { id: 'altbank', capabilities: [] },
        { id: 'monobank', capabilities: ['jars'] },
      ],
      holdings: [h1],
    } as any);
    expect(s.readSnapshot((snap) => snap.register())).toEqual(inTx);

    // A rolled-back registration is not seen.
    expect(() =>
      s.write((tx) => {
        tx.registerSource({ id: 'zbank', capabilities: [] } as any);
        throw new Error('undo');
      }),
    ).toThrow('undo');
    expect(s.write((tx) => tx.register().sources.map((r: any) => r.id))).toEqual([
      'altbank',
      'monobank',
    ]);

    // A fresh store holds no mark and no claim.
    s.write((tx) => {
      tx.claimPosition();
      tx.claimPosition();
    });
    expect(s.readSnapshot((snap) => [snap.isListed(1), snap.isListed(2), snap.claim(F)])).toEqual([
      false,
      false,
      null,
    ]);
    s.close();
  });

  test('existing-only open finds a WAL store before any checkpoint', async () => {
    const { openStore, NoLocalCopyError, StoreLocationError } = await store();
    const dir = mkdtempSync(join(tmpdir(), 'arcanum-store-'));
    const path = join(dir, 'copy.sqlite');
    const empty = mkdtempSync(join(tmpdir(), 'arcanum-store-'));

    // Process A: opens creating, commits one holding row, and stays open without checkpointing.
    const script =
      `const { openStore } = await import(${JSON.stringify(STORE_URL)});` +
      `const s = openStore(${JSON.stringify(path)});` +
      `s.write((tx) => {` +
      `  tx.registerSource({ id: 'monobank', capabilities: [] });` +
      `  tx.registerHolding({ kind: 'jar', sourceId: 'monobank', bankId: 'J1', currency: 'UAH' });` +
      `});` +
      `console.log('ready');` +
      `setInterval(() => {}, 1 << 30);`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' });
    let opened: { close(): void } | undefined;
    try {
      await waitForLine(child.stdout, 'ready');

      // Precondition: the committed row is still in the write-ahead log.
      const before = entries(dir);
      const main = before.find((e) => e.name === 'copy.sqlite');
      const wal = before.find((e) => e.name === 'copy.sqlite-wal');
      expect(main).toBeDefined();
      expect(main!.size === 0 || (wal !== undefined && wal.size > 0)).toBe(true);

      let caught: unknown;
      try {
        opened = openStore(path, [], 'existing');
      } catch (e) {
        caught = e;
      }
      expect(caught instanceof NoLocalCopyError).toBe(false);
      expect(caught instanceof StoreLocationError).toBe(false);
      expect(caught).toBeUndefined();

      const s = opened!;
      expect((s as any).readSnapshot((snap: any) => snap.register().holdings)).toEqual([
        { id: 'monobank:jar:J1', kind: 'jar', sourceId: 'monobank', bankId: 'J1', currency: 'UAH' },
      ] as any);

      // No file was created or truncated by the open.
      const after = entries(dir);
      expect(after.map((e) => e.name)).toEqual(before.map((e) => e.name));
      for (const e of before) {
        expect(after.find((a) => a.name === e.name)!.size).toBeGreaterThanOrEqual(e.size);
      }

      // An empty folder is still no local copy, and nothing appears in it.
      let refused: unknown;
      try {
        openStore(join(empty, 'copy.sqlite'), [], 'existing').close();
      } catch (e) {
        refused = e;
      }
      expect(refused).toBeInstanceOf(NoLocalCopyError);
      expect(readdirSync(empty)).toEqual([]);
    } finally {
      opened?.close();
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  }, 30000);

  test('close releases the location at once', async () => {
    const { openStore } = await store();
    const { Database } = await import('bun:sqlite');
    // Every table installer, as the product's one list (src/app/starters STORE_SCHEMAS) names them,
    // imported from the table owners so the store's test does not load the front ends.
    const STORE_SCHEMAS = [
      (await import('../../src/money/recorded-rates')).ensureRateSchema,
      (await import('../../src/money/quarantine')).ensureQuarantineSchema,
      (await import('../../src/local/covered')).ensureCoverageSchema,
      (await import('../../src/local/transactions')).ensureTransactionSchema,
      (await import('../../src/sync/balances')).ensureBalanceSchema,
      (await import('../../src/sync/rate-gate')).ensureRateLedgerSchema,
      (await import('../../src/sync/progress')).ensureFirstFillSchema,
    ];

    for (let run = 1; run <= 50; run++) {
      const dir = mkdtempSync(join(tmpdir(), 'arcanum-store-'));
      const path = join(dir, 'copy.sqlite');
      try {
        const s = openStore(path, STORE_SCHEMAS);

        // Reads and a write, so the store has statements cached.
        s.write((tx) => {
          tx.registerSource({ id: 'monobank', capabilities: [] } as any);
          tx.registerHolding({ kind: 'jar', sourceId: 'monobank', bankId: 'J1', currency: 'UAH' } as any);
          tx.claimPosition();
          tx.claimPosition();
          tx.takeClaim(F, `t${run}`, 0, 1000);
          return tx.releaseClaim(F, `t${run}`, [1]);
        });
        for (let i = 0; i < 3; i++) {
          s.readSnapshot((snap) => [snap.position(), snap.register(), snap.isListed(1), snap.claim(F)]);
        }

        s.close();

        // Another connection, no busy wait: the journal change and the exclusive lock succeed at once.
        const raw = new Database(path);
        try {
          let failure: unknown;
          try {
            raw.run('PRAGMA journal_mode = DELETE');
            raw.run('BEGIN EXCLUSIVE');
            raw.run('COMMIT');
          } catch (e) {
            failure = e;
          }
          expect({ run, failure: failure === undefined ? undefined : String(failure) }).toEqual({
            run,
            failure: undefined,
          });
          expect(raw.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
        } finally {
          raw.close();
        }

        // A second close does nothing.
        expect(() => s.close()).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60000);
});
