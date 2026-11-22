// Balance family (S-149): ownMoneyOf chooses own money and credit used by the source's declared
// balance convention, and the family lists each in-scope account and jar with its latest reported
// balance, both figures converted at the latest recorded rate and rounded once, net position and
// credit used total as sums of the shown lines. From src/families/balance over the money context of
// src/money/context and the reported balances of src/sync/balances.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { QuestionContext } from '../../src/core/question';
import type { Snapshot, WriteTx } from '../../src/db/index';

const balance = () => import('../../src/families/balance');
const context = () => import('../../src/money/context');
const recordedRates = () => import('../../src/money/recorded-rates');
const balancesModule = () => import('../../src/sync/balances');
const registerModule = () => import('../../src/core/register');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');

const NOW = Date.parse('2026-11-21T12:00:00Z');
const REPORTED_AT = Date.parse('2026-11-21T09:00:00Z');

interface Holding {
  kind: 'account' | 'jar';
  sourceId: string;
  bankId: string;
  balance?: bigint; // absent: no balance held
  limit?: bigint;
}

interface Arrange {
  sources: { id: string; capabilities: string[] }[];
  holdings: Holding[];
  crosses: [rate: string, recordedAt: string][]; // PLN-in-UAH, all under monobank
}

// Opens a fresh in-memory store with the sources and UAH holdings registered, each held balance
// reported once at REPORTED_AT by its own source, and the crosses recorded; runs `body` inside one
// snapshot on the Warsaw calendar.
async function withStore(a: Arrange, body: (snap: Snapshot, cal: Calendar) => void): Promise<void> {
  const { ensureRateSchema, recordRates } = await recordedRates();
  const { ensureBalanceSchema, recordBalances } = await balancesModule();
  const { narrowingName } = await registerModule();
  const { openStore, MEMORY_LOCATION } = await db();
  const { openCalendar } = await dates();
  const { parseExactDecimal } = await exact();
  const { money } = await moneyModule();

  const cal = openCalendar(undefined) as Calendar;
  const store = openStore(MEMORY_LOCATION, [ensureRateSchema, ensureBalanceSchema]);
  try {
    store.write((tx: WriteTx) => {
      for (const s of a.sources) tx.registerSource(s as never);
      for (const h of a.holdings) {
        tx.registerHolding({ kind: h.kind, sourceId: h.sourceId, bankId: h.bankId, currency: 'UAH' });
      }
      for (const h of a.holdings) {
        if (h.balance === undefined) continue;
        const reported = {
          holdingId: narrowingName(h.sourceId, h.kind, h.bankId),
          balance: money(h.balance, 'UAH'),
          creditLimit: h.limit === undefined ? null : money(h.limit, 'UAH'),
        };
        recordBalances(tx, h.sourceId, [reported], REPORTED_AT, 'restated');
      }
      for (const [rate, recordedAt] of a.crosses) {
        const res = recordRates(
          tx,
          'monobank',
          [{ pair: { base: 'PLN', quote: 'UAH' }, figures: { kind: 'cross', rate: parseExactDecimal(rate)! } }],
          Date.parse(recordedAt),
        );
        expect(res.added).toBe(1);
      }
    });
    store.readSnapshot((snap) => body(snap, cal));
  } finally {
    store.close();
  }
}

// A hand-built question context over the whole register displaying `display`; a fresh object on
// every call. Takes resolveScope from the register module, already imported, so that it can run
// inside the synchronous snapshot body.
const ctxFor = (
  resolveScope: (reg: any, narrowing: string | undefined) => unknown,
  snap: Snapshot,
  cal: Calendar,
  display: string,
): QuestionContext => {
  const reg = snap.register();
  return {
    snapshot: snap,
    now: NOW,
    settings: { timeZone: undefined, sources: [] },
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

describe('families/balance', () => {
  test('ownMoneyOf', async () => {
    const { ownMoneyOf } = await balance();
    const { money } = await moneyModule();

    const uah = (minor: bigint) => money(minor, 'UAH');
    const b = (bal: bigint, limit: bigint | null) => ({
      balance: uah(bal),
      creditLimit: limit === null ? null : uah(limit),
    });

    const table: [ReturnType<typeof b>, 'account' | 'jar', string, bigint, bigint | null][] = [
      // 1. The limit is subtracted, and what is below it is credit used: 300000 - 100000.
      [b(100000n, 300000n), 'account', 'includes_credit_limit', -200000n, 200000n],
      // 2. Catches (a): reported own money is never reduced by the limit.
      [b(100000n, 300000n), 'account', 'own_money_as_reported', 100000n, null],
      // 3. Catches (b): above the limit no credit is in use, though a limit exists.
      [b(500000n, 300000n), 'account', 'includes_credit_limit', 200000n, null],
      // 4. Catches (c): exactly at the limit no credit is in use (not 0).
      [b(300000n, 300000n), 'account', 'includes_credit_limit', 0n, null],
      // 5. Reported own money below zero is credit used.
      [b(-40000n, null), 'account', 'own_money_as_reported', -40000n, 40000n],
      // 6. No limit held reads as a limit of 0.
      [b(100000n, null), 'account', 'includes_credit_limit', 100000n, null],
      // 7. Catches (d): a jar is always as reported, whatever the convention and limit.
      [b(150000n, 300000n), 'jar', 'includes_credit_limit', 150000n, null],
    ];
    table.forEach(([held, kind, convention, own, used], i) => {
      const r = ownMoneyOf(held as never, kind as never, convention as never);
      expect([i + 1, r]).toEqual([i + 1, { ownMoney: uah(own), creditUsed: used === null ? null : uah(used) }]);
    });
  });

  test('net position and credit used', async () => {
    const { createBalanceFamily } = await balance();
    const { createMoneyPart } = await context();
    const { narrowingName, resolveScope } = await registerModule();
    const { money } = await moneyModule();

    const uah = (minor: bigint) => money(minor, 'UAH');
    const pln = (minor: bigint) => money(minor, 'PLN');
    const conventions = new Map([['monobank', 'includes_credit_limit']]) as never;

    // Arrange A (B-87): everything at monobank, the rate source of record.
    const monoA = { id: 'monobank', capabilities: ['jars', 'rates'] };
    const partA = createMoneyPart([monoA] as never);
    const familyA = createBalanceFamily(partA, conventions);
    const a1 = narrowingName('monobank', 'account', 'a1');
    const a2 = narrowingName('monobank', 'account', 'a2');
    const j1 = narrowingName('monobank', 'jar', 'j1');

    await withStore(
      {
        sources: [monoA],
        holdings: [
          { kind: 'account', sourceId: 'monobank', bankId: 'a1', balance: 500000n, limit: 300000n },
          { kind: 'account', sourceId: 'monobank', bankId: 'a2', balance: 100000n, limit: 300000n },
          { kind: 'jar', sourceId: 'monobank', bankId: 'j1', balance: 150000n },
        ],
        crosses: [['10.00', '2026-11-20T08:00:00Z']],
      },
      (snap, cal) => {
        // Display UAH: the holdings' own currency.
        const outU = familyA.compute(ctxFor(resolveScope, snap, cal, 'UAH')) as any;
        expect(outU.kind).toBe('body');
        const u = outU.body;
        expect(u.accounts.map((l: any) => l.holdingId)).toEqual([a1, a2]);
        expect(u.accounts.map((l: any) => l.ownMoney.original)).toEqual([uah(200000n), uah(-200000n)]);
        expect(u.accounts[0].creditUsed).toBeNull();
        expect(u.accounts[1].creditUsed).toMatchObject({ original: uah(200000n) });
        expect(u.jars.map((l: any) => l.holdingId)).toEqual([j1]);
        expect(u.jars[0].ownMoney.original).toEqual(uah(150000n));
        expect(u.jars[0].creditUsed).toBeNull();
        // Catches (d): with the jar left out the net would be 0.
        expect(u.netPosition).toEqual(uah(150000n));
        expect(u.creditUsedTotal).toEqual(uah(200000n));
        expect(u.withoutBalance).toEqual([]);

        // Display PLN at the cross 10.00.
        const ctxP = ctxFor(resolveScope, snap, cal, 'PLN');
        const outP = familyA.compute(ctxP) as any;
        expect(outP.kind).toBe('body');
        const p = outP.body;
        expect([...p.accounts, ...p.jars].map((l: any) => l.ownMoney.shown)).toEqual([
          pln(20000n),
          pln(-20000n),
          pln(15000n),
        ]);
        expect(p.netPosition).toEqual(pln(15000n));
        expect(p.creditUsedTotal).toEqual(pln(20000n));
        const items = partA.ratesUsedContributor.contribute(ctxP) as any[];
        expect(items.length).toBe(1);
        expect(items[0]).toMatchObject({ from: 'UAH', to: 'PLN' });
      },
    );

    // Arrange B: the holdings at a second source with no declared convention; two crosses.
    const monoB = { id: 'monobank', capabilities: ['rates'] };
    const second = { id: 'second', capabilities: [] };
    const partB = createMoneyPart([monoB, second] as never);
    const familyB = createBalanceFamily(partB, conventions);
    const b = (bankId: string) => narrowingName('second', 'account', bankId);

    await withStore(
      {
        sources: [monoB, second],
        holdings: [
          { kind: 'account', sourceId: 'second', bankId: 'b1', balance: 100005n, limit: 300000n },
          { kind: 'account', sourceId: 'second', bankId: 'b2', balance: 100005n },
          { kind: 'account', sourceId: 'second', bankId: 'b3', balance: -40000n, limit: 300000n },
          { kind: 'account', sourceId: 'second', bankId: 'b4' },
        ],
        crosses: [
          ['10.00', '2026-11-19T08:00:00Z'],
          ['8.00', '2026-11-20T08:00:00Z'],
        ],
      },
      (snap, cal) => {
        const out = familyB.compute(ctxFor(resolveScope, snap, cal, 'PLN')) as any;
        expect(out.kind).toBe('body');
        const body = out.body;
        // Catches (e): b4, holding no balance, is listed apart, not as a zero line.
        expect(body.accounts.map((l: any) => l.holdingId)).toEqual([b('b1'), b('b2'), b('b3')]);
        expect(body.withoutBalance).toEqual([b('b4')]);
        expect(body.jars).toEqual([]);
        // Catches (c): read as reported, b1 is not 100005 - 300000 = -199995.
        expect(body.accounts.map((l: any) => l.ownMoney.original)).toEqual([
          uah(100005n),
          uah(100005n),
          uah(-40000n),
        ]);
        // Catches (a): at the latest cross 8.00, 100005 / 8 = 12500.625 -> 12501, not 10001 at 10.00.
        expect(body.accounts.map((l: any) => l.ownMoney.shown)).toEqual([pln(12501n), pln(12501n), pln(-5000n)]);
        expect(body.accounts[0].creditUsed).toBeNull();
        expect(body.accounts[1].creditUsed).toBeNull();
        expect(body.accounts[2].creditUsed).toMatchObject({ original: uah(40000n), shown: pln(5000n) });
        // Catches (b): the sum of the rounded lines, 12501 + 12501 - 5000, not 160010 / 8 -> 20001.
        expect(body.netPosition).toEqual(pln(20002n));
        expect(body.creditUsedTotal).toEqual(pln(5000n));
        expect(body.accounts[0].asOf.instant).toBe(REPORTED_AT);
        expect(body.accounts[0].asOf.localDateTime).toEqual(cal.localDateTime(REPORTED_AT));
      },
    );
  });
});
