// Answer rendering (S-174): the one text both front ends show for an answer, and the JSON value the
// assistant attaches beside it. Every rendering opens with the envelope head (title, as-of, display
// currency, scope, period, covered ranges per source, then every other statement); the body
// follows. Pure functions of the value given: nothing is summed, converted, rounded, filtered,
// sorted or dropped, and every figure printed is one found in the answer.

import { SHARED_NAMES } from '../config/settings';
import type { Refusal } from '../core/primitives';
import type { Answer, Envelope } from '../core/question';
import { COVERED_RANGES_KEY, type CoveredRangesStatement } from '../local/covered-ranges';
import { formatMoney, type Money } from '../money/money';
import type { Catalogue, CatalogueEntry } from './catalogue';
import type { OpenRefusal } from './handoff';

export type BodyFormatter = (body: unknown) => string[]; // lines, no trailing newline
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const INDENT = '  ';

function hasExactKeys(v: object, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}

function isMoney(v: unknown): v is Money {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return hasExactKeys(o, ['minor', 'currency']) && typeof o.minor === 'bigint' && typeof o.currency === 'string';
}

function isFraction(v: unknown): v is { num: bigint; den: bigint } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return hasExactKeys(o, ['num', 'den']) && typeof o.num === 'bigint' && typeof o.den === 'bigint';
}

// A value printed on one line: everything but a plain array or a plain object.
function isScalar(v: unknown): boolean {
  return typeof v !== 'object' || v === null || isMoney(v) || isFraction(v);
}

function scalarText(v: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  if (isMoney(v)) return formatMoney(v);
  if (isFraction(v)) return `${v.num}/${v.den}`;
  return String(v);
}

function indent(lines: string[]): string[] {
  return lines.map((l) => INDENT + l);
}

export function labelOf(key: string): string {
  const spaced = key.replace(/[A-Z]/g, (c) => ' ' + c.toLowerCase());
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const layoutBody: BodyFormatter = (body) => {
  if (isScalar(body)) return [scalarText(body)];
  if (Array.isArray(body)) {
    const out: string[] = [];
    for (const item of body) {
      if (isScalar(item)) out.push('- ' + scalarText(item));
      else out.push('-', ...indent(layoutBody(item)));
    }
    return out;
  }
  const out: string[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined) continue;
    const label = labelOf(key);
    if (isScalar(value)) out.push(`${label}: ${scalarText(value)}`);
    else if (Array.isArray(value) && value.length === 0) out.push(`${label}: none`);
    else out.push(`${label}:`, ...indent(layoutBody(value)));
  }
  return out;
};

// Every family uses the shared layout; a family-specific one, if ever needed, is added here.
export function formatterFor(_entry: CatalogueEntry | undefined): BodyFormatter {
  return layoutBody;
}

function coveredLines(statements: Readonly<Record<string, unknown>>): string[] {
  if (!Object.prototype.hasOwnProperty.call(statements, COVERED_RANGES_KEY)) return ['Covered ranges: not stated'];
  const s = statements[COVERED_RANGES_KEY] as CoveredRangesStatement;
  if (s.length === 0) return ['Covered ranges: nothing held'];
  const out = ['Covered ranges:'];
  for (const c of s) {
    if (c.ranges.length === 0) {
      out.push(`${INDENT}${c.sourceId}: nothing held`);
      continue;
    }
    out.push(`${INDENT}${c.sourceId}:`);
    for (const r of c.ranges) out.push(`${INDENT}${INDENT}${r.start} to ${r.end}`);
  }
  return out;
}

export function formatHead(e: Envelope, title: string): string[] {
  const out = [
    title,
    `As of: ${e.asOf.localDateTime} (${e.timeZone})`,
    `Display currency: ${e.displayCurrency}`,
    ...layoutBody({ scope: e.scope }),
  ];
  if (e.period !== null) out.push(`Period: ${e.period.text} (${e.period.firstDay} to ${e.period.lastDay})`);
  out.push(...coveredLines(e.statements));
  for (const [key, value] of Object.entries(e.statements)) {
    if (key === COVERED_RANGES_KEY) continue;
    out.push(...layoutBody({ [key]: value }));
  }
  return out;
}

export function formatAnswer(a: Answer, catalogue: Catalogue): string {
  if (a.kind === 'refused') return formatRefusal(a);
  const entry = catalogue.find((c) => c.family === a.family);
  const lines = formatHead(a, entry ? entry.title : a.family);
  if (a.outcome.kind === 'answered') lines.push(...formatterFor(entry)(a.outcome.body));
  else {
    lines.push(
      `Not offered: no source in scope offers ${a.outcome.capability} (${a.outcome.sources.join(', ')})`,
    );
  }
  return lines.join('\n');
}

export function formatRefusal(r: Refusal): string {
  return `Refused (${r.subject}): ${r.message}`;
}

export function formatOpenRefusal(r: OpenRefusal): string {
  const head = `${SHARED_NAMES.storage} "${r.location}": `;
  if (r.kind === 'no_local_copy') {
    return head + 'no local copy exists at this location; the service or a backfill creates one.';
  }
  return head + `the local copy cannot be opened: ${r.why}`;
}

function toJson(v: unknown): Json {
  if (v === null) return null;
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (isMoney(v)) {
    const text = formatMoney(v);
    return { amount: text.slice(0, text.length - (' ' + v.currency).length), currency: v.currency };
  }
  if (isFraction(v)) return { num: String(v.num), den: String(v.den) };
  if (Array.isArray(v)) return v.filter((m) => m !== undefined).map(toJson);
  const out: { [k: string]: Json } = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = toJson(value);
  }
  return out;
}

export function answerJson(a: Answer): { [k: string]: Json } {
  return toJson(a) as { [k: string]: Json };
}
