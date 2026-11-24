// Answering composition (S-183, src/core/compose): the opener called exactly once with the location
// and every installer, the core built over that same store with the given families and contributors,
// the result frozen; and faults at start: a duplicate family or contributor key closes the opener's
// store exactly once and rethrows createCore's CoreConfigError unchanged, an opener error passes
// through unchanged before createCore, and the product opener's own faults surface.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load. The type import is erased at run time.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Family, QuestionContext, Settings } from '../../src/core/question';

const compose = () => import('../../src/core/compose');
const core = () => import('../../src/core/core');
const store = () => import('../../src/db/index');
const holdings = () => import('../../src/families/holdings');

// Saturday 2026-11-21 12:00 in Warsaw.
const NOW = Date.UTC(2026, 10, 21, 11, 0, 0);

const now = () => NOW;
const settings = (): Settings => ({ timeZone: undefined, sources: [] });
const render = (a: unknown) => JSON.stringify(a);

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

interface Opened {
  location: string;
  schemas: readonly any[];
  closes: number;
  store: any;
}

// Wraps openStore: records each call's location and installers, and each close() of the store it
// returned, which still closes the real store.
const recordingOpener = async () => {
  const { openStore } = await store();
  const opens: Opened[] = [];
  const rec = (location: string, schemas: readonly any[]) => {
    const s = openStore(location, schemas);
    const o: Opened = { location, schemas, closes: 0, store: null };
    o.store = {
      location: s.location,
      readSnapshot: (b: any) => s.readSnapshot(b),
      write: (b: any) => s.write(b),
      close: () => {
        o.closes++;
        s.close();
      },
    };
    opens.push(o);
    return o.store;
  };
  return { opens, rec };
};

// Returns what f throws; fails the test when f throws nothing.
const catchErr = (f: () => unknown): any => {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw, but nothing was thrown');
};

describe('composeAnswering', () => {
  test('one store with every installer, shared with the core', async () => {
    const { composeAnswering } = await compose();
    const { MEMORY_LOCATION } = await store();
    const { holdingsFamily } = await holdings();
    const { opens, rec } = await recordingOpener();

    const calls: string[] = [];
    const i1 = (db: any) => {
      calls.push('i1');
      db.run('CREATE TABLE IF NOT EXISTS probe_rows (n INTEGER)');
    };
    const i2 = (_db: any) => {
      calls.push('i2');
    };
    const probeTable: Family = {
      name: 'probe_table',
      period: 'none',
      movesPoint: false,
      compute: (ctx: QuestionContext) => ({
        kind: 'body',
        body: {
          rows: (ctx.snapshot.db.query('SELECT count(*) AS n FROM probe_rows').get() as { n: number }).n,
          position: ctx.position,
        },
      }),
    } as Family;

    const c = composeAnswering({
      location: MEMORY_LOCATION,
      schemas: [i1, i2],
      now,
      settings,
      families: [holdingsFamily, probeTable],
      contributors: [{ key: 'k', contribute: () => 'K' }] as any,
      open: rec,
    });

    // 1.
    expect(opens.length).toBe(1);
    expect(opens[0].location).toBe(MEMORY_LOCATION);
    expect(opens[0].schemas.length).toBe(2);
    expect(opens[0].schemas[0]).toBe(i1);
    expect(opens[0].schemas[1]).toBe(i2);
    expect(calls).toEqual(['i1', 'i2']);

    // 2.
    expect(Object.isFrozen(c)).toBe(true);
    expect(c.store).toBe(opens[0].store);

    // 3.
    expect(c.store.readSnapshot((s: any) => [s.position(), s.claim('anything')])).toEqual([0, null]);

    // 4.
    expect(
      c.store.write((tx: any) => {
        tx.db.run('INSERT INTO probe_rows VALUES (1)');
        return tx.claimPosition();
      }),
    ).toBe(1);

    // 5.
    const r = await c.core.serve({ asker: 'command_line', family: 'probe_table', options: {} }, render, channel());
    expect((r.answer as any).outcome).toEqual({ kind: 'answered', body: { rows: 1, position: 1 } });
    expect((r.answer as any).statements).toEqual({ k: 'K' });

    // 6.
    expect(opens.length).toBe(1);
    expect(opens[0].closes).toBe(0);
    expect(calls).toEqual(['i1', 'i2']);

    c.store.close();
  });

  test('start faults throw and close the store', async () => {
    const { composeAnswering } = await compose();
    const { createCore, CoreConfigError } = await core();
    const { openStore, MEMORY_LOCATION, StoreLocationError, StoreSchemaError } = await store();
    const { holdingsFamily } = await holdings();
    const { opens, rec } = await recordingOpener();

    const base = {
      location: MEMORY_LOCATION,
      schemas: [(db: any) => db.run('CREATE TABLE IF NOT EXISTS probe_rows (n INTEGER)')],
      now,
      settings,
      families: [holdingsFamily] as readonly Family[],
      contributors: [] as readonly any[],
      open: rec as ((l: string, s: readonly any[]) => any) | undefined,
    };
    const dupContribs = [
      { key: 'c', contribute: () => 1 },
      { key: 'c', contribute: () => 2 },
    ];

    // 1. Duplicate family: the opener's store closed once, CoreConfigError rethrown.
    const e1 = catchErr(() => composeAnswering({ ...base, families: [holdingsFamily, holdingsFamily] }));
    expect(e1).toBeInstanceOf(CoreConfigError);
    expect(opens.length).toBe(1);
    expect(opens[0].closes).toBe(1);

    // 2. Duplicate contributor key: likewise.
    const e2 = catchErr(() => composeAnswering({ ...base, contributors: dupContribs as any }));
    expect(e2).toBeInstanceOf(CoreConfigError);
    expect(opens.length).toBe(2);
    expect(opens[1].closes).toBe(1);

    // 3. Unchanged: the same class and message createCore throws on its own.
    const d = catchErr(() =>
      createCore({
        store: openStore(MEMORY_LOCATION),
        now: base.now,
        settings: base.settings,
        families: [holdingsFamily, holdingsFamily],
        contributors: [],
      }),
    );
    expect(e1.constructor).toBe(d.constructor);
    expect(e1.message).toBe(d.message);

    // 4. Opener fault first: passes through by identity, createCore never reached.
    const sentinel = new Error('opener-sentinel');
    const e4 = catchErr(() =>
      composeAnswering({
        ...base,
        families: [holdingsFamily, holdingsFamily],
        open: () => {
          throw sentinel;
        },
      }),
    );
    expect(e4).toBe(sentinel);

    // 5. Success closes nothing.
    const ok = composeAnswering(base);
    expect(opens.length).toBe(3);
    expect(opens[2].closes).toBe(0);
    expect(ok.store.write((tx: any) => tx.claimPosition())).toBe(1);
    ok.store.close();
    expect(opens[2].closes).toBe(1);

    // 6. Product path (no opener given): the creating openStore's own faults.
    const dir = mkdtempSync(join(tmpdir(), 'arcanum-compose-'));
    try {
      expect(() =>
        composeAnswering({ ...base, open: undefined, location: join(dir, 'no', 'such', 'dir', 'copy.sqlite') }),
      ).toThrow(StoreLocationError);
      expect(() =>
        composeAnswering({
          ...base,
          open: undefined,
          schemas: [
            () => {
              throw new Error('bad installer');
            },
          ],
        }),
      ).toThrow(StoreSchemaError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
