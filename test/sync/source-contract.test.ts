// Source contract (S-217): what every built source declares, from src/sync/source-contract, here its
// push settings — PUSH_SETTING_DECLS, pushSettingsOf and pushAddress — over the real Monobank
// definition and settings group of src/sources/monobank, loaded by src/config/settings.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const contract = () => import('../../src/sync/source-contract');
const monobank = () => import('../../src/sources/monobank');
const settings = () => import('../../src/config/settings');

const URL_NAME = 'ARCANUM_MONOBANK_PUSH_URL';
const SECRET_NAME = 'ARCANUM_MONOBANK_PUSH_SECRET';

// The Monobank source's settings, loaded from env over the group its module exports.
async function loadMono(env: Record<string, string>): Promise<any> {
  const { loadSettings } = await settings();
  const { settingsGroup } = await monobank();
  const record: any = loadSettings(env, [settingsGroup as any]);
  const mono = record.sources.find((s: any) => s.sourceId === 'monobank');
  expect(mono).toBeDefined();
  return mono;
}

// A 'bad' state carrying the raw text exactly and no value.
function expectBad(s: any, name: string, raw: string): void {
  expect(s.state).toBe('bad');
  expect(s.name).toBe(name);
  expect(s.raw).toBe(raw);
  expect('value' in s).toBe(false);
}

describe('sync/source-contract', () => {
  test('monobank push settings', async () => {
    const { PUSH_URL_KEY, PUSH_SECRET_KEY, PUSH_SETTING_DECLS, pushSettingsOf, pushAddress } = await contract();
    const { source, settingsGroup } = await monobank();
    const { sourceSettingName } = await settings();

    // 1. The built definition and its group.
    const def: any = source;
    expect(def.id).toBe('monobank');
    expect(def.balanceConvention).toBe('includes_credit_limit');
    expect(def.settingsGroup).toBe(settingsGroup);
    const group: any = def.settingsGroup;
    expect(group.sourceId).toBe('monobank');
    expect(group.enabledByDefault).toBe(true);
    expect(group.baseAddressDefault).toBe('https://api.monobank.ua');
    expect(group.needsCredential).toBe(true);
    expect(group.extras).toBe(PUSH_SETTING_DECLS);
    expect(PUSH_URL_KEY).toBe('PUSH_URL');
    expect(PUSH_SECRET_KEY).toBe('PUSH_SECRET');
    expect(PUSH_SETTING_DECLS.map((d: any) => d.key)).toEqual([PUSH_URL_KEY, PUSH_SECRET_KEY]);
    for (const d of PUSH_SETTING_DECLS as any[]) {
      expect('default' in d).toBe(true);
      expect(d.default).toBeNull();
    }

    // 2. The names the loader reads.
    expect(sourceSettingName('monobank', 'PUSH_URL')).toBe(URL_NAME);
    expect(sourceSettingName('monobank', 'PUSH_SECRET')).toBe(SECRET_NAME);

    // 3. Both given: the trailing '/' is removed and the address joins the two halves.
    const both = await loadMono({ [URL_NAME]: 'https://h.example/hook/', [SECRET_NAME]: 'abcdefghijklmnop' });
    const p = pushSettingsOf(both);
    expect(p).toEqual({ publicAddress: 'https://h.example/hook', secretPath: 'abcdefghijklmnop' });
    expect(pushAddress(p)).toBe('https://h.example/hook/abcdefghijklmnop');

    // 4. One half or neither: no address.
    const urlOnly = pushSettingsOf(await loadMono({ [URL_NAME]: 'https://h.example/hook/' }));
    expect(urlOnly.secretPath).toBeNull();
    expect(pushAddress(urlOnly)).toBeNull();

    const neitherSettings = await loadMono({});
    const neither = pushSettingsOf(neitherSettings);
    expect(neither).toEqual({ publicAddress: null, secretPath: null });
    expect(pushAddress(neither)).toBeNull();
    expect(neitherSettings.extras[PUSH_URL_KEY]).toEqual({ state: 'defaulted', name: URL_NAME, value: null });
    expect(neitherSettings.extras[PUSH_SECRET_KEY]).toEqual({ state: 'defaulted', name: SECRET_NAME, value: null });
  });

  test('push setting values', async () => {
    const { PUSH_URL_KEY, PUSH_SECRET_KEY, pushSettingsOf } = await contract();

    const secret = async (raw: string): Promise<any> => {
      const mono = await loadMono({ [SECRET_NAME]: raw });
      return { state: mono.extras[PUSH_SECRET_KEY], push: pushSettingsOf(mono) };
    };
    const url = async (raw: string): Promise<any> => {
      const mono = await loadMono({ [URL_NAME]: raw });
      return { state: mono.extras[PUSH_URL_KEY], push: pushSettingsOf(mono) };
    };

    for (const raw of ['abcdefghijklmnop', 'a'.repeat(128), 'A-_9'.repeat(4)]) {
      const r = await secret(raw);
      expect(r.state).toEqual({ state: 'given', name: SECRET_NAME, value: raw });
      expect(r.push.secretPath).toBe(raw);
    }
    for (const raw of ['abcdefghijklmno', 'a'.repeat(129), 'abcdefgh ijklmnop', 'abcdefghijklmno/', '']) {
      const r = await secret(raw);
      expectBad(r.state, SECRET_NAME, raw);
      expect(r.push.secretPath).toBeNull();
    }

    for (const [raw, value] of [
      ['http://h.example', 'http://h.example'],
      ['https://h.example/a/', 'https://h.example/a'],
    ]) {
      const r = await url(raw);
      expect(r.state).toEqual({ state: 'given', name: URL_NAME, value });
      expect(r.push.publicAddress).toBe(value);
    }
    for (const raw of ['ftp://h.example', 'not a url', '']) {
      const r = await url(raw);
      expectBad(r.state, URL_NAME, raw);
      expect(r.push.publicAddress).toBeNull();
    }
  });
});
