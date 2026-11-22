// Register read model (S-49): stable narrowing names, scope resolution against the register of
// sources and holdings, and the capability partition, from src/core/register.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const register = () => import('../../src/core/register');
const primitives = () => import('../../src/core/primitives');

// Both lists sorted by id. altbank declares nothing and holds an account; monobank declares jars
// and holds an account and a jar; zbank declares jars and holds nothing.
const R = {
  sources: [
    { id: 'altbank', capabilities: [] },
    { id: 'monobank', capabilities: ['jars'] },
    { id: 'zbank', capabilities: ['jars'] },
  ],
  holdings: [
    { id: 'altbank:account:X9', kind: 'account', sourceId: 'altbank', bankId: 'X9', currency: 'EUR' },
    { id: 'monobank:account:A1', kind: 'account', sourceId: 'monobank', bankId: 'A1', currency: 'UAH' },
    { id: 'monobank:jar:J1', kind: 'jar', sourceId: 'monobank', bankId: 'J1', currency: 'UAH' },
  ],
} as const;

describe('core/register', () => {
  test('resolveScope all and source', async () => {
    const { narrowingName, resolveScope } = await register();

    expect(narrowingName('monobank', 'jar', 'J1')).toBe('monobank:jar:J1');
    expect(narrowingName('altbank', 'account', 'X9')).toBe('altbank:account:X9');

    for (const n of [undefined, '']) {
      const s = resolveScope(R, n) as any;
      expect(s.narrowing).toEqual({ kind: 'all' });
      expect(s.sources).toEqual(['altbank', 'monobank', 'zbank']);
      expect([...s.holdings]).toEqual([
        'altbank:account:X9',
        'monobank:account:A1',
        'monobank:jar:J1',
      ]);
    }

    const s = resolveScope(R, 'monobank') as any;
    expect(s.narrowing).toEqual({ kind: 'source', sourceId: 'monobank' });
    expect(s.sources).toEqual(['monobank']);
    expect([...s.holdings]).toEqual(['monobank:account:A1', 'monobank:jar:J1']);

    const z = resolveScope(R, 'zbank') as any;
    expect(z.holdings.size).toBe(0);
    expect(z.sources).toEqual(['zbank']);
  });

  test('resolveScope one holding', async () => {
    const { resolveScope } = await register();

    const a = resolveScope(R, 'monobank:account:A1') as any;
    expect(a.narrowing).toEqual({
      kind: 'holding',
      holdingId: 'monobank:account:A1',
      holdingKind: 'account',
      sourceId: 'monobank',
    });
    expect(a.sources).toEqual(['monobank']);
    expect([...a.holdings]).toEqual(['monobank:account:A1']);
    expect(a.holdings.size).toBe(1);

    const j = resolveScope(R, 'monobank:jar:J1') as any;
    expect(j.narrowing).toEqual({
      kind: 'holding',
      holdingId: 'monobank:jar:J1',
      holdingKind: 'jar',
      sourceId: 'monobank',
    });
    expect([...j.holdings]).toEqual(['monobank:jar:J1']);
  });

  test('resolveScope refuses unknown names', async () => {
    const { resolveScope } = await register();
    const { isRefusal } = await primitives();

    for (const t of [
      'Monobank',
      ' monobank',
      'monobank:account:a1',
      'monobank:account',
      'monobank:account:A1:x',
      'nope',
    ]) {
      const r = resolveScope(R, t) as any;
      expect(isRefusal(r)).toBe(true);
      expect(r.reason).toBe('scope_not_found');
      expect(r.subject).toBe(t);
      expect(r.value).toBe(t);
      expect(r.message).toContain(`"${t}"`);
    }
  });

  test('partitionByCapability and restrictToSources', async () => {
    const { resolveScope, partitionByCapability, restrictToSources } = await register();

    const all = resolveScope(R, undefined) as any;

    expect(partitionByCapability(R, all, 'jars')).toEqual({
      offering: ['monobank', 'zbank'],
      notOffering: ['altbank'],
    });
    expect(partitionByCapability(R, resolveScope(R, 'altbank') as any, 'jars')).toEqual({
      offering: [],
      notOffering: ['altbank'],
    });

    const s = restrictToSources(R, all, ['monobank', 'zbank']);
    expect(s.narrowing).toEqual({ kind: 'all' });
    expect(s.sources).toEqual(['monobank', 'zbank']);
    expect([...s.holdings]).toEqual(['monobank:account:A1', 'monobank:jar:J1']);
  });
});
