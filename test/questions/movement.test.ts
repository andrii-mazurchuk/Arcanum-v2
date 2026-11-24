// Movement classifier (S-128): classifyMovement over plain MovementFacts objects, the declared kind
// for every row of the table, the rule order where two rules would hold, and incomeThreshold in
// minor units of the account's own currency. From src/families/movement.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Category } from '../../src/local/classifier';
import type { Money } from '../../src/money/money';

const movement = () => import('../../src/families/movement');
const classifierModule = () => import('../../src/local/classifier');
const moneyModule = () => import('../../src/money/money');

// A TransferView-shaped object: only its presence decides the kind, whatever its direction.
const transfer = (direction: 'in' | 'out') => ({ id: 1, direction, otherHolding: 'other', complete: true });

interface Row {
  amount: Money;
  settled?: boolean;
  category: Category;
  description?: string;
  transfer?: ReturnType<typeof transfer> | null;
  cashback?: Money | null;
}

// Plain MovementFacts: settled true, description empty, transfer and cashback null unless stated.
const facts = (r: Row) => ({
  amount: r.amount,
  settled: r.settled ?? true,
  category: r.category,
  description: r.description ?? '',
  transfer: r.transfer ?? null,
  cashback: r.cashback ?? null,
});

describe('families/movement', () => {
  test('classifier table', async () => {
    const { classifyMovement, incomeThreshold } = await movement();
    const { CATEGORIES, UNCATEGORIZED } = await classifierModule();
    const { money } = await moneyModule();

    const G = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
    const U = UNCATEGORIZED;
    const uah = (minor: bigint) => money(minor, 'UAH');

    const table: [Row, string][] = [
      // 1. A pending outgoing hold is spending, not pending.
      [{ amount: uah(-10000n), settled: false, category: G }, 'spending'],
      [{ amount: uah(-500000n), category: U, transfer: transfer('out') }, 'own_transfer'],
      [{ amount: uah(500000n), category: U, transfer: transfer('in') }, 'own_transfer'],
      [{ amount: uah(0n), category: U }, 'none'],
      [{ amount: uah(10000n), settled: false, category: U }, 'pending'],
      [{ amount: uah(1550n), category: U, description: 'Кешбек', cashback: uah(1550n) }, 'cashback'],
      // 7. A reported cashback of another figure is not this movement.
      [{ amount: uah(1550n), category: U, description: 'Кешбек', cashback: uah(1500n) }, 'other_incoming'],
      [{ amount: uah(25000n), category: G, description: 'Повернення коштів' }, 'refund'],
      [{ amount: uah(25000n), category: G, description: 'ВИПЛАТА дивідендів' }, 'income'],
      // 10-12. The threshold is 50000 whole UAH, i.e. 5000000 minor, inclusive.
      [{ amount: uah(5000000n), category: U, description: 'Transfer' }, 'income'],
      [{ amount: uah(4999999n), category: U, description: 'Transfer' }, 'other_incoming'],
      [{ amount: uah(4999999n), category: G, description: 'Transfer' }, 'refund'],
      // 13. JPY has exponent 0: 50000 minor is 50000 whole units.
      [{ amount: money(50000n, 'JPY'), category: U, description: 'Transfer' }, 'income'],
      // 14-15. Stems are matched against the folded description.
      [{ amount: uah(4999999n), category: U, description: 'Monthly SALARY' }, 'income'],
      [{ amount: uah(25000n), category: G, description: 'ВИПЛАТА ДИВІДЕНДІВ' }, 'income'],
    ];
    table.forEach(([row, kind], i) => {
      expect<any>([i + 1, classifyMovement(facts(row) as never)]).toEqual([i + 1, kind]);
    });

    expect(incomeThreshold('UAH' as never)).toBe(5000000n);
    expect(incomeThreshold('JPY' as never)).toBe(50000n);
  });

  test('first rule wins', async () => {
    const { classifyMovement } = await movement();
    const { CATEGORIES, UNCATEGORIZED } = await classifierModule();
    const { money } = await moneyModule();

    const G = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
    const U = UNCATEGORIZED;
    const uah = (minor: bigint) => money(minor, 'UAH');

    const table: [Row, string][] = [
      // 1. Transfer before zero.
      [{ amount: uah(0n), category: U, transfer: transfer('in') }, 'own_transfer'],
      // 2. Transfer before sign.
      [{ amount: uah(-20000n), settled: false, category: U, transfer: transfer('out') }, 'own_transfer'],
      // 3. Zero before settlement.
      [{ amount: uah(0n), settled: false, category: U }, 'none'],
      // 4. Settlement before cashback.
      [{ amount: uah(1550n), settled: false, category: U, cashback: uah(1550n) }, 'pending'],
      // 5. Cashback before income, though the description holds 'зарплат'.
      [{ amount: uah(1550n), category: U, description: 'зарплата', cashback: uah(1550n) }, 'cashback'],
      // 6. Income (over the threshold) before refund.
      [{ amount: uah(6000000n), category: G, description: 'Повернення коштів' }, 'income'],
      // 7. Same minor in another currency is not cashback.
      [{ amount: uah(1550n), category: U, description: 'x', cashback: money(1550n, 'USD') }, 'other_incoming'],
    ];
    table.forEach(([row, kind], i) => {
      expect<any>([i + 1, classifyMovement(facts(row) as never)]).toEqual([i + 1, kind]);
    });
  });
});
