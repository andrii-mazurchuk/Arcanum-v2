// Backfill command (S-216): the zone check before the store opens, the argument forms (a date range
// or --all), the refusals of non-dates, start after end and wholly future ranges, the clips to now and
// to the earliest date offered naming the stretch dropped, the target minus covered, progress lines
// with rate waits, the exact stretches not fetched, the count added and the covered ranges read
// afresh. Runs in the command-line process over the shared store and rate ledger; it never names the
// runtime's network function, which the starter hands in as fetchImpl.

import { type Calendar, openCalendar } from '../analytics/dates';
import { type SettingsRecord, settingValue } from '../config/settings';
import { type Instant, type SourceId, isRefusal } from '../core/primitives';
import type { Store } from '../db/index';
import { type Interval, readCovered } from '../local/covered';
import { SETTINGS_REFUSAL_EXIT } from '../start-gate';
import { type BackfillPlan, type StepEvent, runBackfillJob } from './jobs';
import { subtractIntervals } from './progress';
import { type HttpFetch, type RateLimitDecl, createRateGate, gatedHttp } from './rate-gate';
import type { SourceDefinition } from './source-contract';

export const BACKFILL_REFUSED_EXIT = 2;
export const BACKFILL_FAILED_EXIT = 1;
export const RANGE_FORM = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;

export interface BackfillParams {
  readonly record: SettingsRecord;
  readonly sourceId: SourceId; // the gate already refused an unknown or switched-off source
  readonly args: readonly string[]; // [range] or ['--all']
  readonly built: readonly SourceDefinition[];
  readonly open: () => Store; // the starter's one openStore(location, the product's installer list)
  readonly now: () => Instant;
  readonly fetchImpl: HttpFetch; // the runtime's network function, supplied by the composition root
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal; // aborted by the starter on the interrupt signal
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const USAGE = 'usage: backfill <source> <YYYY-MM-DD..YYYY-MM-DD> | --all';

// 'YYYY-MM-DD HH:MM' of the calendar's local date-time: no seconds, no offset.
const shown = (calendar: Calendar, i: Instant): string => {
  const t = calendar.localDateTime(i);
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
};

export async function runBackfillCommand(p: BackfillParams): Promise<number> {
  const { record, sourceId: id, out, err } = p;

  const tz = record.shared.timeZone;
  if (tz.state === 'bad') {
    err(`${tz.name} is bad: "${tz.raw}": ${tz.reason}`);
    return SETTINGS_REFUSAL_EXIT;
  }
  const opened = openCalendar(tz.state === 'given' ? tz.value : undefined);
  if (isRefusal(opened)) {
    err(`${tz.name} is bad: "${opened.value ?? ''}": ${opened.message}`);
    return SETTINGS_REFUSAL_EXIT;
  }
  const calendar = opened;
  const at = (i: Instant): string => shown(calendar, i);

  const all = p.args.length === 1 && p.args[0] === '--all';
  const range = !all && p.args.length === 1 && RANGE_FORM.test(p.args[0] as string) ? (p.args[0] as string) : null;
  if (!all && range === null) {
    err(USAGE);
    return BACKFILL_REFUSED_EXIT;
  }

  let from = 0;
  let until = 0;
  if (range !== null) {
    const period = calendar.resolvePeriod(range, p.now());
    if (isRefusal(period)) {
      err(period.message);
      return BACKFILL_REFUSED_EXIT;
    }
    from = period.from;
    until = period.until;
    if (from >= p.now()) {
      err('the range lies wholly in the future');
      return BACKFILL_REFUSED_EXIT;
    }
  }

  // The start gate has already refused an unknown or switched-off source; reaching here without one
  // is a fault of the caller, not a refusal of the holder's.
  const def = p.built.find((d) => d.id === id);
  const settings = record.sources.find((s) => s.sourceId === id);
  if (def === undefined || settings === undefined) throw new Error(`backfill: source ${id} is not built and configured`);

  const store = p.open();
  try {
    const limits = new Map<SourceId, RateLimitDecl>(p.built.map((d) => [d.id, d.limits]));
    const gate = createRateGate({ store, limits, now: p.now, sleep: p.sleep });
    const extras: Record<string, unknown> = {};
    for (const [key, state] of Object.entries(settings.extras)) extras[key] = settingValue(state);
    const client = def.open({
      baseAddress: settingValue(settings.baseAddress) ?? '',
      credential: settings.credential === null ? null : (settingValue(settings.credential) ?? null),
      extras,
      http: gatedHttp(gate, id, p.fetchImpl, (w) =>
        out(`waiting ${Math.ceil(w.waitMs / 1000)} s for ${id}'s rate limit, until ${at(w.until)}`),
      ),
    });

    let plan: BackfillPlan;
    if (range !== null) {
      const n = p.now();
      if (until > n) {
        out(`clipped ${at(n)} .. ${at(until)}: in the future`);
        until = n;
      }
      if (def.earliestAvailable !== undefined) {
        const e = def.earliestAvailable(n);
        if (from < e) {
          out(`clipped ${at(from)} .. ${at(e)}: before the earliest date ${id} offers`);
          from = e;
        }
      }
      const window: Interval[] = from < until ? [{ startAt: from, endAt: until }] : [];
      const covered = store.readSnapshot((s) => readCovered(s, id));
      plan = { kind: 'range', target: subtractIntervals(window, covered) };
    } else {
      const first = store.readSnapshot((s) => readCovered(s, id))[0];
      plan = {
        kind: 'walk',
        from: first === undefined ? p.now() : first.startAt,
        floor: def.earliestAvailable?.(p.now()) ?? null,
      };
    }

    const onStep = (e: StepEvent): void => {
      const span = `${at(e.window.startAt)} .. ${at(e.window.endAt)}`;
      if (e.kind === 'step_done') out(`fetched ${span}: ${e.added} new of ${e.rows}`);
      else err(`not fetched ${span}: ${e.reason}`);
    };
    const outcome = await runBackfillJob(
      { store, definition: def, client, gate, now: p.now, log: () => {}, signal: p.signal, onStep },
      plan,
    );

    out(`added ${outcome.added} transactions`);
    if (outcome.refusedBefore !== null) out(`clipped: ${id} offers nothing before ${at(outcome.refusedBefore)}`);
    if (outcome.earliestReached !== null) out(`earliest date reached: ${at(outcome.earliestReached)}`);
    if (outcome.status === 'failed' && outcome.failed !== null) {
      const notFetched = [...outcome.failed.notFetched].sort((a, b) => a.startAt - b.startAt);
      for (const x of notFetched) {
        err(`stopped: ${at(x.startAt)} .. ${at(x.endAt)} not fetched: ${outcome.failed.reason}`);
      }
    }
    const coveredNow = store.readSnapshot((s) => readCovered(s, id));
    if (coveredNow.length === 0) out(`covered ${id}: nothing`);
    for (const x of coveredNow) out(`covered ${id}: ${at(x.startAt)} .. ${at(x.endAt)}`);

    return outcome.status === 'completed' ? 0 : BACKFILL_FAILED_EXIT;
  } finally {
    store.close();
  }
}
