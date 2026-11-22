// Start gate (S-213): the single owner of the per-command required-settings split and of the
// refusal lines' wording. checkStart is pure; runGated is the process entry's gate for the
// service, backfill and release-check commands and owns their refusal exit code. The assistant
// and question front ends call checkStart themselves, after their parse, and exit 1.

import type { SourceId } from './core/primitives';
import type { SettingState, SettingsRecord, SharedSettings, SourceSettings } from './config/settings';

export type CommandKind = 'service' | 'assistant' | 'question' | 'backfill' | 'release-check';
export type GateTarget =
  | { kind: 'service' }
  | { kind: 'assistant' }
  | { kind: 'question' }
  | { kind: 'release-check' }
  | { kind: 'backfill'; sourceId: string };
export type EntryGateTarget = Extract<GateTarget, { kind: 'service' | 'release-check' | 'backfill' }>;

export const SETTINGS_REFUSAL_EXIT = 78;

export const REQUIRED_SHARED: { readonly [K in CommandKind]: readonly (keyof SharedSettings)[] } = Object.freeze({
  service: Object.freeze(['storage', 'firstFillDays', 'pollMinutes', 'pushPort'] as const),
  assistant: Object.freeze(['storage'] as const),
  question: Object.freeze(['storage'] as const),
  backfill: Object.freeze(['storage'] as const),
  'release-check': Object.freeze([] as const),
});

export type GateVerdict = { ok: true; sources: readonly SourceId[] } | { ok: false; lines: readonly string[] };

// The fault line of one setting, or null when it is given or defaulted.
function faultLine(s: SettingState<unknown>, prefix: string): string | null {
  if (s.state === 'missing') return `${prefix}${s.name} is missing: it has no value and no default`;
  if (s.state === 'bad') return `${prefix}${s.name} is bad: "${s.raw}": ${s.reason}`;
  return null;
}

function sourcePrefix(s: SourceSettings): string {
  return `source ${s.sourceId}: `;
}

function isOn(s: SourceSettings): boolean {
  return (s.enabled.state === 'given' || s.enabled.state === 'defaulted') && s.enabled.value === true;
}

// A switched-on source's group past its switch: base address, credential, then extras in order.
function groupLines(s: SourceSettings, lines: string[]): void {
  const prefix = sourcePrefix(s);
  const settings: SettingState<unknown>[] = [s.baseAddress];
  if (s.credential !== null) settings.push(s.credential);
  settings.push(...Object.values(s.extras));
  for (const setting of settings) {
    const line = faultLine(setting, prefix);
    if (line !== null) lines.push(line);
  }
}

export function checkStart(target: GateTarget, record: SettingsRecord): GateVerdict {
  const lines: string[] = [];
  for (const key of REQUIRED_SHARED[target.kind]) {
    const line = faultLine(record.shared[key], '');
    if (line !== null) lines.push(line);
  }

  let sources: readonly SourceId[] = [];
  if (target.kind === 'service') {
    const before = lines.length;
    for (const s of record.sources) {
      const line = faultLine(s.enabled, sourcePrefix(s));
      if (s.enabled.state === 'bad' && line !== null) lines.push(line);
    }
    const on = record.sources.filter(isOn);
    if (on.length === 0 && lines.length === before) {
      const names = record.sources.map((s) => s.enabled.name).join(', ');
      lines.push(`no source is switched on: set one of ${names} to on`);
    }
    for (const s of on) groupLines(s, lines);
    sources = on.map((s) => s.sourceId);
  } else if (target.kind === 'backfill') {
    const s = record.sources.find((x) => x.sourceId === target.sourceId);
    if (s === undefined) {
      const known = record.sources.map((x) => x.sourceId).join(', ');
      lines.push(`unknown source "${target.sourceId}"; known sources: ${known}`);
    } else if (s.enabled.state === 'bad') {
      lines.push(`${sourcePrefix(s)}${s.enabled.name} is bad: "${s.enabled.raw}": ${s.enabled.reason}`);
    } else if (!isOn(s)) {
      lines.push(`source ${s.sourceId} is switched off (${s.enabled.name})`);
    } else {
      groupLines(s, lines);
    }
    sources = [target.sourceId];
  }

  return lines.length === 0
    ? { ok: true, sources: Object.freeze([...sources]) }
    : { ok: false, lines: Object.freeze(lines) };
}

export async function runGated(
  target: EntryGateTarget,
  record: SettingsRecord,
  stderr: (line: string) => void,
  start: (sources: readonly SourceId[]) => Promise<number>,
): Promise<number> {
  const verdict = checkStart(target, record);
  if (!verdict.ok) {
    for (const line of verdict.lines) stderr(line);
    return SETTINGS_REFUSAL_EXIT;
  }
  return await start(verdict.sources);
}
