// Settings names (S-212): Monobank's declared settings group, exported by its source module as
// `settingsGroup`, and the pure list of every setting name a group list produces, from
// src/config/settings.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const settings = () => import('../../src/config/settings');
const monobank = () => import('../../src/sources/monobank');

const DUP = {
  sourceId: 'dup',
  enabledByDefault: false,
  needsCredential: true,
  extras: [{ key: 'TOKEN', parse: (r: string) => ({ ok: true as const, value: r }) }],
};
const ALT = {
  sourceId: 'alt',
  enabledByDefault: false,
  needsCredential: false,
  extras: [{ key: 'REGION', parse: (r: string) => ({ ok: true as const, value: r }) }],
};

describe('config/settings-names', () => {
  test('monobank group and setting names', async () => {
    const { settingNames, sourceSettingName, loadSettings, SHARED_NAMES } = await settings();
    const MONO = (await monobank()).settingsGroup as any;
    const SH = Object.values(SHARED_NAMES);

    // 1. The declared group: on by default, the bank's address, a credential, two push extras.
    expect(MONO.sourceId).toBe('monobank');
    expect(MONO.enabledByDefault).toBe(true);
    expect(MONO.baseAddressDefault).toBe('https://api.monobank.ua');
    expect(MONO.needsCredential).toBe(true);
    expect(MONO.extras.map((d: any) => d.key).sort()).toEqual(['PUSH_SECRET', 'PUSH_URL']);
    for (const d of MONO.extras) expect(d.default).toBe(null);

    // 2. Ten distinct names: shared first, then ENABLED, BASE_URL, TOKEN, then extras in order.
    const n = settingNames([MONO]);
    expect(n.length).toBe(10);
    expect(new Set(n).size).toBe(10);
    expect(n.slice(0, 8)).toEqual([
      'ARCANUM_STORAGE',
      'ARCANUM_FIRST_FILL_DAYS',
      'ARCANUM_POLL_MINUTES',
      'ARCANUM_PUSH_PORT',
      'ARCANUM_TIME_ZONE',
      'ARCANUM_MONOBANK_ENABLED',
      'ARCANUM_MONOBANK_BASE_URL',
      'ARCANUM_MONOBANK_TOKEN',
    ]);
    expect(n.slice(8)).toEqual(MONO.extras.map((d: any) => sourceSettingName('monobank', d.key)));
    expect([...n].sort()).toEqual([
      'ARCANUM_FIRST_FILL_DAYS',
      'ARCANUM_MONOBANK_BASE_URL',
      'ARCANUM_MONOBANK_ENABLED',
      'ARCANUM_MONOBANK_PUSH_SECRET',
      'ARCANUM_MONOBANK_PUSH_URL',
      'ARCANUM_MONOBANK_TOKEN',
      'ARCANUM_POLL_MINUTES',
      'ARCANUM_PUSH_PORT',
      'ARCANUM_STORAGE',
      'ARCANUM_TIME_ZONE',
    ]);

    // 3. A group without a credential has no TOKEN name; no groups gives the shared names alone.
    expect(settingNames([MONO, ALT as any])).toEqual([
      ...n,
      'ARCANUM_ALT_ENABLED',
      'ARCANUM_ALT_BASE_URL',
      'ARCANUM_ALT_REGION',
    ]);
    expect(settingNames([])).toEqual(SH);

    // 4. A duplicate is reported as it is, not removed, and nothing throws.
    const d = settingNames([DUP as any]);
    expect(d).toEqual([
      ...SH,
      'ARCANUM_DUP_ENABLED',
      'ARCANUM_DUP_BASE_URL',
      'ARCANUM_DUP_TOKEN',
      'ARCANUM_DUP_TOKEN',
    ]);
    expect(d.length).toBe(9);
    expect(new Set(d).size).toBe(8);

    // 5. Absent push settings are defaulted to null under their own names.
    const r = loadSettings({ ARCANUM_STORAGE: ':memory:', ARCANUM_MONOBANK_TOKEN: 't' }, [MONO]) as any;
    expect(r.sources.length).toBe(1);
    expect(r.sources[0].extras.PUSH_URL).toEqual({
      state: 'defaulted',
      name: 'ARCANUM_MONOBANK_PUSH_URL',
      value: null,
    });
    expect(r.sources[0].extras.PUSH_SECRET).toEqual({
      state: 'defaulted',
      name: 'ARCANUM_MONOBANK_PUSH_SECRET',
      value: null,
    });
  });
});
