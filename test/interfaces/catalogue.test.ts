// Option catalogue (S-173): one entry per question family, declaring its tool, command, title and
// typed options once; both front ends are generated from it and parse through it. The shared
// narrowing, period and display-currency options are included by identity, the parse of either
// wire refuses every shape fault naming the option, and both wires give equal drafts.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const catalogueModule = () => import('../../src/interfaces/catalogue');
const primitivesModule = () => import('../../src/core/primitives');
const breakdownModule = () => import('../../src/families/breakdown');

// Loose views of the module's shapes, so the assertions can reach into drafts and schemas.
type AnyEntry = {
  family: string;
  tool: string;
  command: string | null;
  title: string;
  description: string;
  options: readonly AnyOption[];
};
type AnyOption = {
  key: string;
  type: { kind: string; values?: readonly string[] };
  required: boolean;
  target: string;
  description: string;
};
type AnyResult = {
  kind?: string;
  reason?: string;
  subject?: string;
  message?: string;
  family?: string;
  narrowing?: string;
  period?: string;
  displayCurrency?: string;
  options: Record<string, unknown>;
};

async function load() {
  const m = await catalogueModule();
  const entries = m.CATALOGUE_ENTRIES as unknown as readonly AnyEntry[];
  const entry = (f: string): AnyEntry => {
    const e = entries.find((x) => x.family === f);
    if (e === undefined) throw new Error(`no catalogue entry for ${f}`);
    return e;
  };
  const opt = (e: AnyEntry, k: string): AnyOption => {
    const o = e.options.find((x) => x.key === k);
    if (o === undefined) throw new Error(`no option ${k} on ${e.family}`);
    return o;
  };
  const parse = (e: AnyEntry, raw: { wire: 'json'; args: unknown } | { wire: 'argv'; args: string[] }) =>
    (m.parseRaw as (e: unknown, r: unknown) => unknown)(e, raw) as AnyResult;
  const J = (f: string | AnyEntry, args: unknown) =>
    parse(typeof f === 'string' ? entry(f) : f, { wire: 'json', args });
  const A = (f: string | AnyEntry, args: string[]) =>
    parse(typeof f === 'string' ? entry(f) : f, { wire: 'argv', args });
  return { m, entries, entry, opt, J, A };
}

describe('option catalogue', () => {
  test('flagOf kebab-cases each upper-case letter', async () => {
    const { flagOf } = await catalogueModule();

    expect(flagOf('displayCurrency')).toBe('--display-currency');
    expect(flagOf('merchantCap')).toBe('--merchant-cap');
    expect(flagOf('minAmount')).toBe('--min-amount');
    expect(flagOf('maxAmount')).toBe('--max-amount');
    expect(flagOf('narrowing')).toBe('--narrowing');
  });

  test('CATALOGUE_ENTRIES is the declared table', async () => {
    const { m, entries: E } = await load();
    const { DISPLAY_CURRENCIES } = await primitivesModule();
    const { BREAKDOWN_GROUPINGS } = await breakdownModule();
    const NARROWING = m.NARROWING_OPTION as unknown as AnyOption;
    const PERIOD = m.PERIOD_OPTION as unknown as AnyOption;
    const DISPLAY = m.DISPLAY_CURRENCY_OPTION as unknown as AnyOption;

    expect(E.map((e) => e.family)).toEqual([
      'balance',
      'jars',
      'transaction_search',
      'spending_breakdown',
      'exchange_rates',
      'foreign_spending',
      'holdings',
      'new_since_last_asked',
    ]);
    for (const e of E) expect(e.tool).toBe(e.family);
    expect(E.map((e) => e.command)).toEqual([
      'balance',
      'jars',
      'search',
      'breakdown',
      'rates',
      'foreign',
      'holdings',
      null,
    ]);
    expect(E.map((e) => e.title)).toEqual([
      'Balance and net position',
      'Savings jars',
      'Transaction search',
      'Spending breakdown',
      'Exchange rates',
      'Foreign-currency spending',
      'Sources and accounts',
      'New since last asked',
    ]);

    expect(Object.fromEntries(E.map((e) => [e.family, e.options.map((o) => o.key)]))).toEqual({
      balance: ['narrowing', 'displayCurrency'],
      jars: ['narrowing', 'displayCurrency'],
      transaction_search: [
        'narrowing',
        'period',
        'displayCurrency',
        'text',
        'merchant',
        'category',
        'minAmount',
        'maxAmount',
      ],
      spending_breakdown: ['narrowing', 'period', 'displayCurrency', 'grouping', 'merchantCap'],
      exchange_rates: ['currencies'],
      foreign_spending: ['narrowing', 'period', 'displayCurrency', 'currency'],
      holdings: ['narrowing'],
      new_since_last_asked: ['narrowing', 'displayCurrency', 'cap'],
    });

    expect(DISPLAY.type.kind).toBe('choice');
    expect(DISPLAY.type.values).toBe(DISPLAY_CURRENCIES);
    expect(NARROWING.target).toBe('narrowing');
    expect(PERIOD.target).toBe('period');
    expect(DISPLAY.target).toBe('displayCurrency');

    for (const e of E) {
      for (const o of e.options) {
        expect(o.required).toBe(false);
        expect(o.key).toMatch(/^[a-z][a-zA-Z]*$/);
        if (o.key === 'narrowing') expect(o).toBe(NARROWING);
        else if (o.key === 'period') expect(o).toBe(PERIOD);
        else if (o.key === 'displayCurrency') expect(o).toBe(DISPLAY);
        else expect(o.target).toBe('options');

        if (o.key === 'minAmount' || o.key === 'maxAmount') expect(o.type).toEqual({ kind: 'decimal' });
        if (o.key === 'merchantCap' || o.key === 'cap') expect(o.type).toEqual({ kind: 'number' });
        if (o.key === 'currencies') expect(o.type).toEqual({ kind: 'text_list' });
        if (['text', 'merchant', 'category', 'currency'].includes(o.key)) {
          expect(o.type).toEqual({ kind: 'text' });
        }
        if (o.key === 'grouping') {
          expect(o.type.kind).toBe('choice');
          expect(o.type.values).toEqual(BREAKDOWN_GROUPINGS);
        }
      }
    }
  });

  test('both wires give equal drafts', async () => {
    const { J, A } = await load();
    const { BREAKDOWN_GROUPINGS } = await breakdownModule();

    // 1. Search: shared fields as the draft's own, decimals as the same text through both wires.
    const j = J('transaction_search', {
      narrowing: 'Card',
      period: 'last-month',
      displayCurrency: 'USD',
      text: 'flat white',
      minAmount: '0.29',
      maxAmount: '12.50',
    });
    const a = A('transaction_search', [
      '--narrowing',
      'Card',
      '--period=last-month',
      '--display-currency',
      'USD',
      '--text',
      'flat white',
      '--min-amount',
      '0.29',
      '--max-amount=12.50',
    ]);
    const expected = {
      family: 'transaction_search',
      narrowing: 'Card',
      period: 'last-month',
      displayCurrency: 'USD',
      options: { text: 'flat white', minAmount: '0.29', maxAmount: '12.50' },
    };
    for (const d of [j, a]) {
      expect(d).toEqual(expected);
      expect(Object.keys(d).sort()).toEqual(['displayCurrency', 'family', 'narrowing', 'options', 'period']);
      expect(Object.keys(d.options).sort()).toEqual(['maxAmount', 'minAmount', 'text']);
      expect(Object.isFrozen(d.options)).toBe(true);
      expect(typeof d.options.minAmount).toBe('string');
    }

    // 2. Breakdown: a number option is a number through both wires.
    const g = BREAKDOWN_GROUPINGS[0];
    for (const d of [
      J('spending_breakdown', { grouping: g, merchantCap: 5 }),
      A('spending_breakdown', ['--grouping', g, '--merchant-cap', '5']),
    ]) {
      expect(d.options).toEqual({ grouping: g, merchantCap: 5 });
      expect(typeof d.options.merchantCap).toBe('number');
    }

    // 3. Rates: a list is an array, split at ',' on the command line.
    for (const d of [
      J('exchange_rates', { currencies: ['USD', 'EUR'] }),
      A('exchange_rates', ['--currencies', 'USD,EUR']),
    ]) {
      expect(d.options.currencies).toEqual(['USD', 'EUR']);
    }

    // 4. The value is everything after the first '='.
    expect(A('transaction_search', ['--text=a=b']).options.text).toBe('a=b');

    // 5. The next token is the value whatever it is.
    const five = A('transaction_search', ['--text', '--merchant']);
    expect(five.options.text).toBe('--merchant');
    expect('merchant' in five.options).toBe(false);

    // 6. Absent options add no key.
    const bal = J('balance', undefined);
    expect(bal).toEqual({ family: 'balance', options: {} });
    expect(Object.keys(bal).sort()).toEqual(['family', 'options']);
    expect(Object.keys(J('transaction_search', { text: undefined }).options)).toEqual([]);
  });

  test('json wire refuses shape faults naming the option', async () => {
    const { J } = await load();
    const { isRefusal } = await primitivesModule();
    const { BREAKDOWN_GROUPINGS } = await breakdownModule();

    const refused = (r: AnyResult, subject: string): AnyResult => {
      expect(isRefusal(r)).toBe(true);
      expect(r.reason).toBe('bad_option');
      expect(r.subject).toBe(subject);
      return r;
    };

    refused(J('balance', null), 'arguments');
    refused(J('balance', []), 'arguments');
    refused(J('balance', 'x'), 'arguments');
    expect(refused(J('balance', { foo: 1 }), 'foo').message).toBe('"foo" is not an option of balance.');
    refused(J('balance', { asker: 'command_line' }), 'asker');
    refused(J('balance', { narrowing: null }), 'narrowing');
    refused(J('balance', { narrowing: 5 }), 'narrowing');

    expect(refused(J('transaction_search', { minAmount: 0.29 }), 'minAmount').message).toBe(
      'minAmount takes decimal text such as "12.50", not a number.',
    );
    refused(J('transaction_search', { maxAmount: '1e2' }), 'maxAmount');
    refused(J('transaction_search', { category: ['Groceries'] }), 'category');

    refused(J('spending_breakdown', { merchantCap: '5' }), 'merchantCap');
    refused(J('spending_breakdown', { merchantCap: NaN }), 'merchantCap');
    refused(J('spending_breakdown', { merchantCap: Infinity }), 'merchantCap');
    expect((BREAKDOWN_GROUPINGS as readonly string[]).includes('fortnight')).toBe(false);
    expect(refused(J('spending_breakdown', { grouping: 'fortnight' }), 'grouping').message).toBe(
      'grouping "fortnight" is not one of: ' + BREAKDOWN_GROUPINGS.join(', ') + '.',
    );

    refused(J('exchange_rates', { currencies: 'USD' }), 'currencies');
    refused(J('exchange_rates', { currencies: ['USD', 3] }), 'currencies');

    // First fault: unknown keys before any declared value; declared values in declared order.
    refused(J('transaction_search', { minAmount: 0.29, foo: 1 }), 'foo');
    refused(J('transaction_search', { maxAmount: 0.5, minAmount: 0.29 }), 'minAmount');
  });

  test('argv wire refuses shape faults naming the option', async () => {
    const { A } = await load();
    const { isRefusal } = await primitivesModule();

    const refused = (r: AnyResult, subject: string): AnyResult => {
      expect(isRefusal(r)).toBe(true);
      expect(r.reason).toBe('bad_option');
      expect(r.subject).toBe(subject);
      return r;
    };

    refused(A('transaction_search', ['--colour', 'red']), '--colour');
    refused(A('transaction_search', ['--minAmount', '1']), '--minAmount');
    expect(refused(A('transaction_search', ['--text', 'a', '--text', 'b']), 'text').message).toBe(
      '--text is given twice.',
    );
    expect(refused(A('transaction_search', ['--text=a', '--text', 'b']), 'text').message).toBe(
      '--text is given twice.',
    );
    expect(refused(A('transaction_search', ['--merchant']), 'merchant').message).toContain('has no value');
    expect(refused(A('transaction_search', ['coffee']), 'coffee').message).toBe('Unexpected argument "coffee".');
    refused(A('transaction_search', ['--text', 'a', 'b']), 'b');
    refused(A('transaction_search', ['--min-amount', '.5']), 'minAmount');
    refused(A('transaction_search', ['--min-amount', '5.']), 'minAmount');
    refused(A('transaction_search', ['--max-amount', '1e2']), 'maxAmount');

    refused(A('spending_breakdown', ['--merchant-cap', 'five']), 'merchantCap');
    refused(A('spending_breakdown', ['--merchant-cap', '1e2']), 'merchantCap');
    refused(A('spending_breakdown', ['--merchant-cap', '']), 'merchantCap');
    refused(A('spending_breakdown', ['--merchant-cap', '0x10']), 'merchantCap');
    refused(A('spending_breakdown', ['--grouping', 'fortnight']), 'grouping');

    // Range is the family's rule, not the parse's.
    const cap = A('spending_breakdown', ['--merchant-cap', '-3']);
    expect(isRefusal(cap)).toBe(false);
    expect(cap.options.merchantCap).toBe(-3);
    const min = A('transaction_search', ['--min-amount', '-0.5']);
    expect(isRefusal(min)).toBe(false);
    expect(min.options.minAmount).toBe('-0.5');
  });

  test('display currency is a closed list at parse', async () => {
    const { J, A } = await load();
    const { isRefusal, DISPLAY_CURRENCIES } = await primitivesModule();

    const both = (v: string) => [
      J('balance', { displayCurrency: v }),
      A('balance', ['--display-currency', v]),
    ];

    expect('Display currency "GBP" is not supported. Use one of: ' + DISPLAY_CURRENCIES.join(', ') + '.').toBe(
      'Display currency "GBP" is not supported. Use one of: PLN, UAH, USD, EUR.',
    );
    for (const v of ['GBP', 'pln']) {
      for (const r of both(v)) {
        expect(isRefusal(r)).toBe(true);
        expect(r.reason).toBe('bad_display_currency');
        expect(r.subject).toBe('displayCurrency');
        expect(r.message).toBe(
          `Display currency "${v}" is not supported. Use one of: ` + DISPLAY_CURRENCIES.join(', ') + '.',
        );
      }
    }

    for (const c of DISPLAY_CURRENCIES) {
      for (const d of both(c)) {
        expect(isRefusal(d)).toBe(false);
        expect(d.displayCurrency).toBe(c);
        expect(Object.keys(d.options)).toEqual([]);
      }
    }

    const wrongType = J('balance', { displayCurrency: 840 });
    expect(isRefusal(wrongType)).toBe(true);
    expect(wrongType.subject).toBe('displayCurrency');
  });

  test('toolInputSchema renders each option type', async () => {
    const { m, entry, opt } = await load();
    const { DISPLAY_CURRENCIES } = await primitivesModule();
    const { BREAKDOWN_GROUPINGS } = await breakdownModule();
    const NARROWING = m.NARROWING_OPTION as unknown as AnyOption;
    const DISPLAY = m.DISPLAY_CURRENCY_OPTION as unknown as AnyOption;
    const schema = (e: unknown) =>
      (m.toolInputSchema as (e: unknown) => unknown)(e) as {
        type: string;
        properties: Record<string, Record<string, unknown>>;
        required: string[];
        additionalProperties: unknown;
      };

    // 1. Search.
    const search = entry('transaction_search');
    const s = schema(search);
    expect(s.type).toBe('object');
    expect(Object.keys(s.properties)).toEqual([
      'narrowing',
      'period',
      'displayCurrency',
      'text',
      'merchant',
      'category',
      'minAmount',
      'maxAmount',
    ]);
    expect(s.required).toEqual([]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.minAmount).toEqual({
      type: 'string',
      pattern: m.DECIMAL_TEXT.source,
      description: opt(search, 'minAmount').description + ' Written as decimal text, for example "12.50".',
    });
    const pattern = new RegExp(s.properties.minAmount.pattern as string);
    expect(pattern.test('0.29')).toBe(true);
    expect(pattern.test('1e2')).toBe(false);
    expect(s.properties.displayCurrency).toEqual({
      type: 'string',
      enum: [...DISPLAY_CURRENCIES],
      description: DISPLAY.description,
    });
    expect(s.properties.narrowing).toEqual({ type: 'string', description: NARROWING.description });

    // 2. Breakdown.
    const breakdown = entry('spending_breakdown');
    const b = schema(breakdown).properties;
    expect(b.merchantCap).toEqual({ type: 'number', description: opt(breakdown, 'merchantCap').description });
    expect(b.grouping).toEqual({
      type: 'string',
      enum: [...BREAKDOWN_GROUPINGS],
      description: opt(breakdown, 'grouping').description,
    });

    // 3. Rates.
    const rates = entry('exchange_rates');
    expect(schema(rates).properties.currencies).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: opt(rates, 'currencies').description,
    });

    // 4. A required option is listed.
    const X = {
      family: 'x',
      tool: 'x',
      command: 'x',
      title: 'X',
      description: 'D.',
      options: [
        { key: 'name', type: { kind: 'text' }, required: true, target: 'options', description: 'N.' },
        NARROWING,
      ],
    };
    expect(schema(X).required).toEqual(['name']);
  });

  test('buildCatalogue joins and refuses duplicates', async () => {
    const { m, entries } = await load();
    const build = m.buildCatalogue as unknown as (...parts: unknown[]) => readonly unknown[];
    const trends = {
      family: 'trends',
      tool: 'trends',
      command: null,
      title: 'Trends',
      description: 'How spending moves across months.',
      options: [m.NARROWING_OPTION, m.PERIOD_OPTION, m.DISPLAY_CURRENCY_OPTION],
    };

    // 1. Joined in order and frozen; two entries without a command are allowed.
    const c = build(entries, [trends]);
    expect(c.length).toBe(9);
    for (let i = 0; i < 8; i++) expect(c[i]).toBe(entries[i]);
    expect(c[8]).toBe(trends);
    expect(Object.isFrozen(c)).toBe(true);

    // 2. Each duplicate throws a CatalogueError naming it.
    const throwsNaming = (f: () => unknown, ...names: string[]) => {
      let thrown: unknown;
      try {
        f();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(m.CatalogueError);
      const message = (thrown as Error).message;
      expect(names.some((n) => message.includes(n))).toBe(true);
    };
    throwsNaming(() => build(entries, [{ ...trends, family: 'balance' }]), 'balance');
    throwsNaming(() => build(entries, [{ ...trends, tool: 'jars' }]), 'jars');
    throwsNaming(() => build(entries, [{ ...trends, command: 'search' }]), 'search');
    throwsNaming(() => build([{ ...trends, options: [m.NARROWING_OPTION, m.NARROWING_OPTION] }]), 'narrowing');
    throwsNaming(
      () =>
        build([
          {
            ...trends,
            options: [{ key: 'help', type: { kind: 'text' }, required: false, target: 'options', description: 'h' }],
          },
        ]),
      '--help',
      'help',
    );
  });

  test('catalogueFaults lists missing entries only, in handed order', async () => {
    const { m, entries } = await load();
    const faults = m.catalogueFaults as unknown as (names: readonly string[], c: unknown) => string[];

    expect(faults(['weekly_report', 'balance', 'trends'], entries)).toEqual([
      'wiring fault: answer family "weekly_report" has no catalogue entry',
      'wiring fault: answer family "trends" has no catalogue entry',
    ]);
    expect(faults(entries.map((e) => e.family), entries)).toEqual([]);
    expect(faults(['balance'], entries)).toEqual([]);
    expect(faults([], entries)).toEqual([]);
  });

  test('commandUsage and required options', async () => {
    const { m, entry, opt, J, A } = await load();
    const { isRefusal, DISPLAY_CURRENCIES } = await primitivesModule();
    const { BREAKDOWN_GROUPINGS } = await breakdownModule();
    const NARROWING = m.NARROWING_OPTION as unknown as AnyOption;
    const PERIOD = m.PERIOD_OPTION as unknown as AnyOption;
    const DISPLAY = m.DISPLAY_CURRENCY_OPTION as unknown as AnyOption;
    const usage = m.commandUsage as unknown as (e: unknown) => string;
    const lines = (e: unknown) => usage(e).replace(/\n$/, '').split('\n');

    // 1. Breakdown.
    const e = entry('spending_breakdown');
    const currencies = '<' + DISPLAY_CURRENCIES.join('|') + '>';
    const groupings = '<' + BREAKDOWN_GROUPINGS.join('|') + '>';
    expect(lines(e)).toEqual([
      'Usage: breakdown [--narrowing <text>] [--period <text>] [--display-currency ' +
        currencies +
        '] [--grouping ' +
        groupings +
        '] [--merchant-cap <number>]',
      e.description,
      '  --narrowing <text>  ' + NARROWING.description,
      '  --period <text>  ' + PERIOD.description,
      '  --display-currency ' + currencies + '  ' + DISPLAY.description,
      '  --grouping ' + groupings + '  ' + opt(e, 'grouping').description,
      '  --merchant-cap <number>  ' + opt(e, 'merchantCap').description,
    ]);

    // 2. A list's value form.
    const rates = entry('exchange_rates');
    expect(lines(rates)[2]).toBe('  --currencies <a,b,...>  ' + opt(rates, 'currencies').description);

    // 3. A decimal's value form.
    const search = entry('transaction_search');
    expect(lines(search)).toContain('  --min-amount <decimal>  ' + opt(search, 'minAmount').description);

    // 4. A required option: no brackets, and refused when missing on both wires.
    const X = {
      family: 'x',
      tool: 'x',
      command: 'x',
      title: 'X',
      description: 'D.',
      options: [
        { key: 'name', type: { kind: 'text' }, required: true, target: 'options', description: 'N.' },
        NARROWING,
      ],
    };
    expect(lines(X)[0]).toBe('Usage: x --name <text> [--narrowing <text>]');

    const rj = J(X, {});
    expect(isRefusal(rj)).toBe(true);
    expect(rj.reason).toBe('bad_option');
    expect(rj.subject).toBe('name');
    expect(rj.message).toContain('missing');

    const ra = A(X, []);
    expect(isRefusal(ra)).toBe(true);
    expect(ra.reason).toBe('bad_option');
    expect(ra.subject).toBe('name');
  });
});
