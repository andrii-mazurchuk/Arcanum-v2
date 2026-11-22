// Job runner (S-145): the holdings refresh (register, balances stamped before the request, rates,
// push address) under the job's signal, the rate-refusal retry, one step as a whole fetch closed by
// one ingest write holding its covered part and the first-fill mark, forward jobs oldest first
// stopping at the first failure, the start-job choice, the poll, backfill steps newest first or
// walking back, and a failed job's exact not-fetched part. The only planner of steps, the only caller
// of ingest for fetched windows, and the only writer of the first-fill record.

import type { Instant } from '../core/primitives';
import type { HoldingRow } from '../core/register';
import type { Store, WriteTx } from '../db/index';
import { type Interval, coveredPart, normaliseIntervals, readCovered } from '../local/covered';
import { ingest, quarantinedMoments } from '../local/ingest';
import type { TranslatedTransaction } from '../local/translated';
import { type Translated, listQuarantine } from '../money/quarantine';
import { recordRates } from '../money/recorded-rates';
import { recordBalances } from './balances';
import {
  type FirstFillRecord,
  SETTLE_MS,
  createFirstFill,
  excludedMinutes,
  fillIsComplete,
  fillTarget,
  forwardTarget,
  markFirstFillComplete,
  planSteps,
  readFirstFill,
} from './progress';
import type { RateGate } from './rate-gate';
import { type HoldingsReport, type SourceClient, SourceCallError, type SourceDefinition } from './source-contract';

export type JobKind = 'first_fill' | 'catch_up' | 'poll' | 'backfill';

export interface JobDeps {
  readonly store: Store;
  readonly definition: SourceDefinition;
  readonly client: SourceClient; // opened over a GatedHttp of this process's one gate
  readonly gate: RateGate;
  readonly now: () => Instant;
  readonly log: (line: string) => void;
  readonly signal: AbortSignal;
  readonly onStep?: (e: StepEvent) => void;
}

export interface RefreshOptions {
  readonly recordRates: boolean;
  readonly pushAddress: string | null;
  readonly registerWhenUnread: boolean;
}

export type StepEvent =
  | { kind: 'step_done'; window: Interval; added: number; rows: number; covered: boolean }
  | { kind: 'step_failed'; window: Interval; reason: string };

export interface JobOutcome {
  readonly kind: JobKind;
  readonly status: 'completed' | 'failed' | 'stopped';
  readonly stepsDone: number;
  readonly added: number; // rows whose ingest outcome was 'stored'
  readonly failed: { notFetched: readonly Interval[]; reason: string } | null; // set iff status 'failed'
  readonly refusedBefore: Instant | null; // backfill: the bank refused dates before this instant
  readonly earliestReached: Instant | null; // backfill walk: startAt of the last whole step
}

export type BackfillPlan =
  | { kind: 'range'; target: readonly Interval[] } // already clipped and minus covered
  | { kind: 'walk'; from: Instant; floor: Instant | null }; // walk back from `from`; floor = earliestAvailable, if declared

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function withRateRetry<T>(deps: JobDeps, call: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await call();
    } catch (e) {
      if (!(e instanceof SourceCallError && e.kind === 'rate_refused')) throw e;
      deps.gate.recordRefusal(deps.definition.id);
      deps.log(`rate refused source=${deps.definition.id}; retrying`);
      if (deps.signal.aborted) throw deps.signal.reason;
    }
  }
}

export async function refreshHoldings(deps: JobDeps, opts: RefreshOptions): Promise<void> {
  const { store, definition, client, signal } = deps;
  const id = definition.id;
  let requestedAt = deps.now();
  const report: HoldingsReport = await withRateRetry(deps, () => {
    requestedAt = deps.now();
    return client.refreshHoldings(signal);
  });
  store.write((tx) => {
    tx.registerSource({ id, capabilities: definition.capabilities });
    for (const h of report.holdings) tx.registerHolding(h);
    recordBalances(tx, id, report.balances, requestedAt, 'restated');
  });

  const fetchRates = client.fetchRates;
  if (opts.recordRates && fetchRates !== undefined) {
    try {
      const stated = await withRateRetry(deps, () => fetchRates.call(client, signal));
      store.write((tx) => {
        recordRates(tx, id, stated, deps.now());
      });
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      deps.log(`rates fetch failed source=${id}: ${reasonOf(e)}`);
    }
  }

  const registerPush = client.registerPush;
  if (opts.pushAddress !== null && registerPush !== undefined) {
    const held = report.pushAddress;
    const due = held === undefined ? opts.registerWhenUnread : held !== opts.pushAddress;
    if (due) {
      try {
        await registerPush.call(client, opts.pushAddress, signal);
      } catch (e) {
        if (signal.aborted) throw signal.reason;
        deps.log(`push registration failed source=${id}: ${reasonOf(e)}`);
      }
    }
  }
}

interface StepResult {
  readonly added: number;
  readonly rows: number;
  readonly whole: boolean; // false when a covered part could not be computed (an unreadable quarantined moment)
}

const inside = (x: Interval, part: Interval): boolean =>
  x.startAt < x.endAt &&
  x.startAt >= part.startAt &&
  x.endAt <= part.endAt &&
  x.endAt - x.startAt < part.endAt - part.startAt;

// One step over w: every holding fetched whole, then one closing ingest write.
async function step(deps: JobDeps, w: Interval, forward: boolean): Promise<StepResult> {
  const { store, definition, client, signal } = deps;
  const id = definition.id;
  const holdings: HoldingRow[] = store
    .readSnapshot((s) => s.register())
    .holdings.filter((h) => h.sourceId === id);

  const items: Translated<TranslatedTransaction>[] = [];
  for (const h of holdings) {
    let part = w;
    for (;;) {
      const current = part;
      const page = await withRateRetry(deps, () => client.fetchWindow(h, current, signal));
      items.push(...page.items);
      if (page.next === null) break;
      if (!inside(page.next, current)) throw new SourceCallError('other', 'row cap not resolvable');
      part = page.next;
    }
  }
  if (signal.aborted) throw signal.reason;

  const covered = coveredPart(w, quarantinedMoments(items));
  let also: ((tx: WriteTx) => void) | undefined;
  if (forward) {
    const seen = store.readSnapshot((s) => ({
      rec: readFirstFill(s, id),
      before: readCovered(s, id),
      excluded: excludedMinutes(listQuarantine(s.db, id), deps.now() - SETTLE_MS),
    }));
    const rec = seen.rec;
    if (rec !== null && rec.completedAt === null) {
      also = (tx) => {
        if (covered !== null && fillIsComplete([...seen.before, ...covered], seen.excluded, rec)) {
          markFirstFillComplete(tx, id, deps.now());
        }
      };
    }
  }
  const result = ingest(store, { sourceId: id, items, covered, also }, deps.log);
  const added = result.outcomes.filter((o) => o.outcome === 'stored').length;
  return { added, rows: items.length, whole: covered !== null };
}

const outcome = (kind: JobKind, o: Partial<JobOutcome> & Pick<JobOutcome, 'status'>): JobOutcome => ({
  kind,
  stepsDone: 0,
  added: 0,
  failed: null,
  refusedBefore: null,
  earliestReached: null,
  ...o,
});

// The refresh a run function begins with; null when it went through, else the outcome that ends the job.
async function openingRefresh(
  deps: JobDeps,
  kind: JobKind,
  opts: RefreshOptions,
  target: () => readonly Interval[],
): Promise<JobOutcome | null> {
  try {
    await refreshHoldings(deps, opts);
    return null;
  } catch (e) {
    if (deps.signal.aborted) return outcome(kind, { status: 'stopped' });
    const reason = reasonOf(e);
    deps.log(`sync failed source=${deps.definition.id} kind=${kind} before any step: ${reason}`);
    return outcome(kind, { status: 'failed', failed: { notFetched: normaliseIntervals(target()), reason } });
  }
}

async function runForward(deps: JobDeps, kind: JobKind, target: readonly Interval[]): Promise<JobOutcome> {
  const steps = planSteps(target, deps.definition.maxWindowMs, 'oldest_first');
  let stepsDone = 0;
  let added = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const w = steps[i] as Interval;
    if (deps.signal.aborted) return outcome(kind, { status: 'stopped', stepsDone, added });
    try {
      const r = await step(deps, w, true);
      stepsDone += 1;
      added += r.added;
      deps.onStep?.({ kind: 'step_done', window: w, added: r.added, rows: r.rows, covered: r.whole });
    } catch (e) {
      if (deps.signal.aborted) return outcome(kind, { status: 'stopped', stepsDone, added });
      const reason = reasonOf(e);
      deps.onStep?.({ kind: 'step_failed', window: w, reason });
      const notFetched = normaliseIntervals(steps.slice(i));
      deps.log(
        `sync failed source=${deps.definition.id} kind=${kind} from=${new Date((notFetched[0] as Interval).startAt).toISOString()}: ${reason}`,
      );
      return outcome(kind, { status: 'failed', stepsDone, added, failed: { notFetched, reason } });
    }
  }
  return outcome(kind, { status: 'completed', stepsDone, added });
}

// The first-fill record, created before any fetch when the source has none.
function recordFor(deps: JobDeps, jobStart: Instant, firstFillDays: number): FirstFillRecord {
  const id = deps.definition.id;
  return (
    deps.store.readSnapshot((s) => readFirstFill(s, id)) ?? createFirstFill(deps.store, id, jobStart, firstFillDays)
  );
}

function targetOf(deps: JobDeps, kind: JobKind, rec: FirstFillRecord, jobStart: Instant): Interval[] {
  const id = deps.definition.id;
  return deps.store.readSnapshot((s) => {
    const covered = readCovered(s, id);
    const excluded = excludedMinutes(listQuarantine(s.db, id), jobStart - SETTLE_MS);
    return kind === 'first_fill'
      ? fillTarget(covered, excluded, rec, jobStart)
      : forwardTarget(covered, excluded, rec.anchorAt, jobStart);
  });
}

export async function runStartJob(deps: JobDeps, firstFillDays: number, opts: RefreshOptions): Promise<JobOutcome> {
  const jobStart = deps.now();
  const rec = recordFor(deps, jobStart, firstFillDays);
  const kind: JobKind = rec.completedAt === null ? 'first_fill' : 'catch_up';
  const ended = await openingRefresh(deps, kind, opts, () => targetOf(deps, kind, rec, jobStart));
  if (ended !== null) return ended;
  return runForward(deps, kind, targetOf(deps, kind, rec, jobStart));
}

export async function runPoll(deps: JobDeps, firstFillDays: number, opts: RefreshOptions): Promise<JobOutcome> {
  const jobStart = deps.now();
  const rec = recordFor(deps, jobStart, firstFillDays);
  const ended = await openingRefresh(deps, 'poll', opts, () => targetOf(deps, 'poll', rec, jobStart));
  if (ended !== null) return ended;
  return runForward(deps, 'poll', targetOf(deps, 'poll', rec, jobStart));
}

const BACKFILL_REFRESH: RefreshOptions = { recordRates: false, pushAddress: null, registerWhenUnread: false };

export async function runBackfillJob(deps: JobDeps, plan: BackfillPlan): Promise<JobOutcome> {
  const { definition, signal } = deps;
  const maxWindowMs = definition.maxWindowMs;
  const walkStep = (cursor: Instant, floor: Instant | null): Interval => ({
    startAt: Math.max(cursor - maxWindowMs, floor ?? -Infinity),
    endAt: cursor,
  });

  let first: readonly Interval[];
  if (plan.kind === 'range') {
    first = normaliseIntervals(plan.target);
    if (first.length === 0) return outcome('backfill', { status: 'completed' });
  } else {
    const w = walkStep(plan.from, plan.floor);
    if (w.startAt >= w.endAt) return outcome('backfill', { status: 'completed', refusedBefore: plan.floor });
    first = [w];
  }

  const registered = deps.store
    .readSnapshot((s) => s.register())
    .holdings.some((h) => h.sourceId === definition.id);
  if (!registered) {
    const ended = await openingRefresh(deps, 'backfill', BACKFILL_REFRESH, () => first);
    if (ended !== null) return ended;
  }

  let stepsDone = 0;
  let added = 0;
  const stopped = () => outcome('backfill', { status: 'stopped', stepsDone, added });
  const dateRefused = (e: unknown) => e instanceof SourceCallError && e.kind === 'date_refused';

  if (plan.kind === 'range') {
    const steps = planSteps(first, maxWindowMs, 'newest_first');
    for (let i = 0; i < steps.length; i += 1) {
      const w = steps[i] as Interval;
      if (signal.aborted) return stopped();
      try {
        const r = await step(deps, w, false);
        stepsDone += 1;
        added += r.added;
        deps.onStep?.({ kind: 'step_done', window: w, added: r.added, rows: r.rows, covered: r.whole });
      } catch (e) {
        if (signal.aborted) return stopped();
        const reason = reasonOf(e);
        deps.onStep?.({ kind: 'step_failed', window: w, reason });
        if (dateRefused(e)) return outcome('backfill', { status: 'completed', stepsDone, added, refusedBefore: w.endAt });
        const notFetched = normaliseIntervals(steps.slice(i));
        return outcome('backfill', { status: 'failed', stepsDone, added, failed: { notFetched, reason } });
      }
    }
    return outcome('backfill', { status: 'completed', stepsDone, added });
  }

  let cursor = plan.from;
  let earliestReached: Instant | null = null;
  for (;;) {
    const w = walkStep(cursor, plan.floor);
    if (w.startAt >= w.endAt) {
      return outcome('backfill', { status: 'completed', stepsDone, added, refusedBefore: plan.floor, earliestReached });
    }
    if (signal.aborted) return outcome('backfill', { status: 'stopped', stepsDone, added, earliestReached });
    try {
      const r = await step(deps, w, false);
      stepsDone += 1;
      added += r.added;
      earliestReached = w.startAt;
      deps.onStep?.({ kind: 'step_done', window: w, added: r.added, rows: r.rows, covered: r.whole });
      if (r.rows === 0) return outcome('backfill', { status: 'completed', stepsDone, added, earliestReached });
      cursor = w.startAt;
    } catch (e) {
      if (signal.aborted) return outcome('backfill', { status: 'stopped', stepsDone, added, earliestReached });
      const reason = reasonOf(e);
      deps.onStep?.({ kind: 'step_failed', window: w, reason });
      if (dateRefused(e)) {
        return outcome('backfill', { status: 'completed', stepsDone, added, refusedBefore: cursor, earliestReached });
      }
      return outcome('backfill', { status: 'failed', stepsDone, added, earliestReached, failed: { notFetched: [w], reason } });
    }
  }
}
