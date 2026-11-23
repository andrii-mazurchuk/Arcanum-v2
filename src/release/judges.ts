// Release judges (S-238): one pure judge per promise, over what the phases observed and what the
// stand-ins (S-236) recorded. Nothing here reads a clock, a file or the network: every judge is a
// function of the values given and returns a Verdict whose fail names the calls, figures, fields,
// lines or markers it saw. The expected figures come from the dataset (S-233) alone.

import pkg from '../../package.json' with { type: 'json' };
import type { Json } from '../interfaces/render';
import { ANSWER_BOUND_MS, type AskResult, coverageOf } from './assistant';
import { DAY_MS, type Dataset, marker } from './dataset';
import { type CallRecord, type StandInLimit, overLimit } from './stand-ins';

// The pinned runtime (S-240): package.json's engines.bun is the reference pin.
const BUN_VERSION: string = pkg.engines.bun;

export type PromiseKey =
  | 'complete_and_current'
  | 'local_copy_only'
  | 'rate_limits'
  | 'exact_money'
  | 'source_touches_only_itself'
  | 'single_machine';

export const PROMISES: readonly { key: PromiseKey; title: string }[] = [
  { key: 'complete_and_current', title: 'local copy complete and current' },
  { key: 'local_copy_only', title: 'answers from the local copy only' },
  { key: 'rate_limits', title: 'rate limits respected' },
  { key: 'exact_money', title: 'exact money' },
  { key: 'source_touches_only_itself', title: 'adding a source touches only that source' },
  { key: 'single_machine', title: 'single-machine operation' },
];

export type Verdict = { pass: true } | { pass: false; observed: string[] };

const verdictOf = (observed: string[]): Verdict => (observed.length === 0 ? { pass: true } : { pass: false, observed });

type JsonObject = { [k: string]: Json };

const isObject = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

// The value at a dotted path of plain object keys; undefined when any step is missing.
function at(v: Json | undefined, ...keys: string[]): Json | undefined {
  let cur = v;
  for (const k of keys) {
    if (!isObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

// Every plain object in v, v included, depth first in document order.
function objectsIn(v: Json | undefined, out: JsonObject[] = []): JsonObject[] {
  if (Array.isArray(v)) {
    for (const m of v) objectsIn(m, out);
  } else if (isObject(v)) {
    out.push(v);
    for (const m of Object.values(v)) objectsIn(m, out);
  }
  return out;
}

// A Money as S-174's answer JSON writes it: its amount text and its currency, 'absent' when missing.
function moneyOf(v: Json | undefined): { amount: string; currency: string } {
  const amount = at(v, 'amount');
  const currency = at(v, 'currency');
  return {
    amount: typeof amount === 'string' ? amount : 'absent',
    currency: typeof currency === 'string' ? currency : 'absent',
  };
}

// --- rate limits -------------------------------------------------------------------------------

export function judgeRateLimits(records: readonly CallRecord[], limits: readonly StandInLimit[], standIn: string): Verdict {
  const observed: string[] = [];
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  sorted.forEach((r, k) => {
    const prior = sorted.slice(0, k);
    for (const limit of limits) {
      if (!overLimit(prior, limit, r.callClass, r.at)) continue;
      const counted = prior.filter((p) => limit.callClass === null || limit.callClass === p.callClass);
      const inWindow = [...counted.slice(counted.length - limit.calls), r];
      const calls = inWindow.map((c) => `seq ${c.seq} at ${c.at}`).join(', ');
      const cls = limit.callClass ?? 'any call';
      observed.push(
        `${standIn} ${cls}: ${limit.calls + 1} calls within ${limit.windowMs} ms (limit ${limit.calls}): ${calls}`,
      );
    }
    if (r.refused) {
      observed.push(`${standIn} ${r.callClass}: seq ${r.seq} at ${r.at} refused as over its limit (status ${r.status})`);
    }
  });
  return verdictOf(observed);
}

// --- exact money -------------------------------------------------------------------------------

// PLN per unit of each currency at the dataset's one rate table, as an exact fraction.
const TO_PLN: Readonly<Record<'UAH' | 'USD' | 'EUR' | 'PLN', readonly [bigint, bigint]>> = {
  UAH: [1n, 10n],
  USD: [36_555n, 10_000n],
  EUR: [4_025n, 1_000n],
  PLN: [1n, 1n],
};

// num / den rounded once, half away from zero.
function roundHalfAway(num: bigint, den: bigint): bigint {
  const neg = num < 0n;
  const abs = neg ? -num : num;
  let q = abs / den;
  if (2n * (abs % den) >= den) q += 1n;
  return neg ? -q : q;
}

export function expectedPlnMinor(minor: bigint, currency: 'UAH' | 'USD' | 'EUR' | 'PLN'): bigint {
  const [num, den] = TO_PLN[currency];
  return roundHalfAway(minor * num, den);
}

// Decimal text with exactly two minor digits, as the second source serves it.
function minorOfText(text: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(text);
  if (m === null) throw new RangeError(`not two-decimal text: '${text}'`);
  const v = BigInt(m[2]) * 100n + BigInt(m[3]);
  return m[1] === '-' ? -v : v;
}

const MONO_CURRENCY: Readonly<Record<number, 'UAH' | 'USD'>> = { 980: 'UAH', 840: 'USD' };

export function expectedNetPosition(ds: Dataset, withSecond: boolean): bigint {
  let total = 0n;
  for (const h of ds.monobank.holdings) {
    const own = h.kind === 'account' ? h.balance - h.creditLimit : h.balance;
    total += expectedPlnMinor(BigInt(own), MONO_CURRENCY[h.currencyCode]);
  }
  if (withSecond) {
    for (const a of ds.second.accounts) total += expectedPlnMinor(minorOfText(a.balance), a.currency);
  }
  return total;
}

export function servedText(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export function rowsOf(
  value: Json,
): { sourceId: string; bankId: string; amount: Json; shown: Json; category: Json; merchant: Json }[] {
  return objectsIn(at(value, 'outcome', 'body'))
    .filter((o) => typeof o.sourceId === 'string' && typeof o.bankId === 'string')
    .map((o) => ({
      sourceId: o.sourceId as string,
      bankId: o.bankId as string,
      amount: o.amount ?? null,
      shown: o.shown ?? null,
      category: o.category ?? null,
      merchant: o.merchant ?? null,
    }));
}

export function holdingNameFor(
  value: Json,
  sourceId: string,
  bankId: string,
): { name: string } | { name: null; seen: string[] } {
  const seen: string[] = [];
  for (const o of objectsIn(at(value, 'outcome', 'body'))) {
    const id = o.holdingId;
    if (typeof id === 'string' && !seen.includes(id)) seen.push(id);
  }
  const kept = seen.filter((id) => id.startsWith(`${sourceId}:`) && id.endsWith(`:${bankId}`));
  return kept.length === 1 ? { name: kept[0] } : { name: null, seen };
}

export function fixtureMarkers(ds: Dataset): readonly string[] {
  return [marker(ds.runId, 11), marker(ds.runId, 12), marker(ds.runId, 13)];
}

export function judgeFixture(breakdown: Json, searches: ReadonlyMap<string, Json>, ds: Dataset): Verdict {
  const observed: string[] = [];
  const total = moneyOf(at(breakdown, 'outcome', 'body', 'totalSpending'));
  if (total.amount.replace(/^-/, '') !== '10.98' || total.currency !== 'PLN') {
    observed.push(`fixture total ${total.amount} ${total.currency}, expected 10.98 PLN`);
  }
  for (const m of fixtureMarkers(ds)) {
    const search = searches.get(m);
    if (search === undefined) {
      observed.push(`fixture row ${m}: not asked`);
      continue;
    }
    const rows = rowsOf(search);
    const shown = moneyOf(rows[0]?.shown);
    if (rows.length !== 1 || shown.amount !== '-3.66' || shown.currency !== 'PLN') {
      const count = rows.length === 1 ? '' : `${rows.length} rows, `;
      observed.push(`fixture row ${m}: ${count}shown ${shown.amount} ${shown.currency}, expected -3.66 PLN`);
    }
  }
  return verdictOf(observed);
}

// --- answers from the local copy only ----------------------------------------------------------

// True iff the answer states covered ranges for the sources of its scope: for 'combined', a stated
// list with at least one source; otherwise the source the scope names (its text up to the first ':').
function statesCoverage(value: JsonObject, scope: string): boolean {
  if (scope !== 'combined') return coverageOf(value, scope.split(':')[0]) !== null;
  const list = at(value, 'statements', 'coveredRanges');
  return Array.isArray(list) && list.length > 0 && list.every((s) => Array.isArray(at(s, 'ranges')));
}

export function judgeAnswerBound(results: readonly { tool: string; scope: string; result: AskResult }[]): Verdict {
  const observed: string[] = [];
  for (const { tool, scope, result } of results) {
    const name = `${tool} (${scope})`;
    if (result.kind === 'failed') {
      observed.push(`${name}: ${result.reason}`);
      continue;
    }
    if (result.refused) observed.push(`${name}: refused: ${result.text}`);
    if (result.elapsedMs > ANSWER_BOUND_MS) {
      observed.push(`${name}: answered in ${Math.round(result.elapsedMs)} ms, above ${ANSWER_BOUND_MS} ms`);
    }
    if (!statesCoverage(result.value, scope)) observed.push(`${name}: no covered-range statement for its scope`);
  }
  return verdictOf(observed);
}

// --- backfill ----------------------------------------------------------------------------------

export function olderMarkers(ds: Dataset): { inRange: readonly string[]; outOfRange: readonly string[] } {
  const descriptionOf = (id: string) => ds.monobank.older.find((t) => t.id === id)?.description;
  const pick = (ids: readonly string[]) =>
    ids.map(descriptionOf).filter((d): d is string => d !== undefined);
  return { inRange: pick(ds.backfill.inRangeIds), outOfRange: pick(ds.backfill.outOfRangeIds) };
}

export function addedCount(stdout: string): number | null {
  let n: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^added (\d+) transactions$/.exec(line);
    if (m !== null) n = Number(m[1]);
  }
  return n;
}

export interface CoveredRange {
  readonly startAt: number;
  readonly endAt: number;
}

export interface BackfillObservation {
  readonly exitCode: number | null; // null: no exit within its deadline
  readonly stdout: string;
  readonly before: readonly CoveredRange[] | null; // coverageOf(holdings narrowed to 'monobank', 'monobank') just before the backfill started
  readonly after: readonly CoveredRange[] | null; // the same just after it exited
  readonly searches: ReadonlyMap<string, Json>; // older-set marker -> its 'transaction_search' answer value
}

const instant = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms));
const rangeText = (r: CoveredRange | undefined) => (r === undefined ? 'absent' : `${instant(r.startAt)}..${instant(r.endAt)}`);

export function judgeBackfill(o: BackfillObservation, ds: Dataset): Verdict {
  const observed: string[] = [];
  const bf = ds.backfill;

  if (o.exitCode === null) observed.push('backfill did not exit within its deadline');
  else if (o.exitCode !== 0) observed.push(`backfill exit ${o.exitCode}, expected 0`);

  const { inRange, outOfRange } = olderMarkers(ds);
  for (const m of inRange) {
    const search = o.searches.get(m);
    if (search === undefined) {
      observed.push(`backfill marker ${m}: not asked`);
      continue;
    }
    const n = rowsOf(search).length;
    if (n !== 1) observed.push(`backfill marker ${m}: ${n} rows, expected 1`);
  }
  for (const m of outOfRange) {
    const search = o.searches.get(m);
    if (search === undefined) {
      observed.push(`backfill out-of-range marker ${m}: not asked`);
      continue;
    }
    const n = rowsOf(search).length;
    if (n !== 0) observed.push(`backfill out-of-range marker ${m}: ${n} rows, expected 0`);
  }

  const added = addedCount(o.stdout);
  if (added !== bf.inRangeIds.length) {
    observed.push(`backfill reported added ${added ?? 'absent'}, expected ${bf.inRangeIds.length}`);
  }

  if (o.before === null || o.after === null) {
    observed.push('covered ranges not stated');
    return verdictOf(observed);
  }
  const before = o.before;
  const after = o.after;
  const i = after.findIndex((r) => r.startAt === bf.startAt && bf.endAt - 60_000 <= r.endAt && r.endAt <= bf.endAt);
  if (i < 0) {
    observed.push(`no covered range spans ${bf.fromDay}..${bf.toDay}: ${after.map((r) => rangeText(r)).join(', ')}`);
    return verdictOf(observed);
  }
  const r = after[i];
  if (i === after.length - 1 || after[i + 1].startAt <= r.endAt) {
    observed.push('the gap between the backfilled range and the first fill is hidden');
  }
  const rest = after.filter((_, j) => j !== i);
  const count = Math.max(rest.length, before.length);
  for (let j = 0; j < count; j++) {
    const b = before[j];
    const a = rest[j];
    const last = j === before.length - 1 && j === rest.length - 1;
    const same =
      a !== undefined && b !== undefined && a.startAt === b.startAt && (last ? a.endAt >= b.endAt : a.endAt === b.endAt);
    if (!same) {
      observed.push(`covered ranges before the backfill changed: before ${rangeText(b)}, after ${rangeText(a)}`);
      break;
    }
  }
  return verdictOf(observed);
}

const STATEMENT_PATH = /^\/personal\/statement\/([^/]+)\/(\d+)(?:\/(\d+))?$/;

export function backfillAlongside(
  records: readonly CallRecord[],
  ds: Dataset,
): { met: true } | { met: false; observed: string } {
  const backfill: number[] = [];
  const service: number[] = [];
  for (const r of records) {
    if (r.callClass !== 'statement') continue;
    const m = STATEMENT_PATH.exec(r.path.split('?')[0]);
    if (m === null) continue;
    const fromMs = Number(m[2]) * 1000;
    if (fromMs < ds.backfill.endAt) backfill.push(r.seq);
    if (fromMs >= ds.t0 - 7 * DAY_MS) service.push(r.seq);
  }
  if (backfill.length === 0) return { met: false, observed: 'harness precondition not met: no backfill call recorded' };
  const first = Math.min(...backfill);
  const last = Math.max(...backfill);
  if (service.some((s) => first < s && s < last)) return { met: true };
  return {
    met: false,
    observed: `harness precondition not met: no poll call between the backfill's calls (seq ${first} to ${last})`,
  };
}

// --- command line against the assistant --------------------------------------------------------

export interface CommandLineAsk {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly elapsedMs: number;
  readonly stdout: string;
} // exitCode null: killed at the bound

export function maskAskedMoment(text: string): string[] {
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length > 1 && lines[1].startsWith('As of: ')) lines[1] = 'As of: <masked>';
  return lines;
}

export function judgeInterfaceText(
  pairs: readonly { question: string; cli: CommandLineAsk; assistant: AskResult }[],
): Verdict {
  const observed: string[] = [];
  for (const { question, cli, assistant } of pairs) {
    const own: string[] = [];
    if (cli.exitCode === null) own.push(`${question}: no exit within ${ANSWER_BOUND_MS / 1000} s`);
    else if (cli.exitCode !== 0) own.push(`${question}: exit ${cli.exitCode}`);
    if (cli.elapsedMs > ANSWER_BOUND_MS) {
      own.push(`${question}: command line took ${Math.round(cli.elapsedMs)} ms, above ${ANSWER_BOUND_MS} ms`);
    }
    if (assistant.kind === 'failed') own.push(`${question}: assistant ${assistant.reason}`);
    else if (assistant.refused) own.push(`${question}: assistant refused: ${assistant.text}`);
    if (own.length === 0 && assistant.kind === 'answer') {
      const a = maskAskedMoment(cli.stdout);
      const b = maskAskedMoment(assistant.text);
      for (let n = 0; n < Math.max(a.length, b.length); n++) {
        if (a[n] === b[n]) continue;
        own.push(
          `${question}: command line differs from assistant at line ${n + 1}: '${a[n] ?? 'absent'}' != '${b[n] ?? 'absent'}'`,
        );
        break;
      }
    }
    observed.push(...own);
  }
  return verdictOf(observed);
}

// --- source phase ------------------------------------------------------------------------------

const shown = (v: Json | undefined) => (v === undefined ? 'absent' : typeof v === 'string' ? `'${v}'` : JSON.stringify(v));

function differs(path: string, b: Json | undefined, a: Json | undefined): string {
  return `${path}: ${shown(b)} != ${shown(a)}`;
}

const join = (path: string, key: string) => (path === '' ? key : `${path}.${key}`);

// The per-source covered ranges, compared with the last range's end masked: it may only move later.
function rangesDifference(path: string, b: Json | undefined, a: Json | undefined): string | null {
  if (!Array.isArray(b) || !Array.isArray(a)) return compare(path, b, a);
  if (b.length !== a.length) return `${path}: ${b.length} ranges != ${a.length} ranges`;
  for (let i = 0; i < b.length; i++) {
    const p = `${path}[${i}]`;
    if (i < b.length - 1) {
      const d = compare(p, b[i], a[i]);
      if (d !== null) return d;
      continue;
    }
    const br = b[i];
    const ar = a[i];
    if (!isObject(br) || !isObject(ar)) return compare(p, br, ar);
    for (const key of unionKeys(br, ar)) {
      if (key === 'end') continue;
      if (key === 'endAt') {
        const be = br.endAt;
        const ae = ar.endAt;
        if (typeof be !== 'number' || typeof ae !== 'number' || ae < be) return differs(join(p, key), be, ae);
        continue;
      }
      const d = compare(join(p, key), br[key], ar[key]);
      if (d !== null) return d;
    }
  }
  return null;
}

function unionKeys(b: JsonObject, a: JsonObject): string[] {
  const keys = Object.keys(b);
  for (const k of Object.keys(a)) if (!keys.includes(k)) keys.push(k);
  return keys;
}

function compare(path: string, b: Json | undefined, a: Json | undefined): string | null {
  if (Array.isArray(b) && Array.isArray(a)) {
    for (let i = 0; i < Math.max(b.length, a.length); i++) {
      const d = compare(`${path}[${i}]`, b[i], a[i]);
      if (d !== null) return d;
    }
    return null;
  }
  if (isObject(b) && isObject(a)) {
    for (const key of unionKeys(b, a)) {
      if (key === 'asOf') continue;
      const p = join(path, key);
      if (p === 'statements.coveredRanges') {
        const d = coveredRangesDifference(p, b[key], a[key]);
        if (d !== null) return d;
        continue;
      }
      const d = compare(p, b[key], a[key]);
      if (d !== null) return d;
    }
    return null;
  }
  return b === a ? null : differs(path, b, a);
}

function coveredRangesDifference(path: string, b: Json | undefined, a: Json | undefined): string | null {
  if (!Array.isArray(b) || !Array.isArray(a)) return compare(path, b, a);
  for (let i = 0; i < Math.max(b.length, a.length); i++) {
    const p = `${path}[${i}]`;
    const bs = b[i];
    const as = a[i];
    if (!isObject(bs) || !isObject(as)) {
      const d = compare(p, bs, as);
      if (d !== null) return d;
      continue;
    }
    for (const key of unionKeys(bs, as)) {
      if (key === 'asOf') continue;
      const d = key === 'ranges' ? rangesDifference(join(p, key), bs[key], as[key]) : compare(join(p, key), bs[key], as[key]);
      if (d !== null) return d;
    }
  }
  return null;
}

export function maskedDifference(before: Json, after: Json): string | null {
  return compare('', before, after);
}

export function judgeNewPages(pages: readonly Json[], ds: Dataset): Verdict {
  const observed: string[] = [];
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const row of rowsOf(page)) {
      if (row.sourceId === 'monobank') observed.push(`new pages list Monobank transaction ${row.bankId}`);
      else if (row.sourceId === 'second') counts.set(row.bankId, (counts.get(row.bankId) ?? 0) + 1);
    }
  }
  for (const t of ds.second.initial) {
    const n = counts.get(t.id) ?? 0;
    if (n === 0) observed.push(`new pages miss second-source transaction ${t.id}`);
    else if (n > 1) observed.push(`new pages list second-source transaction ${t.id} ${n} times`);
  }
  return verdictOf(observed);
}

export function judgeNarrowedToSecond(value: Json, ds: Dataset): Verdict {
  const observed: string[] = [];
  for (const o of objectsIn(value)) {
    if (typeof o.sourceId === 'string' && o.sourceId !== 'second') {
      const bank = typeof o.bankId === 'string' ? ` (bank id ${o.bankId})` : '';
      observed.push(`answer narrowed to second holds sourceId '${o.sourceId}'${bank}`);
    }
  }
  const m = ds.monobank;
  const texts = new Set([
    ...[...m.initial, ...m.older, m.pushed, m.dropped, ...m.whileStopped].map((t) => t.description),
    ds.pair.text,
  ]);
  const text = JSON.stringify(value);
  for (const t of texts) if (text.includes(t)) observed.push(`answer narrowed to second contains Monobank text '${t}'`);
  return verdictOf(observed);
}

// --- single machine ----------------------------------------------------------------------------

const LOOPBACK_REMOTES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The path with '\' as '/', '.' and '..' segments resolved and no trailing '/'.
function normalPath(p: string): string {
  const out: string[] = [];
  const parts = p.replace(/\\/g, '/').split('/');
  parts.forEach((s, i) => {
    if (s === '..') {
      if (out.length > 1 || (out.length === 1 && out[0] !== '')) out.pop();
    } else if (s !== '.' && !(s === '' && i > 0)) out.push(s);
  });
  return out.join('/');
}

export function judgeSingleMachine(
  records: readonly CallRecord[],
  runtimeVersion: string,
  settings: Readonly<Record<string, string>>,
  folder: string,
): Verdict {
  const observed: string[] = [];
  for (const r of records) {
    if (!LOOPBACK_REMOTES.has(r.remote)) observed.push(`call seq ${r.seq} came from ${r.remote}, not loopback`);
  }
  if (runtimeVersion !== BUN_VERSION) observed.push(`runtime Bun ${runtimeVersion}, expected ${BUN_VERSION}`);
  for (const [name, value] of Object.entries(settings)) {
    if (!name.endsWith('_BASE_URL') && !name.endsWith('_PUSH_URL')) continue;
    let host: string | null = null;
    try {
      host = new URL(value).hostname;
    } catch {
      host = null;
    }
    if (host !== '127.0.0.1') observed.push(`${name} ${value}: host ${host ?? 'unreadable'}, expected 127.0.0.1`);
  }
  const storage = settings.ARCANUM_STORAGE;
  if (storage === undefined) {
    observed.push('ARCANUM_STORAGE not set');
  } else if (!normalPath(storage).startsWith(normalPath(folder) + '/')) {
    observed.push(`ARCANUM_STORAGE ${storage} lies outside ${folder}`);
  }
  return verdictOf(observed);
}
