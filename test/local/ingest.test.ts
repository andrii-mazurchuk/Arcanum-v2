// Ingest (S-113): the one write every arrival path stores through. The checks before the write
// (shape, identity, covered part against unreadable quarantined moments), the caller's own writes
// through a view of the write, store/replace/unchanged with settled-over-pending, classification at
// first storage, quarantine settlement, pairing counts and the covered-part merge, all or nothing.
// From src/local/ingest.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Store, WriteTx } from '../../src/db/index';
import type { Counterpart, TranslatedTransaction } from '../../src/local/translated';
import type { QuarantineEntry } from '../../src/money/quarantine';

const ingestModule = () => import('../../src/local/ingest');
const storeModule = () => import('../../src/db/index');
const transactions = () => import('../../src/local/transactions');
const covered = () => import('../../src/local/covered');
const quarantine = () => import('../../src/money/quarantine');
const translated = () => import('../../src/local/translated');
const moneyModule = () => import('../../src/money/money');

const A = 'monobank:account:a';
const B = 'monobank:account:b';
const J = 'monobank:jar:j';

const at = (s: string): number => Date.parse(`2026-11-21T${s}Z`);
const iv = (startAt: number, endAt: number) => ({ startAt, endAt });
const key = (bankId: string, sourceId = 'monobank') => ({ sourceId, bankId });

type Item =
  | { kind: 'held'; sourceId: string; bankId: string; record: TranslatedTransaction }
  | { kind: 'quarantined'; entry: QuarantineEntry };

const held = (t: TranslatedTransaction): Item => ({ kind: 'held', sourceId: t.sourceId, bankId: t.bankId, record: t });

const q = (bankId: string, occurredAt: number | null): Item => ({
  kind: 'quarantined',
  entry: {
    sourceId: 'monobank',
    bankId,
    raw: '{"amount":"1.5"}',
    reason: 'excess_precision',
    detail: 'x',
    seenAt: Date.parse('2026-11-21T12:00:00Z'),
    occurredAt,
  },
});

const reg = (tx: WriteTx) => {
  tx.registerSource({ id: 'monobank', capabilities: ['jars', 'rates'] });
  tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'a', currency: 'UAH' });
};

// The store of every test, the translated-transaction builder and the readers the checks use.
const arrange = async () => {
  const { openStore, MEMORY_LOCATION } = await storeModule();
  const { ensureTransactionSchema, getTransaction, selectTransactions, listOpenTransfers } = await transactions();
  const { ensureCoverageSchema, readCovered } = await covered();
  const { ensureQuarantineSchema, listQuarantine } = await quarantine();
  const { money } = await moneyModule();

  const store: Store = openStore(MEMORY_LOCATION, [ensureCoverageSchema, ensureTransactionSchema, ensureQuarantineSchema]);

  // Settled, UAH, no codes, no counterpart unless given.
  const tr = (
    bankId: string,
    holdingId: string,
    occurredAt: number,
    minor: bigint,
    extra: Partial<TranslatedTransaction> = {},
  ): TranslatedTransaction => ({
    sourceId: 'monobank',
    bankId,
    holdingId,
    occurredAt,
    amount: money(minor, 'UAH'),
    originalAmount: null,
    cashback: null,
    settled: true,
    mcc: null,
    originalMcc: null,
    merchantText: null,
    description: '',
    comment: null,
    counterpart: null,
    ...extra,
  });

  const read = {
    row: (bankId: string) => store.readSnapshot((s) => getTransaction(s.db, key(bankId))),
    rows: () => store.readSnapshot((s) => selectTransactions(s.db, { order: 'position' })),
    rowCount: () =>
      store.readSnapshot((s) => (s.db.query('SELECT COUNT(*) AS n FROM held_transaction').get() as { n: number }).n),
    transferCount: () =>
      store.readSnapshot((s) => (s.db.query('SELECT COUNT(*) AS n FROM own_transfer').get() as { n: number }).n),
    openTransfers: () => store.readSnapshot((s) => listOpenTransfers(s.db)),
    position: () => store.readSnapshot((s) => s.position()),
    covered: () => store.readSnapshot((s) => readCovered(s, 'monobank')),
    quarantine: () => store.readSnapshot((s) => listQuarantine(s.db, 'monobank')),
    holdings: () => store.readSnapshot((s) => s.register().holdings.map((h) => h.id)),
  };

  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
  };

  return { store, tr, money, read, lines, log };
};

describe('local/ingest', () => {
  test('held once, settled over pending', async () => {
    const { ingest } = await ingestModule();
    const { store, tr, money, read, log } = await arrange();
    try {
      const pending1 = tr('t1', A, at('10:00:00'), -10000n, {
        settled: false,
        mcc: 5411,
        originalMcc: null,
        merchantText: null,
        description: 'SILPO #12 UA',
      });
      const settled1: TranslatedTransaction = {
        ...pending1,
        occurredAt: at('10:05:00'),
        amount: money(-9850n, 'UAH'),
        settled: true,
        mcc: 5812,
        description: 'KFC KYIV',
      };
      const run = (items: Item[], c: { startAt: number; endAt: number }[] | null, also?: (tx: WriteTx) => void) =>
        ingest(store, { sourceId: 'monobank', items: items as never, covered: c, also }, log);

      // 1. Push: stored at position 1, classified from the pending version.
      const r1 = run([held(pending1)], null, reg);
      expect(r1.outcomes).toEqual([{ key: key('t1'), outcome: 'stored' }]);
      let row = read.row('t1');
      expect(row?.position).toBe(1);
      expect(row?.category).toBe('Groceries & Supermarkets');
      expect(row?.merchant).toBe('Silpo');
      expect(row?.settled).toBe(false);

      // 2. Poll: the settled version replaces the pending one, keeping position, category, merchant.
      const r2 = run([held(settled1)], [iv(at('09:00:00'), at('11:00:00'))]);
      expect(r2.outcomes).toEqual([{ key: key('t1'), outcome: 'replaced' }]);
      row = read.row('t1');
      expect(row?.amount.minor).toBe(-9850n);
      expect(row?.settled).toBe(true);
      expect(row?.occurredAt).toBe(at('10:05:00'));
      expect(row?.position).toBe(1);
      expect(row?.category).toBe('Groceries & Supermarkets');
      expect(row?.merchant).toBe('Silpo');
      expect(row?.description).toBe('SILPO #12 UA');

      // 3. Catch-up: the same settled version again.
      const r3 = run([held(settled1)], [iv(at('09:00:00'), at('11:00:00'))]);
      expect(r3.outcomes).toEqual([{ key: key('t1'), outcome: 'unchanged' }]);

      // 4. Backfill: a pending version never replaces a settled one.
      const r4 = run([held(pending1)], [iv(at('08:00:00'), at('11:00:00'))]);
      expect(r4.outcomes).toEqual([{ key: key('t1'), outcome: 'unchanged' }]);
      row = read.row('t1');
      expect(row?.amount.minor).toBe(-9850n);
      expect(row?.settled).toBe(true);

      // 5. One batch, settled first then pending under the same key.
      const settled2 = tr('t2', A, at('11:30:00'), -500n);
      const pending2 = tr('t2', A, at('11:29:00'), -700n, { settled: false });
      const r5 = run([held(settled2), held(pending2)], null);
      expect(r5.outcomes).toEqual([
        { key: key('t2'), outcome: 'stored' },
        { key: key('t2'), outcome: 'unchanged' },
      ]);
      const row2 = read.row('t2');
      expect(row2?.amount.minor).toBe(-500n);
      expect(row2?.settled).toBe(true);

      const rows = read.rows();
      expect(rows.map((r) => [r.bankId, r.position])).toEqual([
        ['t1', 1],
        ['t2', 2],
      ]);
      expect(read.position()).toBe(2);
      expect(read.covered()).toEqual([iv(at('08:00:00'), at('11:00:00'))]);
    } finally {
      store.close();
    }
  });

  test('refusals', async () => {
    const { ingest, IngestSourceError, CoveredPartMismatchError } = await ingestModule();
    const { TranslatedShapeError } = await translated();
    const { store, tr, read, log } = await arrange();
    try {
      let spyCalls = 0;
      const alsoSpy = (tx: WriteTx) => {
        spyCalls += 1;
        reg(tx);
      };
      const run = (items: Item[], also: (tx: WriteTx) => void, c: { startAt: number; endAt: number }[] | null = null) =>
        ingest(store, { sourceId: 'monobank', items: items as never, covered: c, also }, log);
      const nothingStored = () => {
        expect(read.rowCount()).toBe(0);
        expect(read.position()).toBe(0);
        expect(read.quarantine().map((e) => e.bankId)).toEqual(['X']);
      };

      // The register holds A and quarantine holds X.
      run([q('X', Date.parse('2026-11-21T11:00:00Z'))], reg);
      expect(read.holdings()).toEqual([A]);
      nothingStored();

      // 1. A holding neither registered nor registered by also: the write rolls back also's writes.
      const zz = tr('z1', 'monobank:account:zz', at('12:00:00'), -100n);
      expect(() =>
        run([held(zz)], (tx) => {
          reg(tx);
          tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'b', currency: 'UAH' });
        }),
      ).toThrow(IngestSourceError);
      expect(read.holdings()).not.toContain(B);
      nothingStored();

      // 2. The item's bank id differs from its record's: refused before the write, nothing cleared.
      const y = tr('Y', A, at('12:00:00'), -100n);
      const mismatched: Item = { kind: 'held', sourceId: 'monobank', bankId: 'X', record: y };
      let caught: unknown = null;
      try {
        run([mismatched], alsoSpy);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(IngestSourceError);
      expect((caught as Error).message).toContain('monobank:X');
      expect((caught as Error).message).toContain('monobank:Y');
      expect(spyCalls).toBe(0);
      nothingStored();

      // 3. Record and item of another source in a batch of 'monobank'.
      const other = tr('s1', 'second:account:c', at('12:00:00'), -100n, { sourceId: 'second' });
      expect(() => run([held(other)], alsoSpy)).toThrow(IngestSourceError);
      expect(spyCalls).toBe(0);
      nothingStored();

      // 4. A shape error.
      const badCode = tr('m1', A, at('12:00:00'), -100n, { mcc: 10000 });
      expect(() => run([held(badCode)], alsoSpy)).toThrow(TranslatedShapeError);
      expect(spyCalls).toBe(0);
      nothingStored();

      // 5. A covered part given while a quarantined moment is unreadable.
      expect(() =>
        run([q('Q', null)], alsoSpy, [
          iv(Date.parse('2026-11-21T10:00:00Z'), Date.parse('2026-11-21T12:00:00Z')),
        ]),
      ).toThrow(CoveredPartMismatchError);
      expect(spyCalls).toBe(0);
      nothingStored();
      expect(read.covered()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('quarantine and coverage', async () => {
    const { ingest, quarantinedMoments } = await ingestModule();
    const { coveredPart } = await covered();
    const { store, tr, read, lines, log } = await arrange();
    try {
      const window = iv(at('10:00:00'), at('12:00:00'));

      // 1. A poll with one quarantined record: commits, covers the window minus 11:17.
      const items1 = [held(tr('t1', A, at('10:30:00'), -10000n)), q('q1', at('11:17:42'))];
      expect(quarantinedMoments(items1 as never)).toEqual([at('11:17:42')]);
      const r1 = ingest(
        store,
        {
          sourceId: 'monobank',
          items: items1 as never,
          covered: coveredPart(window, quarantinedMoments(items1 as never)),
          also: reg,
        },
        log,
      );
      expect(r1.outcomes).toEqual([{ key: key('t1'), outcome: 'stored' }]);
      expect(r1.quarantined).toBe(1);
      expect(r1.cleared).toBe(0);
      expect(read.covered()).toEqual([iv(at('10:00:00'), at('11:17:00')), iv(at('11:18:00'), at('12:00:00'))]);
      const q1 = read.quarantine();
      expect(q1.map((e) => e.bankId)).toEqual(['q1']);
      expect(q1[0]?.occurredAt).toBe(at('11:17:42'));
      expect(lines).toEqual(['quarantined source=monobank bank_id=q1 reason=excess_precision detail=x']);

      // 2. The exact restatement clears the entry and fills the minute.
      const items2 = [held(tr('q1', A, at('11:17:42'), -2000n))];
      const r2 = ingest(
        store,
        {
          sourceId: 'monobank',
          items: items2 as never,
          covered: coveredPart(iv(at('11:00:00'), at('12:00:00')), []),
        },
        log,
      );
      expect(r2.cleared).toBe(1);
      expect(r2.outcomes.map((o) => o.outcome)).toEqual(['stored']);
      expect(read.quarantine()).toEqual([]);
      expect(read.covered()).toEqual([iv(at('10:00:00'), at('12:00:00'))]);

      // 3. An unreadable moment: no covered part, the write still commits.
      const items3 = [q('q3', null), q('q4', at('13:30:00'))];
      const moments3 = quarantinedMoments(items3 as never);
      expect(moments3).toEqual([null, at('13:30:00')]);
      expect(coveredPart(iv(at('13:00:00'), at('14:00:00')), moments3)).toBeNull();
      const r3 = ingest(store, { sourceId: 'monobank', items: items3 as never, covered: null }, log);
      expect(r3.quarantined).toBe(2);
      expect(read.covered()).toEqual([iv(at('10:00:00'), at('12:00:00'))]);
      const held3 = read.quarantine();
      expect(held3.map((e) => [e.bankId, e.occurredAt])).toEqual([
        ['q3', null],
        ['q4', at('13:30:00')],
      ]);
    } finally {
      store.close();
    }
  });

  test('whole write and the view', async () => {
    const { ingest } = await ingestModule();
    const { CoveredPartError } = await covered();
    const { store, tr, read, log } = await arrange();
    try {
      let seen: string[] = [];
      const regAB = (tx: WriteTx) => {
        tx.registerSource({ id: 'monobank', capabilities: ['jars', 'rates'] });
        tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'a', currency: 'UAH' });
        tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'b', currency: 'UAH' });
        seen = tx.register().holdings.map((h) => h.id);
      };
      const items = [
        held(tr('x', A, at('12:00:00'), -10000n)),
        held(tr('y', B, at('12:05:00'), 10000n)),
        q('q1', at('12:30:00')),
      ];
      const nothingRemains = () => {
        expect(read.rowCount()).toBe(0);
        expect(read.transferCount()).toBe(0);
        expect(read.position()).toBe(0);
        expect(read.quarantine()).toEqual([]);
        expect(read.holdings()).toEqual([]);
        expect(read.covered()).toEqual([]);
      };

      // 1. A bad covered part fails the merge, the last step: everything before it rolls back.
      expect(() =>
        ingest(
          store,
          { sourceId: 'monobank', items: items as never, covered: [iv(at('13:00:00'), at('13:00:00'))], also: regAB },
          log,
        ),
      ).toThrow(CoveredPartError);
      nothingRemains();

      // 2. also throwing after its writes.
      expect(() =>
        ingest(
          store,
          {
            sourceId: 'monobank',
            items: items as never,
            covered: null,
            also: (tx) => {
              regAB(tx);
              throw new Error('boom');
            },
          },
          log,
        ),
      ).toThrow('boom');
      nothingRemains();

      // 3. Holdings registered only by also are seen through the view and pass the check.
      seen = [];
      const r = ingest(store, { sourceId: 'monobank', items: items as never, covered: null, also: regAB }, log);
      expect(seen).toEqual([A, B]);
      expect(r.outcomes.map((o) => o.outcome)).toEqual(['stored', 'stored']);
      expect(r.transfersFormed).toBe(1);
      expect(r.transfersCompleted).toBe(0);
      expect(read.position()).toBe(2);
      const xt = read.row('x')?.transfer;
      const yt = read.row('y')?.transfer;
      expect(xt).not.toBeNull();
      expect(xt?.id).toBeNumber();
      expect(yt?.id).toBe(xt?.id as number);
    } finally {
      store.close();
    }
  });

  test('transfer counts', async () => {
    const { ingest } = await ingestModule();
    const { store, tr, read, log } = await arrange();
    try {
      const regAB = (tx: WriteTx) => {
        tx.registerSource({ id: 'monobank', capabilities: ['jars', 'rates'] });
        tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'a', currency: 'UAH' });
        tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'b', currency: 'UAH' });
      };
      const regJ = (tx: WriteTx) => {
        tx.registerHolding({ kind: 'jar', sourceId: 'monobank', bankId: 'j', currency: 'UAH' });
      };
      const topUp: Counterpart = { holdingId: J, bankId: null, via: 'jar_top_up' };

      // 1. A pair and a marked top-up recorded one-sided: two formed.
      const r1 = ingest(
        store,
        {
          sourceId: 'monobank',
          items: [
            held(tr('x', A, at('12:00:00'), -10000n)),
            held(tr('y', B, at('12:05:00'), 10000n)),
            held(tr('t', A, at('12:30:00'), -500n, { counterpart: topUp })),
          ] as never,
          covered: null,
          also: regAB,
        },
        log,
      );
      expect(r1.transfersFormed).toBe(2);
      expect(r1.transfersCompleted).toBe(0);
      const tTransfer = read.row('t')?.transfer;
      expect(tTransfer).toEqual({ direction: 'out', otherHolding: J, complete: false, id: tTransfer?.id as number });
      expect(tTransfer?.id).toBeNumber();

      // 2. The jar side arrives later and completes t's open transfer: one completed, none formed.
      const j = tr('j', J, at('12:31:00'), 500n);
      const r2 = ingest(store, { sourceId: 'monobank', items: [held(j)] as never, covered: null, also: regJ }, log);
      expect(r2.outcomes).toEqual([{ key: key('j'), outcome: 'stored' }]);
      expect(r2.transfersFormed).toBe(0);
      expect(r2.transfersCompleted).toBe(1);
      const tAfter = read.row('t')?.transfer;
      const jAfter = read.row('j')?.transfer;
      expect(tAfter?.id).toBe(tTransfer?.id as number);
      expect(jAfter?.id).toBe(tTransfer?.id as number);
      expect(tAfter?.complete).toBe(true);
      expect(jAfter?.complete).toBe(true);
      expect(read.openTransfers()).toEqual([]);

      // 3. The same settled version again: nothing formed or completed.
      const r3 = ingest(store, { sourceId: 'monobank', items: [held(j)] as never, covered: null }, log);
      expect(r3.outcomes).toEqual([{ key: key('j'), outcome: 'unchanged' }]);
      expect(r3.transfersFormed).toBe(0);
      expect(r3.transfersCompleted).toBe(0);
      expect(read.transferCount()).toBe(2);
    } finally {
      store.close();
    }
  });
});
