// Settings (S-244): the total loader over the groups it is handed, the frozen four-state record,
// the shared setting parsers and defaults, per-source settings groups and the question view, from
// src/config/settings; Monobank's group is the `settingsGroup` its source module exports.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const settings = () => import('../../src/config/settings');
const monobank = () => import('../../src/sources/monobank');
const dates = () => import('../../src/analytics/dates');
const db = () => import('../../src/db/index');

async function monoGroup(): Promise<any> {
  return (await monobank()).settingsGroup;
}

// A 'bad' state carrying the raw text exactly, a non-empty reason and no value.
function expectBad(s: any, name: string, raw: string): void {
  expect(s.state).toBe('bad');
  expect(s.name).toBe(name);
  expect(s.raw).toBe(raw);
  expect(typeof s.reason).toBe('string');
  expect(s.reason.length).toBeGreaterThan(0);
  expect('value' in s).toBe(false);
}

describe('config/settings', () => {
  test('whole-number parsers', async () => {
    const { loadSettings } = await settings();
    const groups = [await monoGroup()];
    const shared = (name: string, raw: string): any => (loadSettings({ [name]: raw }, groups) as any).shared;

    const POLL = 'ARCANUM_POLL_MINUTES';
    for (const raw of ['60', '060']) {
      expect(shared(POLL, raw).pollMinutes).toEqual({ state: 'given', name: POLL, value: 60 });
    }
    for (const raw of ['0', '-5', '1.5', '1e2', '+5', ' 60', '']) {
      expectBad(shared(POLL, raw).pollMinutes, POLL, raw);
    }
    expect(shared(POLL, '9007199254740991').pollMinutes).toEqual({
      state: 'given',
      name: POLL,
      value: 9007199254740991,
    });
    expectBad(shared(POLL, '9007199254740992').pollMinutes, POLL, '9007199254740992');

    const DAYS = 'ARCANUM_FIRST_FILL_DAYS';
    expect(shared(DAYS, '1').firstFillDays).toEqual({ state: 'given', name: DAYS, value: 1 });
    expect(shared(DAYS, '90').firstFillDays).toEqual({ state: 'given', name: DAYS, value: 90 });
    expectBad(shared(DAYS, '91').firstFillDays, DAYS, '91');
    expectBad(shared(DAYS, '0').firstFillDays, DAYS, '0');

    const PORT = 'ARCANUM_PUSH_PORT';
    expect(shared(PORT, '0').pushPort).toEqual({ state: 'given', name: PORT, value: 0 });
    expect(shared(PORT, '65535').pushPort).toEqual({ state: 'given', name: PORT, value: 65535 });
    expectBad(shared(PORT, '65536').pushPort, PORT, '65536');
    expectBad(shared(PORT, '-1').pushPort, PORT, '-1');
  });

  test('four states and defaults', async () => {
    const { loadSettings, settingValue, SHARED_NAMES } = await settings();
    const { DEFAULT_TIME_ZONE } = await dates();
    const { MEMORY_LOCATION } = await db();
    const groups = [await monoGroup()];

    // 1. The shared names, in this order.
    expect(SHARED_NAMES).toEqual({
      storage: 'ARCANUM_STORAGE',
      firstFillDays: 'ARCANUM_FIRST_FILL_DAYS',
      pollMinutes: 'ARCANUM_POLL_MINUTES',
      pushPort: 'ARCANUM_PUSH_PORT',
      timeZone: 'ARCANUM_TIME_ZONE',
      mcpPort: 'ARCANUM_MCP_PORT',
    });
    expect(Object.keys(SHARED_NAMES)).toEqual([
      'storage',
      'firstFillDays',
      'pollMinutes',
      'pushPort',
      'timeZone',
      'mcpPort',
    ]);

    // 2. Absent: storage is missing, the others take their defaults.
    const empty = loadSettings({}, groups) as any;
    expect(empty.shared.storage).toEqual({ state: 'missing', name: 'ARCANUM_STORAGE' });
    expect(empty.shared.firstFillDays).toEqual({ state: 'defaulted', name: 'ARCANUM_FIRST_FILL_DAYS', value: 90 });
    expect(empty.shared.pollMinutes).toEqual({ state: 'defaulted', name: 'ARCANUM_POLL_MINUTES', value: 60 });
    expect(empty.shared.pushPort).toEqual({ state: 'defaulted', name: 'ARCANUM_PUSH_PORT', value: 8080 });
    expect(DEFAULT_TIME_ZONE).toBe('Europe/Warsaw');
    expect(empty.shared.timeZone).toEqual({
      state: 'defaulted',
      name: 'ARCANUM_TIME_ZONE',
      value: DEFAULT_TIME_ZONE,
    });
    expect(empty.shared.mcpPort).toEqual({ state: 'defaulted', name: 'ARCANUM_MCP_PORT', value: 8090 });

    // 3. A bad value stays bad; an empty storage value is present, not absent.
    const bad = loadSettings({ ARCANUM_POLL_MINUTES: '0', ARCANUM_STORAGE: '' }, groups) as any;
    expect(bad.shared.pollMinutes.state).toBe('bad');
    expect(bad.shared.pollMinutes.raw).toBe('0');
    expect(settingValue(bad.shared.pollMinutes)).toBeUndefined();
    expect(bad.shared.storage).toEqual({ state: 'bad', name: 'ARCANUM_STORAGE', raw: '', reason: 'empty' });

    // 4. The in-memory mode and any path are given; the path is not checked at load.
    const mem = loadSettings({ ARCANUM_STORAGE: MEMORY_LOCATION }, groups) as any;
    expect(mem.shared.storage).toEqual({ state: 'given', name: 'ARCANUM_STORAGE', value: MEMORY_LOCATION });
    const path = loadSettings({ ARCANUM_STORAGE: '/no/such/dir/a.db' }, groups) as any;
    expect(path.shared.storage).toEqual({ state: 'given', name: 'ARCANUM_STORAGE', value: '/no/such/dir/a.db' });

    // 5. settingValue gives a value only when given or defaulted.
    expect(settingValue(mem.shared.storage)).toBe(MEMORY_LOCATION);
    expect(settingValue(empty.shared.firstFillDays)).toBe(90);
    expect(settingValue(empty.shared.storage)).toBeUndefined();

    // 6. The MCP port is 1..65535 in plain digits; a bad value stays bad, never defaulted.
    const MCP = 'ARCANUM_MCP_PORT';
    const mcp = (raw: string): any => (loadSettings({ [MCP]: raw }, groups) as any).shared.mcpPort;
    for (const [raw, value] of [
      ['8091', 8091],
      ['1', 1],
      ['65535', 65535],
    ] as const) {
      expect(mcp(raw)).toEqual({ state: 'given', name: MCP, value });
    }
    for (const raw of ['0', '65536', '-1', '80.5', '', 'x']) expectBad(mcp(raw), MCP, raw);
  });

  describe('loader is total and frozen', () => {
    const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const saved: Record<string, any> = {};
    let savedExit: any;
    let calls: string[] = [];

    beforeEach(() => {
      calls = [];
      for (const m of METHODS) {
        saved[m] = (console as any)[m];
        (console as any)[m] = () => {
          calls.push(m);
        };
      }
      savedExit = process.exit;
      (process as any).exit = () => {
        calls.push('exit');
        throw new Error('process.exit called');
      };
    });

    afterEach(() => {
      for (const m of METHODS) (console as any)[m] = saved[m];
      (process as any).exit = savedExit;
    });

    // Every object or array reachable from x through own property values is frozen.
    function expectDeepFrozen(x: any, path: string): void {
      if (typeof x !== 'object' || x === null) return;
      expect([path, Object.isFrozen(x)]).toEqual([path, true]);
      for (const k of Object.keys(x)) expectDeepFrozen(x[k], path + '.' + k);
    }

    test('loader is total and frozen', async () => {
      const { loadSettings, SHARED_NAMES } = await settings();
      const groups = [await monoGroup()];
      const HOSTILE = [
        '\u0000',
        'x'.repeat(100000),
        '-1',
        'NaN',
        'Infinity',
        '9'.repeat(400),
        '[object Object]',
        'undefined',
        '\n',
      ];

      // 1. Hostile values never throw, print or exit.
      let last: any;
      for (const h of HOSTILE) {
        const env: Record<string, string> = {};
        for (const name of Object.values(SHARED_NAMES)) env[name] = h;
        env.ARCANUM_MONOBANK_ENABLED = h;
        env.ARCANUM_MONOBANK_BASE_URL = h;
        env.ARCANUM_MONOBANK_TOKEN = h;
        for (let i = 0; i < 1000; i++) env['ARCANUM_X' + i] = h;
        expect(() => {
          last = loadSettings(env, groups);
        }).not.toThrow();
        expect(calls).toEqual([]);

        // 3. Undeclared names leave no trace.
        expect(Object.keys(last)).toEqual(['shared', 'sources']);
      }

      // 2. Frozen at every level.
      expectDeepFrozen(last, 'record');
      const empty = loadSettings({}, groups) as any;
      expectDeepFrozen(empty, 'record');
      expect(Object.isFrozen(empty.shared.storage)).toBe(true);
      expect(Object.isFrozen(empty.sources[0].extras)).toBe(true);
      expect(Object.keys(empty)).toEqual(['shared', 'sources']);

      // 4. Later changes to the environment object change nothing.
      const env: Record<string, string> = { ARCANUM_STORAGE: '/a.db' };
      const r = loadSettings(env, groups) as any;
      env.ARCANUM_STORAGE = '/b.db';
      env.ARCANUM_POLL_MINUTES = '5';
      expect(r.shared.storage.value).toBe('/a.db');
      expect(r.shared.pollMinutes.state).toBe('defaulted');
      expect(calls).toEqual([]);
    });
  });

  test('source groups', async () => {
    const { loadSettings, sourceSettingName } = await settings();
    const MONO = await monoGroup();
    const ALT = {
      sourceId: 'alt',
      enabledByDefault: false,
      baseAddressDefault: 'http://alt.example',
      needsCredential: false,
      extras: [
        {
          key: 'REGION',
          parse: (r: string) =>
            r === 'eu' ? { ok: true as const, value: 'eu' } : { ok: false as const, reason: 'unknown region' },
          default: 'eu',
        },
      ],
    };
    const groups = [MONO, ALT as any];
    const sources = (env: Record<string, string>): any[] => (loadSettings(env, groups) as any).sources;
    const m = (env: Record<string, string>): any => sources(env).find((s) => s.sourceId === 'monobank');
    const a = (env: Record<string, string>): any => sources(env).find((s) => s.sourceId === 'alt');

    // 1. Defaults, a missing credential, no credential at all, and an extra's own default.
    expect(m({}).enabled).toEqual({ state: 'defaulted', name: 'ARCANUM_MONOBANK_ENABLED', value: true });
    expect(m({}).baseAddress).toEqual({
      state: 'defaulted',
      name: 'ARCANUM_MONOBANK_BASE_URL',
      value: 'https://api.monobank.ua',
    });
    expect(m({}).credential).toEqual({ state: 'missing', name: 'ARCANUM_MONOBANK_TOKEN' });
    expect(a({}).enabled).toEqual({ state: 'defaulted', name: 'ARCANUM_ALT_ENABLED', value: false });
    expect(a({}).baseAddress).toEqual({ state: 'defaulted', name: 'ARCANUM_ALT_BASE_URL', value: 'http://alt.example' });
    expect(a({}).credential).toBe(null);
    expect(a({}).extras.REGION).toEqual({ state: 'defaulted', name: 'ARCANUM_ALT_REGION', value: 'eu' });

    // 2. Switches take exactly 'on' or 'off'.
    const EN = 'ARCANUM_MONOBANK_ENABLED';
    expect(m({ [EN]: 'on' }).enabled).toEqual({ state: 'given', name: EN, value: true });
    expect(m({ [EN]: 'off' }).enabled).toEqual({ state: 'given', name: EN, value: false });
    expectBad(m({ [EN]: 'ON' }).enabled, EN, 'ON');
    expectBad(m({ [EN]: '' }).enabled, EN, '');

    // 3. Base addresses are http or https and lose one trailing slash.
    const URL_NAME = 'ARCANUM_MONOBANK_BASE_URL';
    expect(m({ [URL_NAME]: 'http://127.0.0.1:9/' }).baseAddress).toEqual({
      state: 'given',
      name: URL_NAME,
      value: 'http://127.0.0.1:9',
    });
    expect(m({ [URL_NAME]: 'https://x//' }).baseAddress).toEqual({ state: 'given', name: URL_NAME, value: 'https://x/' });
    for (const raw of ['ftp://x', 'not a url', '']) expectBad(m({ [URL_NAME]: raw }).baseAddress, URL_NAME, raw);

    // 4. Credentials are non-empty and untrimmed.
    const TOKEN = 'ARCANUM_MONOBANK_TOKEN';
    expect(m({ [TOKEN]: '' }).credential).toEqual({ state: 'bad', name: TOKEN, raw: '', reason: 'empty' });
    expect(m({ [TOKEN]: ' t ' }).credential).toEqual({ state: 'given', name: TOKEN, value: ' t ' });

    // 5. An extra uses its own parse; a group without a credential never reads its TOKEN name.
    expect(a({ ARCANUM_ALT_REGION: 'us' }).extras.REGION).toEqual({
      state: 'bad',
      name: 'ARCANUM_ALT_REGION',
      raw: 'us',
      reason: 'unknown region',
    });
    expect(a({ ARCANUM_ALT_TOKEN: 'x' }).credential).toBe(null);

    // 6. Names and order.
    expect(sourceSettingName('alt', 'REGION')).toBe('ARCANUM_ALT_REGION');
    expect((loadSettings({}, [MONO, ALT as any]) as any).sources.map((s: any) => s.sourceId)).toEqual([
      'monobank',
      'alt',
    ]);
    expect((loadSettings({}, [ALT as any, MONO]) as any).sources.map((s: any) => s.sourceId)).toEqual([
      'alt',
      'monobank',
    ]);
  });

  test('question view', async () => {
    const { loadSettings, questionSettings } = await settings();
    const MONO = await monoGroup();
    const ALT = { sourceId: 'alt', enabledByDefault: false, needsCredential: false, extras: [] };
    const groups = [MONO, ALT as any];
    const q = (env: Record<string, string>): any => questionSettings(loadSettings(env, groups));

    // 1-4, 7. Switched-on sources in group order; a bad switch is never listed; no token needed.
    expect(q({}).sources).toEqual(['monobank']);
    expect(q({ ARCANUM_ALT_ENABLED: 'on' }).sources).toEqual(['monobank', 'alt']);
    expect(q({ ARCANUM_MONOBANK_ENABLED: 'off', ARCANUM_ALT_ENABLED: 'on' }).sources).toEqual(['alt']);
    expect(q({ ARCANUM_MONOBANK_ENABLED: 'ON' }).sources).toEqual([]);

    // 5. The zone is the value, the raw bad text, or undefined when defaulted.
    expect(q({ ARCANUM_TIME_ZONE: 'UTC' }).timeZone).toBe('UTC');
    expect(q({ ARCANUM_TIME_ZONE: 'Mars/Base' }).timeZone).toBe('Mars/Base');
    expect(q({}).timeZone).toBeUndefined();

    // 6. Frozen, and the same on every call.
    const record = loadSettings({}, groups);
    const v = questionSettings(record) as any;
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.sources)).toBe(true);
    expect(questionSettings(record)).toEqual(v);
  });

  test('time zone setting', async () => {
    const { loadSettings } = await settings();
    const { openCalendar } = await dates();
    const groups = [await monoGroup()];
    const zone = (raw: string): any => (loadSettings({ ARCANUM_TIME_ZONE: raw }, groups) as any).shared.timeZone;

    const NAMES = ['Etc/GMT'];
    for (let i = 1; i <= 12; i++) NAMES.push('Etc/GMT+' + i);
    for (let i = 1; i <= 14; i++) NAMES.push('Etc/GMT-' + i);
    expect(NAMES.length).toBe(27);

    // 1-2. Every fixed whole-hour offset name and the usual names load as given.
    for (const n of [...NAMES, 'Europe/Warsaw', 'UTC']) {
      expect(zone(n)).toEqual({ state: 'given', name: 'ARCANUM_TIME_ZONE', value: n });
    }

    // 3. A bad zone carries the calendar's own refusal message.
    for (const raw of ['Mars/Base', '']) {
      const tz = zone(raw);
      const refusal = openCalendar(raw) as any;
      expect(refusal.kind).toBe('refused');
      expect(tz.state).toBe('bad');
      expect(tz.raw).toBe(raw);
      expect(tz.reason).toBe(refusal.message);
    }
  });
});
