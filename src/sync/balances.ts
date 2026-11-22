// Reported balances (S-243): each holding's balance, credit limit and jar goal as separate fields,
// each with its own as-of moment and optional finer order. recordBalances is the only writer and
// decides every carried field on its own: an earlier moment is kept, a later one replaces, an equal
// one keeps an equal value and is otherwise ordered by the finer order, else the later arrival.

import type { Database } from 'bun:sqlite';
import type { HoldingId, Instant, SourceId } from '../core/primitives';
import type { HoldingRow } from '../core/register';
import type { Snapshot, WriteTx } from '../db/index';
import { type Money, money } from '../money/money';

export interface ReportedBalance {
  readonly holdingId: HoldingId;
  readonly balance: Money;
  readonly creditLimit: Money | null;
  readonly goal?: Money | null;
  readonly order?: number | null;
}

export interface HeldBalance {
  readonly holdingId: HoldingId;
  readonly sourceId: SourceId;
  readonly balance: Money;
  readonly reportedAt: Instant;
  readonly creditLimit: Money | null;
  readonly creditLimitAt: Instant | null;
  readonly goal: Money | null;
  readonly goalAt: Instant | null;
}

export type LimitMode = 'restated' | 'if_given';

export class BalanceShapeError extends Error {
  constructor(holdingId: string, rule: string) {
    super(`Reported balance for holding "${holdingId}" breaks a rule: ${rule}.`);
    this.name = 'BalanceShapeError';
  }
}

export function ensureBalanceSchema(db: Database): void {
  db.run(
    'CREATE TABLE IF NOT EXISTS holding_balance (' +
      'holding_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, currency TEXT NOT NULL, ' +
      'balance_minor TEXT NOT NULL, reported_at INTEGER NOT NULL, balance_order INTEGER, ' +
      'credit_limit_minor TEXT, credit_limit_at INTEGER, credit_limit_order INTEGER, ' +
      'goal_minor TEXT, goal_at INTEGER, goal_order INTEGER)',
  );
}

interface BalanceRow {
  holding_id: string;
  source_id: string;
  currency: string;
  balance_minor: string;
  reported_at: number;
  balance_order: number | null;
  credit_limit_minor: string | null;
  credit_limit_at: number | null;
  credit_limit_order: number | null;
  goal_minor: string | null;
  goal_at: number | null;
  goal_order: number | null;
}

const COLUMNS =
  'holding_id, source_id, currency, balance_minor, reported_at, balance_order, ' +
  'credit_limit_minor, credit_limit_at, credit_limit_order, goal_minor, goal_at, goal_order';

// One field as held: its value in minor units (null for 'none'), its moment and its finer order.
interface Field {
  minor: bigint | null;
  at: Instant | null;
  order: number | null;
}

// Whether a carried field replaces the held one, per the per-field moment and same-moment rules.
function replaces(held: Field, minor: bigint | null, t: Instant, o: number | null): boolean {
  if (held.at === null) return true;
  if (t > held.at) return true;
  if (t < held.at) return false;
  if (minor === held.minor) return false;
  if (o !== null && held.order !== null && o < held.order) return false;
  return true;
}

function check(b: ReportedBalance, sourceId: SourceId, holdings: Map<string, HoldingRow>): void {
  const id = String(b.holdingId);
  if (!id.startsWith(`${sourceId}:`)) {
    throw new BalanceShapeError(id, `holdingId does not belong to source "${sourceId}"`);
  }
  const h = holdings.get(id);
  if (h === undefined) throw new BalanceShapeError(id, 'the holding is not registered');
  if (h.currency !== b.balance.currency) {
    throw new BalanceShapeError(id, `balance currency ${b.balance.currency} is not the holding's ${h.currency}`);
  }
  if (b.creditLimit !== null) {
    if (h.kind !== 'account') throw new BalanceShapeError(id, 'a credit limit belongs to an account only');
    if (b.creditLimit.currency !== b.balance.currency) {
      throw new BalanceShapeError(id, 'the credit limit is not in the balance currency');
    }
  }
  if (b.goal !== undefined && b.goal !== null) {
    if (h.kind !== 'jar') throw new BalanceShapeError(id, 'a goal belongs to a jar only');
    if (b.goal.currency !== b.balance.currency) {
      throw new BalanceShapeError(id, 'the goal is not in the balance currency');
    }
  }
  if (b.order !== undefined && b.order !== null && !Number.isSafeInteger(b.order)) {
    throw new BalanceShapeError(id, 'order is not a safe integer');
  }
}

const text = (minor: bigint | null): string | null => (minor === null ? null : minor.toString());
const big = (t: string | null): bigint | null => (t === null ? null : BigInt(t));

export function recordBalances(
  tx: WriteTx,
  sourceId: SourceId,
  balances: readonly ReportedBalance[],
  reportedAt: Instant,
  limits: LimitMode,
): { written: number; kept: number } {
  const holdings = new Map(tx.register().holdings.map((h) => [h.id, h] as const));
  for (const b of balances) {
    check(b, sourceId, holdings);
    if (!Number.isSafeInteger(reportedAt)) {
      throw new BalanceShapeError(String(b.holdingId), 'reportedAt is not a safe integer');
    }
  }

  const select = tx.db.query(`SELECT ${COLUMNS} FROM holding_balance WHERE holding_id = ?`);
  const insert = tx.db.query(
    `INSERT INTO holding_balance (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = tx.db.query(
    'UPDATE holding_balance SET currency = ?, balance_minor = ?, reported_at = ?, balance_order = ?, ' +
      'credit_limit_minor = ?, credit_limit_at = ?, credit_limit_order = ?, ' +
      'goal_minor = ?, goal_at = ?, goal_order = ? WHERE holding_id = ?',
  );

  let written = 0;
  let kept = 0;
  for (const b of balances) {
    const o = b.order ?? null;
    const row = select.get(b.holdingId) as BalanceRow | null;
    const bal: Field = row
      ? { minor: big(row.balance_minor), at: row.reported_at, order: row.balance_order }
      : { minor: null, at: null, order: null };
    const lim: Field = row
      ? { minor: big(row.credit_limit_minor), at: row.credit_limit_at, order: row.credit_limit_order }
      : { minor: null, at: null, order: null };
    const goal: Field = row
      ? { minor: big(row.goal_minor), at: row.goal_at, order: row.goal_order }
      : { minor: null, at: null, order: null };
    let currency = row ? row.currency : b.balance.currency;
    let changed = false;

    const balMinor = b.balance.minor;
    if (replaces(bal, balMinor, reportedAt, o)) {
      Object.assign(bal, { minor: balMinor, at: reportedAt, order: o });
      currency = b.balance.currency;
      changed = true;
    }
    if (limits === 'restated' || b.creditLimit !== null) {
      const limMinor = b.creditLimit === null ? null : b.creditLimit.minor;
      if (replaces(lim, limMinor, reportedAt, o)) {
        Object.assign(lim, { minor: limMinor, at: reportedAt, order: o });
        changed = true;
      }
    }
    if (b.goal !== undefined) {
      const goalMinor = b.goal === null ? null : b.goal.minor;
      if (replaces(goal, goalMinor, reportedAt, o)) {
        Object.assign(goal, { minor: goalMinor, at: reportedAt, order: o });
        changed = true;
      }
    }

    if (!changed) {
      kept++;
      continue;
    }
    written++;
    const values = [
      currency,
      text(bal.minor),
      bal.at,
      bal.order,
      text(lim.minor),
      lim.at,
      lim.order,
      text(goal.minor),
      goal.at,
      goal.order,
    ] as const;
    if (row === null) insert.run(b.holdingId, sourceId, ...values);
    else update.run(...values, b.holdingId);
  }
  return { written, kept };
}

export function readBalances(snap: Snapshot, sourceId?: SourceId): HeldBalance[] {
  const rows = (
    sourceId === undefined
      ? snap.db.query(`SELECT ${COLUMNS} FROM holding_balance ORDER BY holding_id`).all()
      : snap.db
          .query(`SELECT ${COLUMNS} FROM holding_balance WHERE source_id = ? ORDER BY holding_id`)
          .all(sourceId)
  ) as BalanceRow[];
  return rows.map((r) => ({
    holdingId: r.holding_id,
    sourceId: r.source_id,
    balance: money(BigInt(r.balance_minor), r.currency),
    reportedAt: r.reported_at,
    creditLimit: r.credit_limit_minor === null ? null : money(BigInt(r.credit_limit_minor), r.currency),
    creditLimitAt: r.credit_limit_at,
    goal: r.goal_minor === null ? null : money(BigInt(r.goal_minor), r.currency),
    goalAt: r.goal_at,
  }));
}
