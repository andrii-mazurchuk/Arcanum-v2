// Question, context, family, contributors and the answer envelope (S-134), judged through the
// answering core (S-229, src/core/core) over a memory store (S-242, src/db/index): the period
// rule, and the contributor and scope statements of every envelope.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load. The type import is erased at run time.

import { describe, expect, test } from 'bun:test';
import type {
  EnvelopeContributor,
  Family,
  Question,
  QuestionContext,
  Settings,
} from '../../src/core/question';

const core = () => import('../../src/core/core');
const store = () => import('../../src/db/index');
const holdings = () => import('../../src/families/holdings');

// Saturday 2026-11-21 12:00 in Warsaw.
const NOW = Date.UTC(2026, 10, 21, 11, 0, 0);

// Core fixture K: altbank declares nothing and holds account X9; monobank declares jars and holds
// account A1 and jar J1.
const fixtureK = async () => {
  const { openStore, MEMORY_LOCATION } = await store();
  const s = openStore(MEMORY_LOCATION);
  s.write((tx: any) => {
    tx.registerSource({ id: 'altbank', capabilities: [] });
    tx.registerSource({ id: 'monobank', capabilities: ['jars'] });
    tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'A1', currency: 'UAH' });
    tx.registerHolding({ kind: 'jar', sourceId: 'monobank', bankId: 'J1', currency: 'UAH' });
    tx.registerHolding({ kind: 'account', sourceId: 'altbank', bankId: 'X9', currency: 'EUR' });
  });
  return s;
};

const settings = (): Settings => ({ timeZone: undefined, sources: [] });

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

const render = (a: unknown) => JSON.stringify(a);

describe('core/question', () => {
  test('period rule', async () => {
    const { createCore } = await core();
    const s = await fixtureK();

    const echo = (ctx: QuestionContext) => ({ kind: 'body' as const, body: { period: ctx.period } });
    const families: Family[] = [
      { name: 'opt_nodefault', period: 'optional', movesPoint: false, compute: echo },
      {
        name: 'opt_default',
        period: 'optional',
        defaultPeriod: 'last-7-days',
        movesPoint: false,
        compute: echo,
      },
      {
        name: 'req_default',
        period: 'required',
        defaultPeriod: 'this-month',
        movesPoint: false,
        compute: echo,
      },
      { name: 'none_fam', period: 'none', movesPoint: false, compute: echo },
    ];
    const c = createCore({ store: s, now: () => NOW, settings, families, contributors: [] } as any);

    const ask = async (family: string, period?: string) => {
      const q: Question = { asker: 'command_line', family, options: {} };
      if (period !== undefined) q.period = period;
      return (await c.serve(q, render as any, channel())).answer as any;
    };

    let e = await ask('opt_nodefault');
    expect(e.period).toBeNull();
    expect(e.outcome.body.period).toBeNull();

    e = await ask('opt_default');
    expect(e.period).toEqual({ text: 'last-7-days', firstDay: '2026-11-15', lastDay: '2026-11-21' });
    expect(e.outcome.body.period.from).toBe(Date.UTC(2026, 10, 14, 23, 0, 0));
    expect(e.outcome.body.period.until).toBe(Date.UTC(2026, 10, 21, 23, 0, 0));

    e = await ask('opt_default', 'this-week');
    expect(e.period).toEqual({ text: 'this-week', firstDay: '2026-11-16', lastDay: '2026-11-21' });

    e = await ask('req_default');
    expect(e.period).toEqual({ text: 'this-month', firstDay: '2026-11-01', lastDay: '2026-11-21' });

    e = await ask('opt_nodefault', 'last-week');
    expect(e.period).toEqual({ text: 'last-week', firstDay: '2026-11-09', lastDay: '2026-11-15' });

    e = await ask('none_fam');
    expect(e.period).toBeNull();

    s.close();
  });

  test('statements and scope statement', async () => {
    const { createCore } = await core();
    const { holdingsFamily } = await holdings();
    const s = await fixtureK();

    let jarCalls = 0;
    const jarFam: Family = {
      name: 'jar_fam',
      period: 'none',
      capability: 'jars',
      movesPoint: false,
      compute: () => {
        jarCalls += 1;
        return { kind: 'body', body: {} };
      },
    };
    const contributors: EnvelopeContributor[] = [
      { key: 'covered', contribute: () => 'C' },
      { key: 'rates', contribute: (ctx) => ({ holdings: ctx.scope.holdings.size }) },
    ];
    const c = createCore({
      store: s,
      now: () => NOW,
      settings,
      families: [holdingsFamily, jarFam],
      contributors,
    } as any);

    const ask = async (family: string, narrowing?: string) => {
      const q: Question = { asker: 'assistant', family, options: {} };
      if (narrowing !== undefined) q.narrowing = narrowing;
      return (await c.serve(q, render as any, channel())).answer as any;
    };

    let e = await ask('holdings');
    expect(e.statements).toEqual({ covered: 'C', rates: { holdings: 3 } });
    expect(e.scope).toEqual({
      narrowing: { kind: 'all' },
      sources: ['altbank', 'monobank'],
      notOffering: [],
    });

    e = await ask('jar_fam', 'altbank');
    expect(e.kind).toBe('envelope');
    expect(e.outcome).toEqual({ kind: 'not_available', capability: 'jars', sources: ['altbank'] });
    expect(e.statements).toEqual({ covered: 'C', rates: { holdings: 1 } });
    expect(jarCalls).toBe(0);

    e = await ask('jar_fam');
    expect(e.outcome.kind).toBe('answered');
    expect(e.scope.sources).toEqual(['monobank']);
    expect(e.scope.notOffering).toEqual(['altbank']);
    // Contributors see the restricted scope.
    expect(e.statements.rates).toEqual({ holdings: 2 });
    expect(jarCalls).toBe(1);

    s.close();
  });
});
