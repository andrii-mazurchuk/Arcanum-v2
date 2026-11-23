// Built source list (S-221): the composition root's one ordered list of the sources the product is
// built with, Monobank first then the second source. The settings groups, the balance conventions
// and the one money part are all taken from it, once, when this module is first loaded. Only the
// composition root (app/bin, app/starters, app/sources) imports this module.

import type { SourceId } from '../core/primitives';
import type { SourceSettingsGroup } from '../config/settings';
import { type MoneyPart, createMoneyPart } from '../money/context';
import { source as monobank } from '../sources/monobank/source';
import { source as second } from '../sources/second/source';
import type { BalanceConvention, SourceDefinition } from '../sync/source-contract';

// Fixed product order: the rate source of record is read from it, so Monobank stays first.
export const BUILT_SOURCES: readonly SourceDefinition[] = Object.freeze([monobank, second]);

export const BUILT_GROUPS: readonly SourceSettingsGroup[] = Object.freeze(
  BUILT_SOURCES.map((d) => d.settingsGroup),
);

export const BALANCE_CONVENTIONS: ReadonlyMap<SourceId, BalanceConvention> = new Map(
  BUILT_SOURCES.map((d) => [d.id, d.balanceConvention] as const),
);

// The one money part of the process; nothing else in the product calls createMoneyPart.
export const MONEY_PART: MoneyPart = createMoneyPart(BUILT_SOURCES);

// In list order: a line for each id seen before, and one for each definition whose settings group
// names another source; [] when neither.
export function sourceListFaults(list: readonly SourceDefinition[]): string[] {
  const faults: string[] = [];
  const seen = new Set<SourceId>();
  for (const d of list) {
    if (seen.has(d.id)) faults.push(`duplicate source "${d.id}" in the built source list`);
    seen.add(d.id);
    if (d.settingsGroup.sourceId !== d.id) {
      faults.push(`source "${d.id}": settings group names "${d.settingsGroup.sourceId}"`);
    }
  }
  return faults;
}
