// Answer primitives (S-01): the one refusal shape and the closed vocabularies every other
// answer-frame entry imports from src/core/primitives.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const primitives = () => import('../../src/core/primitives');

describe('core/primitives', () => {
  test('refuse builds a frozen refusal and isRefusal tells it apart', async () => {
    const { refuse, isRefusal } = await primitives();

    const r = refuse(
      'bad_option',
      'limit',
      'The option "limit" holds "-3", which is not a whole number of 1 or more.',
      '-3',
    );
    const r2 = refuse('scope_not_found', 'x', 'm');

    expect(r).toEqual({
      kind: 'refused',
      reason: 'bad_option',
      subject: 'limit',
      value: '-3',
      message: 'The option "limit" holds "-3", which is not a whole number of 1 or more.',
    });
    expect(r2.value).toBeUndefined();

    expect(Object.isFrozen(r)).toBe(true);
    expect(() => {
      (r as any).reason = 'bad_period';
    }).toThrow(TypeError);
    expect(r.reason).toBe('bad_option');

    expect(isRefusal(r)).toBe(true);
    expect(isRefusal({ kind: 'refused' })).toBe(true);

    for (const x of [null, undefined, 'refused', 42, { kind: 'envelope' }, {}, []]) {
      let result: unknown;
      expect(() => {
        result = isRefusal(x);
      }).not.toThrow();
      expect(result).toBe(false);
    }
  });

  test('declared vocabularies are exact', async () => {
    const { DISPLAY_CURRENCIES, DEFAULT_DISPLAY_CURRENCY, ASKERS, REFUSAL_REASONS } =
      await primitives();

    expect([...DISPLAY_CURRENCIES]).toEqual(['PLN', 'UAH', 'USD', 'EUR']);
    expect(DEFAULT_DISPLAY_CURRENCY).toBe('PLN');
    expect([...ASKERS]).toEqual(['assistant', 'command_line']);
    expect([...REFUSAL_REASONS]).toEqual([
      'unknown_time_zone',
      'bad_period',
      'scope_not_found',
      'bad_display_currency',
      'bad_option',
    ]);
  });
});
