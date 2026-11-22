// Rates used (S-29): the list assembled from the provenance of the conversion results an answer
// shows, one item per (applied pair and direction, record date), substituted marks ORed, one
// not-converted item per pair, from src/money/rates-used.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const ratesUsed = () => import('../../src/money/rates-used');
const exact = () => import('../../src/money/exact');
const moneyModule = () => import('../../src/money/money');

describe('money/rates-used', () => {
  test('rates used for built and unconverted lines', async () => {
    const { assembleRatesUsed } = await ratesUsed();
    const { parseExactDecimal, fraction } = await exact();
    const { money } = await moneyModule();
    const p = (t: string) => parseExactDecimal(t)!;

    const legUSD = {
      applied: { from: 'USD', to: 'UAH' },
      quoted: { base: 'USD', quote: 'UAH' },
      quotedValue: p('41.2451'),
      appliedValue: fraction(412451n, 10000n),
      recordDate: '2026-11-20',
      heldFrom: Date.parse('2026-11-20T10:00:00Z'),
      substituted: false,
    };
    const legPLN = {
      applied: { from: 'UAH', to: 'PLN' },
      quoted: { base: 'PLN', quote: 'UAH' },
      quotedValue: p('10.00'),
      appliedValue: fraction(1n, 10n),
      recordDate: '2026-11-19',
      heldFrom: Date.parse('2026-11-19T10:00:00Z'),
      substituted: true,
    };
    const shown: any[] = [
      { kind: 'converted', original: money(100n, 'USD'), line: money(412n, 'PLN'), legs: [legUSD, legPLN] },
      { kind: 'same', original: money(123n, 'PLN'), line: money(123n, 'PLN') },
      { kind: 'converted', original: money(200n, 'USD'), line: money(825n, 'PLN'), legs: [legUSD, legPLN] },
      { kind: 'unconverted', original: money(5000n, 'GBP'), pair: { from: 'GBP', to: 'PLN' } },
    ];

    const items = assembleRatesUsed(shown);
    expect(items).toEqual([
      {
        kind: 'applied',
        from: 'UAH',
        to: 'PLN',
        quoted: { base: 'PLN', quote: 'UAH' },
        quotedValue: '10.00',
        appliedValue: { num: 1n, den: 10n },
        date: '2026-11-19',
        substituted: true,
      },
      {
        kind: 'applied',
        from: 'USD',
        to: 'UAH',
        quoted: { base: 'USD', quote: 'UAH' },
        quotedValue: '41.2451',
        appliedValue: { num: 412451n, den: 10000n },
        date: '2026-11-20',
        substituted: false,
      },
      { kind: 'not_converted', from: 'GBP', to: 'PLN' },
    ] as any);

    expect(assembleRatesUsed([])).toEqual([]);
    expect(assembleRatesUsed([shown[1]])).toEqual([]);
  });

  test('rates used grouping and substitution', async () => {
    const { assembleRatesUsed, RateItemConflictError } = await ratesUsed();
    const { parseExactDecimal, fraction } = await exact();
    const { money } = await moneyModule();

    const leg = (subst: boolean, date: string, value: any) => ({
      applied: { from: 'UAH', to: 'PLN' },
      quoted: { base: 'PLN', quote: 'UAH' },
      quotedValue: parseExactDecimal('10.00')!,
      appliedValue: value,
      recordDate: date,
      heldFrom: Date.parse(date + 'T10:00:00Z'),
      substituted: subst,
    });
    const conv = (l: any): any => ({
      kind: 'converted',
      original: money(1000n, 'UAH'),
      line: money(100n, 'PLN'),
      legs: [l],
    });
    const unc = (code: string): any => ({
      kind: 'unconverted',
      original: money(100n, code),
      pair: { from: code, to: 'PLN' },
    });
    const tenth = fraction(1n, 10n);

    // A: the substituted mark is ORed within a group, whichever leg comes first.
    const forward = assembleRatesUsed([conv(leg(false, '2026-11-19', tenth)), conv(leg(true, '2026-11-19', tenth))]);
    expect(forward).toHaveLength(1);
    expect(forward[0]).toMatchObject({ kind: 'applied', substituted: true, date: '2026-11-19' });
    const reverse = assembleRatesUsed([conv(leg(true, '2026-11-19', tenth)), conv(leg(false, '2026-11-19', tenth))]);
    expect(reverse).toHaveLength(1);
    expect(reverse[0]).toMatchObject({ kind: 'applied', substituted: true, date: '2026-11-19' });

    // B: the record date is part of the group key, and dates sort ascending.
    const split = assembleRatesUsed([conv(leg(false, '2026-11-20', tenth)), conv(leg(false, '2026-11-18', tenth))]);
    expect(split).toHaveLength(2);
    expect(split[0]).toMatchObject({ kind: 'applied', date: '2026-11-18', substituted: false });
    expect(split[1]).toMatchObject({ kind: 'applied', date: '2026-11-20', substituted: false });

    // C: one not_converted item per pair, sorted by from.
    expect(assembleRatesUsed([unc('GBP'), unc('CHF'), unc('GBP')])).toEqual([
      { kind: 'not_converted', from: 'CHF', to: 'PLN' },
      { kind: 'not_converted', from: 'GBP', to: 'PLN' },
    ] as any);

    // D: two different applied values in one group are an invariant breach.
    expect(() =>
      assembleRatesUsed([conv(leg(false, '2026-11-19', tenth)), conv(leg(false, '2026-11-19', fraction(1n, 11n)))]),
    ).toThrow(RateItemConflictError);
  });
});
