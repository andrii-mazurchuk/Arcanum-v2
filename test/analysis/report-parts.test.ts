// Report parts (S-162): the only figures a report computes itself — the comparison with the previous
// period as differences of gross ledger spending, in total and per category over the union of both
// spans' categories; the per-day average rounded half away from zero; the weekly day with the most
// converted spending on local dates and the single largest converted transaction, both with
// earliest-wins ties; and the fixed no-budgets section. From src/analytics/report-parts over the
// period ledger of src/analytics/ledger and the money part of src/money/context.
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

const reportParts = () => import('../../src/analytics/report-parts');
const ledgerModule = () => import('../../src/analytics/ledger');
const movement = () => import('../../src/families/movement');
const context = () => import('../../src/money/context');
const transactions = () => import('../../src/local/transactions');
const recordedRates = () => import('../../src/money/recorded-rates');
const registerModule = () => import('../../src/core/register');
const classifierModule = () => import('../../src/local/classifier');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const moneyModule = () => import('../../src/money/money');

const NOW = Date.parse('2026-11-21T12:00:00+01:00');
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;

// The week under report and the week before it, at Warsaw midnights.
const W = { from: Date.parse('2026-11-09T00:00:00+01:00'), until: Date.parse('2026-11-16T00:00:00+01:00') };
const P = { from: Date.parse('2026-11-02T00:00:00+01:00'), until: Date.parse('2026-11-09T00:00:00+01:00') };

interface Tx {
  bankId: string;
  holding: string; // the account's bankId
  at: string | number; // ISO instant, or an instant
  amount: Money;
  category: Category;
  description?: string;
}

interface Arrange {
  holdings: { bankId: string; currency: string }[];
  txs: Tx[]; // stored in this order, each at the next position, in one write
}

// Opens a fresh in-memory store with monobank and its accounts registered and the transactions
// stored, settled; no rate is recorded. Runs `body` inside one snapshot on the Warsaw calendar.
async function withStore(a: Arrange, body: (snap: Snapshot, cal: Calendar) => void): Promise<void> {
  const { ensureTransactionSchema, insertTransaction } = await transactions();
  const { ensureRateSchema } = await recordedRates();
  const { narrowingName } = await registerModule();
  const { openStore, MEMORY_LOCATION } = await db();
  const { openCalendar } = await dates();

  const cal = openCalendar(undefined) as Calendar;
  const store = openStore(MEMORY_LOCATION, [ensureTransactionSchema, ensureRateSchema]);
  try {
    store.write((tx: WriteTx) => {
      tx.registerSource(MONO as never);
      for (const h of a.holdings) {
        tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: h.bankId, currency: h.currency } as never);
      }
      for (const t of a.txs) {
        const translated = {
          sourceId: 'monobank',
          bankId: t.bankId,
          holdingId: narrowingName('monobank', 'account', t.holding),
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
        const classified = { category: t.category, merchant: t.description || 'Test' };
        insertTransaction(tx, translated as never, tx.claimPosition(), classified as never);
      }
    });
    store.readSnapshot((snap) => body(snap, cal));
  } finally {
    store.close();
  }
}

// A hand-built question context over the whole register (unnarrowed scope) at NOW, display PLN.
const ctxFor = (
  resolveScope: (reg: any, narrowing: string | undefined) => unknown,
  snap: Snapshot,
  cal: Calendar,
): QuestionContext => {
  const reg = snap.register();
  return {
    snapshot: snap,
    now: NOW,
    settings: { timeZone: undefined, sources: ['monobank'] },
    calendar: cal,
    displayCurrency: 'PLN',
    position: snap.position(),
    register: reg,
    scope: resolveScope(reg, undefined),
    period: null,
    asker: 'command_line',
    options: {},
  } as unknown as QuestionContext;
};

describe('analytics/report-parts', () => {
  test('report parts: comparison, per day, no budgets', async () => {
    const { compareSpending, averagePerDay, NO_BUDGETS } = await reportParts();
    const { buildLedger } = await ledgerModule();
    const { classifyMovement } = await movement();
    const { createMoneyPart } = await context();
    const { selectTransactions } = await transactions();
    const { resolveScope } = await registerModule();
    const { CATEGORIES } = await classifierModule();
    const { money } = await moneyModule();

    const G = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
    const F = CATEGORIES.find((c) => c === 'Fast Food') as Category;
    const pln = (minor: bigint) => money(minor, 'PLN');
    const part = createMoneyPart([MONO] as never);

    await withStore(
      {
        holdings: [{ bankId: 'P', currency: 'PLN' }],
        txs: [
          { bankId: 'w1', holding: 'P', at: '2026-11-10T12:00:00+01:00', amount: pln(-47000n), category: G },
          { bankId: 'w2', holding: 'P', at: '2026-11-11T12:00:00+01:00', amount: pln(-3000n), category: F },
          { bankId: 'wr', holding: 'P', at: '2026-11-12T12:00:00+01:00', amount: pln(2000n), category: G },
          { bankId: 'p1', holding: 'P', at: '2026-11-03T12:00:00+01:00', amount: pln(-40000n), category: G },
        ],
      },
      (snap, cal) => {
        // Precondition: the +2000 on groceries is a refund, not spending or income.
        const held = selectTransactions(snap.db, { order: 'position' });
        expect(classifyMovement(held.find((t) => t.bankId === 'wr')! as never)).toBe('refund');

        const ctx = ctxFor(resolveScope, snap, cal);
        const ledger = buildLedger(ctx, part.moneyFor(ctx), [W, P]);

        // Catches spending net of refunds (48000 and 8000) and previous minus current (-10000).
        const c = compareSpending(ledger, W, P);
        expect(c.current).toEqual(pln(50000n));
        expect(c.previous).toEqual(pln(40000n));
        expect(c.difference).toEqual(pln(10000n));

        // Catches categories in read order, a refund netted into groceries (45000), and an absent
        // previous side left undefined instead of 0.
        const expected = [
          { category: G, current: pln(47000n), previous: pln(40000n), difference: pln(7000n) },
          { category: F, current: pln(3000n), previous: pln(0n), difference: pln(3000n) },
        ].sort((x, y) => CATEGORIES.indexOf(x.category) - CATEGORIES.indexOf(y.category));
        expect(c.byCategory).toEqual(expected);

        // The sign follows the arguments: current minus previous.
        const back = compareSpending(ledger, P, W);
        expect(back.difference).toEqual(pln(-10000n));

        // Catches byCategory over the current span's keys only: with P current, Fast Food exists
        // only in the previous span and must still appear, at current 0.
        const backFast = back.byCategory.find((x) => x.category === F);
        expect(backFast).toEqual({ category: F, current: pln(0n), previous: pln(3000n), difference: pln(-3000n) });
      },
    );

    // 70001 / 7 = 10000.14 -> 10000; 10001 / 2 = 5000.5 -> 5001 half away from zero (catches
    // truncation, 5000); no days -> null (catches a throw or a division by zero).
    expect(averagePerDay(pln(70001n), 7)).toEqual(pln(10000n));
    expect(averagePerDay(pln(10001n), 2)).toEqual(pln(5001n));
    expect(averagePerDay(pln(5n), 0)).toBeNull();

    // Catches any wording or flag other than the fixed section.
    expect(NO_BUDGETS).toEqual({ set: false, text: 'No budgets are set; there is no way to set one.' });
  });

  test('report parts: top day and largest transaction', async () => {
    const { topDay, largestTransaction } = await reportParts();
    const { buildLedger } = await ledgerModule();
    const { createMoneyPart } = await context();
    const { resolveScope } = await registerModule();
    const { CATEGORIES } = await classifierModule();
    const { money } = await moneyModule();

    const G = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
    const pln = (minor: bigint) => money(minor, 'PLN');
    const usd = (minor: bigint) => money(minor, 'USD');
    const part = createMoneyPart([MONO] as never);
    const holdings = [
      { bankId: 'P', currency: 'PLN' },
      { bankId: 'U', currency: 'USD' },
    ];
    const s = W;

    const storeA: Tx[] = [
      { bankId: 'a1', holding: 'P', at: '2026-11-10T12:00:00+01:00', amount: pln(-12000n), category: G },
      { bankId: 'a2', holding: 'P', at: '2026-11-12T12:00:00+01:00', amount: pln(-12000n), category: G },
      { bankId: 'au', holding: 'U', at: '2026-11-13T12:00:00+01:00', amount: usd(-99999n), category: G },
    ];

    // Store A: two equal days; the earliest wins. The unconverted USD line decides nothing.
    await withStore({ holdings, txs: storeA }, (snap, cal) => {
      const ctx = ctxFor(resolveScope, snap, cal);
      const ledger = buildLedger(ctx, part.moneyFor(ctx), [s]);
      // Precondition: no USD rate is held, so the USD line has no figure.
      expect(ledger.lines(s, 'spending').find((l) => l.tx.bankId === 'au')!.figure).toBeNull();

      // Catches latest-wins ties ('2026-11-12') and ranking by original amount across currencies.
      expect(topDay(ledger, cal, s)).toEqual({ day: '2026-11-10', spending: pln(12000n) });

      // Catches the 99999 USD line ranked largest by its original amount, and latest-wins ties.
      const largest = largestTransaction(ledger, cal, s)!;
      expect(largest).not.toBeNull();
      expect(largest.line.tx.bankId).toBe('a1');
      expect(largest.line.figure).toEqual(pln(12000n));
    });

    // Store B: 23:30 UTC on 11-11 is 00:30 on 11-12 in Warsaw, so 11-12 holds 20000.
    const late = Date.parse('2026-11-11T23:30:00Z');
    await withStore(
      {
        holdings,
        txs: [...storeA, { bankId: 'b1', holding: 'P', at: late, amount: pln(-8000n), category: G }],
      },
      (snap, cal) => {
        expect(cal.localDay(late)).toBe('2026-11-12');
        const ctx = ctxFor(resolveScope, snap, cal);
        const ledger = buildLedger(ctx, part.moneyFor(ctx), [s]);
        // Catches lines placed on their UTC date: 11-12 at 12000 ties 11-10 and answers 11-10.
        expect(topDay(ledger, cal, s)).toEqual({ day: '2026-11-12', spending: pln(20000n) });
      },
    );

    // Store C: equal largest figures; the earlier instant wins although it was stored second.
    await withStore(
      {
        holdings,
        txs: [
          { bankId: 'c10', holding: 'P', at: '2026-11-10T10:00:00+01:00', amount: pln(-25000n), category: G },
          { bankId: 'c09', holding: 'P', at: '2026-11-10T09:00:00+01:00', amount: pln(-25000n), category: G },
          { bankId: 'c11', holding: 'P', at: '2026-11-11T09:00:00+01:00', amount: pln(-9000n), category: G },
        ],
      },
      (snap, cal) => {
        const ctx = ctxFor(resolveScope, snap, cal);
        const ledger = buildLedger(ctx, part.moneyFor(ctx), [s]);
        // Catches latest-wins ties and ties broken by storage order alone (both pick the 10:00 line).
        const largest = largestTransaction(ledger, cal, s)!;
        expect(largest).not.toBeNull();
        expect(largest.line.tx.bankId).toBe('c09');
        expect(largest.line.at).toBe(Date.parse('2026-11-10T09:00:00+01:00'));
        expect(largest.localDateTime).toBe(cal.localDateTime(largest.line.at));
      },
    );

    // Store D: equal figures at the same instant; the smaller storage position wins.
    await withStore(
      {
        holdings,
        txs: [
          { bankId: 'dp', holding: 'P', at: '2026-11-10T09:00:00+01:00', amount: pln(-25000n), category: G },
          { bankId: 'dq', holding: 'P', at: '2026-11-10T09:00:00+01:00', amount: pln(-25000n), category: G },
        ],
      },
      (snap, cal) => {
        const ctx = ctxFor(resolveScope, snap, cal);
        const ledger = buildLedger(ctx, part.moneyFor(ctx), [s]);
        const lines = ledger.lines(s, 'spending');
        const p = lines.find((l) => l.tx.bankId === 'dp')!.tx.position;
        const q = lines.find((l) => l.tx.bankId === 'dq')!.tx.position;
        expect(p).toBeLessThan(q);
        // Catches the later position winning the tie.
        const largest = largestTransaction(ledger, cal, s)!;
        expect(largest).not.toBeNull();
        expect(largest.line.tx.position).toBe(p);
        expect(largest.line.tx.bankId).toBe('dp');
      },
    );

    // Store E: only an unconverted line; neither exists.
    await withStore(
      {
        holdings,
        txs: [{ bankId: 'eu', holding: 'U', at: '2026-11-13T12:00:00+01:00', amount: usd(-99999n), category: G }],
      },
      (snap, cal) => {
        const ctx = ctxFor(resolveScope, snap, cal);
        const ledger = buildLedger(ctx, part.moneyFor(ctx), [s]);
        expect(ledger.lines(s, 'spending').length).toBe(1);
        // Catches ranking by original amount: a top day of 99999 and the USD line as largest.
        expect(topDay(ledger, cal, s)).toBeNull();
        expect(largestTransaction(ledger, cal, s)).toBeNull();
      },
    );

    // An empty store: no spending line at all.
    await withStore({ holdings, txs: [] }, (snap, cal) => {
      const ctx = ctxFor(resolveScope, snap, cal);
      const ledger = buildLedger(ctx, part.moneyFor(ctx), [s]);
      expect(topDay(ledger, cal, s)).toBeNull();
      expect(largestTransaction(ledger, cal, s)).toBeNull();
    });
  });
});
