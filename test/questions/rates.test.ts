// Rates family (S-130, src/families/rates): per requested currency, the latest held record of that
// currency against the hryvnia from the rate source of record, shown as quoted with its recorded
// moment and local date-time; duplicates dropped, bad currencies refused, nothing converted. Asked
// through the composed core with the money part's 'ratesUsed' contributor, so the envelope's
// rates-used statement is the one the product would show. From src/families/rates over the money
// part of src/money/context.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { Settings } from '../../src/core/question';
import type { StatedRate } from '../../src/money/recorded-rates';

const rates = () => import('../../src/families/rates');
const context = () => import('../../src/money/context');
const compose = () => import('../../src/core/compose');
const recordedRates = () => import('../../src/money/recorded-rates');
const db = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');
const exact = () => import('../../src/money/exact');

const T1 = Date.parse('2026-11-19T09:15:00Z');
const T2 = Date.parse('2026-11-20T09:15:00Z');
const RECORDED_AT = Date.parse('2026-11-21T10:00:00Z');
const NOW = Date.parse('2026-11-21T12:00:00Z');

// Monobank as built: the source offering rates. SECOND offers none.
const MONO = { id: 'monobank', capabilities: ['jars', 'rates'] } as const;
const SECOND = { id: 'second', capabilities: [] } as const;

const now = () => NOW;
const settings = (): Settings => ({ timeZone: undefined, sources: [] });
const render = (a: unknown) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

type Rec = { base: string; quote: string; statedFrom: number } & (
  | { buy: string; sell: string }
  | { rate: string }
);

// Composes the core over a fresh in-memory store with the rates family built over a money part of
// `built`, records each batch for 'monobank' in its own write, in the order given, and returns an
// asker for the 'exchange_rates' family plus the closer.
async function composed(built: readonly unknown[], batches: readonly (readonly Rec[])[]) {
  const { createRatesFamily } = await rates();
  const { createMoneyPart } = await context();
  const { composeAnswering } = await compose();
  const { ensureRateSchema, recordRates } = await recordedRates();
  const { MEMORY_LOCATION } = await db();
  const { parseExactDecimal } = await exact();

  const part = createMoneyPart(built as never);
  const family = createRatesFamily(part);
  const c = composeAnswering({
    location: MEMORY_LOCATION,
    schemas: [ensureRateSchema],
    now,
    settings,
    families: [family as never],
    contributors: [part.ratesUsedContributor],
  });
  const d = (text: string) => parseExactDecimal(text)!;
  for (const batch of batches) {
    const stated: StatedRate[] = batch.map((r) => ({
      pair: { base: r.base, quote: r.quote },
      statedFrom: r.statedFrom,
      figures: 'rate' in r ? { kind: 'cross', rate: d(r.rate) } : { kind: 'buy_sell', buy: d(r.buy), sell: d(r.sell) },
    }));
    c.store.write((tx) => {
      expect(recordRates(tx, 'monobank', stated, RECORDED_AT).added).toBe(stated.length);
    });
  }
  const ask = async (options: Record<string, unknown>): Promise<any> =>
    (await c.core.serve({ asker: 'command_line', family: 'exchange_rates', options }, render, channel())).answer;
  return { family, part, ask, close: () => c.store.close() };
}

// Recorded in this order: USD at T2, then USD at T1, then PLN cross at T1.
const STORE_A: Rec[][] = [
  [{ base: 'USD', quote: 'UAH', statedFrom: T2, buy: '41.10', sell: '41.311' }],
  [{ base: 'USD', quote: 'UAH', statedFrom: T1, buy: '40.95', sell: '41.2002' }],
  [{ base: 'PLN', quote: 'UAH', statedFrom: T1, rate: '10.00' }],
];

describe('families/rates', () => {
  test('latest record as quoted', async () => {
    const { DEFAULT_RATE_CURRENCIES } = await rates();
    const { openCalendar } = await dates();
    const cal = openCalendar(undefined) as Calendar;

    expect([...DEFAULT_RATE_CURRENCIES]).toEqual(['USD', 'EUR', 'PLN', 'GBP']);

    // Arrange A: Monobank built as the rates source.
    const a = await composed([MONO], STORE_A);
    try {
      expect(a.family.name).toBe('exchange_rates');
      expect(a.family.period).toBe('none');
      expect(a.family.capability).toBeUndefined();
      expect(a.family.movesPoint).toBe(false);

      const answer = await a.ask({});
      expect(answer.kind).toBe('envelope');
      // The latest by moment, not the earliest nor the last inserted (both '40.95'/'41.2002' at T1);
      // figures as written, not through a number ('41.1', '10').
      expect(answer.outcome).toEqual({
        kind: 'answered',
        body: {
          rateSource: 'monobank',
          lines: [
            {
              currency: 'USD',
              quote: {
                pair: { base: 'USD', quote: 'UAH' },
                figures: { kind: 'buy_sell', buy: '41.10', sell: '41.311' },
                recordedAt: T2,
                localDateTime: cal.localDateTime(T2),
              },
            },
            { currency: 'EUR', quote: null },
            {
              currency: 'PLN',
              quote: {
                pair: { base: 'PLN', quote: 'UAH' },
                figures: { kind: 'cross', rate: '10.00' },
                recordedAt: T1,
                localDateTime: cal.localDateTime(T1),
              },
            },
            { currency: 'GBP', quote: null },
          ],
        },
      });
      // Nothing converted, nothing shown: the rates-used statement is empty.
      expect(answer.statements.ratesUsed).toEqual([]);

      // Duplicates dropped keeping the first: two lines, not three.
      const dup = await a.ask({ currencies: ['EUR', 'EUR', 'USD'] });
      expect(dup.kind).toBe('envelope');
      const dupLines = dup.outcome.body.lines;
      expect(dupLines.map((l: any) => l.currency)).toEqual(['EUR', 'USD']);
      expect(dupLines[0].quote).toBeNull();
      expect(dupLines[1].quote.figures).toEqual({ kind: 'buy_sell', buy: '41.10', sell: '41.311' });

      // Refused: the hryvnia itself, a code not in the table, a lower-case code, an empty list.
      for (const [value, named] of [
        [['UAH'], 'UAH'],
        [['XYZ'], 'XYZ'],
        [['usd'], 'usd'],
        [[], undefined],
      ] as const) {
        const r = await a.ask({ currencies: value });
        expect([value, r.kind, r.reason, r.subject]).toEqual([value, 'refused', 'bad_option', 'currencies']);
        if (named !== undefined) expect([value, r.value]).toEqual([value, named]);
      }
      const uah = await a.ask({ currencies: ['UAH'] });
      expect(uah.message).toBe('The currency "UAH" cannot be shown against the hryvnia.');

      const foo = await a.ask({ foo: 1 });
      expect([foo.kind, foo.reason, foo.subject]).toEqual(['refused', 'bad_option', 'foo']);
    } finally {
      a.close();
    }

    // Arrange B: the only EUR record is UAH-in-EUR; served as held, not as a reciprocal (~'42.55').
    const b = await composed([MONO], [[{ base: 'UAH', quote: 'EUR', statedFrom: T1, rate: '0.0235' }]]);
    try {
      const answer = await b.ask({ currencies: ['EUR'] });
      expect(answer.kind).toBe('envelope');
      expect(answer.outcome.body.lines).toEqual([
        {
          currency: 'EUR',
          quote: {
            pair: { base: 'UAH', quote: 'EUR' },
            figures: { kind: 'cross', rate: '0.0235' },
            recordedAt: T1,
            localDateTime: cal.localDateTime(T1),
          },
        },
      ]);
    } finally {
      b.close();
    }

    // Arrange C: no built source offers rates; Monobank's records do not fall through.
    const c = await composed([SECOND], STORE_A);
    try {
      const answer = await c.ask({});
      expect(answer.kind).toBe('envelope');
      expect(answer.outcome.body).toEqual({
        rateSource: null,
        lines: [
          { currency: 'USD', quote: null },
          { currency: 'EUR', quote: null },
          { currency: 'PLN', quote: null },
          { currency: 'GBP', quote: null },
        ],
      });
    } finally {
      c.close();
    }
  });
});
