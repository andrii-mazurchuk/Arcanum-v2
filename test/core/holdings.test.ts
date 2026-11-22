// Holdings family (S-07, src/families/holdings): lists the sources in scope with their declared
// capabilities and, under each, only the in-scope holdings, reading nothing but register and scope.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load. The type import is erased at run time.

import { describe, expect, test } from 'bun:test';
import type { QuestionContext } from '../../src/core/question';
import type { RegisterView } from '../../src/core/register';

const holdings = () => import('../../src/families/holdings');
const register = () => import('../../src/core/register');

// Register R: altbank declares nothing and holds account X9; monobank declares jars and holds
// account A1 and jar J1; zbank declares jars and holds nothing.
const R: RegisterView = {
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
};

// Every QuestionContext field but register and scope throws when read.
const OTHER_FIELDS = [
  'snapshot',
  'now',
  'settings',
  'calendar',
  'displayCurrency',
  'position',
  'period',
  'asker',
  'options',
] as const;

const ctxFor = async (n: string | undefined): Promise<QuestionContext> => {
  const { resolveScope } = await register();
  const ctx: Record<string, unknown> = { register: R, scope: resolveScope(R, n) };
  for (const name of OTHER_FIELDS) {
    Object.defineProperty(ctx, name, {
      enumerable: true,
      get() {
        throw new Error('read ' + name);
      },
    });
  }
  return ctx as unknown as QuestionContext;
};

describe('families/holdings', () => {
  test('holdings lists scope', async () => {
    const { holdingsFamily } = await holdings();

    expect(holdingsFamily.name).toBe('holdings');
    expect(holdingsFamily.period).toBe('none');
    expect(holdingsFamily.movesPoint).toBe(false);
    expect(holdingsFamily.capability).toBeUndefined();

    const all = holdingsFamily.compute(await ctxFor(undefined));
    expect(all).toEqual({
      kind: 'body',
      body: {
        sources: [
          {
            id: 'altbank',
            capabilities: [],
            holdings: [{ name: 'altbank:account:X9', kind: 'account', currency: 'EUR' }],
          },
          {
            id: 'monobank',
            capabilities: ['jars'],
            holdings: [
              { name: 'monobank:account:A1', kind: 'account', currency: 'UAH' },
              { name: 'monobank:jar:J1', kind: 'jar', currency: 'UAH' },
            ],
          },
          { id: 'zbank', capabilities: ['jars'], holdings: [] },
        ],
      },
    });
    expect((all as { pending?: unknown }).pending).toBeUndefined();

    const jar = holdingsFamily.compute(await ctxFor('monobank:jar:J1'));
    expect(jar).toEqual({
      kind: 'body',
      body: {
        sources: [
          {
            id: 'monobank',
            capabilities: ['jars'],
            holdings: [{ name: 'monobank:jar:J1', kind: 'jar', currency: 'UAH' }],
          },
        ],
      },
    });
  });
});
