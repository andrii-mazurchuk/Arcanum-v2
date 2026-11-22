// Health family (S-167): signals and score over one measured month and its as-at instant — low
// savings, high discretionary spending, unusually high categories, high cash use and stagnant goal
// jars, each with severity, figure, threshold, explanation and recommendation — and the fixed
// deduction table floored at 0. From src/analysis/health over the period ledger of
// src/analytics/ledger, the held balances of src/sync/balances and the money part of
// src/money/context.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { QuestionContext } from '../../src/core/question';
import type { Snapshot, WriteTx } from '../../src/db/index';
import type { Category } from '../../src/local/classifier';
import type { Money } from '../../src/money/money';

const health = () => import('../../src/analysis/health');
const signalsModule = () => import('../../src/analytics/signals');
const movement = () => import('../../src/families/movement');
const context = () => import('../../src/money/context');
const transactions = () => import('../../src/local/transactions');
const recordedRates = () => import('../../src/money/recorded-rates');
const balancesModule = () => import('../../src/sync/balances');
const registerModule = () => import('../../src/core/register');
const classifierModule = () => import('../../src/local/classifier');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const moneyModule = () => import('../../src/money/money');

const NOW = Date.parse('2026-11-21T12:00:00+01:00');
// The end of October 2026 in Warsaw: the as-at instant of the last complete month asked at NOW.
const AS_AT = Date.parse('2026-11-01T00:00:00+01:00');
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const REPORTED_AT = '2026-11-20T08:00:00+01:00';

interface Tx {
  bankId: string;
  holding: string; // the monobank holding's bankId
  at: string | number; // ISO instant, or an instant
  amount: Money;
  category?: Category; // default Uncategorized
  description?: string;
}

interface Held {
  jar: string; // the monobank jar's bankId
  balance: Money;
  goal: Money | null;
}

interface Arrange {
  holdings: { kind: 'account' | 'jar'; bankId: string; currency: string }[];
  txs: Tx[]; // stored in this order, each at the next position, in one write
  transfers?: [outBankId: string, inBankId: string][]; // linked as one own transfer each
  balances?: Held[]; // reported by monobank at REPORTED_AT
}

// Opens a fresh in-memory store with monobank and its holdings registered, the transactions stored
// settled and linked, no rate recorded, and the jar balances held; runs `body` inside one snapshot
// on the Warsaw calendar.
async function withStore(a: Arrange, body: (snap: Snapshot, cal: Calendar) => void): Promise<void> {
  const { ensureTransactionSchema, insertTransaction, createTransfer } = await transactions();
  const { ensureRateSchema } = await recordedRates();
  const { ensureBalanceSchema, recordBalances } = await balancesModule();
  const { narrowingName } = await registerModule();
  const { UNCATEGORIZED } = await classifierModule();
  const { openStore, MEMORY_LOCATION } = await db();
  const { openCalendar } = await dates();

  const cal = openCalendar('Europe/Warsaw') as Calendar;
  const store = openStore(MEMORY_LOCATION, [ensureTransactionSchema, ensureRateSchema, ensureBalanceSchema]);
  const kindOf = new Map(a.holdings.map((h) => [h.bankId, h.kind]));
  const holdingOf = (bankId: string) => narrowingName('monobank', kindOf.get(bankId)!, bankId);
  try {
    store.write((tx: WriteTx) => {
      tx.registerSource(MONO as never);
      for (const h of a.holdings) {
        tx.registerHolding({ kind: h.kind, sourceId: 'monobank', bankId: h.bankId, currency: h.currency } as never);
      }
      for (const t of a.txs) {
        const translated = {
          sourceId: 'monobank',
          bankId: t.bankId,
          holdingId: holdingOf(t.holding),
          occurredAt: typeof t.at === 'number' ? t.at : Date.parse(t.at),
          amount: t.amount,
          originalAmount: null,
          cashback: null,
          settled: true,
          mcc: null,
          originalMcc: null,
          merchantText: null,
          description: t.description ?? '',
          comment: null,
          counterpart: null,
        };
        const classified = { category: t.category ?? UNCATEGORIZED, merchant: t.description || 'Test' };
        insertTransaction(tx, translated as never, tx.claimPosition(), classified as never);
      }
      for (const [outId, inId] of a.transfers ?? []) {
        const out = a.txs.find((t) => t.bankId === outId)!;
        const inn = a.txs.find((t) => t.bankId === inId)!;
        createTransfer(tx, holdingOf(out.holding), holdingOf(inn.holding), 1, [
          { sourceId: 'monobank', bankId: outId },
          { sourceId: 'monobank', bankId: inId },
        ]);
      }
      for (const b of a.balances ?? []) {
        const reported = { holdingId: holdingOf(b.jar), balance: b.balance, creditLimit: null, goal: b.goal };
        recordBalances(tx, 'monobank', [reported as never], Date.parse(REPORTED_AT), 'restated');
      }
    });
    store.readSnapshot((snap) => body(snap, cal));
  } finally {
    store.close();
  }
}

// A hand-built question context at NOW over the whole register (unnarrowed scope), display UAH,
// with `options`; a fresh object on every call.
const ctxFor = (
  resolveScope: (reg: any, narrowing: string | undefined) => unknown,
  snap: Snapshot,
  cal: Calendar,
  options: Record<string, unknown> = {},
): QuestionContext => {
  const reg = snap.register();
  return {
    snapshot: snap,
    now: NOW,
    settings: { timeZone: 'Europe/Warsaw', sources: ['monobank'] },
    calendar: cal,
    displayCurrency: 'UAH',
    position: snap.position(),
    register: reg,
    scope: resolveScope(reg, undefined),
    period: null,
    asker: 'command_line',
    options,
  } as unknown as QuestionContext;
};

// The 10th of each month at 12:00 Warsaw time (summer time until 2026-10-25).
const OFFSETS: Record<string, string> = { '07': '+02:00', '08': '+02:00', '09': '+02:00', '10': '+02:00', '11': '+01:00' };
const tenth = (month: string) => `2026-${month}-10T12:00:00${OFFSETS[month]}`;

// One own transfer from A to `jar` at `at`: the A side out, the jar side in.
const topUp = (
  txs: Tx[],
  transfers: [string, string][],
  jar: string,
  at: string | number,
  amount: (minor: bigint) => Money,
  minor: bigint,
) => {
  txs.push({ bankId: `${jar}-o`, holding: 'A', at, amount: amount(-minor) });
  txs.push({ bankId: `${jar}-i`, holding: jar, at, amount: amount(minor) });
  transfers.push([`${jar}-o`, `${jar}-i`]);
};

const row = (s: any) => [s.name, s.severity, s.subject, s.figure, s.threshold, s.deduction];

describe('analysis/health', () => {
  test('health: worked October', async () => {
    const { createHealthFamily } = await health();
    const { classifyMovement } = await movement();
    const { createMoneyPart } = await context();
    const { selectTransactions } = await transactions();
    const { resolveScope, narrowingName } = await registerModule();
    const { CATEGORIES } = await classifierModule();
    const { money } = await moneyModule();

    const uah = (minor: bigint) => money(minor, 'UAH');
    const FF = 'Fast Food' as Category;
    const ATM = 'ATM & Cash' as Category;
    const G = 'Groceries & Supermarkets' as Category;
    const J1 = narrowingName('monobank', 'jar', 'J1');
    const J4 = narrowingName('monobank', 'jar', 'J4');
    const family = createHealthFamily(createMoneyPart([MONO] as never));

    const txs: Tx[] = [];
    const spend = (month: string, category: Category, minor: bigint) =>
      txs.push({ bankId: `${month}-${category}`, holding: 'A', at: tenth(month), amount: uah(-minor), category });
    spend('07', FF, 12000n);
    spend('07', ATM, 4000n);
    spend('07', G, 30000n);
    for (const m of ['08', '09']) {
      spend(m, ATM, 4000n);
      spend(m, G, 30000n);
    }
    spend('10', FF, 36003n);
    spend('10', ATM, 9001n);
    spend('10', G, 45001n);
    txs.push({ bankId: 'salary', holding: 'A', at: tenth('10'), amount: uah(100000n), description: 'Salary' });
    const transfers: [string, string][] = [];
    topUp(txs, transfers, 'J1', '2026-09-20T12:00:00+02:00', uah, 10000n);
    topUp(txs, transfers, 'J2', '2026-10-15T12:00:00+02:00', uah, 10000n);

    await withStore(
      {
        holdings: [
          { kind: 'account', bankId: 'A', currency: 'UAH' },
          { kind: 'jar', bankId: 'J1', currency: 'UAH' },
          { kind: 'jar', bankId: 'J2', currency: 'UAH' },
          { kind: 'jar', bankId: 'J3', currency: 'UAH' },
          { kind: 'jar', bankId: 'J4', currency: 'UAH' },
          { kind: 'jar', bankId: 'J5', currency: 'UAH' },
        ],
        txs,
        transfers,
        balances: [
          { jar: 'J1', balance: uah(300000n), goal: uah(1000000n) },
          { jar: 'J2', balance: uah(100000n), goal: uah(500000n) },
          { jar: 'J3', balance: uah(50000n), goal: uah(0n) },
          { jar: 'J4', balance: uah(0n), goal: uah(200000n) },
        ],
      },
      (snap, cal) => {
        // Preconditions: the salary is income; the A side of each top-up is an own transfer.
        const held = selectTransactions(snap.db, { order: 'position' });
        const kind = (id: string) => classifyMovement(held.find((t) => t.bankId === id)! as never);
        expect(kind('salary')).toBe('income');
        expect(kind('J1-o')).toBe('own_transfer');
        expect(kind('J2-o')).toBe('own_transfer');

        const out = family.compute(ctxFor(resolveScope, snap, cal)) as any;
        expect(out.kind).toBe('body');
        const body = out.body;

        // Catches measuring the month in progress (November), which finds no spending at all.
        expect(body.month).toEqual({ label: '2026-10', firstDay: '2026-10-01', lastDay: '2026-10-31', partial: false });
        expect(body.asAt).toEqual({ instant: AS_AT, localDateTime: cal.localDateTime(AS_AT) });

        const stagnant = 'no top-up in the 30 days to ' + cal.localDateTime(AS_AT);
        const spikeFirst = CATEGORIES.indexOf(FF) < CATEGORIES.indexOf(ATM);
        expect(spikeFirst).toBe(true);
        expect(body.signals.map(row)).toEqual([
          // T = 90005; (100000 - 90005) x 1000 / 100000 = 99.95 tenths -> 10.0%. Catches judging
          // the exact 9.995% as below 10%: 'alert', deduction 30.
          ['low_savings_rate', 'warning', null, '10.0%', '20.0%', 15],
          // D x 5 = 180015 > T x 2 = 180010; catches a threshold not strictly at 40%.
          ['high_discretionary_spending', 'warning', null, '40.0%', '40%', 10],
          // 36003 x 3 / 12000 = 9.00075; 9001 x 3 / 12000 = 2.25025. CATEGORIES order.
          ['unusually_high_category', 'alert', FF, '9.00 times', '3 times', 10],
          ['unusually_high_category', 'warning', ATM, '2.25 times', '2 times', 5],
          // C x 10 = 90010 > 90005.
          ['high_cash_use', 'info', null, '10.0%', '10%', 5],
          // J2's 2026-10-15 top-up keeps it; catches J3 (goal 0) or J5 (no balance row) judged.
          ['stagnant_jar', 'warning', J1, stagnant, '30 days', 5],
          ['stagnant_jar', 'warning', J4, stagnant, '30 days', 5],
        ]);

        // Groceries is only elevated, which raises nothing: 2 x 45001 x 3 = 270006 >= 3 x 90000,
        // while 45001 x 3 = 135003 < 2 x 90000 keeps it below high.
        expect(body.signals.some((s: any) => s.subject === G)).toBe(false);

        // 15 + 10 + 10 + 5 + 5 + 5 + 5 = 55. Catches J3 or J5 stagnant (40), the savings alert (30).
        expect(body.score).toBe(45);
        expect(body.jarsNotOffered).toEqual([]);

        for (const s of body.signals) {
          expect(typeof s.explanation).toBe('string');
          expect(s.explanation.length).toBeGreaterThan(0);
          expect(typeof s.recommendation).toBe('string');
          expect(s.recommendation.length).toBeGreaterThan(0);
        }
      },
    );
  });

  test('health: strict thresholds', async () => {
    const { createHealthFamily, DEDUCTIONS } = await health();
    const { STAGNANT_WINDOW_MS } = await signalsModule();
    const { createMoneyPart } = await context();
    const { resolveScope, narrowingName } = await registerModule();
    const { money } = await moneyModule();

    const uah = (minor: bigint) => money(minor, 'UAH');
    const J = narrowingName('monobank', 'jar', 'J');
    const part = createMoneyPart([MONO] as never);
    const family = createHealthFamily(part);

    expect(family.name).toBe('health_signals');
    expect(family.period).toBe('none');
    expect(family.movesPoint).toBe(false);
    expect(DEDUCTIONS).toEqual({
      low_savings_alert: 30,
      low_savings_warning: 15,
      high_discretionary_spending: 10,
      spike_category: 10,
      high_category: 5,
      high_cash_use: 5,
      stagnant_jar: 5,
    });

    // October spending in three categories and J's single top-up at `topUpAt`; no income.
    const arrange = (ff: bigint, atm: bigint, g: bigint, topUpAt: number): Arrange => {
      const txs: Tx[] = [
        { bankId: 'ff', holding: 'A', at: tenth('10'), amount: uah(-ff), category: 'Fast Food' },
        { bankId: 'atm', holding: 'A', at: tenth('10'), amount: uah(-atm), category: 'ATM & Cash' },
        { bankId: 'g', holding: 'A', at: tenth('10'), amount: uah(-g), category: 'Groceries & Supermarkets' },
      ];
      const transfers: [string, string][] = [];
      topUp(txs, transfers, 'J', topUpAt, uah, 10000n);
      return {
        holdings: [
          { kind: 'account', bankId: 'A', currency: 'UAH' },
          { kind: 'jar', bankId: 'J', currency: 'UAH' },
        ],
        txs,
        transfers,
        balances: [{ jar: 'J', balance: uah(0n), goal: uah(100000n) }],
      };
    };

    // Store 1: D = 4000 of T = 10000 is exactly 40%, C = 1000 exactly 10%, and the top-up lies on
    // the closed lower bound of the stretch. Catches >= in place of > (score 85), no income read as
    // a 0% savings rate (an alert), and an open lower bound (stagnant_jar raised).
    await withStore(arrange(4000n, 1000n, 5000n, AS_AT - STAGNANT_WINDOW_MS), (snap, cal) => {
      const out = family.compute(ctxFor(resolveScope, snap, cal)) as any;
      expect(out.kind).toBe('body');
      expect(out.body.signals).toEqual([]);
      expect(out.body.score).toBe(100);
    });

    // Store 2: 40.01% and 10.01%, both shown to one decimal; the top-up 1 ms before the stretch.
    await withStore(arrange(4001n, 1001n, 4998n, AS_AT - STAGNANT_WINDOW_MS - 1), (snap, cal) => {
      const out = family.compute(ctxFor(resolveScope, snap, cal)) as any;
      expect(out.kind).toBe('body');
      expect(out.body.signals.map((s: any) => [s.name, s.subject, s.figure, s.deduction])).toEqual([
        ['high_discretionary_spending', null, '40.0%', 10],
        ['high_cash_use', null, '10.0%', 5],
        ['stagnant_jar', J, 'no top-up in the 30 days to ' + cal.localDateTime(AS_AT), 5],
      ]);
      expect(out.body.score).toBe(80);

      // Any option is refused, returned rather than thrown.
      const bad = family.compute(ctxFor(resolveScope, snap, cal, { x: 1 })) as any;
      expect([bad.kind, bad.reason, bad.subject]).toEqual(['refused', 'bad_option', 'x']);
    });
  });

  test('health: score floor', async () => {
    const { createHealthFamily } = await health();
    const { classifyMovement } = await movement();
    const { createMoneyPart } = await context();
    const { selectTransactions } = await transactions();
    const { resolveScope } = await registerModule();
    const { CATEGORIES } = await classifierModule();
    const { money } = await moneyModule();

    const uah = (minor: bigint) => money(minor, 'UAH');
    const family = createHealthFamily(createMoneyPart([MONO] as never));
    const discretionary: Category[] = [
      'Restaurants & Cafes',
      'Fast Food',
      'Entertainment',
      'Fitness & Sport',
      'Clothing & Apparel',
      'Shopping',
    ];
    const seven: Category[] = [...discretionary, 'ATM & Cash'];

    const txs: Tx[] = [];
    for (const c of seven) txs.push({ bankId: `09-${c}`, holding: 'A', at: tenth('09'), amount: uah(-1000n), category: c });
    for (const c of discretionary) {
      txs.push({ bankId: `10-${c}`, holding: 'A', at: tenth('10'), amount: uah(-10000n), category: c });
    }
    txs.push({ bankId: '10-cash', holding: 'A', at: tenth('10'), amount: uah(-35000n), category: 'ATM & Cash' });
    txs.push({ bankId: 'salary', holding: 'A', at: tenth('10'), amount: uah(100000n), description: 'Salary' });

    await withStore({ holdings: [{ kind: 'account', bankId: 'A', currency: 'UAH' }], txs }, (snap, cal) => {
      const held = selectTransactions(snap.db, { order: 'position' });
      expect(classifyMovement(held.find((t) => t.bankId === 'salary')! as never)).toBe('income');

      const out = family.compute(ctxFor(resolveScope, snap, cal)) as any;
      expect(out.kind).toBe('body');
      const signals = out.body.signals as any[];

      // (100000 - 95000) / 100000 = 5.0%: below 10%, an alert.
      const savings = signals.filter((s) => s.name === 'low_savings_rate');
      expect(savings.map(row)).toEqual([['low_savings_rate', 'alert', null, '5.0%', '10.0%', 30]]);

      // 60000 x 5 > 95000 x 2.
      expect(signals.filter((s) => s.name === 'high_discretionary_spending').length).toBe(1);

      // Each x x 3 >= 3 x 1000: seven spikes, one deduction each, in CATEGORIES order. Catches one
      // spike deduction however many categories spike (score 45).
      const spikes = signals.filter((s) => s.name === 'unusually_high_category');
      const ordered = [...seven].sort((a, b) => CATEGORIES.indexOf(a) - CATEGORIES.indexOf(b));
      expect(spikes.map((s) => [s.subject, s.severity, s.deduction])).toEqual(ordered.map((c) => [c, 'alert', 10]));

      // 35000 x 10 > 95000.
      expect(signals.filter((s) => s.name === 'high_cash_use').length).toBe(1);

      // 30 + 10 + 70 + 5 = 115; catches 100 minus the sum without a floor (-15).
      expect(signals.reduce((sum, s) => sum + s.deduction, 0)).toBe(115);
      expect(out.body.score).toBe(0);
    });
  });
});
