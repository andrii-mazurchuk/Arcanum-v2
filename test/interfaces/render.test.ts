// Answer rendering (S-174): the shared envelope head (title, as-of, display currency, scope,
// period, covered ranges per source, then every other statement), the shared body layout, the
// refusal and open-refusal texts, and the JSON value of an answer attached for the assistant.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const renderModule = () => import('../../src/interfaces/render');
const catalogueModule = () => import('../../src/interfaces/catalogue');
const moneyModule = () => import('../../src/money/money');
const primitivesModule = () => import('../../src/core/primitives');
const settingsModule = () => import('../../src/config/settings');

type Money = { minor: bigint; currency: string };

// The envelope of the formatHead order test; each test takes a fresh copy and overrides fields.
function baseEnvelope(): Record<string, unknown> {
  return {
    kind: 'envelope',
    family: 'balance',
    asker: 'assistant',
    asOf: { instant: 1795341600000, localDateTime: '2026-11-22T10:00:00+01:00', position: 42 },
    timeZone: 'Europe/Warsaw',
    displayCurrency: 'PLN',
    scope: { narrowing: 'monobank', sources: ['monobank', 'second'], notOffering: [] },
    period: { text: 'last-month', firstDay: '2026-10-01', lastDay: '2026-10-31' },
    statements: {
      ratesUsed: [
        { pair: 'USD/PLN', date: '2026-10-14', rate: { num: 73111n, den: 20000n }, substituted: true },
      ],
      coveredRanges: [
        {
          sourceId: 'monobank',
          ranges: [
            { startAt: 0, endAt: 0, start: '2026-08-24T14:01:00+02:00', end: '2026-09-30T23:59:00+02:00' },
            { startAt: 0, endAt: 0, start: '2026-10-02T00:00:00+02:00', end: '2026-11-22T09:59:00+01:00' },
          ],
        },
        { sourceId: 'second', ranges: [] },
      ],
      note: 'held up to the last poll',
    },
    outcome: { kind: 'answered', body: {} },
  };
}

const HEAD_LINES = [
  'Balance and net position',
  'As of: 2026-11-22T10:00:00+01:00 (Europe/Warsaw)',
  'Display currency: PLN',
  'Scope:',
  '  Narrowing: monobank',
  '  Sources:',
  '    - monobank',
  '    - second',
  '  Not offering: none',
  'Period: last-month (2026-10-01 to 2026-10-31)',
  'Covered ranges:',
  '  monobank:',
  '    2026-08-24T14:01:00+02:00 to 2026-09-30T23:59:00+02:00',
  '    2026-10-02T00:00:00+02:00 to 2026-11-22T09:59:00+01:00',
  '  second: nothing held',
  'Rates used:',
  '  -',
  '    Pair: USD/PLN',
  '    Date: 2026-10-14',
  '    Rate: 73111/20000',
  '    Substituted: yes',
  'Note: held up to the last poll',
];

describe('labelOf and an empty list', () => {
  test('labels space and lower-case each capital and capitalise the first letter', async () => {
    const { labelOf } = await renderModule();
    expect(labelOf('moreMatched')).toBe('More matched');
    expect(labelOf('ratesUsed')).toBe('Rates used');
    expect(labelOf('notConverted')).toBe('Not converted');
    expect(labelOf('scope')).toBe('Scope');
    expect(labelOf('n')).toBe('N');
  });

  test('an empty array renders as none on its label line', async () => {
    const { layoutBody } = await renderModule();
    expect(layoutBody({ moreMatched: 0, rows: [] })).toEqual(['More matched: 0', 'Rows: none']);
  });
});

describe('layoutBody scalars and nesting', () => {
  test('every value kind, nesting with two-space indent, undefined skipped, insertion order kept', async () => {
    const { layoutBody } = await renderModule();
    const { formatMoney } = await moneyModule();
    const m1: Money = { minor: -235n, currency: 'PLN' };
    const m2: Money = { minor: 1099n, currency: 'PLN' };
    const body = {
      total: m1,
      share: { num: 1n, den: 3n },
      count: 9007199254740993n,
      ok: true,
      off: false,
      gone: null,
      skipped: undefined,
      name: 'Café',
      lines: [{ merchant: 'Biedronka', amount: m2 }, 'x'],
      odd: { minor: 5n, currency: 'PLN', note: 'kept' },
      meta: { depth: { n: 1 } },
    };
    expect(layoutBody(body)).toEqual([
      'Total: ' + formatMoney(m1),
      'Share: 1/3',
      'Count: 9007199254740993',
      'Ok: yes',
      'Off: no',
      'Gone: none',
      'Name: Café',
      'Lines:',
      '  -',
      '    Merchant: Biedronka',
      '    Amount: ' + formatMoney(m2),
      '  - x',
      'Odd:',
      '  Minor: 5',
      '  Currency: PLN',
      '  Note: kept',
      'Meta:',
      '  Depth:',
      '    N: 1',
    ]);
  });

  test('a scalar body gives one line', async () => {
    const { layoutBody } = await renderModule();
    const { formatMoney } = await moneyModule();
    const m1: Money = { minor: -235n, currency: 'PLN' };
    expect(layoutBody('hello')).toEqual(['hello']);
    expect(layoutBody(m1)).toEqual([formatMoney(m1)]);
  });
});

describe('formatHead order and covered ranges', () => {
  test('title, as-of, currency, scope, period, covered ranges, then other statements in key order', async () => {
    const { formatHead } = await renderModule();
    const e = baseEnvelope();
    expect(formatHead(e as never, 'Balance and net position')).toEqual(HEAD_LINES);
  });
});

describe('formatHead edge cases', () => {
  const tail = [
    'As of: 2026-11-22T10:00:00+01:00 (Europe/Warsaw)',
    'Display currency: PLN',
    'Scope:',
    '  Narrowing: none',
    '  Sources: none',
    '  Not offering: none',
  ];
  const edge = (statements: Record<string, unknown>) => ({
    ...baseEnvelope(),
    period: null,
    scope: { narrowing: null, sources: [], notOffering: [] },
    statements,
  });

  test('empty covered statement is nothing held, absent is not stated, null period has no line', async () => {
    const { formatHead } = await renderModule();
    const empty = formatHead(edge({ coveredRanges: [], ratesUsed: [] }) as never, 'T');
    expect(empty).toEqual(['T', ...tail, 'Covered ranges: nothing held', 'Rates used: none']);
    const absent = formatHead(edge({ ratesUsed: [] }) as never, 'T');
    expect(absent).toEqual(['T', ...tail, 'Covered ranges: not stated', 'Rates used: none']);
    for (const line of [...empty, ...absent]) expect(line.startsWith('Period:')).toBe(false);
  });
});

describe('formatAnswer shapes', () => {
  test('answered: head then body, catalogue title, no trailing newline', async () => {
    const { formatAnswer, formatHead } = await renderModule();
    const { CATALOGUE_ENTRIES } = await catalogueModule();
    const { formatMoney } = await moneyModule();
    const net: Money = { minor: -235n, currency: 'PLN' };
    const e = { ...baseEnvelope(), outcome: { kind: 'answered', body: { netPosition: net, accounts: [] } } };
    const text = formatAnswer(e as never, CATALOGUE_ENTRIES);
    expect(text).toBe(
      [...formatHead(e as never, 'Balance and net position'), 'Net position: ' + formatMoney(net), 'Accounts: none'].join(
        '\n',
      ),
    );
    expect(text.endsWith('\n')).toBe(false);
  });

  test('not available: one Not offered line under the catalogue title', async () => {
    const { formatAnswer } = await renderModule();
    const { CATALOGUE_ENTRIES } = await catalogueModule();
    const e = {
      ...baseEnvelope(),
      family: 'jars',
      outcome: { kind: 'not_available', capability: 'jars', sources: ['second', 'third'] },
    };
    const lines = formatAnswer(e as never, CATALOGUE_ENTRIES).split('\n');
    expect(lines[0]).toBe('Savings jars');
    expect(lines[lines.length - 1]).toBe('Not offered: no source in scope offers jars (second, third)');
  });

  test('a family unknown to the catalogue is titled by its family name', async () => {
    const { formatAnswer } = await renderModule();
    const { CATALOGUE_ENTRIES } = await catalogueModule();
    const e = { ...baseEnvelope(), family: 'trends', outcome: { kind: 'answered', body: {} } };
    expect(formatAnswer(e as never, CATALOGUE_ENTRIES).split('\n')[0]).toBe('trends');
  });

  test('a refusal renders as formatRefusal of it', async () => {
    const { formatAnswer, formatRefusal } = await renderModule();
    const { CATALOGUE_ENTRIES } = await catalogueModule();
    const { refuse } = await primitivesModule();
    const r = refuse('scope_not_found', 'narrowing', 'No source or holding is named "Savings".', 'Savings');
    expect(formatAnswer(r, CATALOGUE_ENTRIES)).toBe(formatRefusal(r));
  });
});

describe('refusal texts', () => {
  test('formatRefusal names the subject', async () => {
    const { formatRefusal } = await renderModule();
    const { refuse } = await primitivesModule();
    const r = refuse('bad_option', 'minAmount', 'minAmount takes decimal text such as "12.50", not a number.', '0.29');
    expect(formatRefusal(r)).toBe(
      'Refused (minAmount): minAmount takes decimal text such as "12.50", not a number.',
    );
  });

  test('formatOpenRefusal names ARCANUM_STORAGE and the location as given', async () => {
    const { formatOpenRefusal } = await renderModule();
    const { SHARED_NAMES } = await settingsModule();
    expect(SHARED_NAMES.storage).toBe('ARCANUM_STORAGE');
    expect(formatOpenRefusal({ kind: 'no_local_copy', location: '/d/a.db' })).toBe(
      'ARCANUM_STORAGE "/d/a.db": no local copy exists at this location; the service or a backfill creates one.',
    );
    expect(formatOpenRefusal({ kind: 'open_failed', location: '/d/a.db', why: 'file is not a database' })).toBe(
      'ARCANUM_STORAGE "/d/a.db": the local copy cannot be opened: file is not a database',
    );
    expect(
      formatOpenRefusal({ kind: 'no_local_copy', location: 'data/../My Data/a.db' }).startsWith(
        'ARCANUM_STORAGE "data/../My Data/a.db": ',
      ),
    ).toBe(true);
  });
});

describe('answerJson converts exactly', () => {
  test('deep copy with Money as amount text, Fractions and bigints as strings, agreeing with the text', async () => {
    const { answerJson, formatAnswer } = await renderModule();
    const { CATALOGUE_ENTRIES } = await catalogueModule();
    const { formatMoney } = await moneyModule();
    const m1: Money = { minor: -235n, currency: 'PLN' };
    const m2: Money = { minor: 1099n, currency: 'PLN' };
    const m3: Money = { minor: 5n, currency: 'UAH' };
    const amt = (m: Money) => formatMoney(m).slice(0, -(' ' + m.currency).length);
    const e = {
      ...baseEnvelope(),
      outcome: {
        kind: 'answered',
        body: {
          total: m1,
          small: m3,
          share: { num: 1n, den: 3n },
          count: 9007199254740993n,
          gone: undefined,
          lines: [{ amount: m2, note: null, ok: true, n: 2 }],
        },
      },
    };
    const j = answerJson(e as never) as any;

    expect(Object.keys(j)).toEqual(Object.keys(e));
    expect(j.outcome.body).toEqual({
      total: { amount: '-2.35', currency: 'PLN' },
      small: { amount: amt(m3), currency: 'UAH' },
      share: { num: '1', den: '3' },
      count: '9007199254740993',
      lines: [{ amount: { amount: amt(m2), currency: 'PLN' }, note: null, ok: true, n: 2 }],
    });
    expect(amt(m2)).toBe('10.99');
    expect('gone' in j.outcome.body).toBe(false);
    expect(j.statements.ratesUsed[0].rate).toEqual({ num: '73111', den: '20000' });
    expect(() => JSON.stringify(j)).not.toThrow();

    const text = formatAnswer(e as never, CATALOGUE_ENTRIES);
    const jsonOf: [Money, { amount: string; currency: string }][] = [
      [m1, j.outcome.body.total],
      [m2, j.outcome.body.lines[0].amount],
      [m3, j.outcome.body.small],
    ];
    for (const [m, jm] of jsonOf) {
      expect(text).toContain(formatMoney(m));
      expect(jm.amount + ' ' + jm.currency).toBe(formatMoney(m));
    }

    expect(e.outcome.body.total.minor).toBe(-235n);
  });
});
