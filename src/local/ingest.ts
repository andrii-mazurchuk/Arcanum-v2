// Ingest (S-113): the one write every arrival path stores through. Shape, identity and covered-part
// checks and the known-holdings read happen before the write; inside one store write come the
// caller's own writes, store/replace/unchanged per key with settled-over-pending, classification at
// first storage, quarantine settlement, pairing and the covered-part merge. Any throw rolls it all back.

import type { HoldingId, Instant, SourceId } from '../core/primitives';
import type { Store, WriteTx } from '../db/index';
import type { Translated } from '../money/quarantine';
import { settleQuarantine } from '../money/quarantine';
import { classify } from './classifier';
import type { Interval } from './covered';
import { mergeCovered } from './covered';
import { pairInWrite } from './pairing';
import { getTransaction, insertTransaction, settleHeld } from './transactions';
import type { TransactionKey, TranslatedTransaction } from './translated';
import { checkTranslated, keyText } from './translated';

export interface IngestBatch {
  readonly sourceId: SourceId;
  readonly items: readonly Translated<TranslatedTransaction>[]; // the step's whole translated batch, quarantined items included
  readonly covered: readonly Interval[] | null; // coveredPart(window, quarantinedMoments(items)) of a step that fetched its whole window; null for push, or when coveredPart gave null
  readonly also?: (tx: WriteTx) => void; // the step's own writes in the same write: register rows, recorded rates, balances, its progress point
}

export type RowOutcome = 'stored' | 'replaced' | 'unchanged';

export interface IngestResult {
  readonly outcomes: readonly { key: TransactionKey; outcome: RowOutcome }[]; // one per held item, in batch order
  readonly quarantined: number;
  readonly cleared: number;
  readonly transfersFormed: number; // pair + one_sided decisions
  readonly transfersCompleted: number;
}

export class IngestSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestSourceError';
  }
}

export class CoveredPartMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoveredPartMismatchError';
  }
}

export function quarantinedMoments(items: readonly Translated<TranslatedTransaction>[]): (Instant | null)[] {
  const out: (Instant | null)[] = [];
  for (const item of items) if (item.kind === 'quarantined') out.push(item.entry.occurredAt);
  return out;
}

// The WriteTx handed to `also`: every member is tx's own, except registerHolding, which also adds
// the registered holding's id to known.
function viewOf(tx: WriteTx, known: Set<HoldingId>): WriteTx {
  const registerHolding: WriteTx['registerHolding'] = (h) => {
    const row = tx.registerHolding(h);
    known.add(row.id);
    return row;
  };
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === 'registerHolding') return registerHolding;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function ingest(store: Store, batch: IngestBatch, log: (line: string) => void): IngestResult {
  // (a) Identity and shape, before the write opens.
  for (const item of batch.items) {
    if (item.kind === 'held') {
      const t = item.record;
      const itemKey = keyText({ sourceId: item.sourceId, bankId: item.bankId });
      if (t.sourceId !== item.sourceId || item.sourceId !== batch.sourceId || t.bankId !== item.bankId) {
        throw new IngestSourceError(
          `ingest into source "${batch.sourceId}": item ${itemKey} carries record ${keyText(t)}`,
        );
      }
      checkTranslated(t);
    } else if (item.entry.sourceId !== batch.sourceId) {
      throw new IngestSourceError(
        `ingest into source "${batch.sourceId}": quarantined item ${keyText(item.entry)} is of another source`,
      );
    }
  }

  // (b) No covered part over a quarantined record whose moment is unreadable.
  if (batch.covered !== null && quarantinedMoments(batch.items).some((m) => m === null)) {
    throw new CoveredPartMismatchError(
      `ingest into source "${batch.sourceId}": a covered part was given while a quarantined moment is unreadable`,
    );
  }

  // (c) The known holdings.
  const known = new Set<HoldingId>(store.readSnapshot((snap) => snap.register()).holdings.map((h) => h.id));

  return store.write((tx) => {
    if (batch.also !== undefined) batch.also(viewOf(tx, known));

    const outcomes: { key: TransactionKey; outcome: RowOutcome }[] = [];
    const fresh: TransactionKey[] = [];
    for (const item of batch.items) {
      if (item.kind !== 'held') continue;
      const t = item.record;
      const key: TransactionKey = { sourceId: t.sourceId, bankId: t.bankId };
      if (!known.has(t.holdingId)) {
        throw new IngestSourceError(`ingest: ${keyText(key)} is on holding '${t.holdingId}', which is not registered`);
      }
      const h = getTransaction(tx.db, key);
      let outcome: RowOutcome;
      if (h === null) {
        insertTransaction(tx, t, tx.claimPosition(), classify(t));
        outcome = 'stored';
      } else if (!h.settled && t.settled) {
        settleHeld(tx, t);
        outcome = 'replaced';
      } else {
        outcome = 'unchanged';
      }
      outcomes.push({ key, outcome });
      if (outcome !== 'unchanged') fresh.push(key);
    }

    const { quarantined, cleared } = settleQuarantine(tx, batch.sourceId, batch.items, log);

    let transfersFormed = 0;
    let transfersCompleted = 0;
    if (fresh.length > 0) {
      for (const d of pairInWrite(tx, fresh)) {
        if (d.kind === 'complete') transfersCompleted += 1;
        else transfersFormed += 1;
      }
    }

    if (batch.covered !== null) mergeCovered(tx, batch.sourceId, batch.covered);

    return { outcomes, quarantined, cleared, transfersFormed, transfersCompleted };
  });
}
