// Holdings family (S-07): lists the sources in scope with their declared capabilities and, under
// each, its in-scope accounts and jars by narrowing name. Reads only the register and the scope.

import type { Family } from '../core/question';
import type { Capability, HoldingKind } from '../core/register';

export interface HoldingsBody {
  sources: readonly {
    id: string;
    capabilities: readonly Capability[];
    holdings: readonly { name: string; kind: HoldingKind; currency: string }[];
  }[];
}

export const holdingsFamily: Family<HoldingsBody> = {
  name: 'holdings',
  period: 'none',
  movesPoint: false,
  compute(ctx) {
    const { register, scope } = ctx;
    const capabilitiesOf = new Map(register.sources.map((s) => [s.id, s.capabilities]));
    return {
      kind: 'body',
      body: {
        sources: scope.sources.map((id) => ({
          id,
          capabilities: capabilitiesOf.get(id) ?? [],
          holdings: register.holdings
            .filter((h) => h.sourceId === id && scope.holdings.has(h.id))
            .map((h) => ({ name: h.id, kind: h.kind, currency: h.currency })),
        })),
      },
    };
  },
};
