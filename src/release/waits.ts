// Release waits (S-237): every wait on the product is a repeated question every 5 seconds until a
// condition on the answers holds, with a deadline computed from the limits the check wrote itself
// (S-236) and the calls the awaited jobs make at the stand-ins: (C_running + C_next) x 2 x spacing
// + 2 x polling interval + 60 seconds (A-134). The doubled spacing allows each call a lateness of up
// to one whole spacing, since the check cannot read the product's margin.

import type { StandInLimit } from './stand-ins';
import { SECOND_PAGE_LIMIT } from '../sources/second/source';

export const ASK_INTERVAL_MS = 5_000;
export const DEADLINE_SLACK_MS = 60_000;
export const POLL_INTERVAL_MS = 60_000; // the polling interval the check sets (1 minute)

// The largest gap between counted calls the stand-in enforces: max over limits of windowMs / calls.
export function spacingMs(limits: readonly StandInLimit[]): number {
  let max = 0;
  for (const l of limits) max = Math.max(max, l.windowMs / l.calls);
  return max;
}

export function waitDeadlineMs(p: {
  runningCalls: number;
  nextCalls: number;
  spacingMs: number;
  pollIntervalMs: number;
}): number {
  return (p.runningCalls + p.nextCalls) * 2 * p.spacingMs + 2 * p.pollIntervalMs + DEADLINE_SLACK_MS;
}

// One client-info call plus one statement call per holding.
export function monobankJobCalls(statementHoldings: number): number {
  return 1 + statementHoldings;
}

// One listing call plus, per account, its pages over the job's window (at least one).
export function secondJobCalls(perAccountRecords: readonly number[]): number {
  let calls = 1;
  for (const n of perAccountRecords) calls += Math.max(1, Math.ceil(n / SECOND_PAGE_LIMIT));
  return calls;
}

export interface WaitOutcome {
  readonly met: boolean;
  readonly observed: string;
  readonly elapsedMs: number;
}

// Probes at once and then every ASK_INTERVAL_MS until a probe reports met, or until a probe has been
// made whose start is at or after the deadline; the outcome is that last probe's.
export async function waitFor(
  deadlineMs: number,
  probe: () => Promise<{ met: boolean; observed: string }>,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<WaitOutcome> {
  const start = now();
  for (;;) {
    const probeStart = now();
    let answer: { met: boolean; observed: string };
    try {
      answer = await probe();
    } catch (e) {
      answer = { met: false, observed: e instanceof Error ? e.message : String(e) };
    }
    if (answer.met || probeStart >= start + deadlineMs) {
      return { met: answer.met, observed: answer.observed, elapsedMs: now() - start };
    }
    await sleep(ASK_INTERVAL_MS);
  }
}

// Ranges are drawn inward to the minute, so an end may lie up to a minute before the covered instant.
export function covers(
  ranges: readonly { startAt: number; endAt: number }[] | null,
  from: number,
  until: number,
): boolean {
  if (ranges === null) return false;
  return ranges.some((r) => r.startAt <= from && r.endAt >= until - 60_000);
}
