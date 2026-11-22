// Held transactions (S-141): the one place the transaction and own-transfer tables are declared,
// read and written. Rows are keyed by (source, bank id); category and merchant are decided once at
// first storage; a pairing is never removed or re-paired. Minor units are stored as the decimal
// text of the bigint, so no amount passes through a binary floating-point number. The row writes
// are called only by the ingest step, inside its storing write.

import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { HoldingId, Instant, Position } from '../core/primitives';
import type { TransactionHead, WriteTx } from '../db/index';
import { LISTED_MARKS_TABLE } from '../db/index';
import type { Money } from '../money/money';
import { money } from '../money/money';
import type { Category, Classification } from './classifier';
import type { Counterpart, CounterpartVia, TransactionKey, TranslatedTransaction } from './translated';
import { keyText } from './translated';

export function ensureTransactionSchema(db: Database): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS held_transaction (' +
      'source_id TEXT NOT NULL, bank_id TEXT NOT NULL, holding_id TEXT NOT NULL, ' +
      'occurred_at INTEGER NOT NULL, position INTEGER NOT NULL UNIQUE, ' +
      'amount_minor TEXT NOT NULL, amount_currency TEXT NOT NULL, ' +
      'original_minor TEXT, original_currency TEXT, cashback_minor TEXT, ' +
      'settled INTEGER NOT NULL CHECK (settled IN (0, 1)), mcc INTEGER, original_mcc INTEGER, ' +
      'merchant_text TEXT, description TEXT NOT NULL, comment TEXT, ' +
      'counterpart_holding TEXT, counterpart_bank_id TEXT, counterpart_via TEXT, ' +
      'category TEXT NOT NULL, merchant TEXT NOT NULL, transfer_id INTEGER, ' +
      'PRIMARY KEY (source_id, bank_id))',
  );
  db.run('CREATE INDEX IF NOT EXISTS held_transaction_occurred_at ON held_transaction (occurred_at)');
  db.run('CREATE INDEX IF NOT EXISTS held_transaction_holding_id ON held_transaction (holding_id)');
  db.run('CREATE INDEX IF NOT EXISTS held_transaction_transfer_id ON held_transaction (transfer_id)');
  db.run(
    'CREATE TABLE IF NOT EXISTS own_transfer (' +
      'id INTEGER PRIMARY KEY, out_holding TEXT NOT NULL, in_holding TEXT NOT NULL, tier INTEGER NOT NULL)',
  );
}

export interface TransferView {
  readonly id: number;
  readonly direction: 'out' | 'in'; // 'out' when this movement's amount.minor < 0n
  readonly otherHolding: HoldingId; // the holding on the other end, held or not
  readonly complete: boolean; // both sides held; false for an open one-sided transfer
}

export interface StoredTransaction extends TransactionHead {
  readonly amount: Money;
  readonly originalAmount: Money | null;
  readonly cashback: Money | null; // the bank-reported cashback of the version held, in amount's currency; null when none reported
  readonly settled: boolean;
  readonly mcc: number | null;
  readonly originalMcc: number | null;
  readonly merchantText: string | null;
  readonly description: string;
  readonly comment: string | null;
  readonly counterpart: Counterpart | null;
  readonly category: Category; // decided once at first storage
  readonly merchant: string; // decided once at first storage
  readonly transfer: TransferView | null;
}

export interface TransactionQuery {
  readonly holdings?: ReadonlySet<HoldingId>; // absent: every holding
  readonly from?: Instant; // occurredAt >= from
  readonly until?: Instant; // occurredAt < until
  readonly afterPosition?: Position; // position > afterPosition
  readonly upToPosition?: Position; // position <= upToPosition
  readonly category?: Category; // stored category equals it exactly; absent: every category
  readonly unlistedOnly?: boolean; // true: only rows whose position has no row in LISTED_MARKS_TABLE
  readonly order: 'position' | 'occurred'; // ascending; 'occurred' ties broken by position
  readonly limit?: number; // whole number >= 1; absent: no limit
}

interface Row {
  source_id: string;
  bank_id: string;
  holding_id: string;
  occurred_at: number;
  position: number;
  amount_minor: string;
  amount_currency: string;
  original_minor: string | null;
  original_currency: string | null;
  cashback_minor: string | null;
  settled: number;
  mcc: number | null;
  original_mcc: number | null;
  merchant_text: string | null;
  description: string;
  comment: string | null;
  counterpart_holding: string | null;
  counterpart_bank_id: string | null;
  counterpart_via: string | null;
  category: string;
  merchant: string;
  transfer_id: number | null;
  out_holding: string | null;
  in_holding: string | null;
  side_count: number;
}

const SELECT_ROWS =
  'SELECT h.*, o.out_holding, o.in_holding, ' +
  '(SELECT COUNT(*) FROM held_transaction s WHERE s.transfer_id = h.transfer_id) AS side_count ' +
  'FROM held_transaction h LEFT JOIN own_transfer o ON o.id = h.transfer_id';

function fromRow(r: Row): StoredTransaction {
  const amount = money(BigInt(r.amount_minor), r.amount_currency);
  let transfer: TransferView | null = null;
  if (r.transfer_id !== null && r.out_holding !== null && r.in_holding !== null) {
    const direction = amount.minor < 0n ? 'out' : 'in';
    transfer = {
      id: r.transfer_id,
      direction,
      otherHolding: direction === 'out' ? r.in_holding : r.out_holding,
      complete: r.side_count === 2,
    };
  }
  return {
    sourceId: r.source_id,
    bankId: r.bank_id,
    holdingId: r.holding_id,
    occurredAt: r.occurred_at,
    position: r.position,
    amount,
    originalAmount:
      r.original_minor === null || r.original_currency === null
        ? null
        : money(BigInt(r.original_minor), r.original_currency),
    cashback: r.cashback_minor === null ? null : money(BigInt(r.cashback_minor), r.amount_currency),
    settled: r.settled === 1,
    mcc: r.mcc,
    originalMcc: r.original_mcc,
    merchantText: r.merchant_text,
    description: r.description,
    comment: r.comment,
    counterpart:
      r.counterpart_holding === null || r.counterpart_via === null
        ? null
        : {
            holdingId: r.counterpart_holding,
            bankId: r.counterpart_bank_id,
            via: r.counterpart_via as CounterpartVia,
          },
    category: r.category as Category,
    merchant: r.merchant,
    transfer,
  };
}

export function selectTransactions(db: Database, q: TransactionQuery): StoredTransaction[] {
  const where: string[] = [];
  const args: SQLQueryBindings[] = [];
  if (q.holdings !== undefined) {
    if (q.holdings.size === 0) return [];
    where.push(`h.holding_id IN (${[...q.holdings].map(() => '?').join(', ')})`);
    args.push(...q.holdings);
  }
  if (q.from !== undefined) {
    where.push('h.occurred_at >= ?');
    args.push(q.from);
  }
  if (q.until !== undefined) {
    where.push('h.occurred_at < ?');
    args.push(q.until);
  }
  if (q.afterPosition !== undefined) {
    where.push('h.position > ?');
    args.push(q.afterPosition);
  }
  if (q.upToPosition !== undefined) {
    where.push('h.position <= ?');
    args.push(q.upToPosition);
  }
  if (q.category !== undefined) {
    where.push('h.category = ?');
    args.push(q.category);
  }
  if (q.unlistedOnly === true) {
    where.push(`h.position NOT IN (SELECT position FROM ${LISTED_MARKS_TABLE})`);
  }
  let sql = SELECT_ROWS;
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  sql += q.order === 'occurred' ? ' ORDER BY h.occurred_at, h.position' : ' ORDER BY h.position';
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1) {
      throw new RangeError(`limit ${q.limit} is not a whole number >= 1`);
    }
    sql += ' LIMIT ?';
    args.push(q.limit);
  }
  return (db.query(sql).all(...args) as Row[]).map(fromRow);
}

export function getTransaction(db: Database, key: TransactionKey): StoredTransaction | null {
  const row = db
    .query(`${SELECT_ROWS} WHERE h.source_id = ? AND h.bank_id = ?`)
    .get(key.sourceId, key.bankId) as Row | null;
  return row === null ? null : fromRow(row);
}

export interface OwnTransferRow {
  readonly id: number;
  readonly outHolding: HoldingId;
  readonly inHolding: HoldingId;
  readonly tier: 1 | 2 | 3 | 4; // the tier that formed it; a tier-2 completion leaves it 4
  readonly sides: readonly TransactionKey[]; // 1 (open) or 2 (complete), in position order
}

interface TransferRow {
  id: number;
  out_holding: string;
  in_holding: string;
  tier: number;
}

function sidesOf(db: Database, id: number): TransactionKey[] {
  return (
    db
      .query('SELECT source_id, bank_id FROM held_transaction WHERE transfer_id = ? ORDER BY position')
      .all(id) as { source_id: string; bank_id: string }[]
  ).map((s) => ({ sourceId: s.source_id, bankId: s.bank_id }));
}

function transferFromRow(db: Database, r: TransferRow): OwnTransferRow {
  return {
    id: r.id,
    outHolding: r.out_holding,
    inHolding: r.in_holding,
    tier: r.tier as 1 | 2 | 3 | 4,
    sides: sidesOf(db, r.id),
  };
}

export function listOpenTransfers(db: Database): OwnTransferRow[] {
  const rows = db
    .query(
      'SELECT o.id, o.out_holding, o.in_holding, o.tier FROM own_transfer o ' +
        'WHERE (SELECT COUNT(*) FROM held_transaction h WHERE h.transfer_id = o.id) = 1 ' +
        'ORDER BY o.id',
    )
    .all() as TransferRow[];
  return rows.map((r) => transferFromRow(db, r));
}

export function getTransfer(db: Database, id: number): OwnTransferRow | null {
  const row = db
    .query('SELECT id, out_holding, in_holding, tier FROM own_transfer WHERE id = ?')
    .get(id) as TransferRow | null;
  return row === null ? null : transferFromRow(db, row);
}

// Row writes: called only by the ingest step, inside its storing write.

export function insertTransaction(
  tx: WriteTx,
  t: TranslatedTransaction,
  position: Position,
  c: Classification,
): void {
  tx.db.run(
    'INSERT INTO held_transaction (' +
      'source_id, bank_id, holding_id, occurred_at, position, amount_minor, amount_currency, ' +
      'original_minor, original_currency, cashback_minor, settled, mcc, original_mcc, ' +
      'merchant_text, description, comment, counterpart_holding, counterpart_bank_id, ' +
      'counterpart_via, category, merchant, transfer_id' +
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    [
      t.sourceId,
      t.bankId,
      t.holdingId,
      t.occurredAt,
      position,
      t.amount.minor.toString(),
      t.amount.currency,
      t.originalAmount === null ? null : t.originalAmount.minor.toString(),
      t.originalAmount === null ? null : t.originalAmount.currency,
      t.cashback === null ? null : t.cashback.minor.toString(),
      t.settled ? 1 : 0,
      t.mcc,
      t.originalMcc,
      t.merchantText,
      t.description,
      t.comment,
      t.counterpart === null ? null : t.counterpart.holdingId,
      t.counterpart === null ? null : t.counterpart.bankId,
      t.counterpart === null ? null : t.counterpart.via,
      c.category,
      c.merchant,
    ],
  );
}

export function settleHeld(tx: WriteTx, t: TranslatedTransaction): void {
  const result = tx.db.run(
    'UPDATE held_transaction SET occurred_at = ?, amount_minor = ?, amount_currency = ?, ' +
      'original_minor = ?, original_currency = ?, cashback_minor = ?, settled = 1 ' +
      'WHERE source_id = ? AND bank_id = ?',
    [
      t.occurredAt,
      t.amount.minor.toString(),
      t.amount.currency,
      t.originalAmount === null ? null : t.originalAmount.minor.toString(),
      t.originalAmount === null ? null : t.originalAmount.currency,
      t.cashback === null ? null : t.cashback.minor.toString(),
      t.sourceId,
      t.bankId,
    ],
  );
  if (result.changes !== 1) throw new Error(`settleHeld: no held transaction ${keyText(t)}`);
}

// Sets transfer_id on a held row whose transfer_id is NULL; throws for a missing or linked row.
function linkSide(tx: WriteTx, transferId: number, key: TransactionKey): void {
  const result = tx.db.run(
    'UPDATE held_transaction SET transfer_id = ? ' +
      'WHERE source_id = ? AND bank_id = ? AND transfer_id IS NULL',
    [transferId, key.sourceId, key.bankId],
  );
  if (result.changes !== 1) {
    throw new Error(`own transfer ${transferId}: ${keyText(key)} is not a held, unpaired movement`);
  }
}

export function createTransfer(
  tx: WriteTx,
  outHolding: HoldingId,
  inHolding: HoldingId,
  tier: 1 | 2 | 3 | 4,
  sides: readonly TransactionKey[],
): number {
  if (sides.length !== 1 && sides.length !== 2) {
    throw new Error(`own transfer: ${sides.length} sides given, expected 1 or 2`);
  }
  const row = tx.db
    .query('INSERT INTO own_transfer (out_holding, in_holding, tier) VALUES (?, ?, ?) RETURNING id')
    .get(outHolding, inHolding, tier) as { id: number };
  for (const key of sides) linkSide(tx, row.id, key);
  return row.id;
}

export function attachSide(tx: WriteTx, transferId: number, key: TransactionKey): void {
  const held = tx.db
    .query(
      'SELECT (SELECT COUNT(*) FROM held_transaction h WHERE h.transfer_id = o.id) AS n ' +
        'FROM own_transfer o WHERE o.id = ?',
    )
    .get(transferId) as { n: number } | null;
  if (held === null) throw new Error(`own transfer ${transferId} does not exist`);
  if (held.n !== 1) throw new Error(`own transfer ${transferId} has ${held.n} sides, not one`);
  linkSide(tx, transferId, key);
}
