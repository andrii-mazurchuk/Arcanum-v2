// Jar activity (S-166): the jars in scope by the jars capability split, the one has-a-goal
// predicate, per-jar and total top-ups over a span from the period ledger's jar lines (S-156), the
// 3-month average window that never holds a partial month, the average monthly top-up and the
// months-to-goal integer rule on exact jar-currency minor units. From src/analysis/jar-activity
// over the ledger of src/analytics/ledger and the held balances of src/sync/balances.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { QuestionContext } from '../../src/core/question';
import type { Snapshot, WriteTx } from '../../src/db/index';
import type { Money } from '../../src/money/money';

const jarActivity = () => import('../../src/analysis/jar-activity');
const ledgerModule = () => import('../../src/analytics/ledger');
const periods = () => import('../../src/analytics/periods');
const jarsFamily = () => import('../../src/families/jars');
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
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const S2 = { id: 's2', capabilities: [] } as const; // declares no 'jars' capability

interface Holding {
  sourceId?: string; // default monobank
  kind: 'account' | 'jar';
  bankId: string;
  currency: string;
}

interface Tx {
  bankId: string;
  holding: string; // the monobank holding's bankId
  at: string; // ISO instant
  amount: Money;
}

interface Held {
  jar: string; // the monobank jar's bankId
  balance: Money;
  goal: Money | null;
  reportedAt: string;
}

interface Arrange {
  sources: readonly { id: string; capabilities: readonly string[] }[];
  holdings: Holding[];
  txs: Tx[]; // stored in this order, each at the next position, in one write
  transfers?: [outBankId: string, inBankId: string][]; // linked as one own transfer each
  balances?: Held[]; // reported by monobank
}

// Opens a fresh in-memory store with the sources and holdings registered, the monobank transactions
// stored and linked, no rate recorded, and the jar balances held; runs `body` inside one snapshot
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
  const kindOf = new Map(a.holdings.filter((h) => h.sourceId === undefined).map((h) => [h.bankId, h.kind]));
  const holdingOf = (bankId: string) => narrowingName('monobank', kindOf.get(bankId)!, bankId);
  try {
    store.write((tx: WriteTx) => {
      for (const s of a.sources) tx.registerSource(s as never);
      for (const h of a.holdings) {
        tx.registerHolding({
          kind: h.kind,
          sourceId: h.sourceId ?? 'monobank',
          bankId: h.bankId,
          currency: h.currency,
        } as never);
      }
      for (const t of a.txs) {
        const translated = {
          sourceId: 'monobank',
          bankId: t.bankId,
          holdingId: holdingOf(t.holding),
          occurredAt: Date.parse(t.at),
          amount: t.amount,
          originalAmount: null,
          cashback: null,
          settled: true,
          mcc: null,
          originalMcc: null,
          merchantText: null,
          description: '',
          comment: null,
          counterpart: null,
        };
        insertTransaction(tx, translated as never, tx.claimPosition(), {
          category: UNCATEGORIZED,
          merchant: 'Test',
        } as never);
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
        recordBalances(tx, 'monobank', [reported as never], Date.parse(b.reportedAt), 'restated');
      }
    });
    store.readSnapshot((snap) => body(snap, cal));
  } finally {
    store.close();
  }
}

// A hand-built question context at NOW over the whole register (unnarrowed scope); a fresh object
// on every call. Takes resolveScope from the register module, already imported, so that it can run
// inside the synchronous snapshot body.
const ctxFor = (
  resolveScope: (reg: any, narrowing: string | undefined) => unknown,
  snap: Snapshot,
  cal: Calendar,
  display: string,
  sources: string[],
): QuestionContext => {
  const reg = snap.register();
  return {
    snapshot: snap,
    now: NOW,
    settings: { timeZone: undefined, sources },
    calendar: cal,
    displayCurrency: display,
    position: snap.position(),
    register: reg,
    scope: resolveScope(reg, undefined),
    period: null,
    asker: 'command_line',
    options: {},
  } as unknown as QuestionContext;
};

const figures = (t: any) => ({ count: t.count, sum: t.sum, shown: t.shown, notConverted: t.notConverted });

describe('analysis/jar-activity', () => {
  test('jar activity: goal, months to goal, window', async () => {
    const { hasGoal, monthsToGoal, averageWindow } = await jarActivity();
    const { monthPeriod, currentMonth } = await periods();
    const { openCalendar } = await dates();
    const { money } = await moneyModule();

    const u = (minor: bigint) => money(minor, 'UAH');

    // The one has-a-goal predicate: set exactly when not null and above zero.
    expect(hasGoal(null)).toBe(false);
    expect(hasGoal(u(0n))).toBe(false);
    expect(hasGoal(u(1n))).toBe(true);
    expect(hasGoal(u(400000n))).toBe(true);
    expect(hasGoal(u(-5n))).toBe(false);

    // Gap 600000, x 3 = 1800000: 6 x 300000 = 1800000 exactly.
    expect(monthsToGoal(u(1000000n), u(400000n), 300000n)).toEqual({ kind: 'months', months: 6n });
    // Catches floor instead of ceiling: 6 x 290000 = 1740000 < 1800000, so 7, not 6.
    expect(monthsToGoal(u(1000000n), u(400000n), 290000n)).toEqual({ kind: 'months', months: 7n });
    expect(monthsToGoal(u(1000000n), u(400000n), 420000n)).toEqual({ kind: 'months', months: 5n });
    // Catches dividing the gap by the rounded average: 100002 / 33334 = 3, while
    // 3 x 100001 = 300003 < 300006 makes the exact answer 4.
    expect(monthsToGoal(u(500002n), u(400000n), 100001n)).toEqual({ kind: 'months', months: 4n });

    expect(monthsToGoal(u(1000000n), u(1000000n), 0n)).toEqual({ kind: 'reached' });
    expect(monthsToGoal(u(1000000n), u(1200000n), 300000n)).toEqual({ kind: 'reached' });
    expect(monthsToGoal(u(1000000n), u(400000n), 0n)).toEqual({ kind: 'not_estimable' });

    expect(monthsToGoal(null, u(400000n), 300000n)).toEqual({ kind: 'no_goal' });
    expect(monthsToGoal(u(0n), u(400000n), 300000n)).toEqual({ kind: 'no_goal' });
    // Catches the balance checked before the goal: no_balance.
    expect(monthsToGoal(null, null, 0n)).toEqual({ kind: 'no_goal' });
    expect(monthsToGoal(u(1000000n), null, 300000n)).toEqual({ kind: 'no_balance' });

    const cal = openCalendar('Europe/Warsaw') as Calendar;
    const labels = (ps: readonly { label: string }[]) => ps.map((p) => p.label);

    const oct = averageWindow(cal, monthPeriod(cal, '2026-10', NOW), NOW);
    expect(labels(oct)).toEqual(['2026-08', '2026-09', '2026-10']);
    // Catches a window holding the partial month: ['2026-09', '2026-10', '2026-11'].
    const nov = averageWindow(cal, currentMonth(cal, NOW), NOW);
    expect(labels(nov)).toEqual(['2026-08', '2026-09', '2026-10']);
    const jan = averageWindow(cal, monthPeriod(cal, '2026-01', NOW), NOW);
    expect(labels(jan)).toEqual(['2025-11', '2025-12', '2026-01']);
    for (const p of [...oct, ...nov, ...jan]) expect(p.partial).toBe(false);
  });

  test('jar activity: top-ups in a span', async () => {
    const { jarScope, topUpsIn } = await jarActivity();
    const { buildLedger } = await ledgerModule();
    const { createMoneyPart } = await context();
    const { resolveScope, narrowingName } = await registerModule();
    const { money } = await moneyModule();

    const uah = (minor: bigint) => money(minor, 'UAH');
    const usd = (minor: bigint) => money(minor, 'USD');
    const J1 = narrowingName('monobank', 'jar', 'J1');
    const J2 = narrowingName('monobank', 'jar', 'J2');
    const J3 = narrowingName('monobank', 'jar', 'J3');
    const part = createMoneyPart([MONO, S2] as never);

    await withStore(
      {
        sources: [MONO, S2],
        holdings: [
          { kind: 'account', bankId: 'A', currency: 'UAH' },
          { kind: 'jar', bankId: 'J1', currency: 'UAH' },
          { kind: 'jar', bankId: 'J2', currency: 'USD' },
          { kind: 'jar', bankId: 'J3', currency: 'UAH' },
          { sourceId: 's2', kind: 'account', bankId: 'X', currency: 'UAH' },
        ],
        txs: [
          { bankId: 'early', holding: 'J1', at: '2026-11-05T12:00:00+01:00', amount: uah(9000n) },
          { bankId: 'to', holding: 'A', at: '2026-11-10T12:00:00+01:00', amount: uah(-20000n) },
          { bankId: 'ti', holding: 'J1', at: '2026-11-10T12:00:00+01:00', amount: uah(20000n) },
          { bankId: 'plain', holding: 'J1', at: '2026-11-11T12:00:00+01:00', amount: uah(5000n) },
          { bankId: 'wo', holding: 'J1', at: '2026-11-12T12:00:00+01:00', amount: uah(-3000n) },
          { bankId: 'wi', holding: 'A', at: '2026-11-12T12:00:00+01:00', amount: uah(3000n) },
          { bankId: 'u1', holding: 'J2', at: '2026-11-13T12:00:00+01:00', amount: usd(1000n) },
        ],
        transfers: [
          ['to', 'ti'],
          ['wo', 'wi'],
        ],
      },
      (snap, cal) => {
        const ctx = ctxFor(resolveScope, snap, cal, 'UAH', ['monobank', 's2']);
        const mc = part.moneyFor(ctx);
        const s = { from: Date.parse('2026-11-09T00:00:00+01:00'), until: Date.parse('2026-11-16T00:00:00+01:00') };
        const ledger = buildLedger(ctx, mc, [s, { from: Date.parse('2026-11-01T00:00:00+01:00'), until: NOW }]);

        // The capability split: S2 is named, never shown as holding no jars.
        const scope = jarScope(ctx);
        expect(scope.jars.map((h) => h.id)).toEqual([J1, J2, J3]);
        expect(scope.offering).toEqual(['monobank']);
        expect(scope.notOffering).toEqual(['s2']);

        const section = topUpsIn(ledger, scope, s, mc);
        // Catches listing only jars with top-ups: J3 would be dropped.
        expect(section.jars.map((t) => t.jar)).toEqual([J1, J2, J3]);
        expect(section.jars.map((t) => t.sourceId)).toEqual(['monobank', 'monobank', 'monobank']);

        // Catches own-transfer top-ups only (count 1, sum 20000) and every non-zero jar movement
        // (count 3, sum 22000); the 11-05 top-up lies before s.
        expect(figures(section.jars[0])).toEqual({ count: 2, sum: uah(25000n), shown: uah(25000n), notConverted: [] });
        // No USD rate held: the original is kept in its own currency and named, valued 0 in UAH.
        expect(figures(section.jars[1])).toEqual({ count: 1, sum: usd(1000n), shown: uah(0n), notConverted: [usd(1000n)] });
        expect(figures(section.jars[2])).toEqual({ count: 0, sum: uah(0n), shown: uah(0n), notConverted: [] });

        expect(section.total).toEqual(uah(25000n));
        expect(section.notOffering).toEqual(['s2']);

        // Catches the unconverted result kept from mc.show: USD to UAH would go unnamed.
        const items = part.ratesUsedContributor.contribute(ctx) as any[];
        expect(items).toContainEqual({ kind: 'not_converted', from: 'USD', to: 'UAH' });
      },
    );
  });

  test('jar activity: outlook', async () => {
    const { jarScope, jarOutlook, averageWindow } = await jarActivity();
    const { buildLedger } = await ledgerModule();
    const { monthPeriod, currentMonth } = await periods();
    const { progressOf } = await jarsFamily();
    const { createMoneyPart } = await context();
    const { resolveScope, narrowingName } = await registerModule();
    const { money } = await moneyModule();

    const uah = (minor: bigint) => money(minor, 'UAH');
    const J1 = narrowingName('monobank', 'jar', 'J1');
    const J2 = narrowingName('monobank', 'jar', 'J2');
    const J3 = narrowingName('monobank', 'jar', 'J3');
    const REPORTED_AT = '2026-11-20T08:00:00+01:00';
    const part = createMoneyPart([MONO] as never);

    // Each top-up is one own transfer from A on the 10th of its month at 12:00 local.
    const offsets: Record<string, string> = { '08': '+02:00', '09': '+02:00', '10': '+02:00', '11': '+01:00' };
    const txs: Tx[] = [];
    const transfers: [string, string][] = [];
    const topUp = (jar: string, month: string, minor: bigint) => {
      const at = `2026-${month}-10T12:00:00${offsets[month]}`;
      const id = `${jar}-${month}`;
      txs.push({ bankId: `${id}-o`, holding: 'A', at, amount: uah(-minor) });
      txs.push({ bankId: `${id}-i`, holding: jar, at, amount: uah(minor) });
      transfers.push([`${id}-o`, `${id}-i`]);
    };
    topUp('J1', '08', 90000n);
    topUp('J1', '09', 100000n);
    topUp('J1', '10', 110000n);
    topUp('J1', '11', 200000n);
    topUp('J2', '08', 33333n);
    topUp('J2', '09', 33334n);
    topUp('J2', '10', 33334n);

    await withStore(
      {
        sources: [MONO],
        holdings: [
          { kind: 'account', bankId: 'A', currency: 'UAH' },
          { kind: 'jar', bankId: 'J1', currency: 'UAH' },
          { kind: 'jar', bankId: 'J2', currency: 'UAH' },
          { kind: 'jar', bankId: 'J3', currency: 'UAH' },
        ],
        txs,
        transfers,
        balances: [
          { jar: 'J1', balance: uah(400000n), goal: uah(1000000n), reportedAt: REPORTED_AT },
          { jar: 'J2', balance: uah(400000n), goal: uah(500002n), reportedAt: REPORTED_AT },
          { jar: 'J3', balance: uah(50000n), goal: null, reportedAt: REPORTED_AT },
        ],
      },
      (snap, cal) => {
        const outlookOf = (report: any) => {
          const ctx = ctxFor(resolveScope, snap, cal, 'UAH', ['monobank']);
          const mc = part.moneyFor(ctx);
          const ledger = buildLedger(ctx, mc, [report, ...averageWindow(cal, report, NOW)]);
          return jarOutlook(ctx, ledger, jarScope(ctx), report, mc);
        };

        const out = outlookOf(monthPeriod(cal, '2026-10', NOW));
        expect(out.jars.map((j) => j.jar)).toEqual([J1, J2, J3]);
        const [j1, j2, j3] = out.jars;

        const at = Date.parse(REPORTED_AT);
        expect(j1!.sourceId).toBe('monobank');
        expect(j1!.balance).toEqual(uah(400000n));
        expect(j1!.goal).toEqual(uah(1000000n));
        expect(j1!.asOf).toEqual({ instant: at, localDateTime: cal.localDateTime(at) });
        expect(j1!.progress).toEqual(progressOf(uah(400000n), uah(1000000n)));
        expect(j1!.month.count).toBe(1);
        expect(j1!.month.sum).toEqual(uah(110000n));
        // Average of August to October: 300000 / 3.
        expect(j1!.averageMonthly).toEqual(uah(100000n));
        expect(j1!.monthsToGoal).toEqual({ kind: 'months', months: 6n });

        expect(j2!.month.sum).toEqual(uah(33334n));
        // 100001 / 3 rounded; catches months from the rounded average, 3.
        expect(j2!.averageMonthly).toEqual(uah(33334n));
        expect(j2!.monthsToGoal).toEqual({ kind: 'months', months: 4n });

        expect(j3!.goal).toBeNull();
        expect(j3!.monthsToGoal).toEqual({ kind: 'no_goal' });
        expect(j3!.month.count).toBe(0);

        // Catches a total over the 3-month window instead of the report month (400001).
        expect(out.total).toEqual(uah(143334n));
        expect(out.notOffering).toEqual([]);

        // Catches a November window holding the partial month (Sep, Oct, Nov: 410000), which
        // averages 136667 and gives 5 months.
        const outNov = outlookOf(currentMonth(cal, NOW));
        const n1 = outNov.jars.find((j) => j.jar === J1)!;
        expect(n1.month.count).toBe(1);
        expect(n1.month.sum).toEqual(uah(200000n));
        expect(n1.averageMonthly).toEqual(uah(100000n));
        expect(n1.monthsToGoal).toEqual({ kind: 'months', months: 6n });
        expect(outNov.total).toEqual(uah(200000n));
      },
    );
  });
});
