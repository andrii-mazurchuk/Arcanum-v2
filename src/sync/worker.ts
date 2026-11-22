// Sync worker (S-104): one single-flight worker per switched-on source, its start job then a poll on
// each tick at start plus whole intervals (bigint tick arithmetic, timers split at the longest delay),
// a busy tick dropped, every job's failure contained, and a stop that cancels the timer, aborts the job
// and resolves when it has ended.

import type { Instant } from '../core/primitives';
import { type JobDeps, type JobOutcome, type RefreshOptions, runPoll, runStartJob } from './jobs';

export const MAX_TIMER_MS = 2_147_483_647; // longest delay one timer is given

export interface Timers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WorkerDeps {
  readonly job: Omit<JobDeps, 'signal'>; // store, definition, client, gate, now, log
  readonly firstFillDays: number; // the setting's value, 1..90
  readonly pollMinutes: number; // the setting's value, whole, >= 1
  readonly startedAt: Instant; // the service's start instant
  readonly pushAddress: string | null; // pushAddress(pushSettingsOf(...)) when the source has push, else null
  readonly timers: Timers;
}

export interface SyncWorker {
  start(): void; // once
  stop(): Promise<void>; // idempotent
  readonly busy: boolean;
  readonly ticksDropped: number;
}

export function nextTickAt(startedAt: Instant, pollMinutes: number, now: Instant): bigint {
  const interval = BigInt(pollMinutes) * 60000n;
  return BigInt(startedAt) + (BigInt(now - startedAt) / interval + 1n) * interval;
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createSyncWorker(deps: WorkerDeps): SyncWorker {
  const { job, timers } = deps;
  const id = job.definition.id;
  const controller = new AbortController();
  const jobDeps: JobDeps = { ...job, signal: controller.signal };

  let started = false;
  let stopped = false;
  let handle: unknown = null;
  let next = 0n;
  let running: Promise<void> | null = null;
  let ticksDropped = 0;

  const arm = (): void => {
    const remaining = next - BigInt(job.now());
    const max = BigInt(MAX_TIMER_MS);
    handle = timers.setTimeout(fire, Number(remaining < max ? remaining : max));
  };

  const run = (label: string, call: (opts: RefreshOptions) => Promise<JobOutcome>, opts: RefreshOptions): void => {
    let promise: Promise<JobOutcome>;
    try {
      promise = call(opts);
    } catch (e) {
      promise = Promise.reject(e);
    }
    running = promise
      .then(
        (o) => {
          job.log(`sync ${o.kind} source=${id} status=${o.status} steps=${o.stepsDone} added=${o.added}`);
        },
        (e) => {
          job.log(`sync ${label} source=${id} crashed: ${reasonOf(e)}`);
        },
      )
      .finally(() => {
        running = null;
      });
  };

  function fire(): void {
    handle = null;
    if (stopped) return;
    const now = job.now();
    if (BigInt(now) < next) {
      arm();
      return;
    }
    next = nextTickAt(deps.startedAt, deps.pollMinutes, now);
    arm();
    if (running !== null) {
      ticksDropped += 1;
      job.log(`poll tick dropped source=${id}: busy`);
      return;
    }
    run('poll', (opts) => runPoll(jobDeps, deps.firstFillDays, opts), {
      recordRates: true,
      pushAddress: deps.pushAddress,
      registerWhenUnread: false,
    });
  }

  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      next = nextTickAt(deps.startedAt, deps.pollMinutes, job.now());
      arm();
      run('start', (opts) => runStartJob(jobDeps, deps.firstFillDays, opts), {
        recordRates: true,
        pushAddress: deps.pushAddress,
        registerWhenUnread: true,
      });
    },
    stop(): Promise<void> {
      if (!stopped) {
        stopped = true;
        if (handle !== null) {
          timers.clearTimeout(handle);
          handle = null;
        }
        controller.abort();
      }
      return running ?? Promise.resolve();
    },
    get busy(): boolean {
      return running !== null;
    },
    get ticksDropped(): number {
      return ticksDropped;
    },
  };
}
