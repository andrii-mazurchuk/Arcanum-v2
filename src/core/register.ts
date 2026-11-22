// Register read model (S-49): sources with their declared capabilities, holdings (accounts and
// jars) with stable narrowing names, scope resolution and the capability partition. Pure
// functions over a register view; reading and writing the rows is the store's.

import type { CurrencyCode, HoldingId, Refusal, SourceId } from './primitives';
import { refuse } from './primitives';

export const CAPABILITIES = ['jars', 'rates'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type HoldingKind = 'account' | 'jar';

export interface SourceRow {
  id: SourceId;
  capabilities: readonly Capability[]; // each at most once, in CAPABILITIES order; declared, never inferred
}
export interface HoldingRow {
  id: HoldingId;
  kind: HoldingKind;
  sourceId: SourceId;
  bankId: string;
  currency: CurrencyCode;
}
export interface RegisterView {
  sources: readonly SourceRow[]; // sorted by id
  holdings: readonly HoldingRow[]; // sorted by id
}

// The only builder of a HoldingId. A source id never contains ':', so the name splits back at its
// first two colons.
export function narrowingName(sourceId: SourceId, kind: HoldingKind, bankId: string): HoldingId {
  return `${sourceId}:${kind}:${bankId}`;
}

export type Narrowing =
  | { kind: 'all' }
  | { kind: 'source'; sourceId: SourceId }
  | { kind: 'holding'; holdingId: HoldingId; holdingKind: HoldingKind; sourceId: SourceId };
export interface ResolvedScope {
  narrowing: Narrowing;
  sources: readonly SourceId[];
  holdings: ReadonlySet<HoldingId>;
}

// Exact match against the register: none -> every holding; a source id -> its accounts and jars;
// a holding id -> that holding alone. Order follows the register.
export function resolveScope(reg: RegisterView, narrowing: string | undefined): ResolvedScope | Refusal {
  if (narrowing === undefined || narrowing === '') {
    return {
      narrowing: { kind: 'all' },
      sources: reg.sources.map((s) => s.id),
      holdings: new Set(reg.holdings.map((h) => h.id)),
    };
  }
  const source = reg.sources.find((s) => s.id === narrowing);
  if (source !== undefined) {
    return {
      narrowing: { kind: 'source', sourceId: source.id },
      sources: [source.id],
      holdings: new Set(reg.holdings.filter((h) => h.sourceId === source.id).map((h) => h.id)),
    };
  }
  const holding = reg.holdings.find((h) => h.id === narrowing);
  if (holding !== undefined) {
    return {
      narrowing: {
        kind: 'holding',
        holdingId: holding.id,
        holdingKind: holding.kind,
        sourceId: holding.sourceId,
      },
      sources: [holding.sourceId],
      holdings: new Set([holding.id]),
    };
  }
  return refuse(
    'scope_not_found',
    narrowing,
    `Nothing named "${narrowing}" is known: no source, account or jar has that name.`,
    narrowing,
  );
}

// Splits the in-scope sources by the declaration alone, never by whether any rows exist.
export function partitionByCapability(
  reg: RegisterView,
  scope: ResolvedScope,
  cap: Capability,
): { offering: SourceId[]; notOffering: SourceId[] } {
  const declaring = new Set(reg.sources.filter((s) => s.capabilities.includes(cap)).map((s) => s.id));
  const offering: SourceId[] = [];
  const notOffering: SourceId[] = [];
  for (const id of scope.sources) (declaring.has(id) ? offering : notOffering).push(id);
  return { offering, notOffering };
}

// Keeps the narrowing as stated; drops every source not listed and every holding of such a source.
export function restrictToSources(
  reg: RegisterView,
  scope: ResolvedScope,
  sources: readonly SourceId[],
): ResolvedScope {
  const keep = new Set(sources);
  const sourceOf = new Map(reg.holdings.map((h) => [h.id, h.sourceId]));
  const holdings = new Set<HoldingId>();
  for (const id of scope.holdings) {
    const sourceId = sourceOf.get(id);
    if (sourceId !== undefined && keep.has(sourceId)) holdings.add(id);
  }
  return {
    narrowing: scope.narrowing,
    sources: scope.sources.filter((id) => keep.has(id)),
    holdings,
  };
}
