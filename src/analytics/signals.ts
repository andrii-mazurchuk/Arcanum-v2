// Stagnant-jar check (S-155): a jar is stagnant when no top-up has an instant in the closed
// 720-hour stretch ending at the as-at instant. The window is 720 hours of 3_600_000 ms, never 30
// local days, so it ignores clock changes. Top-ups are transactions' own instants as the bank
// records them; which jars are judged is decided by the caller (the health family, S-167).

import type { Instant } from '../core/primitives';

export const STAGNANT_WINDOW_MS = 2_592_000_000; // 720 hours of 3_600_000 ms

// Closed at both ends: a top-up exactly STAGNANT_WINDOW_MS before asAt, or at asAt, counts.
// Top-ups after asAt are ignored; no top-up at all is stagnant.
export function isStagnant(topUps: Iterable<Instant>, asAt: Instant): boolean {
  const from = asAt - STAGNANT_WINDOW_MS;
  for (const t of topUps) {
    if (from <= t && t <= asAt) return false;
  }
  return true;
}
