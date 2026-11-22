// New-since-last-asked family (S-148): lists the unmarked held transactions in scope, oldest-stored
// first up to the snapshot's position, at most the cap the question names, with the count of the
// rest in scope, and hands back as pending exactly the positions it listed. It writes and marks
// nothing: the core marks `pending` after the reply's write completes. Options are checked before
// anything is read.

import { refuse } from '../core/primitives';
import type { Family } from '../core/question';
import { selectTransactions, type TransactionQuery } from '../local/transactions';
import type { MoneyPart } from '../money/context';
import { convertRow, type TransactionRow } from './rows';

export const NEW_CAP_MIN = 1;
export const NEW_CAP_MAX = 100;
export const NEW_CAP_DEFAULT = 20; // fixed, no setting

export interface NewBody {
  readonly rows: readonly TransactionRow[]; // oldest-stored first (ascending position)
  readonly remaining: number; // unmarked transactions in scope, position <= ctx.position, not listed on this page
  readonly cap: number; // the cap applied
}

const OPTION_KEYS = ['cap'] as const;

export function createNewFamily(money: MoneyPart): Family<NewBody> {
  return {
    name: 'new_since_last_asked',
    period: 'none',
    movesPoint: true,
    compute(ctx) {
      const options = ctx.options;
      for (const key of Object.keys(options)) {
        if (!(OPTION_KEYS as readonly string[]).includes(key)) {
          return refuse('bad_option', key, `The new-since-last-asked question takes no option "${key}".`);
        }
      }

      let cap = NEW_CAP_DEFAULT;
      if ('cap' in options) {
        const value = options.cap;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < NEW_CAP_MIN || value > NEW_CAP_MAX) {
          return refuse('bad_option', 'cap', 'The cap must be a whole number from 1 to 100.', String(value));
        }
        cap = value;
      }

      const q: TransactionQuery = {
        holdings: ctx.scope.holdings,
        upToPosition: ctx.position,
        unlistedOnly: true,
        order: 'position',
      };
      const listed = selectTransactions(ctx.snapshot.db, { ...q, limit: cap });
      const remaining = selectTransactions(ctx.snapshot.db, q).length - listed.length;

      const m = money.moneyFor(ctx);
      const converted = listed.map((t) => convertRow(ctx, m, t));
      m.show(converted.map((c) => c.result));
      const rows = converted.map((c) => c.row);
      return {
        kind: 'body',
        body: { rows, remaining, cap },
        pending: listed.map((t) => t.position),
      };
    },
  };
}
