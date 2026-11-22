// Translated transaction (S-138): the one shape every source fills for ingest. Its identity key
// and the deterministic key order, and the eight rules checkTranslated enforces, from
// src/local/translated.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type import is erased at run time.

import { describe, expect, test } from 'bun:test';
import type { TranslatedTransaction } from '../../src/local/translated';

const translated = () => import('../../src/local/translated');
const moneyModule = () => import('../../src/money/money');
const register = () => import('../../src/core/register');

describe('local/translated', () => {
  test('keyText and compareKeys', async () => {
    const { keyText, compareKeys } = await translated();

    const k1 = { sourceId: 'monobank', bankId: 'Zeta' };
    const k2 = { sourceId: 'monobank', bankId: 'alpha' };
    const k3 = { sourceId: 'monobank', bankId: 'Zeta' };
    const k4 = { sourceId: 'monobank', bankId: 'Zeta-longer-identifier' };

    expect(keyText(k1)).toBe('monobank:Zeta');

    // 'Z' is U+005A and 'a' is U+0061: code unit order puts Zeta first, a locale order would not.
    // Exact -1 / 1, not a raw code unit difference (which would give -7 here).
    expect(compareKeys(k1, k2)).toBe(-1);
    expect(compareKeys(k2, k1)).toBe(1);

    expect(compareKeys(k1, k3)).toBe(0);

    // The shorter text is a prefix of the longer one.
    expect(compareKeys(k1, k4)).toBe(-1);
    expect(compareKeys(k4, k1)).toBe(1);
  });

  test('checkTranslated rules', async () => {
    const { checkTranslated, TranslatedShapeError } = await translated();
    const { money } = await moneyModule();
    const { narrowingName } = await register();

    const at = Date.parse('2026-11-21T10:00:00Z');
    const base: TranslatedTransaction = {
      sourceId: 'monobank',
      bankId: 'tx-1',
      holdingId: narrowingName('monobank', 'account', 'a'),
      occurredAt: at,
      amount: money(-10000n, 'UAH'),
      originalAmount: money(-273n, 'USD'),
      cashback: money(250n, 'UAH'),
      settled: true,
      mcc: 5411,
      originalMcc: null,
      merchantText: null,
      description: 'SILPO',
      comment: null,
      counterpart: null,
    };

    const passes: readonly (readonly [string, TranslatedTransaction])[] = [
      ['base', base],
      ['cashback null', { ...base, cashback: null }],
      ['cashback stated zero', { ...base, cashback: money(0n, 'UAH') }],
      ['mcc 0', { ...base, mcc: 0 }],
      ['mcc 9999', { ...base, mcc: 9999 }],
      ['originalMcc 9999', { ...base, originalMcc: 9999 }],
      ['both amounts zero', { ...base, amount: money(0n, 'UAH'), originalAmount: money(0n, 'USD') }],
      ['originalAmount null', { ...base, originalAmount: null }],
      [
        'unregistered counterpart jar',
        { ...base, counterpart: { holdingId: narrowingName('monobank', 'jar', 'j'), bankId: null, via: 'jar_top_up' } },
      ],
    ];
    for (const [name, t] of passes) {
      try {
        checkTranslated(t);
      } catch (e) {
        throw new Error(`pass case '${name}' threw: ${String(e)}`);
      }
    }

    const throws: readonly (readonly [string, TranslatedTransaction, string])[] = [
      ['1 holding prefix without colon', { ...base, holdingId: 'monobankX:account:a' }, 'monobank:tx-1'],
      ['2 empty bank id', { ...base, bankId: '' }, 'monobank:'],
      ['3 fractional instant', { ...base, occurredAt: at + 0.5 }, 'monobank:tx-1'],
      ['4a original in same currency', { ...base, originalAmount: money(-273n, 'UAH') }, 'monobank:tx-1'],
      ['4b original opposite sign', { ...base, originalAmount: money(273n, 'USD') }, 'monobank:tx-1'],
      [
        '4c negative against zero',
        { ...base, amount: money(-10000n, 'UAH'), originalAmount: money(0n, 'USD') },
        'monobank:tx-1',
      ],
      [
        '5 self counterpart',
        { ...base, counterpart: { holdingId: base.holdingId, bankId: null, via: 'link' } },
        'monobank:tx-1',
      ],
      ['6a mcc 10000', { ...base, mcc: 10000 }, 'monobank:tx-1'],
      ['6b mcc -1', { ...base, mcc: -1 }, 'monobank:tx-1'],
      ['6c fractional originalMcc', { ...base, originalMcc: 5411.5 }, 'monobank:tx-1'],
      ['7 cashback in another currency', { ...base, cashback: money(250n, 'PLN') }, 'monobank:tx-1'],
      ['8 negative cashback', { ...base, cashback: money(-250n, 'UAH') }, 'monobank:tx-1'],
    ];
    for (const [name, t, key] of throws) {
      let caught: unknown;
      try {
        checkTranslated(t);
      } catch (e) {
        caught = e;
      }
      expect({ name, threw: caught instanceof TranslatedShapeError }).toEqual({ name, threw: true });
      expect((caught as Error).message).toContain(key);
    }
  });
});
