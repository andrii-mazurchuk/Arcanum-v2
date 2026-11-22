// Settings (S-212): the only parser of setting values and the only place defaults are applied.
// loadSettings is total over the environment and the source groups it is handed, and returns one
// deep-frozen record in four states per setting. Every other part receives the record (or a value
// taken from it) and never reads the environment. This module keeps no list of sources.

import { DEFAULT_TIME_ZONE, openCalendar } from '../analytics/dates';
import type { SourceId } from '../core/primitives';
import { isRefusal } from '../core/primitives';
import type { Settings } from '../core/question';
import { MEMORY_LOCATION } from '../db/index';

export type SettingState<T> =
  | { state: 'given'; name: string; value: T }
  | { state: 'defaulted'; name: string; value: T }
  | { state: 'missing'; name: string } // absent, no default: a fault
  | { state: 'bad'; name: string; raw: string; reason: string }; // present, invalid: a fault, never replaced by a default

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };
export interface SettingDecl<T> {
  key: string; // in a source group: the part after ARCANUM_<ID>_
  parse(raw: string): Parsed<T>; // total, never throws
  default?: T; // absent: an absent value is 'missing'
}

export interface SharedSettings {
  storage: SettingState<string>; // ARCANUM_STORAGE
  firstFillDays: SettingState<number>; // ARCANUM_FIRST_FILL_DAYS
  pollMinutes: SettingState<number>; // ARCANUM_POLL_MINUTES
  pushPort: SettingState<number>; // ARCANUM_PUSH_PORT
  timeZone: SettingState<string>; // ARCANUM_TIME_ZONE
}
export const SHARED_NAMES: { readonly [K in keyof SharedSettings]: string } = Object.freeze({
  storage: 'ARCANUM_STORAGE',
  firstFillDays: 'ARCANUM_FIRST_FILL_DAYS',
  pollMinutes: 'ARCANUM_POLL_MINUTES',
  pushPort: 'ARCANUM_PUSH_PORT',
  timeZone: 'ARCANUM_TIME_ZONE',
});

export interface SourceSettingsGroup {
  // declared by each source module and exported from it as `settingsGroup`
  sourceId: SourceId; // matches /^[a-z][a-z0-9]*$/
  enabledByDefault: boolean; // true for monobank only
  baseAddressDefault?: string;
  needsCredential: boolean;
  extras: readonly SettingDecl<unknown>[];
}
export interface SourceSettings {
  sourceId: SourceId;
  enabled: SettingState<boolean>; // ARCANUM_<ID>_ENABLED
  baseAddress: SettingState<string>; // ARCANUM_<ID>_BASE_URL
  credential: SettingState<string> | null; // ARCANUM_<ID>_TOKEN; null iff !needsCredential
  extras: Readonly<Record<string, SettingState<unknown>>>; // by decl key
}
export interface SettingsRecord {
  shared: SharedSettings;
  sources: readonly SourceSettings[]; // in groups order
}

type Env = Readonly<Record<string, string | undefined>>;

// A plain decimal whole number within [min, max]; anything else is refused with the range named.
function wholeNumber(min: number, max: number): (raw: string) => Parsed<number> {
  return (raw) => {
    if (!/^[0-9]+$/.test(raw)) return { ok: false, reason: 'not a whole number' };
    const n = Number(raw);
    if (!(n >= min && n <= max)) return { ok: false, reason: `not between ${min} and ${max}` };
    return { ok: true, value: n };
  };
}

function parseStorage(raw: string): Parsed<string> {
  if (raw === '') return { ok: false, reason: 'empty' };
  // MEMORY_LOCATION is the in-memory mode; any other value is a file path, opened by the store.
  return { ok: true, value: raw === MEMORY_LOCATION ? MEMORY_LOCATION : raw };
}

function parseTimeZone(raw: string): Parsed<string> {
  const opened = openCalendar(raw);
  return isRefusal(opened) ? { ok: false, reason: opened.message } : { ok: true, value: raw };
}

function parseSwitch(raw: string): Parsed<boolean> {
  if (raw === 'on') return { ok: true, value: true };
  if (raw === 'off') return { ok: true, value: false };
  return { ok: false, reason: "neither 'on' nor 'off'" };
}

function parseBaseAddress(raw: string): Parsed<string> {
  if (!URL.canParse(raw)) return { ok: false, reason: 'not an address' };
  const protocol = new URL(raw).protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return { ok: false, reason: 'not an http or https address' };
  return { ok: true, value: raw.endsWith('/') ? raw.slice(0, -1) : raw };
}

function parseCredential(raw: string): Parsed<string> {
  return raw === '' ? { ok: false, reason: 'empty' } : { ok: true, value: raw };
}

// One setting's state; a parser that throws despite its contract still yields 'bad', never a throw.
function load<T>(env: Env, name: string, parse: (raw: string) => Parsed<T>, fallback?: T): SettingState<T> {
  const raw = env[name];
  if (raw === undefined) {
    return fallback === undefined ? { state: 'missing', name } : { state: 'defaulted', name, value: fallback };
  }
  let parsed: Parsed<T>;
  try {
    parsed = parse(raw);
  } catch (e) {
    parsed = { ok: false, reason: e instanceof Error && e.message !== '' ? e.message : 'unparseable' };
  }
  return parsed.ok ? { state: 'given', name, value: parsed.value } : { state: 'bad', name, raw, reason: parsed.reason };
}

function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const k of Object.keys(x)) deepFreeze((x as Record<string, unknown>)[k]);
  }
  return x;
}

export function sourceSettingName(id: SourceId, key: string): string {
  return `ARCANUM_${id.toUpperCase()}_${key}`;
}

export function settingNames(groups: readonly SourceSettingsGroup[]): readonly string[] {
  const names: string[] = Object.values(SHARED_NAMES);
  for (const g of groups) {
    names.push(sourceSettingName(g.sourceId, 'ENABLED'), sourceSettingName(g.sourceId, 'BASE_URL'));
    if (g.needsCredential) names.push(sourceSettingName(g.sourceId, 'TOKEN'));
    for (const d of g.extras) names.push(sourceSettingName(g.sourceId, d.key));
  }
  return names;
}

function loadSource(env: Env, g: SourceSettingsGroup): SourceSettings {
  const name = (key: string) => sourceSettingName(g.sourceId, key);
  const extras: Record<string, SettingState<unknown>> = {};
  for (const d of g.extras) extras[d.key] = load(env, name(d.key), (raw) => d.parse(raw), d.default);
  return {
    sourceId: g.sourceId,
    enabled: load(env, name('ENABLED'), parseSwitch, g.enabledByDefault),
    baseAddress: load(env, name('BASE_URL'), parseBaseAddress, g.baseAddressDefault),
    credential: g.needsCredential ? load(env, name('TOKEN'), parseCredential) : null,
    extras,
  };
}

export function loadSettings(env: Env, groups: readonly SourceSettingsGroup[]): SettingsRecord {
  const shared: SharedSettings = {
    storage: load(env, SHARED_NAMES.storage, parseStorage),
    firstFillDays: load(env, SHARED_NAMES.firstFillDays, wholeNumber(1, 90), 90),
    pollMinutes: load(env, SHARED_NAMES.pollMinutes, wholeNumber(1, Number.MAX_SAFE_INTEGER), 60),
    pushPort: load(env, SHARED_NAMES.pushPort, wholeNumber(0, 65535), 8080),
    timeZone: load(env, SHARED_NAMES.timeZone, parseTimeZone, DEFAULT_TIME_ZONE),
  };
  return deepFreeze({ shared, sources: groups.map((g) => loadSource(env, g)) });
}

export function settingValue<T>(s: SettingState<T>): T | undefined {
  return s.state === 'given' || s.state === 'defaulted' ? s.value : undefined;
}

const questionViews = new WeakMap<SettingsRecord, Settings>();

export function questionSettings(record: SettingsRecord): Settings {
  const known = questionViews.get(record);
  if (known !== undefined) return known;
  const tz = record.shared.timeZone;
  const timeZone = tz.state === 'given' ? tz.value : tz.state === 'bad' ? tz.raw : undefined;
  const sources = record.sources.filter((s) => settingValue(s.enabled) === true).map((s) => s.sourceId);
  const view: Settings = Object.freeze({ timeZone, sources: Object.freeze(sources) });
  questionViews.set(record, view);
  return view;
}
