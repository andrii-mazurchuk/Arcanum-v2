// Own-transfer pairing (S-78): the inclusive windows, the counterpart-compatibility rule, the pure
// four-tier planner (explicit links, completion of open one-sided transfers, closest-in-time amount
// matches, one-sided recording) and its application inside the ingest write. A stored pairing is
// never re-paired; the only change it takes is an open one-sided transfer gaining its missing side.

import type { HoldingId, Instant } from '../core/primitives';
import type { WriteTx } from '../db/index';
import type { Money } from '../money/money';
import type { StoredTransaction } from './transactions';
import { attachSide, createTransfer, getTransaction, listOpenTransfers, selectTransactions } from './transactions';
import type { Counterpart, TransactionKey } from './translated';
import { compareKeys, keyText } from './translated';

export const SAME_SOURCE_WINDOW_MS = 600_000; // 10 minutes
export const CROSS_SOURCE_WINDOW_MS = 259_200_000; // 3 days = 72 hours = 3 x 86_400_000

export function sourceOfHolding(h: HoldingId): string {
  const i = h.indexOf(':');
  return i < 0 ? h : h.slice(0, i);
}

export function windowFor(a: HoldingId, b: HoldingId): number {
  return sourceOfHolding(a) === sourceOfHolding(b) ? SAME_SOURCE_WINDOW_MS : CROSS_SOURCE_WINDOW_MS;
}

export interface Movement {
  readonly key: TransactionKey;
  readonly holdingId: HoldingId;
  readonly occurredAt: Instant;
  readonly amount: Money;
  readonly originalAmount: Money | null;
  readonly counterpart: Counterpart | null;
  readonly fresh: boolean; // stored or replaced by the current write
}

export interface OpenTransfer {
  readonly id: number;
  readonly recorded: Movement; // its one held side
  readonly namedHolding: HoldingId;
}

export type PairingDecision =
  | { kind: 'pair'; tier: 1 | 3; out: TransactionKey; in: TransactionKey; outHolding: HoldingId; inHolding: HoldingId }
  | { kind: 'complete'; transferId: number; key: TransactionKey }
  | { kind: 'one_sided'; key: TransactionKey; outHolding: HoldingId; inHolding: HoldingId };

function figures(m: Movement): Money[] {
  return m.originalAmount === null ? [m.amount] : [m.amount, m.originalAmount];
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export function sameAmount(a: Movement, b: Movement): boolean {
  return figures(a).some((x) =>
    figures(b).some((y) => x.currency === y.currency && abs(x.minor) === abs(y.minor)),
  );
}

function oppositeSigned(a: Movement, b: Movement): boolean {
  return (a.amount.minor < 0n && b.amount.minor > 0n) || (a.amount.minor > 0n && b.amount.minor < 0n);
}

export function compatible(a: Movement, b: Movement): boolean {
  return (
    (a.counterpart === null || a.counterpart.holdingId === b.holdingId) &&
    (b.counterpart === null || b.counterpart.holdingId === a.holdingId)
  );
}

function links(x: Movement, y: Movement): boolean {
  return x.counterpart !== null && x.counterpart.bankId === y.key.bankId && x.counterpart.holdingId === y.holdingId;
}

function gap(x: Movement, y: Movement): number {
  return Math.abs(x.occurredAt - y.occurredAt);
}

// The ordering key of a candidate pair: gap, earlier moment, lesser key, greater key.
function comparePairs(a: [Movement, Movement], b: [Movement, Movement]): number {
  const g = gap(a[0], a[1]) - gap(b[0], b[1]);
  if (g !== 0) return g;
  const e =
    Math.min(a[0].occurredAt, a[1].occurredAt) - Math.min(b[0].occurredAt, b[1].occurredAt);
  if (e !== 0) return e;
  const [aLo, aHi] = compareKeys(a[0].key, a[1].key) <= 0 ? [a[0].key, a[1].key] : [a[1].key, a[0].key];
  const [bLo, bHi] = compareKeys(b[0].key, b[1].key) <= 0 ? [b[0].key, b[1].key] : [b[1].key, b[0].key];
  return compareKeys(aLo, bLo) || compareKeys(aHi, bHi);
}

function pairDecision(tier: 1 | 3, x: Movement, y: Movement): PairingDecision {
  const [out, inn] = x.amount.minor < 0n ? [x, y] : [y, x];
  return { kind: 'pair', tier, out: out.key, in: inn.key, outHolding: out.holdingId, inHolding: inn.holdingId };
}

export function planPairings(unpaired: readonly Movement[], open: readonly OpenTransfer[]): PairingDecision[] {
  const decisions: PairingDecision[] = [];
  const free = new Set<Movement>(unpaired);

  const twoSided = (tier: 1 | 3, accept: (x: Movement, y: Movement) => boolean): void => {
    const candidates: [Movement, Movement][] = [];
    const list = unpaired.filter((m) => free.has(m));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i] as Movement;
        const y = list[j] as Movement;
        if (!x.fresh && !y.fresh) continue;
        if (x.holdingId === y.holdingId || !oppositeSigned(x, y) || !compatible(x, y)) continue;
        if (accept(x, y)) candidates.push([x, y]);
      }
    }
    candidates.sort(comparePairs);
    for (const [x, y] of candidates) {
      if (!free.has(x) || !free.has(y)) continue;
      free.delete(x);
      free.delete(y);
      decisions.push(pairDecision(tier, x, y));
    }
  };

  // 1. Links: no time window.
  twoSided(1, (x, y) => links(x, y) || links(y, x));

  // 2. Completion of open one-sided transfers.
  const completions: { t: OpenTransfer; m: Movement }[] = [];
  for (const t of open) {
    for (const m of unpaired) {
      if (!free.has(m) || (!t.recorded.fresh && !m.fresh)) continue;
      if (m.holdingId !== t.namedHolding || !compatible(t.recorded, m) || !oppositeSigned(t.recorded, m)) continue;
      if (!sameAmount(t.recorded, m)) continue;
      if (gap(t.recorded, m) > windowFor(t.recorded.holdingId, m.holdingId)) continue;
      completions.push({ t, m });
    }
  }
  completions.sort((a, b) => comparePairs([a.t.recorded, a.m], [b.t.recorded, b.m]));
  const completed = new Set<number>();
  for (const { t, m } of completions) {
    if (completed.has(t.id) || !free.has(m)) continue;
    completed.add(t.id);
    free.delete(m);
    decisions.push({ kind: 'complete', transferId: t.id, key: m.key });
  }

  // 3. Amount matches within the inclusive window.
  twoSided(3, (x, y) => sameAmount(x, y) && gap(x, y) <= windowFor(x.holdingId, y.holdingId));

  // 4. One-sided recording of fresh, still-free movements the bank names a holding for.
  const left = unpaired
    .filter((m) => free.has(m) && m.fresh && m.counterpart !== null && m.amount.minor !== 0n)
    .sort((a, b) => a.occurredAt - b.occurredAt || compareKeys(a.key, b.key));
  for (const m of left) {
    const named = (m.counterpart as Counterpart).holdingId;
    decisions.push(
      m.amount.minor < 0n
        ? { kind: 'one_sided', key: m.key, outHolding: m.holdingId, inHolding: named }
        : { kind: 'one_sided', key: m.key, outHolding: named, inHolding: m.holdingId },
    );
  }
  return decisions;
}

function toMovement(t: StoredTransaction, fresh: ReadonlySet<string>): Movement {
  const key = { sourceId: t.sourceId, bankId: t.bankId };
  return {
    key,
    holdingId: t.holdingId,
    occurredAt: t.occurredAt,
    amount: t.amount,
    originalAmount: t.originalAmount,
    counterpart: t.counterpart,
    fresh: fresh.has(keyText(key)),
  };
}

// Called only by the ingest step, inside its write, after rows are stored and replaced and before
// coverage merges, with the keys it stored or replaced.
export function pairInWrite(tx: WriteTx, freshKeys: readonly TransactionKey[]): PairingDecision[] {
  const db = tx.db;
  const fresh = new Set(freshKeys.map(keyText));
  const unpaired = new Map<string, StoredTransaction>();
  const consider = (t: StoredTransaction | null): void => {
    if (t !== null && t.transfer === null) unpaired.set(keyText(t), t);
  };

  const freshRows: StoredTransaction[] = [];
  for (const k of freshKeys) {
    const t = getTransaction(db, k);
    if (t !== null) freshRows.push(t);
  }
  for (const f of freshRows) {
    consider(f);
    for (const t of selectTransactions(db, {
      from: f.occurredAt - CROSS_SOURCE_WINDOW_MS,
      until: f.occurredAt + CROSS_SOURCE_WINDOW_MS + 1,
      order: 'occurred',
    })) {
      consider(t);
    }
    if (f.counterpart !== null && f.counterpart.bankId !== null) {
      const named = getTransaction(db, { sourceId: sourceOfHolding(f.counterpart.holdingId), bankId: f.counterpart.bankId });
      if (named !== null && named.holdingId === f.counterpart.holdingId) consider(named);
    }
    const naming = db
      .query(
        'SELECT source_id, bank_id FROM held_transaction ' +
          'WHERE counterpart_holding = ? AND counterpart_bank_id = ? AND transfer_id IS NULL',
      )
      .all(f.holdingId, f.bankId) as { source_id: string; bank_id: string }[];
    for (const n of naming) consider(getTransaction(db, { sourceId: n.source_id, bankId: n.bank_id }));
  }

  const open: OpenTransfer[] = [];
  for (const o of listOpenTransfers(db)) {
    const side = o.sides[0];
    if (side === undefined) continue;
    const recorded = getTransaction(db, side);
    if (recorded === null) continue;
    open.push({
      id: o.id,
      recorded: toMovement(recorded, fresh),
      namedHolding: recorded.holdingId === o.outHolding ? o.inHolding : o.outHolding,
    });
  }

  const decisions = planPairings(
    [...unpaired.values()].map((t) => toMovement(t, fresh)),
    open,
  );
  for (const d of decisions) {
    if (d.kind === 'pair') createTransfer(tx, d.outHolding, d.inHolding, d.tier, [d.out, d.in]);
    else if (d.kind === 'complete') attachSide(tx, d.transferId, d.key);
    else createTransfer(tx, d.outHolding, d.inHolding, 4, [d.key]);
  }
  return decisions;
}
