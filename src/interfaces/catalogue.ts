// Option catalogue (S-173): the single declaration of what each question family accepts. Both front
// ends are generated from it (the assistant's tool input schemas, the command line's flags and help)
// and both parse through it, so the same raw options give the same draft through either wire. The
// parse owns shape only: value rules that need the frame or the local copy stay in the families.

import { DISPLAY_CURRENCIES, isRefusal, refuse, type Refusal } from '../core/primitives';
import type { QuestionDraft } from '../core/question';
import { BREAKDOWN_GROUPINGS, DEFAULT_GROUPING, DEFAULT_MERCHANT_CAP } from '../families/breakdown';
import { NEW_CAP_DEFAULT, NEW_CAP_MAX, NEW_CAP_MIN } from '../families/new';
import { DEFAULT_RATE_CURRENCIES } from '../families/rates';
import { CATEGORIES } from '../local/classifier';

export type OptionType =
  | { kind: 'text' }                               // any string
  | { kind: 'number' }                             // a finite number; range and wholeness stay the family's value rules
  | { kind: 'decimal' }                            // text matching DECIMAL_TEXT, carried on as that same text
  | { kind: 'choice'; values: readonly string[] }  // exactly one of values, case-sensitive
  | { kind: 'text_list' };                         // a list of strings
export type OptionTarget = 'narrowing' | 'period' | 'displayCurrency' | 'options';
export interface OptionSpec {
  key: string;            // /^[a-z][a-zA-Z]*$/: the tool argument name, and the subject of every refusal of it
  type: OptionType;
  required: boolean;
  target: OptionTarget;   // where the parsed value goes in the QuestionDraft ('options': under options[key])
  description: string;
}
export interface CatalogueEntry {
  family: string;          // the Family.name it parses for
  tool: string;            // the assistant's tool name
  command: string | null;  // the command-line command; null: not offered at the command line
  title: string;           // heading of every rendering of this family's answers
  description: string;
  options: readonly OptionSpec[];
}
export type Catalogue = readonly CatalogueEntry[];
export class CatalogueError extends Error {}

export const DECIMAL_TEXT: RegExp = /^-?[0-9]+(\.[0-9]+)?$/; // the grammar of S-16's parseExactDecimal

export const NARROWING_OPTION: OptionSpec = Object.freeze({
  key: 'narrowing',
  type: Object.freeze({ kind: 'text' as const }),
  required: false,
  target: 'narrowing' as const,
  description:
    'Narrow the answer to one source, by its id, or one account or jar, by its name as the sources-and-accounts listing gives it; absent: every source',
});
export const PERIOD_OPTION: OptionSpec = Object.freeze({
  key: 'period',
  type: Object.freeze({ kind: 'text' as const }),
  required: false,
  target: 'period' as const,
  description:
    "The period, as the calendar reads it, for example last-month or 2026-10-01..2026-10-31; absent: the question's default",
});
export const DISPLAY_CURRENCY_OPTION: OptionSpec = Object.freeze({
  key: 'displayCurrency',
  type: Object.freeze({ kind: 'choice' as const, values: DISPLAY_CURRENCIES }), // that very list, never a copy
  required: false,
  target: 'displayCurrency' as const,
  description: 'The currency amounts are shown in; absent: PLN',
});

function own(key: string, type: OptionType, description: string): OptionSpec {
  return Object.freeze({ key, type: Object.freeze(type), required: false, target: 'options' as const, description });
}

function entry(
  family: string,
  command: string | null,
  title: string,
  description: string,
  options: readonly OptionSpec[],
): CatalogueEntry {
  return Object.freeze({ family, tool: family, command, title, description, options: Object.freeze([...options]) });
}

export const CATALOGUE_ENTRIES: readonly CatalogueEntry[] = Object.freeze([
  entry(
    'balance',
    'balance',
    'Balance and net position',
    'What each account holds now and the net position across them.',
    [NARROWING_OPTION, DISPLAY_CURRENCY_OPTION],
  ),
  entry('jars', 'jars', 'Savings jars', 'What each savings jar holds now and how far it is towards its goal.', [
    NARROWING_OPTION,
    DISPLAY_CURRENCY_OPTION,
  ]),
  entry(
    'transaction_search',
    'search',
    'Transaction search',
    'Which transactions in the period match the words, merchant, category and amount range given.',
    [
      NARROWING_OPTION,
      PERIOD_OPTION,
      DISPLAY_CURRENCY_OPTION,
      own('text', { kind: 'text' }, 'Words found in the merchant or description'),
      own('merchant', { kind: 'text' }, 'The whole merchant name'),
      own('category', { kind: 'text' }, 'One of: ' + CATEGORIES.join(', ')),
      own(
        'minAmount',
        { kind: 'decimal' },
        "Inclusive lower bound on each transaction's size in the display currency",
      ),
      own(
        'maxAmount',
        { kind: 'decimal' },
        "Inclusive upper bound on each transaction's size in the display currency",
      ),
    ],
  ),
  entry(
    'spending_breakdown',
    'breakdown',
    'Spending breakdown',
    'Where the money went in the period, grouped by category, merchant or time, with total spending, refunds and net spending.',
    [
      NARROWING_OPTION,
      PERIOD_OPTION,
      DISPLAY_CURRENCY_OPTION,
      own(
        'grouping',
        { kind: 'choice', values: BREAKDOWN_GROUPINGS },
        'How to group the spending; ' + DEFAULT_GROUPING + ' when omitted',
      ),
      own(
        'merchantCap',
        { kind: 'number' },
        'How many merchant groups to show, a whole number of 1 or more; ' + DEFAULT_MERCHANT_CAP + ' when omitted',
      ),
    ],
  ),
  entry(
    'exchange_rates',
    'rates',
    'Exchange rates',
    'The latest held exchange rate of each requested currency against the hryvnia, as quoted.',
    [
      own(
        'currencies',
        { kind: 'text_list' },
        'The currencies to show against the hryvnia; ' + DEFAULT_RATE_CURRENCIES.join(', ') + ' when omitted',
      ),
    ],
  ),
  entry(
    'foreign_spending',
    'foreign',
    'Foreign-currency spending',
    'What was spent in currencies other than the account currency in the period, by original currency.',
    [
      NARROWING_OPTION,
      PERIOD_OPTION,
      DISPLAY_CURRENCY_OPTION,
      own('currency', { kind: 'text' }, 'One original currency code to narrow to'),
    ],
  ),
  entry(
    'holdings',
    'holdings',
    'Sources and accounts',
    'Which sources, accounts and jars are held, by the names a question can narrow to.',
    [NARROWING_OPTION],
  ),
  entry(
    'new_since_last_asked',
    null,
    'New since last asked',
    'Which transactions have arrived since this was last asked.',
    [
      NARROWING_OPTION,
      DISPLAY_CURRENCY_OPTION,
      own(
        'cap',
        { kind: 'number' },
        'how many new transactions to list in this answer, a whole number from ' +
          NEW_CAP_MIN +
          ' to ' +
          NEW_CAP_MAX +
          '; ' +
          NEW_CAP_DEFAULT +
          ' when omitted',
      ),
    ],
  ),
]);

export function flagOf(key: string): string {
  return '--' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

export function buildCatalogue(...parts: readonly (readonly CatalogueEntry[])[]): Catalogue {
  const all: CatalogueEntry[] = parts.flatMap((p) => [...p]);
  const families = new Set<string>();
  const tools = new Set<string>();
  const commands = new Set<string>();
  for (const e of all) {
    if (families.has(e.family)) throw new CatalogueError(`Two catalogue entries share the family "${e.family}".`);
    families.add(e.family);
    if (tools.has(e.tool)) throw new CatalogueError(`Two catalogue entries share the tool "${e.tool}".`);
    tools.add(e.tool);
    if (e.command !== null) {
      if (commands.has(e.command)) {
        throw new CatalogueError(`Two catalogue entries share the command "${e.command}".`);
      }
      commands.add(e.command);
    }
    const keys = new Set<string>();
    for (const o of e.options) {
      if (keys.has(o.key)) throw new CatalogueError(`The entry "${e.family}" has two options with the key "${o.key}".`);
      keys.add(o.key);
      if (flagOf(o.key) === '--help') {
        throw new CatalogueError(`The entry "${e.family}" has an option "${o.key}" whose flag is --help.`);
      }
    }
  }
  return Object.freeze(all);
}

export type RawInput = { wire: 'json'; args: unknown } | { wire: 'argv'; args: readonly string[] };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function outOfChoice(o: OptionSpec, values: readonly string[], v: string): Refusal {
  if (o === DISPLAY_CURRENCY_OPTION) {
    return refuse(
      'bad_display_currency',
      'displayCurrency',
      'Display currency "' + v + '" is not supported. Use one of: ' + DISPLAY_CURRENCIES.join(', ') + '.',
      v,
    );
  }
  return refuse('bad_option', o.key, o.key + ' "' + v + '" is not one of: ' + values.join(', ') + '.', v);
}

function wrongType(o: OptionSpec, expected: string, value: unknown): Refusal {
  const shown = typeof value === 'string' ? value : value === undefined ? undefined : JSON.stringify(value) ?? String(value);
  return refuse('bad_option', o.key, o.key + ' takes ' + expected + '.', shown);
}

function expectedOf(t: OptionType): string {
  switch (t.kind) {
    case 'text':
      return 'text';
    case 'number':
      return 'a number';
    case 'decimal':
      return 'decimal text such as "12.50"';
    case 'choice':
      return 'one of: ' + t.values.join(', ');
    case 'text_list':
      return 'a list of text';
  }
}

function fromJson(o: OptionSpec, value: unknown): unknown {
  const t = o.type;
  switch (t.kind) {
    case 'text':
      return typeof value === 'string' ? value : wrongType(o, expectedOf(t), value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : wrongType(o, expectedOf(t), value);
    case 'decimal':
      if (typeof value === 'number') {
        return refuse('bad_option', o.key, o.key + ' takes decimal text such as "12.50", not a number.', String(value));
      }
      return typeof value === 'string' && DECIMAL_TEXT.test(value) ? value : wrongType(o, expectedOf(t), value);
    case 'choice':
      if (typeof value !== 'string') return wrongType(o, expectedOf(t), value);
      return t.values.includes(value) ? value : outOfChoice(o, t.values, value);
    case 'text_list':
      return Array.isArray(value) && value.every((m) => typeof m === 'string')
        ? [...value]
        : wrongType(o, expectedOf(t), value);
  }
}

function fromText(o: OptionSpec, v: string): unknown {
  const t = o.type;
  switch (t.kind) {
    case 'text':
      return v;
    case 'number':
      return DECIMAL_TEXT.test(v) ? Number(v) : wrongType(o, expectedOf(t), v);
    case 'decimal':
      return DECIMAL_TEXT.test(v) ? v : wrongType(o, expectedOf(t), v);
    case 'choice':
      return t.values.includes(v) ? v : outOfChoice(o, t.values, v);
    case 'text_list':
      return v.split(',');
  }
}

// Reads the argv tokens into the text given per declared key, or the first fault.
function readArgv(entry: CatalogueEntry, args: readonly string[]): Map<string, string> | Refusal {
  const given = new Map<string, string>();
  let i = 0;
  while (i < args.length) {
    const token = args[i] as string;
    if (!token.startsWith('--')) return refuse('bad_option', token, 'Unexpected argument "' + token + '".', token);
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    const o = entry.options.find((x) => flagOf(x.key) === flag);
    if (o === undefined) {
      return refuse('bad_option', flag, flag + ' is not an option of ' + entry.command + '.');
    }
    if (given.has(o.key)) return refuse('bad_option', o.key, flag + ' is given twice.');
    if (eq !== -1) {
      given.set(o.key, token.slice(eq + 1));
      i += 1;
    } else {
      if (i + 1 >= args.length) return refuse('bad_option', o.key, flag + ' (' + o.key + ') has no value.');
      given.set(o.key, args[i + 1] as string);
      i += 2;
    }
  }
  return given;
}

export function parseRaw(entry: CatalogueEntry, raw: RawInput): QuestionDraft | Refusal {
  const values = new Map<string, unknown>(); // key -> the raw value given, absent keys left out
  let read: (o: OptionSpec, v: unknown) => unknown;
  if (raw.wire === 'json') {
    const args = raw.args === undefined ? {} : raw.args;
    if (!isPlainObject(args)) {
      return refuse('bad_option', 'arguments', 'The arguments of ' + entry.tool + ' must be an object of options.');
    }
    for (const key of Object.keys(args)) {
      if (!entry.options.some((o) => o.key === key)) {
        return refuse('bad_option', key, '"' + key + '" is not an option of ' + entry.tool + '.');
      }
      if (args[key] !== undefined) values.set(key, args[key]);
    }
    read = fromJson;
  } else {
    const given = readArgv(entry, raw.args);
    if (given instanceof Map) for (const [k, v] of given) values.set(k, v);
    else return given;
    read = (o, v) => fromText(o, v as string);
  }

  const draft: { family: string; narrowing?: string; period?: string; displayCurrency?: string } = {
    family: entry.family,
  };
  const options: Record<string, unknown> = {};
  for (const o of entry.options) {
    if (!values.has(o.key)) {
      if (o.required) return refuse('bad_option', o.key, o.key + ' is missing; ' + entry.tool + ' requires it.');
      continue;
    }
    const parsed = read(o, values.get(o.key));
    if (isRefusal(parsed)) return parsed;
    if (o.target === 'options') options[o.key] = parsed;
    else draft[o.target] = parsed as string;
  }
  return { ...draft, options: Object.freeze(options) };
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}

export function toolInputSchema(entry: CatalogueEntry): ToolInputSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const o of entry.options) {
    const t = o.type;
    switch (t.kind) {
      case 'text':
        properties[o.key] = { type: 'string', description: o.description };
        break;
      case 'number':
        properties[o.key] = { type: 'number', description: o.description };
        break;
      case 'decimal':
        properties[o.key] = {
          type: 'string',
          pattern: DECIMAL_TEXT.source,
          description: o.description + ' Written as decimal text, for example "12.50".',
        };
        break;
      case 'choice':
        properties[o.key] = { type: 'string', enum: [...t.values], description: o.description };
        break;
      case 'text_list':
        properties[o.key] = { type: 'array', items: { type: 'string' }, description: o.description };
        break;
    }
  }
  return {
    type: 'object',
    properties,
    required: entry.options.filter((o) => o.required).map((o) => o.key),
    additionalProperties: false,
  };
}

function valueForm(t: OptionType): string {
  switch (t.kind) {
    case 'text':
      return '<text>';
    case 'number':
      return '<number>';
    case 'decimal':
      return '<decimal>';
    case 'choice':
      return '<' + t.values.join('|') + '>';
    case 'text_list':
      return '<a,b,...>';
  }
}

export function commandUsage(entry: CatalogueEntry): string {
  let usage = 'Usage: ' + entry.command;
  for (const o of entry.options) {
    const part = flagOf(o.key) + ' ' + valueForm(o.type);
    usage += o.required ? ' ' + part : ' [' + part + ']';
  }
  const lines = [usage, entry.description];
  for (const o of entry.options) lines.push('  ' + flagOf(o.key) + ' ' + valueForm(o.type) + '  ' + o.description);
  return lines.join('\n') + '\n';
}

export function catalogueFaults(familyNames: readonly string[], catalogue: Catalogue): string[] {
  return familyNames
    .filter((name) => !catalogue.some((e) => e.family === name))
    .map((name) => 'wiring fault: answer family "' + name + '" has no catalogue entry');
}
