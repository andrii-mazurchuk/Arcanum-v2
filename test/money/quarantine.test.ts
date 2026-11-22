// Quarantine (S-83): the per-source set-aside of records that cannot be held exactly, keyed by
// (source, bank id), replaced by a re-fetch, cleared by a later exact translation and logged, from
// src/money/quarantine over the store of src/db.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const quarantine = () => import('../../src/money/quarantine');
const db = () => import('../../src/db/index');

describe('money/quarantine', () => {
  for (const where of ['memory', 'file'] as const) {
    test(`quarantine replaces, clears and keeps a null moment (${where})`, async () => {
      const { ensureQuarantineSchema, settleQuarantine, listQuarantine } = await quarantine();
      const { openStore, MEMORY_LOCATION } = await db();

      const dir = where === 'file' ? mkdtempSync(join(tmpdir(), 'arcanum-quarantine-')) : null;
      const location = dir === null ? MEMORY_LOCATION : join(dir, 'copy.sqlite');
      const store = openStore(location, [ensureQuarantineSchema]);
      try {
        const lines: string[] = [];
        const log = (l: string) => {
          lines.push(l);
        };
        const S = Date.parse('2026-11-20T10:00:00Z');
        const T = Date.parse('2026-11-20T07:15:00Z');
        const q = (bankId: string, occurredAt: number | null, detail: string) => ({
          kind: 'quarantined' as const,
          entry: {
            sourceId: 'monobank',
            bankId,
            raw: '{"id":"' + bankId + '"}',
            reason: 'excess_precision' as const,
            detail,
            seenAt: S,
            occurredAt,
          },
        });
        const h = (bankId: string) => ({
          kind: 'held' as const,
          sourceId: 'monobank',
          bankId,
          record: {},
        });
        const listed = () => store.readSnapshot((snap) => listQuarantine(snap.db));

        // Step 1: a missing moment is kept as null; a held item with no entry clears nothing.
        const first = store.write((tx) =>
          settleQuarantine(tx, 'monobank', [q('a', null, 'd1'), h('b')], log),
        );
        expect(first).toEqual({ quarantined: 1, cleared: 0 });
        expect(lines).toEqual([
          'quarantined source=monobank bank_id=a reason=excess_precision detail=d1',
        ]);
        const afterFirst = listed();
        expect(afterFirst).toHaveLength(1);
        expect(afterFirst[0]!.bankId).toBe('a');
        expect(afterFirst[0]!.occurredAt).toBeNull();
        expect(afterFirst[0]!.seenAt).toBe(S);
        expect(afterFirst[0]!.detail).toBe('d1');
        expect(afterFirst).toEqual([
          {
            sourceId: 'monobank',
            bankId: 'a',
            raw: '{"id":"a"}',
            reason: 'excess_precision',
            detail: 'd1',
            seenAt: S,
            occurredAt: null,
          },
        ]);

        // Step 2: a re-fetch of the same record replaces its entry, moment included.
        const second = store.write((tx) =>
          settleQuarantine(tx, 'monobank', [q('a', T, 'd2')], log),
        );
        expect(second).toEqual({ quarantined: 1, cleared: 0 });
        const afterSecond = listed();
        expect(afterSecond).toHaveLength(1);
        expect(afterSecond[0]!.occurredAt).toBe(T);
        expect(afterSecond[0]!.detail).toBe('d2');
        expect(lines).toHaveLength(2);

        // Step 3: the record now held exactly clears its entry and logs nothing.
        const third = store.write((tx) => settleQuarantine(tx, 'monobank', [h('a')], log));
        expect(third).toEqual({ quarantined: 0, cleared: 1 });
        expect(listed()).toEqual([]);
        expect(lines).toHaveLength(2);
      } finally {
        store.close();
        if (dir !== null) rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("quarantine refuses another source's items", async () => {
    const {
      ensureQuarantineSchema,
      settleQuarantine,
      listQuarantine,
      QuarantineSourceMismatchError,
    } = await quarantine();
    const { openStore, MEMORY_LOCATION } = await db();

    const store = openStore(MEMORY_LOCATION, [ensureQuarantineSchema]);
    try {
      const S = Date.parse('2026-11-20T10:00:00Z');
      const entry = (sourceId: string, bankId: string) => ({
        sourceId,
        bankId,
        raw: 'x',
        reason: 'malformed' as const,
        detail: 'd',
        seenAt: S,
        occurredAt: S,
      });
      const listed = () => store.readSnapshot((snap) => listQuarantine(snap.db));

      // An entry under another source's id throws, and the entry before it rolls back too.
      expect(() =>
        store.write((tx) =>
          settleQuarantine(
            tx,
            'monobank',
            [
              { kind: 'quarantined', entry: entry('monobank', 'c') },
              { kind: 'quarantined', entry: entry('second', 'd') },
            ],
            () => {},
          ),
        ),
      ).toThrow(QuarantineSourceMismatchError);
      expect(listed()).toEqual([]);

      // A held id under another source's id throws as well.
      expect(() =>
        store.write((tx) =>
          settleQuarantine(
            tx,
            'monobank',
            [{ kind: 'held', sourceId: 'second', bankId: 'e', record: {} }],
            () => {},
          ),
        ),
      ).toThrow(QuarantineSourceMismatchError);
      expect(listed()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
