// Monobank source (S-219): its declarations, the exact JSON reader, the translation of client info,
// statement items, statements and rates, and the push translator. Switched on by default, with jars
// and rates, a balance that includes the credit limit, one call a minute per call class and a window
// of 31 days and one hour. Nothing outside this module and its client knows Monobank's shape: past
// translation nothing distinguishes the source from the second source except its declarations.
//
// Every body is read with readJsonExact, so no figure ever passes through a floating-point number.
// This module calls nothing; the calls are in ./client, made only through cfg.http.

import type { Instant, SourceId } from '../../core/primitives';
import { type HoldingRow, narrowingName } from '../../core/register';
import type { SourceSettingsGroup } from '../../config/settings';
import type { Interval } from '../../local/covered';
import type { TranslatedTransaction } from '../../local/translated';
import { currencyByNumeric } from '../../money/currencies';
import { parseExactDecimal } from '../../money/exact';
import { type Money, money } from '../../money/money';
import type { QuarantineReason, Translated } from '../../money/quarantine';
import type { RateFigures, StatedRate } from '../../money/recorded-rates';
import type { ReportedBalance } from '../../sync/balances';
import type { RateLimitDecl } from '../../sync/rate-gate';
import {
  type HoldingsReport,
  type PushReading,
  type PushTranslator,
  type SourceDefinition,
  type WindowPage,
  PUSH_SETTING_DECLS,
  SourceCallError,
} from '../../sync/source-contract';
import { openMonobankClient } from './client';

export const MONOBANK_ID: SourceId = 'monobank';
export const MONOBANK_PAGE_CAP = 500; // most items one statement reply holds
export const MONOBANK_MAX_WINDOW_MS = 2_682_000_000; // 31 days and 1 hour
export const MONOBANK_LIMITS: RateLimitDecl = {
  windows: [
    { callClass: 'client_info', calls: 1, windowMs: 60_000 },
    { callClass: 'statement', calls: 1, windowMs: 60_000 },
    { callClass: 'webhook', calls: 1, windowMs: 60_000 },
    { callClass: 'currency', calls: 1, windowMs: 60_000 },
  ],
  marginMs: 2_000,
  refusalCooldownMs: 60_000,
};

export const settingsGroup: SourceSettingsGroup = {
  sourceId: 'monobank',
  enabledByDefault: true,
  baseAddressDefault: 'https://api.monobank.ua',
  needsCredential: true,
  extras: PUSH_SETTING_DECLS,
};

// --- exact JSON ------------------------------------------------------------------------------

export class JsonNumber {
  constructor(readonly text: string) {}
}

export type ExactJson = null | boolean | string | JsonNumber | ExactJson[] | { readonly [key: string]: ExactJson };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const SPACE = /[ \t\n\r]*/y;

class JsonSyntax extends Error {}

// A strict reader over one text: standard grammar, a repeated key keeping its last value.
function parseExact(text: string): ExactJson {
  let at = 0;
  const fail = (): never => {
    throw new JsonSyntax();
  };
  const space = () => {
    SPACE.lastIndex = at;
    SPACE.exec(text);
    at = SPACE.lastIndex;
  };
  const token = (re: RegExp): string | null => {
    re.lastIndex = at;
    const m = re.exec(text);
    if (m === null) return null;
    at = re.lastIndex;
    return m[0];
  };
  const literal = (word: string): boolean => {
    if (!text.startsWith(word, at)) return false;
    at += word.length;
    return true;
  };
  const string = (): string => {
    const s = token(STRING);
    return s === null ? fail() : (JSON.parse(s) as string);
  };
  const value = (): ExactJson => {
    space();
    const c = text[at];
    let v: ExactJson;
    if (c === '{') {
      at++;
      const obj: Record<string, ExactJson> = {};
      space();
      if (text[at] === '}') at++;
      else {
        for (;;) {
          space();
          const key = string();
          space();
          if (text[at++] !== ':') fail();
          // defineProperty, so a key such as '__proto__' is an ordinary own field.
          Object.defineProperty(obj, key, { value: value(), enumerable: true, writable: true, configurable: true });
          const sep = text[at++];
          if (sep === '}') break;
          if (sep !== ',') fail();
        }
      }
      v = obj;
    } else if (c === '[') {
      at++;
      const arr: ExactJson[] = [];
      space();
      if (text[at] === ']') at++;
      else {
        for (;;) {
          arr.push(value());
          const sep = text[at++];
          if (sep === ']') break;
          if (sep !== ',') fail();
        }
      }
      v = arr;
    } else if (c === '"') v = string();
    else if (literal('true')) v = true;
    else if (literal('false')) v = false;
    else if (literal('null')) v = null;
    else {
      const n = token(NUMBER);
      v = n === null ? fail() : new JsonNumber(n);
    }
    space();
    return v;
  };
  const v = value();
  if (at !== text.length) fail();
  return v;
}

// undefined when text is not exactly one JSON value.
export function readJsonExact(text: string): ExactJson | undefined {
  try {
    return parseExact(text);
  } catch {
    return undefined;
  }
}

// Numbers are written as their text.
export function writeJsonExact(v: ExactJson): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (v instanceof JsonNumber) return v.text;
  if (Array.isArray(v)) return `[${v.map(writeJsonExact).join(',')}]`;
  const fields = Object.keys(v).map((k) => `${JSON.stringify(k)}:${writeJsonExact((v as Record<string, ExactJson>)[k]!)}`);
  return `{${fields.join(',')}}`;
}

type JsonObject = { readonly [key: string]: ExactJson };

const isObject = (x: unknown): x is JsonObject =>
  typeof x === 'object' && x !== null && !Array.isArray(x) && !(x instanceof JsonNumber);

const own = (o: JsonObject, key: string): ExactJson | undefined =>
  Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;

// A whole figure as BigInt(text), else null.
function whole(x: ExactJson | undefined): bigint | null {
  return x instanceof JsonNumber && /^-?(0|[1-9]\d*)$/.test(x.text) ? BigInt(x.text) : null;
}

// A seconds figure as its instant in milliseconds, else null.
function secondsAt(x: ExactJson | undefined): Instant | null {
  if (!(x instanceof JsonNumber) || !/^(0|[1-9]\d*)$/.test(x.text)) return null;
  const ms = Number(x.text) * 1000;
  return Number.isSafeInteger(ms) ? ms : null;
}

// The alphabetic code of a whole numeric code in the currency table, else null.
function currencyOf(x: ExactJson | undefined): string | null {
  const n = whole(x);
  if (n === null || n < 0n || n > 9999n) return null;
  return currencyByNumeric(Number(n))?.code ?? null;
}

function code(x: ExactJson | undefined): number | null {
  const n = whole(x);
  return n !== null && n >= 0n && n <= 9999n ? Number(n) : null;
}

const sign = (n: bigint): number => (n < 0n ? -1 : n > 0n ? 1 : 0);

const unreadable = (what: string): never => {
  throw new SourceCallError('other', `monobank: unreadable reply: ${what}`);
};

// --- translation -----------------------------------------------------------------------------

export function secondsWindow(window: Interval): { from: number; to: number } | null {
  const from = Math.ceil(window.startAt / 1000);
  const to = Math.ceil(window.endAt / 1000) - 1;
  return from > to ? null : { from, to };
}

export function translateClientInfo(body: ExactJson): HoldingsReport {
  if (!isObject(body)) return unreadable('client info is not an object');
  const accounts = own(body, 'accounts');
  if (!Array.isArray(accounts)) return unreadable('accounts is not an array');
  const jars = own(body, 'jars');
  if (jars !== undefined && !Array.isArray(jars)) return unreadable('jars is not an array');
  const hook = own(body, 'webHookUrl');
  if (hook !== undefined && typeof hook !== 'string') return unreadable('webHookUrl is not a string');

  const holdings: HoldingsReport['holdings'][number][] = [];
  const balances: ReportedBalance[] = [];

  const accountSeen = new Set<string>();
  for (const a of accounts) {
    if (!isObject(a)) return unreadable('an account is not an object');
    const id = own(a, 'id');
    const balance = whole(own(a, 'balance'));
    const creditLimit = whole(own(a, 'creditLimit'));
    const numeric = whole(own(a, 'currencyCode'));
    if (typeof id !== 'string' || balance === null || creditLimit === null || numeric === null) {
      return unreadable('an account field is missing or of the wrong kind');
    }
    if (accountSeen.has(id)) return unreadable(`account ${id} listed twice`);
    accountSeen.add(id);
    const currency = currencyOf(own(a, 'currencyCode'));
    if (currency === null) continue;
    holdings.push({ kind: 'account', sourceId: MONOBANK_ID, bankId: id, currency });
    balances.push({
      holdingId: narrowingName(MONOBANK_ID, 'account', id),
      balance: money(balance, currency),
      creditLimit: money(creditLimit, currency),
    });
  }

  const jarSeen = new Set<string>();
  for (const j of jars ?? []) {
    if (!isObject(j)) return unreadable('a jar is not an object');
    const id = own(j, 'id');
    const balance = whole(own(j, 'balance'));
    const goalField = own(j, 'goal');
    const goal = whole(goalField);
    const numeric = whole(own(j, 'currencyCode'));
    if (typeof id !== 'string' || balance === null || numeric === null) {
      return unreadable('a jar field is missing or of the wrong kind');
    }
    if (goal === null && goalField !== undefined && goalField !== null) return unreadable(`jar ${id} goal is not whole`);
    if (jarSeen.has(id)) return unreadable(`jar ${id} listed twice`);
    jarSeen.add(id);
    const currency = currencyOf(own(j, 'currencyCode'));
    if (currency === null) continue;
    holdings.push({ kind: 'jar', sourceId: MONOBANK_ID, bankId: id, currency });
    balances.push({
      holdingId: narrowingName(MONOBANK_ID, 'jar', id),
      balance: money(balance, currency),
      creditLimit: null,
      goal: goal === null ? null : money(goal, currency),
    });
  }

  return { holdings, balances, pushAddress: typeof hook === 'string' && hook !== '' ? hook : null };
}

export function translateStatementItem(
  item: ExactJson,
  holding: HoldingRow,
  seenAt: Instant,
): Translated<TranslatedTransaction> {
  if (!isObject(item)) return unreadable('a statement item is not an object');
  const id = own(item, 'id');
  if (typeof id !== 'string' || id === '') return unreadable('a statement item has no id');

  const quarantined = (reason: QuarantineReason, detail: string, occurredAt: Instant | null) =>
    ({
      kind: 'quarantined',
      entry: { sourceId: MONOBANK_ID, bankId: id, raw: writeJsonExact(item), reason, detail, seenAt, occurredAt },
    }) as const;

  const cur = holding.currency;
  const at = secondsAt(own(item, 'time'));
  if (at === null) return quarantined('malformed', 'time is not a seconds figure', null);
  const amount = whole(own(item, 'amount'));
  if (amount === null) return quarantined('malformed', 'amount is not whole', at);
  const operationCurrency = currencyOf(own(item, 'currencyCode'));
  if (operationCurrency === null) return quarantined('unknown_currency', 'currencyCode is not in the currency table', at);

  let originalAmount: Money | null = null;
  if (operationCurrency !== cur) {
    const op = whole(own(item, 'operationAmount'));
    if (op === null) return quarantined('malformed', 'operationAmount is not whole', at);
    if (sign(op) !== sign(amount)) return quarantined('malformed', 'operationAmount and amount differ in sign', at);
    originalAmount = money(op, operationCurrency);
  }

  let cashback: Money | null = null;
  const cashbackField = own(item, 'cashbackAmount');
  if (cashbackField !== undefined) {
    const c = whole(cashbackField);
    if (c === null || c < 0n) return quarantined('malformed', 'cashbackAmount is not whole or is negative', at);
    cashback = money(c, cur);
  }

  const description = own(item, 'description');
  const comment = own(item, 'comment');
  return {
    kind: 'held',
    sourceId: MONOBANK_ID,
    bankId: id,
    record: {
      sourceId: MONOBANK_ID,
      bankId: id,
      holdingId: holding.id,
      occurredAt: at,
      amount: money(amount, cur),
      originalAmount,
      cashback,
      settled: own(item, 'hold') !== true,
      mcc: code(own(item, 'mcc')),
      originalMcc: code(own(item, 'originalMcc')),
      merchantText: null,
      description: typeof description === 'string' ? description : '',
      comment: typeof comment === 'string' ? comment : null,
      counterpart: null,
    },
  };
}

export function translateStatement(body: ExactJson, holding: HoldingRow, window: Interval, seenAt: Instant): WindowPage {
  if (!Array.isArray(body)) return unreadable('statement is not an array');
  if (body.length > MONOBANK_PAGE_CAP) return unreadable(`statement holds ${body.length} items`);
  const items: Translated<TranslatedTransaction>[] = [];
  const seen = new Set<string>();
  let smin: Instant | null = null;
  for (const x of body) {
    const t = translateStatementItem(x, holding, seenAt);
    const at = secondsAt(own(x as JsonObject, 'time'));
    if (at !== null) {
      if (at < window.startAt || at >= window.endAt) return unreadable('an item lies outside the window');
      if (smin === null || at < smin) smin = at;
    }
    const bankId = t.kind === 'held' ? t.bankId : t.entry.bankId;
    if (seen.has(bankId)) continue;
    seen.add(bankId);
    items.push(t);
  }
  if (body.length < MONOBANK_PAGE_CAP) return { items, next: null };
  if (smin === null) return unreadable('row cap not resolvable');
  const end = smin + 1000;
  if (end >= window.endAt) return unreadable('row cap not resolvable');
  return { items, next: { startAt: window.startAt, endAt: end } };
}

export function translateCurrency(body: ExactJson): StatedRate[] {
  if (!Array.isArray(body)) return unreadable('currency is not an array');
  const rates: StatedRate[] = [];
  for (const e of body) {
    if (!isObject(e)) continue;
    const base = currencyOf(own(e, 'currencyCodeA'));
    const quote = currencyOf(own(e, 'currencyCodeB'));
    if (base === null || quote === null) continue;
    const buy = own(e, 'rateBuy');
    const sell = own(e, 'rateSell');
    const cross = own(e, 'rateCross');
    let figures: RateFigures;
    if (buy instanceof JsonNumber && sell instanceof JsonNumber) {
      const b = parseExactDecimal(buy.text);
      const s = parseExactDecimal(sell.text);
      if (b === null || s === null) continue;
      figures = { kind: 'buy_sell', buy: b, sell: s };
    } else if (cross instanceof JsonNumber) {
      const r = parseExactDecimal(cross.text);
      if (r === null) continue;
      figures = { kind: 'cross', rate: r };
    } else continue;
    const statedFrom = secondsAt(own(e, 'date'));
    rates.push(statedFrom === null ? { pair: { base, quote }, figures } : { pair: { base, quote }, statedFrom, figures });
  }
  return rates;
}

// --- push ------------------------------------------------------------------------------------

function readPush(body: string, ctx: Parameters<PushTranslator['read']>[2]): PushReading {
  const bad = (reason: string): PushReading => ({ kind: 'not_well_formed', reason });
  const note = readJsonExact(body);
  if (!isObject(note)) return bad('body is not a JSON object');
  if (own(note, 'type') !== 'StatementItem') return bad("type is not 'StatementItem'");
  const data = own(note, 'data');
  if (!isObject(data)) return bad('data is not an object');
  const account = own(data, 'account');
  if (typeof account !== 'string' || account === '') return bad('data.account is not a non-empty string');
  const statementItem = own(data, 'statementItem');
  if (!isObject(statementItem)) return bad('data.statementItem is not an object');
  const id = own(statementItem, 'id');
  if (typeof id !== 'string' || id === '') return bad('data.statementItem has no id');

  const holding = ctx.register.holdings.find((h) => h.sourceId === MONOBANK_ID && h.bankId === account);
  if (holding === undefined) return { kind: 'unknown_holding', holdingId: narrowingName(MONOBANK_ID, 'account', account) };
  let item: Translated<TranslatedTransaction>;
  try {
    item = translateStatementItem(statementItem, holding, ctx.now);
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }
  const balance = whole(own(statementItem, 'balance'));
  return {
    kind: 'notification',
    holdingId: holding.id,
    holdingKind: holding.kind,
    item,
    balance: balance === null ? null : { holdingId: holding.id, balance: money(balance, holding.currency), creditLimit: null },
  };
}

export const monobankPush: PushTranslator = {
  read(body, _contentType, ctx) {
    try {
      return readPush(body, ctx);
    } catch (e) {
      return { kind: 'not_well_formed', reason: `unexpected: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
  addressCheck: { method: 'GET', status: 200 },
};

export const source: SourceDefinition = {
  id: MONOBANK_ID,
  capabilities: ['jars', 'rates'],
  settingsGroup,
  balanceConvention: 'includes_credit_limit',
  limits: MONOBANK_LIMITS,
  maxWindowMs: MONOBANK_MAX_WINDOW_MS,
  push: monobankPush,
  open: (cfg) => openMonobankClient(cfg),
};
