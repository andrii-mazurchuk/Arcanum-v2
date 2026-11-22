// Jars family (S-150): progressOf gives a jar's progress as the exact share of its goal, with one
// display percent rounded half away from zero, and the family lists each in-scope jar in register
// order with its latest reported balance, goal and progress, the balance converted at the latest
// recorded rate and rounded once, the total as the sum of the shown lines. From src/families/jars
// over the money context of src/money/context and the reported balances of src/sync/balances.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { QuestionContext } from '../../src/core/question';
import type { Snapshot, WriteTx } from '../../src/db/index';

const jars = () => import('../../src/families/jars');
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
const LATER_AT = Date.parse('2026-11-21T10:00:00Z');

// A hand-built question context over the whole register displaying `display` with `options`; a
// fresh object on every call. Takes resolveScope from the register module, already imported, so
// that it can run inside the synchronous snapshot body.
const ctxFor = (
  resolveScope: (reg: any, narrowing: string | undefined) => unknown,
  snap: Snapshot,
  cal: Calendar,
  display: string,
  options: Record<string, unknown> = {},
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
    options,
  } as unknown as QuestionContext;
};

describe('families/jars', () => {
  test('progressOf', async () => {
    const { progressOf, PROGRESS_PERCENT_DECIMALS } = await jars();
    const { fraction } = await exact();
    const { money } = await moneyModule();

    expect(PROGRESS_PERCENT_DECIMALS).toBe(1);
    const uah = (minor: bigint) => money(minor, 'UAH');

    const table: [balance: bigint, goal: bigint, num: bigint, den: bigint, percent: string, reached: boolean][] = [
      [150000n, 400000n, 3n, 8n, '37.5%', false],
      // Catches (c): exactly at the goal is reached.
      [400000n, 400000n, 1n, 1n, '100.0%', true],
      // Above the goal the share passes one and stays reached.
      [450000n, 400000n, 9n, 8n, '112.5%', true],
      // Catches (a): 66.666… rounds to 66.7, not truncated to 66.6.
      [200000n, 300000n, 2n, 3n, '66.7%', false],
      // Catches (b): 6.25 rounds half away from zero to 6.3, not half to even 6.2.
      [25000n, 400000n, 1n, 16n, '6.3%', false],
      [0n, 400000n, 0n, 1n, '0.0%', false],
    ];
    for (const [bal, goal, num, den, percent, reached] of table) {
      const p = progressOf(uah(bal), uah(goal));
      expect([bal, goal, p]).toEqual([bal, goal, { share: fraction(num, den), percentText: percent, reached }]);
    }

    // Catches (d): no positive goal is no progress, never a division by zero.
    expect(progressOf(uah(150000n), null)).toBeNull();
    expect(progressOf(uah(150000n), uah(0n))).toBeNull();
    expect(progressOf(uah(150000n), uah(-100n))).toBeNull();
  });

  test('jars answer', async () => {
    const { createJarsFamily } = await jars();
    const { createMoneyPart } = await context();
    const { ensureRateSchema, recordRates } = await recordedRates();
    const { ensureBalanceSchema, recordBalances } = await balancesModule();
    const { narrowingName, resolveScope } = await registerModule();
    const { openStore, MEMORY_LOCATION } = await db();
    const { openCalendar } = await dates();
    const { fraction, parseExactDecimal } = await exact();
    const { money } = await moneyModule();

    const uah = (minor: bigint) => money(minor, 'UAH');
    const pln = (minor: bigint) => money(minor, 'PLN');
    const cal = openCalendar(undefined) as Calendar;

    const mono = { id: 'monobank', capabilities: ['jars', 'rates'] };
    const family = createJarsFamily(createMoneyPart([mono] as never));
    const a1 = narrowingName('monobank', 'account', 'a1');
    const j1 = narrowingName('monobank', 'jar', 'j1');
    const j2 = narrowingName('monobank', 'jar', 'j2');
    const j3 = narrowingName('monobank', 'jar', 'j3');

    expect(family.name).toBe('jars');
    expect(family.capability).toBe('jars');
    expect(family.period).toBe('none');
    expect(family.movesPoint).toBe(false);

    const store = openStore(MEMORY_LOCATION, [ensureRateSchema, ensureBalanceSchema]);
    try {
      store.write((tx: WriteTx) => {
        tx.registerSource(mono as never);
        tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'a1', currency: 'UAH' });
        tx.registerHolding({ kind: 'jar', sourceId: 'monobank', bankId: 'j1', currency: 'UAH' });
        tx.registerHolding({ kind: 'jar', sourceId: 'monobank', bankId: 'j2', currency: 'UAH' });
        tx.registerHolding({ kind: 'jar', sourceId: 'monobank', bankId: 'j3', currency: 'UAH' });
        recordBalances(
          tx,
          'monobank',
          [
            { holdingId: a1, balance: uah(999999n), creditLimit: null },
            { holdingId: j1, balance: uah(100005n), creditLimit: null, goal: uah(400000n) },
            { holdingId: j2, balance: uah(100005n), creditLimit: null, goal: null },
          ],
          REPORTED_AT,
          'restated',
        );
        const res = recordRates(
          tx,
          'monobank',
          [{ pair: { base: 'PLN', quote: 'UAH' }, figures: { kind: 'cross', rate: parseExactDecimal('10.00')! } }],
          Date.parse('2026-11-20T08:00:00Z'),
        );
        expect(res.added).toBe(1);
      });

      store.readSnapshot((snap: Snapshot) => {
        const out = family.compute(ctxFor(resolveScope, snap, cal, 'PLN')) as any;
        expect(out.kind).toBe('body');
        const body = out.body;
        // Catches (b) and (c): the account a1 is no jar, and j3, holding no balance, is listed apart.
        expect(body.jars.map((l: any) => l.name)).toEqual([j1, j2]);
        expect(body.withoutBalance).toEqual([j3]);

        const [l1, l2] = body.jars;
        expect(l1.sourceId).toBe('monobank');
        expect(l1.balance).toEqual(uah(100005n));
        expect(l1.asOf.instant).toBe(REPORTED_AT);
        expect(l1.asOf.localDateTime).toEqual(cal.localDateTime(REPORTED_AT));
        expect(l1.goal).toEqual(uah(400000n));
        // 25.00125 -> 25.0.
        expect(l1.progress).toEqual({ share: fraction(100005n, 400000n), percentText: '25.0%', reached: false });
        expect(l2.balance).toEqual(uah(100005n));
        expect(l2.goal).toBeNull();
        expect(l2.progress).toBeNull();

        // 100005 / 10 = 10000.5 -> 10001 on each line.
        expect(body.jars.map((l: any) => l.shown)).toEqual([pln(10001n), pln(10001n)]);
        expect(body.jars.map((l: any) => l.notConverted)).toEqual([null, null]);
        // Catches (a): the sum of the rounded lines 10001 x 2, not 200010 / 10 = 20001.
        expect(body.total).toEqual(pln(20002n));

        const foo = family.compute(ctxFor(resolveScope, snap, cal, 'PLN', { foo: 1 })) as any;
        expect([foo.kind, foo.reason, foo.subject]).toEqual(['refused', 'bad_option', 'foo']);
      });

      // A later report for j1 carries its goal as removed.
      store.write((tx: WriteTx) => {
        recordBalances(
          tx,
          'monobank',
          [{ holdingId: j1, balance: uah(100005n), creditLimit: null, goal: null }],
          LATER_AT,
          'restated',
        );
      });

      store.readSnapshot((snap: Snapshot) => {
        const out = family.compute(ctxFor(resolveScope, snap, cal, 'PLN')) as any;
        expect(out.kind).toBe('body');
        const l1 = out.body.jars.find((l: any) => l.name === j1);
        // Catches (d): the removed goal is not kept from the earlier report.
        expect(l1.goal).toBeNull();
        expect(l1.progress).toBeNull();
        expect(l1.asOf.instant).toBe(LATER_AT);
      });
    } finally {
      store.close();
    }
  });
});
