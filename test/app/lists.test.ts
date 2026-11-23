// Composition lists (S-196, src/app/starters): the thirteen answer families in catalogue order, the
// envelope contributors in envelope order over the one money part, the one store installer list
// with no installer twice, the one catalogue joining the analysis families' entries; and every
// family answering over a fresh in-memory store opened with that installer list.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load. The type import is erased at run time.

import { describe, expect, spyOn, test } from 'bun:test';
import type { Settings } from '../../src/core/question';

const starters = () => import('../../src/app/starters');
const sources = () => import('../../src/app/sources');
const catalogue = () => import('../../src/interfaces/catalogue');
const compose = () => import('../../src/core/compose');
const primitives = () => import('../../src/core/primitives');
const coveredRanges = () => import('../../src/local/covered-ranges');
const quarantine = () => import('../../src/money/quarantine');
const balances = () => import('../../src/sync/balances');
const rateGate = () => import('../../src/sync/rate-gate');

const NAMES = [
  'balance',
  'jars',
  'transaction_search',
  'spending_breakdown',
  'exchange_rates',
  'foreign_spending',
  'holdings',
  'new_since_last_asked',
  'trends',
  'behaviour_patterns',
  'weekly_report',
  'monthly_report',
  'health_signals',
];

// Saturday 2026-11-21 12:00 in Warsaw.
const NOW = Date.UTC(2026, 10, 21, 11);

// S-134's Settings: no zone set, Monobank switched on.
const settings = (): Settings => ({ timeZone: undefined, sources: ['monobank'] });
const render = (a: unknown) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

describe('app/starters lists', () => {
  test('families and contributors', async () => {
    const { ANSWER_FAMILIES, ANSWER_CONTRIBUTORS, STORE_SCHEMAS } = await starters();
    const { MONEY_PART } = await sources();
    const { COVERED_RANGES_KEY, coveredRangesContributor } = await coveredRanges();
    const { ensureQuarantineSchema } = await quarantine();
    const { ensureBalanceSchema } = await balances();
    const { ensureRateLedgerSchema } = await rateGate();

    // Catalogue order, which is the order the assistant lists its tools in.
    const names = ANSWER_FAMILIES.map((f) => f.name);
    expect(names).toEqual(NAMES);
    expect(new Set(names).size).toBe(13);

    // Envelope order; the second is the one money part's contributor, not a second part's.
    expect(ANSWER_CONTRIBUTORS.length).toBe(2);
    expect(ANSWER_CONTRIBUTORS[0]).toBe(coveredRangesContributor);
    expect(ANSWER_CONTRIBUTORS[0]!.key).toBe(COVERED_RANGES_KEY);
    expect(ANSWER_CONTRIBUTORS[1]).toBe(MONEY_PART.ratesUsedContributor);

    // One installer list, each installer once, holding the named table owners'.
    expect(new Set(STORE_SCHEMAS).size).toBe(STORE_SCHEMAS.length);
    expect(STORE_SCHEMAS).toContain(ensureQuarantineSchema);
    expect(STORE_SCHEMAS).toContain(ensureBalanceSchema);
    expect(STORE_SCHEMAS).toContain(ensureRateLedgerSchema);

    // Evaluated once per process: a second import gives the very same list.
    const again = await import('../../src/app/starters');
    expect(again.ANSWER_FAMILIES).toBe(ANSWER_FAMILIES);
  });

  test('catalogue', async () => {
    const { ANSWER_FAMILIES, ANSWER_CATALOGUE, ANALYSIS_CATALOGUE_ENTRIES } = await starters();
    const {
      CATALOGUE_ENTRIES,
      DISPLAY_CURRENCY_OPTION,
      NARROWING_OPTION,
      PERIOD_OPTION,
      catalogueFaults,
      toolInputSchema,
    } = await catalogue();

    const names = ANSWER_FAMILIES.map((f) => f.name);
    expect(catalogueFaults(names, ANSWER_CATALOGUE)).toEqual([]);
    for (const e of ANSWER_CATALOGUE) expect(names).toContain(e.family);

    expect(ANALYSIS_CATALOGUE_ENTRIES.map((e) => [e.family, e.command, e.title])).toEqual([
      ['trends', 'trends', 'Spending trends'],
      ['behaviour_patterns', 'patterns', 'Behaviour patterns'],
      ['weekly_report', 'weekly', 'Weekly report'],
      ['monthly_report', 'monthly', 'Monthly report'],
      ['health_signals', 'health', 'Financial health'],
    ]);

    const withPeriod = ['behaviour_patterns', 'weekly_report', 'monthly_report'];
    for (const e of ANALYSIS_CATALOGUE_ENTRIES) {
      expect(e.options[0]).toBe(NARROWING_OPTION);
      expect(e.options.includes(PERIOD_OPTION)).toBe(withPeriod.includes(e.family));
      expect(e.options).toContain(DISPLAY_CURRENCY_OPTION);
      for (const o of e.options) expect(o.required).toBe(false);
    }

    const trends = ANALYSIS_CATALOGUE_ENTRIES.find((e) => e.family === 'trends')!;
    const trendsSchema = toolInputSchema(trends);
    expect(trendsSchema.properties.months?.type).toBe('number');
    expect('period' in trendsSchema.properties).toBe(false);
    expect(trendsSchema.required).toEqual([]);
    const health = ANALYSIS_CATALOGUE_ENTRIES.find((e) => e.family === 'health_signals')!;
    expect('period' in toolInputSchema(health).properties).toBe(false);

    // CATALOGUE_ENTRIES first, then the analysis entries, each by identity and in order.
    const expected = [...CATALOGUE_ENTRIES, ...ANALYSIS_CATALOGUE_ENTRIES];
    expect(ANSWER_CATALOGUE.length).toBe(expected.length);
    expected.forEach((e, i) => expect(ANSWER_CATALOGUE[i]).toBe(e));
  });

  test('every family answers over an empty store', async () => {
    const { ANSWER_FAMILIES, ANSWER_CONTRIBUTORS, STORE_SCHEMAS } = await starters();
    const { composeAnswering } = await compose();
    const { REFUSAL_REASONS } = await primitives();
    const { COVERED_RANGES_KEY } = await coveredRanges();

    const logged: unknown[][] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      }),
    );

    const { core, store } = composeAnswering({
      location: ':memory:',
      schemas: STORE_SCHEMAS,
      now: () => NOW,
      settings,
      families: ANSWER_FAMILIES,
      contributors: ANSWER_CONTRIBUTORS,
    });
    try {
      expect(core).toBeDefined();
      for (const name of ANSWER_FAMILIES.map((f) => f.name)) {
        const r = await core.serve({ asker: 'command_line', family: name, options: {} }, render, channel());
        const a = r.answer;
        expect(render(a)).not.toContain('no such table');
        if (a.kind === 'envelope') {
          expect(a.family).toBe(name);
          expect(['answered', 'not_available']).toContain(a.outcome.kind);
          expect(Object.keys(a.statements)).toContain(COVERED_RANGES_KEY);
        } else {
          expect(a.kind).toBe('refused');
          expect(REFUSAL_REASONS as readonly string[]).toContain(a.reason);
        }
      }
    } finally {
      store.close();
      for (const s of spies) s.mockRestore();
    }
    for (const args of logged) expect(args.map((x) => String(x)).join(' ')).not.toContain('no such table');
  });
});
