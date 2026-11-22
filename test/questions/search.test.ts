// Search family (S-123): options checked before anything is read, each refusal naming its option;
// the period and scope bound the store read; category by folded whole-name equality, merchant as
// the whole folded name, text as a folded substring of merchant or description; the amount range
// on each row's shown figure, sign ignored, both bounds inclusive; newest first with position
// breaking ties, capped at SEARCH_CAP with the count of further matches. Asked through the composed
// core with the money part's 'ratesUsed' contributor. From src/families/search over the money part
// of src/money/context.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Settings } from '../../src/core/question';
import type { WriteTx } from '../../src/db/index';
import type { Category } from '../../src/local/classifier';
import type { Money } from '../../src/money/money';

const search = () => import('../../src/families/search');
const context = () => import('../../src/money/context');
const compose = () => import('../../src/core/compose');
const recordedRates = () => import('../../src/money/recorded-rates');
const transactions = () => import('../../src/local/transactions');
const classifierModule = () => import('../../src/local/classifier');
const registerModule = () => import('../../src/core/register');
const db = () => import('../../src/db/index');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');

const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const NOW = Date.parse('2026-11-21T12:00:00Z');
const RATE_AT = Date.parse('2026-11-10T08:00:00Z'); // Warsaw 2026-11-10 09:00

const now = () => NOW;
const settings = (): Settings => ({ timeZone: undefined, sources: [] });
const render = (a: unknown) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

// A settled transaction on the account named by its bank id; description equals merchant unless
// stated.
interface Tx {
  bankId: string;
  account: string;
  at: number;
  amount: Money;
  original?: Money;
  merchant: string;
  description?: string;
}

// Composes the core over a fresh in-memory store with the search family built over a money part of
// Monobank, registers Monobank and its `accounts` (bank id -> currency), records a PLN-in-UAH cross
// 10.00 at RATE_AT when `plnCross` is set, and inserts `txs` in the order given, each at its own
// claimed position. Returns an asker for 'transaction_search', each bank id's position, and the
// closer.
async function composed(accounts: Readonly<Record<string, string>>, txs: readonly Tx[], plnCross = false) {
  const { createSearchFamily } = await search();
  const { createMoneyPart } = await context();
  const { composeAnswering } = await compose();
  const { ensureRateSchema, recordRates } = await recordedRates();
  const { ensureTransactionSchema, insertTransaction } = await transactions();
  const { CATEGORIES } = await classifierModule();
  const { narrowingName } = await registerModule();
  const { MEMORY_LOCATION } = await db();
  const { parseExactDecimal } = await exact();

  const G = CATEGORIES.find((c) => c === 'Groceries & Supermarkets') as Category;
  const part = createMoneyPart([MONO] as never);
  const family = createSearchFamily(part);
  const c = composeAnswering({
    location: MEMORY_LOCATION,
    schemas: [ensureRateSchema, ensureTransactionSchema],
    now,
    settings,
    families: [family as never],
    contributors: [part.ratesUsedContributor],
  });
  const positions = new Map<string, number>();
  c.store.write((tx: WriteTx) => {
    tx.registerSource(MONO as never);
    for (const [bankId, currency] of Object.entries(accounts)) {
      tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId, currency } as never);
    }
    if (plnCross) {
      const stated = [
        { pair: { base: 'PLN', quote: 'UAH' }, statedFrom: RATE_AT, figures: { kind: 'cross', rate: parseExactDecimal('10.00')! } },
      ];
      expect(recordRates(tx, 'monobank', stated as never, RATE_AT).added).toBe(1);
    }
    for (const t of txs) {
      const position = tx.claimPosition();
      positions.set(t.bankId, position);
      insertTransaction(
        tx,
        {
          sourceId: 'monobank',
          bankId: t.bankId,
          holdingId: narrowingName('monobank', 'account', t.account),
          occurredAt: t.at,
          amount: t.amount,
          originalAmount: t.original ?? null,
          cashback: null,
          settled: true,
          mcc: null,
          originalMcc: null,
          merchantText: null,
          description: t.description ?? t.merchant,
          comment: null,
          counterpart: null,
        } as never,
        position,
        { category: G, merchant: t.merchant } as never,
      );
    }
  });
  const ask = async (q: { period?: string; displayCurrency?: string; options?: Record<string, unknown> }): Promise<any> =>
    (
      await c.core.serve(
        {
          asker: 'command_line',
          family: 'transaction_search',
          period: q.period,
          displayCurrency: q.displayCurrency ?? 'UAH',
          options: q.options ?? {},
        },
        render,
        channel(),
      )
    ).answer;
  return { family, ask, positions, close: () => c.store.close() };
}

// The body of an answered envelope, failing loudly on anything else.
function bodyOf(answer: any): any {
  expect(answer.kind).toBe('envelope');
  expect(answer.outcome.kind).toBe('answered');
  return answer.outcome.body;
}

const merchants = (body: any): string[] => body.rows.map((r: any) => r.merchant);

describe('families/search', () => {
  test('search options', async () => {
    const { resolveCategory, SEARCH_CAP } = await search();

    expect(SEARCH_CAP).toBe(50);

    // Catches (c) and (d): folded whole-name equality after a trim, never a prefix or inclusion.
    expect(resolveCategory('groceries & supermarkets')).toBe('Groceries & Supermarkets');
    expect(resolveCategory('  GROCERIES & SUPERMARKETS ')).toBe('Groceries & Supermarkets');
    expect(resolveCategory('Groceries')).toBeNull();

    const a = await composed({ card: 'UAH' }, []);
    try {
      expect(a.family.name).toBe('transaction_search');
      expect(a.family.period).toBe('optional');
      expect(a.family.defaultPeriod).toBeUndefined();
      expect(a.family.capability).toBeUndefined();
      expect(a.family.movesPoint).toBe(false);

      // Refused, naming the option: an unknown key, blank or non-string text options, a category
      // off the list, a negative bound, three decimals for a two-decimal currency, a reversed range.
      for (const [options, subject] of [
        [{ foo: 'x' }, 'foo'],
        [{ text: '   ' }, 'text'],
        [{ merchant: 5 }, 'merchant'],
        [{ category: 'Groceries' }, 'category'],
        [{ minAmount: '-1' }, 'minAmount'],
        [{ maxAmount: '1.234' }, 'maxAmount'],
        [{ minAmount: '200', maxAmount: '100' }, 'amountRange'],
      ] as const) {
        const r = await a.ask({ options });
        expect([options, r.kind, r.reason, r.subject]).toEqual([options, 'refused', 'bad_option', subject]);
      }
      const category = await a.ask({ options: { category: 'Groceries' } });
      expect(category.message).toBe('The category "Groceries" is not on the category list.');

      // Catches (a): bounds compared as amounts, not as text ('9' > '10').
      const nineTen = bodyOf(await a.ask({ options: { minAmount: '9', maxAmount: '10' } }));
      expect(nineTen.rows).toEqual([]);
      expect(nineTen.matched).toBe(0);

      // Catches (b): equal bounds are a range of one amount, not refused.
      bodyOf(await a.ask({ options: { minAmount: '100', maxAmount: '100' } }));

      // Catches (d): the category is resolved whatever its case.
      bodyOf(await a.ask({ options: { category: 'groceries & supermarkets' } }));
    } finally {
      a.close();
    }
  });

  test('amount range in display currency', async () => {
    const { money } = await moneyModule();

    // No GBP rate of any kind.
    const a = await composed(
      { card: 'UAH', gbp: 'GBP' },
      [
        { bankId: 't1', account: 'card', at: Date.parse('2026-11-10T10:00:00Z'), amount: money(-15000n, 'UAH'), merchant: 'Silpo' },
        {
          bankId: 't2',
          account: 'card',
          at: Date.parse('2026-11-10T11:00:00Z'),
          amount: money(-41200n, 'UAH'),
          original: money(-1000n, 'USD'),
          merchant: 'Amazon',
        },
        { bankId: 't3', account: 'gbp', at: Date.parse('2026-11-10T12:00:00Z'), amount: money(-1000n, 'GBP'), merchant: 'Tesco' },
      ],
      true,
    );
    try {
      const range = async (displayCurrency: string, minAmount: string, maxAmount: string) =>
        bodyOf(await a.ask({ displayCurrency, options: { minAmount, maxAmount } }));

      // Catches (b): the size of -150.00 UAH lies within 100..200; the signed figure would not.
      const uah = await range('UAH', '100', '200');
      expect(merchants(uah)).toEqual(['Silpo']);
      expect(uah.matched).toBe(1);

      // Catches (c): inclusive at both ends.
      expect(merchants(await range('UAH', '412', '412'))).toEqual(['Amazon']);

      // Catches (a): in PLN, t1 shows -15.00, so the account's own 150.00 does not match 100..200.
      const pln = await range('PLN', '100', '200');
      expect(pln.rows).toEqual([]);
      expect(pln.matched).toBe(0);

      // Catches (c): a range of one amount in the display currency.
      const fifteen = await range('PLN', '15', '15');
      expect(merchants(fifteen)).toEqual(['Silpo']);
      expect(fifteen.rows[0].shown).toEqual(money(-1500n, 'PLN'));

      // Catches (d): Amazon shows -41.20 PLN from the amount the account moved, not its 10.00 USD.
      const amazon = await range('PLN', '40', '42');
      expect(merchants(amazon)).toEqual(['Amazon']);
      expect(amazon.rows[0].shown).toEqual(money(-4120n, 'PLN'));

      // Catches (a): Amazon's own 412.00 UAH does not match 400..420 in PLN.
      expect((await range('PLN', '400', '420')).rows).toEqual([]);

      // Catches (e): an unconverted row matches no range, neither as 0 nor as its own 10.00 GBP.
      expect(merchants(await range('UAH', '0', '1000000'))).toEqual(['Amazon', 'Silpo']);

      // Without a range the unconverted row is listed, with no figure and the pair it lacks.
      const all = bodyOf(await a.ask({ displayCurrency: 'UAH' }));
      expect(merchants(all)).toEqual(['Tesco', 'Amazon', 'Silpo']);
      expect(all.rows[0].shown).toBeNull();
      expect(all.rows[0].notConverted).toEqual({ from: 'GBP', to: 'UAH' });
    } finally {
      a.close();
    }
  });

  test('merchant, text, order and cap', async () => {
    const { money } = await moneyModule();

    const day = (d: string) => Date.parse(`2026-11-${d}T10:00:00Z`);
    const a = await composed({ card: 'UAH' }, [
      { bankId: 'p1', account: 'card', at: day('10'), amount: money(-1000n, 'UAH'), merchant: 'Silpo' },
      { bankId: 'p2', account: 'card', at: day('11'), amount: money(-2000n, 'UAH'), merchant: 'Silpo Express' },
      { bankId: 'p3', account: 'card', at: day('12'), amount: money(-3000n, 'UAH'), merchant: 'SILPO', description: 'x' },
      { bankId: 'p4', account: 'card', at: day('13'), amount: money(-4000n, 'UAH'), merchant: 'Novus', description: 'оплата silpo' },
      { bankId: 'p5', account: 'card', at: day('14'), amount: money(-5000n, 'UAH'), merchant: 'ATB' },
    ]);
    try {
      // Catches (a): the whole folded merchant, not 'Silpo Express' by inclusion.
      const merchant = bodyOf(await a.ask({ options: { merchant: 'silpo' } }));
      expect(merchants(merchant)).toEqual(['SILPO', 'Silpo']);
      expect(merchant.matched).toBe(2);
      expect(merchant.moreMatched).toBe(0);
      expect(merchant.cap).toBe(50);

      // Catches (b): text matched in the description too ('Novus').
      const text = bodyOf(await a.ask({ options: { text: 'SILPO' } }));
      expect(merchants(text)).toEqual(['Novus', 'SILPO', 'Silpo Express', 'Silpo']);
      expect(text.matched).toBe(4);

      // Within the period only.
      const period = bodyOf(await a.ask({ period: '2026-11-11..2026-11-12', options: { text: 'silpo' } }));
      expect(merchants(period)).toEqual(['SILPO', 'Silpo Express']);

      // Catches (c): no filter at all lists everything held, newest first.
      expect(merchants(bodyOf(await a.ask({})))).toEqual(['ATB', 'Novus', 'SILPO', 'Silpo Express', 'Silpo']);

      // Nothing matched is an empty list, not a refusal.
      const none = bodyOf(await a.ask({ options: { merchant: 'Lidl' } }));
      expect(none.rows).toEqual([]);
      expect(none.matched).toBe(0);
    } finally {
      a.close();
    }

    // Position k at 2026-11-01T00:00Z + k minutes; position 53 at the same instant as 52.
    const start = Date.parse('2026-11-01T00:00:00Z');
    const b = await composed(
      { card: 'UAH' },
      Array.from({ length: 53 }, (_, i) => {
        const k = i + 1;
        return {
          bankId: `b${k}`,
          account: 'card',
          at: start + Math.min(k, 52) * 60_000,
          amount: money(-100n, 'UAH'),
          merchant: 'ATB',
        };
      }),
    );
    try {
      // The bank ids were stored in this order: b1 at the lowest position, b53 at the highest.
      const stored = Array.from({ length: 53 }, (_, i) => b.positions.get(`b${i + 1}`)!);
      expect(stored).toEqual([...stored].sort((x, y) => x - y));
      expect(new Set(stored).size).toBe(53);

      const capped = bodyOf(await b.ask({ options: { merchant: 'atb' } }));
      // Catches (f): capped at 50. Catches (e): the further matches, not every match.
      expect(capped.rows.length).toBe(50);
      expect(capped.matched).toBe(53);
      expect(capped.moreMatched).toBe(3);
      expect(capped.cap).toBe(50);
      // Catches (d): the tie at one instant broken by position descending, so b53 before b52.
      expect(capped.rows.map((r: any) => r.bankId)).toEqual(Array.from({ length: 50 }, (_, i) => `b${53 - i}`));
    } finally {
      b.close();
    }
  });
});
