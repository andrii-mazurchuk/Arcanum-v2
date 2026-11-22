// Period ledger (S-156): one read of the scope's movements over the union of the requested spans,
// each classified once by the movement classifier of S-128 and each counted, cashback and jar line
// converted once at its own local day; per-span views over half-open spans whose sums are of those
// same rounded lines. From src/analytics/ledger over the money context of src/money/context and the
// held transactions of src/local/transactions.
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

const ledgerModule = () => import('../../src/analytics/ledger');
const movement = () => import('../../src/families/movement');
const context = () => import('../../src/money/context');
const transactions = () => import('../../src/local/transactions');
const recordedRates = () => import('../../src/money/recorded-rates');
const registerModule = () => import('../../src/core/register');
const classifierModule = () => import('../../src/local/classifier');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');

const NOW = Date.parse('2026-11-21T12:00:00+01:00');
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;

interface Holding {
  kind: 'account' | 'jar';
  bankId: string;
  currency: string;
}

interface Tx {
  bankId: string;
  holding: string; // the holding's bankId
  at: string | number; // ISO instant, or an instant
  amount: Money;
  category: Category;
  description?: string;
  settled?: boolean; // default true
  cashback?: Money;
}

interface BuySell {
  base: string;
  quote: string;
  buy: string;
  sell: string;
  statedFrom: string;
}

interface Arrange {
  holdings: Holding[];
  txs: Tx[]; // stored in this order, each at the next position, in one write
  later?: Tx[]; // stored afterwards, in a second write: the later moment of storage
  transfers?: [outBankId: string, inBankId: string][]; // linked as one own transfer each
  rates?: BuySell[]; // under monobank
}

const holdingId = async (kind: 'account' | 'jar', bankId: string): Promise<string> => {
  const { narrowingName } = await registerModule();
  return narrowingName('monobank', kind, bankId);
};

// Opens a fresh in-memory store with monobank and its holdings registered, the transactions stored
// and linked, and the rates recorded; runs `body` inside one snapshot on the Warsaw calendar.
async function withStore(a: Arrange, body: (snap: Snapshot, cal: Calendar) => void): Promise<void> {
  const { ensureTransactionSchema, insertTransaction, createTransfer } = await transactions();
  const { ensureRateSchema, recordRates } = await recordedRates();
  const { narrowingName } = await registerModule();
  const { openStore, MEMORY_LOCATION } = await db();
  const { openCalendar } = await dates();
  const { parseExactDecimal } = await exact();

  const cal = openCalendar(undefined) as Calendar;
  const store = openStore(MEMORY_LOCATION, [ensureTransactionSchema, ensureRateSchema]);
  const kindOf = new Map(a.holdings.map((h) => [h.bankId, h.kind]));
  const holdingOf = (bankId: string) => narrowingName('monobank', kindOf.get(bankId)!, bankId);
  const all = [...a.txs, ...(a.later ?? [])];
  const store1 = (tx: WriteTx, t: Tx) => {
    const translated = {
      sourceId: 'monobank',
      bankId: t.bankId,
      holdingId: holdingOf(t.holding),
      occurredAt: typeof t.at === 'number' ? t.at : Date.parse(t.at),
      amount: t.amount,
      originalAmount: null,
      cashback: t.cashback ?? null,
      settled: t.settled ?? true,
      mcc: null,
      originalMcc: null,
      merchantText: null,
      description: t.description ?? '',
      comment: null,
      counterpart: null,
    };
    const classified = { category: t.category, merchant: t.description || 'Test' };
    insertTransaction(tx, translated as never, tx.claimPosition(), classified as never);
  };
  try {
    store.write((tx: WriteTx) => {
      tx.registerSource(MONO as never);
      for (const h of a.holdings) {
        tx.registerHolding({ kind: h.kind, sourceId: 'monobank', bankId: h.bankId, currency: h.currency } as never);
      }
      for (const t of a.txs) store1(tx, t);
      for (const [outId, inId] of a.transfers ?? []) {
        const out = all.find((t) => t.bankId === outId)!;
        const inn = all.find((t) => t.bankId === inId)!;
        createTransfer(tx, holdingOf(out.holding), holdingOf(inn.holding), 1, [
          { sourceId: 'monobank', bankId: outId },
          { sourceId: 'monobank', bankId: inId },
        ]);
      }
      for (const r of a.rates ?? []) {
        const res = recordRates(
          tx,
          'monobank',
          [
            {
              pair: { base: r.base, quote: r.quote },
              statedFrom: Date.parse(r.statedFrom),
              figures: { kind: 'buy_sell', buy: parseExactDecimal(r.buy)!, sell: parseExactDecimal(r.sell)! },
            },
          ],
          Date.parse(r.statedFrom),
        );
        expect(res.added).toBe(1);
      }
    });
    if (a.later !== undefined) {
      store.write((tx: WriteTx) => {
        for (const t of a.later!) store1(tx, t);
      });
    }
    store.readSnapshot((snap) => body(snap, cal));
  } finally {
    store.close();
  }
}

// A hand-built question context over the whole register (unnarrowed scope); a fresh object on
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
    settings: { timeZone: undefined, sources: ['monobank'] },
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

const bankIds = (lines: readonly { tx: { bankId: string } }[]): string[] => lines.map((l) => l.tx.bankId);

describe('analytics/ledger', () => {
  test('ledger: worked classification and bucketing', async () => {
    const { buildLedger } = await ledgerModule();
    const { classifyMovement } = await movement();
    const { createMoneyPart } = await context();
    const { selectTransactions } = await transactions();
    const { resolveScope } = await registerModule();
    const { CATEGORIES, UNCATEGORIZED } = await classifierModule();
    const { money } = await moneyModule();

    const G = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
    const S = CATEGORIES.find((c) => c === 'Shopping') as Category;
    const F = CATEGORIES.find((c) => c === 'Fast Food') as Category;
    const U = UNCATEGORIZED;
    const uah = (minor: bigint) => money(minor, 'UAH');
    const usd = (minor: bigint) => money(minor, 'USD');
    const J = await holdingId('jar', 'J');
    const part = createMoneyPart([MONO] as never);

    await withStore(
      {
        holdings: [
          { kind: 'account', bankId: 'A', currency: 'UAH' },
          { kind: 'account', bankId: 'B', currency: 'UAH' },
          { kind: 'account', bankId: 'U', currency: 'USD' },
          { kind: 'jar', bankId: 'J', currency: 'UAH' },
        ],
        txs: [
          {
            bankId: 't2',
            holding: 'A',
            at: '2026-11-05T12:00:00+01:00',
            amount: uah(1550n),
            category: U,
            description: 'Кешбек',
            cashback: uah(1550n),
          },
          {
            bankId: 't3',
            holding: 'A',
            at: '2026-11-06T12:00:00+01:00',
            amount: uah(500000n),
            category: U,
            description: 'salary',
          },
          { bankId: 't4o', holding: 'A', at: '2026-11-07T12:00:00+01:00', amount: uah(-50000n), category: U },
          { bankId: 't4i', holding: 'B', at: '2026-11-07T12:00:00+01:00', amount: uah(50000n), category: U },
          { bankId: 't5o', holding: 'A', at: '2026-11-08T12:00:00+01:00', amount: uah(-20000n), category: U },
          { bankId: 't5i', holding: 'J', at: '2026-11-08T12:00:00+01:00', amount: uah(20000n), category: U },
          { bankId: 't6', holding: 'U', at: '2026-11-09T12:00:00+01:00', amount: usd(-5000n), category: S },
          {
            bankId: 't7',
            holding: 'A',
            at: '2026-11-10T12:00:00+01:00',
            amount: uah(-3000n),
            category: F,
            cashback: uah(30n),
          },
        ],
        // tx 1: an October purchase stored on 2026-11-20, after every November one.
        later: [{ bankId: 't1', holding: 'A', at: '2026-10-31T23:30:00+01:00', amount: uah(-10000n), category: G }],
        transfers: [
          ['t4o', 't4i'],
          ['t5o', 't5i'],
        ],
      },
      (snap, cal) => {
        // Precondition: the shared classifier's kinds for the stored movements.
        const held = selectTransactions(snap.db, { order: 'position' });
        const kinds = Object.fromEntries(held.map((t) => [t.bankId, classifyMovement(t as never)]));
        expect(kinds).toEqual({
          t1: 'spending',
          t2: 'cashback',
          t3: 'income',
          t4o: 'own_transfer',
          t4i: 'own_transfer',
          t5o: 'own_transfer',
          t5i: 'own_transfer',
          t6: 'spending',
          t7: 'spending',
        });
        const t1 = held.find((t) => t.bankId === 't1')!;
        expect(t1.position).toBe(Math.max(...held.map((t) => t.position)));

        const ctx = ctxFor(resolveScope, snap, cal, 'UAH');
        const mc = part.moneyFor(ctx);
        const oct = { from: Date.parse('2026-10-01T00:00:00+02:00'), until: Date.parse('2026-11-01T00:00:00+01:00') };
        const nov = { from: Date.parse('2026-11-01T00:00:00+01:00'), until: NOW };
        const ledger = buildLedger(ctx, mc, [oct, nov]);

        expect(ledger.display).toBe('UAH');
        expect(ledger.read).toEqual({ from: oct.from, until: NOW });

        // Catches bucketing by the moment of storage: tx 1 stays in October.
        const octLines = ledger.lines(oct);
        expect(bankIds(octLines)).toEqual(['t1']);
        expect(octLines[0]!.kind).toBe('spending');
        expect(octLines[0]!.original).toEqual(uah(10000n));
        expect(octLines[0]!.figure).toEqual(uah(10000n));
        expect(octLines[0]!.at).toBe(t1.occurredAt);

        // Catches own transfers counted by sign, and cashback counted as a line of its own.
        const novLines = ledger.lines(nov);
        expect(bankIds(novLines)).toEqual(['t3', 't6', 't7']);
        expect(novLines.map((l) => l.kind)).toEqual(['income', 'spending', 'spending']);
        expect(bankIds(ledger.lines(nov, 'spending'))).toEqual(['t6', 't7']);
        const t6Line = novLines.find((l) => l.tx.bankId === 't6')!;
        expect(t6Line.figure).toBeNull();
        expect(t6Line.result.kind).toBe('unconverted');

        // Catches cashback lines taken only from 'cashback'-kind movements: t7 is spending.
        const cb = ledger.cashbackLines(nov);
        expect(bankIds(cb)).toEqual(['t2', 't7']);
        expect(cb.map((l) => l.original)).toEqual([uah(1550n), uah(30n)]);

        // Catches a jar top-up dropped with the own transfer, or jar lines from both sides.
        const jar = ledger.jarLines(nov);
        expect(bankIds(jar)).toEqual(['t5i']);
        expect(jar[0]!.jar).toBe(J);
        expect(jar[0]!.original).toEqual(uah(20000n));
        expect(ledger.jarLines(nov, J)).toEqual(jar);
        expect(ledger.jarLines(oct)).toEqual([]);

        // Catches storage-moment bucketing (oct 0, nov 13000), own transfers by sign (73000 and
        // 570000), cashback only from 'cashback' kind (1550), and NaN or a throw from the
        // unconverted line.
        expect(ledger.totals(oct)).toEqual({ spending: uah(10000n), refunds: uah(0n), income: uah(0n), cashback: uah(0n) });
        expect(ledger.totals(nov)).toEqual({
          spending: uah(3000n),
          refunds: uah(0n),
          income: uah(500000n),
          cashback: uah(1580n),
        });

        // Catches the unconverted line dropped from the keys: 'Shopping' stays, valued 0.
        const byCat = ledger.spendingByCategory(nov);
        const expectedKeys = [S, F].sort((x, y) => CATEGORIES.indexOf(x) - CATEGORIES.indexOf(y));
        expect([...byCat.keys()]).toEqual(expectedKeys);
        expect(byCat.get(S)).toEqual(uah(0n));
        expect(byCat.get(F)).toEqual(uah(3000n));

        // Three counted lines and two cashback lines; jar line results are not among them.
        expect(ledger.results(nov).length).toBe(5);

        expect(() => buildLedger(ctx, mc, [])).toThrow(RangeError);
      },
    );
  });

  test('ledger: one conversion per line, sums of rounded lines', async () => {
    const { buildLedger } = await ledgerModule();
    const { createMoneyPart } = await context();
    const { resolveScope } = await registerModule();
    const { CATEGORIES } = await classifierModule();
    const { parseExactDecimal } = await exact();
    const { money } = await moneyModule();

    const S = CATEGORIES.find((c) => c === 'Shopping') as Category;
    const usd = (minor: bigint) => money(minor, 'USD');
    const pln = (minor: bigint) => money(minor, 'PLN');
    const part = createMoneyPart([MONO] as never);

    await withStore(
      {
        holdings: [{ kind: 'account', bankId: 'U', currency: 'USD' }],
        txs: [
          { bankId: 'p1', holding: 'U', at: '2026-11-10T10:00:00+01:00', amount: usd(-100n), category: S },
          { bankId: 'p2', holding: 'U', at: '2026-11-10T11:00:00+01:00', amount: usd(-100n), category: S },
          { bankId: 'p3', holding: 'U', at: '2026-11-10T12:00:00+01:00', amount: usd(-100n), category: S },
        ],
        rates: [{ base: 'USD', quote: 'PLN', buy: '3.6500', sell: '3.6610', statedFrom: '2026-11-10T08:00:00+01:00' }],
      },
      (snap, cal) => {
        const ctx = ctxFor(resolveScope, snap, cal, 'PLN');
        const mc = part.moneyFor(ctx) as any;
        let count = 0;
        const counted = {
          ...mc,
          converter: {
            display: mc.converter.display,
            convert(amount: Money, when: unknown) {
              count++;
              return mc.converter.convert(amount, when);
            },
          },
        };
        const s = { from: Date.parse('2026-11-09T00:00:00+01:00'), until: Date.parse('2026-11-16T00:00:00+01:00') };

        const ledger = buildLedger(ctx, counted, [s]);
        const c0 = count;
        for (let i = 0; i < 2; i++) {
          ledger.lines(s);
          ledger.totals(s);
          ledger.spendingByCategory(s);
          ledger.results(s);
        }

        // Catches views that convert on demand.
        expect(c0).toBe(3);
        expect(count).toBe(3);

        // 100 x 3.6555 = 365.55 -> 366, half away from zero. Catches truncation, 365.
        const spending = ledger.lines(s, 'spending');
        expect(spending.length).toBe(3);
        for (const l of spending) expect(l.figure).toEqual(pln(366n));

        // Catches one rounding of the exact sum, 1097, and truncated lines, 1095.
        expect(ledger.totals(s).spending).toEqual(pln(1098n));
        expect(ledger.spendingByCategory(s).get(S)).toEqual(pln(1098n));

        const results = ledger.results(s) as any[];
        expect(results.length).toBe(3);
        for (const r of results) {
          expect(r.kind).toBe('converted');
          expect(r.legs.length).toBe(1);
          expect(r.legs[0].quotedValue).toEqual(parseExactDecimal('3.6555'));
          expect(r.legs[0].recordDate).toBe('2026-11-10');
        }
      },
    );
  });

  test('ledger: span edges, jar lines, key order', async () => {
    const { buildLedger } = await ledgerModule();
    const { createMoneyPart } = await context();
    const { resolveScope } = await registerModule();
    const { CATEGORIES, UNCATEGORIZED } = await classifierModule();
    const { money } = await moneyModule();

    const fast = CATEGORIES.find((c) => c === 'Fast Food') as Category;
    const groceries = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
    const [lo, hi] = CATEGORIES.indexOf(fast) > CATEGORIES.indexOf(groceries) ? [groceries, fast] : [fast, groceries];
    const U = UNCATEGORIZED;
    const uah = (minor: bigint) => money(minor, 'UAH');
    const edge = Date.parse('2026-11-16T00:00:00+01:00');
    const J = await holdingId('jar', 'J');
    const part = createMoneyPart([MONO] as never);

    await withStore(
      {
        holdings: [
          { kind: 'account', bankId: 'A', currency: 'UAH' },
          { kind: 'jar', bankId: 'J', currency: 'UAH' },
        ],
        txs: [
          { bankId: 'h1', holding: 'A', at: '2026-11-10T12:00:00+01:00', amount: uah(-1000n), category: hi },
          { bankId: 'l1', holding: 'A', at: edge - 1, amount: uah(-2000n), category: lo },
          { bankId: 'l2', holding: 'A', at: edge, amount: uah(-4000n), category: lo },
          { bankId: 'j1', holding: 'J', at: '2026-11-10T13:00:00+01:00', amount: uah(7000n), category: U },
          {
            bankId: 'j2',
            holding: 'J',
            at: '2026-11-11T13:00:00+01:00',
            amount: uah(2000n),
            category: U,
            settled: false,
          },
          { bankId: 'wo', holding: 'J', at: '2026-11-12T13:00:00+01:00', amount: uah(-3000n), category: U },
          { bankId: 'wi', holding: 'A', at: '2026-11-12T13:00:00+01:00', amount: uah(3000n), category: U },
          { bankId: 'to', holding: 'A', at: '2026-11-13T13:00:00+01:00', amount: uah(-4000n), category: U },
          { bankId: 'ti', holding: 'J', at: '2026-11-13T13:00:00+01:00', amount: uah(4000n), category: U },
        ],
        transfers: [
          ['wo', 'wi'],
          ['to', 'ti'],
        ],
      },
      (snap, cal) => {
        const ctx = ctxFor(resolveScope, snap, cal, 'UAH');
        const s1 = { from: Date.parse('2026-11-09T00:00:00+01:00'), until: edge };
        const s2 = { from: edge, until: NOW };
        const ledger = buildLedger(ctx, part.moneyFor(ctx), [s1, s2]);

        // Catches an inclusive until: the line at edge belongs to s2 only.
        expect(ledger.lines(s1, 'spending').map((l) => l.original.minor)).toEqual([1000n, 2000n]);
        expect(ledger.lines(s2, 'spending').map((l) => l.original.minor)).toEqual([4000n]);

        // Catches jar lines from own transfers only ([4000]), from settled movements only
        // ([7000, 4000]), and from any non-zero jar movement (the -3000 withdrawal).
        expect(ledger.jarLines(s1, J).map((l) => l.original)).toEqual([uah(7000n), uah(2000n), uah(4000n)]);
        expect(ledger.jarLines(s2)).toEqual([]);

        // Catches keys in read order, [hi, lo].
        const byCat = ledger.spendingByCategory(s1);
        expect([...byCat.keys()]).toEqual([lo, hi]);
        expect(byCat.get(lo)).toEqual(uah(2000n));
        expect(byCat.get(hi)).toEqual(uah(1000n));

        // Catches an inclusive until: 7000 in s1.
        expect(ledger.totals(s1).spending).toEqual(uah(3000n));
        expect(ledger.totals(s2).spending).toEqual(uah(4000n));
      },
    );
  });
});
