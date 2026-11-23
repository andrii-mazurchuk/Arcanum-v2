// Start gate (S-213): the per-command required-settings split, the pure check and its refusal
// lines, and runGated, the process entry's gate for the service, backfill and release-check
// commands. Records come from src/config/settings; Monobank's group is the `settingsGroup` its
// source module exports.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gate = () => import('../../src/start-gate');
const settings = () => import('../../src/config/settings');
const monobank = () => import('../../src/sources/monobank');

async function monoGroup(): Promise<any> {
  return (await monobank()).settingsGroup;
}

const TOKEN_MISSING = 'source monobank: ARCANUM_MONOBANK_TOKEN is missing: it has no value and no default';
const STORAGE_MISSING = 'ARCANUM_STORAGE is missing: it has no value and no default';

describe('config/start-gate', () => {
  test('worked cases with Monobank the only group', async () => {
    const { checkStart, SETTINGS_REFUSAL_EXIT, REQUIRED_SHARED } = await gate();
    const { loadSettings } = await settings();
    const groups = [await monoGroup()];
    const check = (target: any, env: Record<string, string>): any => {
      const record = loadSettings(env, groups);
      let verdict: any;
      expect(() => {
        verdict = checkStart(target, record);
      }).not.toThrow();
      return verdict;
    };

    // 1. Defaults satisfy the service; a defaulted null push extra is not missing.
    const env1 = { ARCANUM_STORAGE: '/d/a.db', ARCANUM_MONOBANK_TOKEN: 't' };
    expect(check({ kind: 'service' }, env1)).toEqual({ ok: true, sources: ['monobank'] });
    const shared = (loadSettings(env1, groups) as any).shared;
    expect([shared.firstFillDays.state, shared.firstFillDays.value]).toEqual(['defaulted', 90]);
    expect([shared.pollMinutes.state, shared.pollMinutes.value]).toEqual(['defaulted', 60]);
    expect([shared.pushPort.state, shared.pushPort.value]).toEqual(['defaulted', 8080]);
    expect([shared.timeZone.state, shared.timeZone.value]).toEqual(['defaulted', 'Europe/Warsaw']);

    // 2. A question needs storage.
    expect(check({ kind: 'question' }, {})).toEqual({ ok: false, lines: [STORAGE_MISSING] });

    // 3. A bad poll interval refuses the service, not the question; every fault is listed.
    const env3 = { ARCANUM_STORAGE: ':memory:', ARCANUM_POLL_MINUTES: '0' };
    expect(check({ kind: 'question' }, env3)).toEqual({ ok: true, sources: [] });
    const v3 = check({ kind: 'service' }, env3);
    expect(v3.ok).toBe(false);
    expect(v3.lines.length).toBe(2);
    const prefix = 'ARCANUM_POLL_MINUTES is bad: "0": ';
    expect(v3.lines[0].startsWith(prefix)).toBe(true);
    expect(v3.lines[0].length).toBeGreaterThan(prefix.length);
    expect(v3.lines[1]).toBe(TOKEN_MISSING);

    // 4. A switched-off source is never checked.
    expect(check({ kind: 'service' }, { ARCANUM_STORAGE: '/d/a.db', ARCANUM_MONOBANK_ENABLED: 'off' }).lines).toEqual([
      'no source is switched on: set one of ARCANUM_MONOBANK_ENABLED to on',
    ]);

    // 5. The zone refuses nothing.
    expect(
      check({ kind: 'service' }, { ARCANUM_STORAGE: '/d/a.db', ARCANUM_MONOBANK_TOKEN: 't', ARCANUM_TIME_ZONE: 'Mars/Base' }),
    ).toEqual({ ok: true, sources: ['monobank'] });

    // 6. A bad switch gives its own line and no 'no source' line.
    const v6 = check({ kind: 'service' }, { ARCANUM_STORAGE: '/d/a.db', ARCANUM_MONOBANK_ENABLED: 'ON' });
    expect(v6.ok).toBe(false);
    expect(v6.lines.length).toBe(1);
    expect(v6.lines[0].startsWith('source monobank: ARCANUM_MONOBANK_ENABLED is bad: "ON": ')).toBe(true);

    // 7. The assistant and the release check look at no source group.
    const env7 = { ARCANUM_STORAGE: ':memory:', ARCANUM_MONOBANK_ENABLED: 'ON' };
    expect(check({ kind: 'assistant' }, env7)).toEqual({ ok: true, sources: [] });
    expect(check({ kind: 'release-check' }, env7)).toEqual({ ok: true, sources: [] });
    expect(check({ kind: 'release-check' }, {})).toEqual({ ok: true, sources: [] });

    expect(SETTINGS_REFUSAL_EXIT).toBe(78);
    expect(REQUIRED_SHARED).toEqual({
      service: ['storage', 'firstFillDays', 'pollMinutes', 'pushPort'],
      assistant: ['storage'],
      question: ['storage'],
      backfill: ['storage'],
      'release-check': [],
    });
  });

  test('two sources: ordering and backfill', async () => {
    const { checkStart } = await gate();
    const { loadSettings } = await settings();
    const MONO = await monoGroup();
    const ALT = {
      sourceId: 'alt',
      enabledByDefault: false,
      needsCredential: false,
      extras: [
        {
          key: 'REGION',
          parse: (r: string) =>
            r === 'eu' ? { ok: true as const, value: 'eu' } : { ok: false as const, reason: 'unknown region' },
        },
      ],
    };
    const groups = [MONO, ALT as any];
    const check = (target: any, env: Record<string, string>): any => checkStart(target, loadSettings(env, groups));
    const ALT_OK = { ARCANUM_ALT_ENABLED: 'on', ARCANUM_ALT_BASE_URL: 'http://127.0.0.1:9', ARCANUM_ALT_REGION: 'eu' };

    // 1. Shared faults first, then each source in record order, each in group order.
    const v1 = check(
      { kind: 'service' },
      { ARCANUM_STORAGE: '/d/a.db', ARCANUM_FIRST_FILL_DAYS: '91', ARCANUM_ALT_ENABLED: 'on' },
    );
    expect(v1.ok).toBe(false);
    expect(v1.lines.length).toBe(4);
    expect(v1.lines[0].startsWith('ARCANUM_FIRST_FILL_DAYS is bad: "91": ')).toBe(true);
    expect(v1.lines[1]).toBe(TOKEN_MISSING);
    expect(v1.lines[2]).toBe('source alt: ARCANUM_ALT_BASE_URL is missing: it has no value and no default');
    expect(v1.lines[3]).toBe('source alt: ARCANUM_ALT_REGION is missing: it has no value and no default');

    // 2. The no-source line names every switch.
    expect(check({ kind: 'service' }, { ARCANUM_STORAGE: '/d/a.db', ARCANUM_MONOBANK_ENABLED: 'off' }).lines).toEqual([
      'no source is switched on: set one of ARCANUM_MONOBANK_ENABLED, ARCANUM_ALT_ENABLED to on',
    ]);

    // 3. Both sources on and complete.
    expect(check({ kind: 'service' }, { ARCANUM_STORAGE: '/d/a.db', ARCANUM_MONOBANK_TOKEN: 't', ...ALT_OK })).toEqual({
      ok: true,
      sources: ['monobank', 'alt'],
    });

    // 4. An unknown source.
    expect(check({ kind: 'backfill', sourceId: 'zzz' }, { ARCANUM_STORAGE: ':memory:' }).lines).toEqual([
      'unknown source "zzz"; known sources: monobank, alt',
    ]);

    // 5. A switched-off source.
    expect(check({ kind: 'backfill', sourceId: 'alt' }, { ARCANUM_STORAGE: ':memory:' }).lines).toEqual([
      'source alt is switched off (ARCANUM_ALT_ENABLED)',
    ]);

    // 6. Storage, then the source's own group.
    expect(check({ kind: 'backfill', sourceId: 'monobank' }, {}).lines).toEqual([STORAGE_MISSING, TOKEN_MISSING]);

    // 7. Backfill checks only its own source.
    expect(check({ kind: 'backfill', sourceId: 'alt' }, { ARCANUM_STORAGE: ':memory:', ...ALT_OK })).toEqual({
      ok: true,
      sources: ['alt'],
    });

    // 8. A bad switch on the backfilled source.
    const v8 = check(
      { kind: 'backfill', sourceId: 'alt' },
      { ARCANUM_STORAGE: ':memory:', ...ALT_OK, ARCANUM_ALT_ENABLED: 'yes' },
    );
    expect(v8.lines.length).toBe(1);
    expect(v8.lines[0].startsWith('source alt: ARCANUM_ALT_ENABLED is bad: "yes": ')).toBe(true);
  });

  test('runGated', async () => {
    const { runGated, checkStart, SETTINGS_REFUSAL_EXIT } = await gate();
    const { loadSettings } = await settings();
    const MONO = await monoGroup();
    const ALT = {
      sourceId: 'alt',
      enabledByDefault: false,
      baseAddressDefault: 'http://127.0.0.1:9',
      needsCredential: false,
      extras: [],
    };
    const run = async (target: any, groups: any[], env: Record<string, string>, CODE: number) => {
      const record = loadSettings(env, groups);
      const err: string[] = [];
      const stderr = (l: string) => {
        err.push(l);
      };
      const calls: (readonly string[])[] = [];
      const start = (s: readonly string[]) => {
        calls.push([...s]);
        return new Promise<number>((r) => setTimeout(() => r(CODE), 20));
      };
      const code = await runGated(target, record, stderr, start as any);
      return { record, err, calls, code };
    };

    // 1. A service refusal: one write per line, in order, no start, 78.
    const r1 = await run({ kind: 'service' }, [MONO], {}, 0);
    expect(r1.code).toBe(78);
    expect(r1.code).toBe(SETTINGS_REFUSAL_EXIT);
    expect(r1.calls).toEqual([]);
    expect(r1.err).toEqual([STORAGE_MISSING, TOKEN_MISSING]);
    expect<any>(r1.err).toEqual((checkStart({ kind: 'service' }, r1.record) as { lines: readonly string[] }).lines);

    // 2. A backfill refusal.
    const r2 = await run({ kind: 'backfill', sourceId: 'zzz' }, [MONO, ALT], { ARCANUM_STORAGE: ':memory:' }, 0);
    expect(r2.code).toBe(78);
    expect(r2.calls).toEqual([]);
    expect(r2.err).toEqual(['unknown source "zzz"; known sources: monobank, alt']);

    // 3. An accepted service: start's own awaited code, with the verdict's sources.
    const r3 = await run(
      { kind: 'service' },
      [MONO, ALT],
      { ARCANUM_STORAGE: '/d/a.db', ARCANUM_MONOBANK_TOKEN: 't', ARCANUM_ALT_ENABLED: 'on' },
      17,
    );
    expect(r3.code).toBe(17);
    expect(r3.calls).toEqual([['monobank', 'alt']]);
    expect(r3.err).toEqual([]);

    // 4. An accepted backfill gets only its own source.
    const r4 = await run(
      { kind: 'backfill', sourceId: 'alt' },
      [MONO, ALT],
      { ARCANUM_STORAGE: ':memory:', ARCANUM_ALT_ENABLED: 'on' },
      0,
    );
    expect(r4.code).toBe(0);
    expect(r4.calls).toEqual([['alt']]);
    expect(r4.err).toEqual([]);

    // 5. The release check needs nothing and gets no sources.
    const r5 = await run({ kind: 'release-check' }, [MONO], {}, 3);
    expect(r5.code).toBe(3);
    expect(r5.calls).toEqual([[]]);
    expect(r5.err).toEqual([]);
  });

  describe('runGated refuses before start and touches nothing', () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'arcanum-start-gate-'));
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    // A start that records a copy of its sources, creates the store file, then resolves code.
    function spyStart(record: any, code: number) {
      const calls: string[][] = [];
      const start = async (sources: readonly string[]) => {
        calls.push([...sources]);
        writeFileSync(record.shared.storage.value, '');
        return code;
      };
      return { calls, start };
    }

    test('runGated refuses before start and touches nothing', async () => {
      const { runGated, checkStart, SETTINGS_REFUSAL_EXIT } = await gate();
      const { loadSettings } = await settings();
      const groups = [await monoGroup()];
      let lines: string[] = [];
      const stderr = (l: string) => {
        lines.push(l);
      };

      // 1. Refused: 78, no start, the check's lines, and no file.
      const record = loadSettings({ ARCANUM_STORAGE: join(tmp, 'a.db') }, groups);
      const s1 = spyStart(record, 0);
      const code1 = await runGated({ kind: 'service' }, record, stderr, s1.start as any);
      expect(code1).toBe(78);
      expect(code1).toBe(SETTINGS_REFUSAL_EXIT);
      expect(s1.calls.length).toBe(0);
      expect(lines).toEqual([TOKEN_MISSING]);
      expect<any>(lines).toEqual((checkStart({ kind: 'service' }, record) as { lines: readonly string[] }).lines);
      expect(readdirSync(tmp)).toEqual([]);

      // 2. The release check looks at no source group and passes start's code through.
      lines = [];
      const s2 = spyStart(record, 5);
      expect(await runGated({ kind: 'release-check' }, record, stderr, s2.start as any)).toBe(5);
      expect(s2.calls).toEqual([[]]);
      expect(lines).toEqual([]);

      // 3. An accepted service gets the verdict's sources.
      lines = [];
      const record3 = loadSettings({ ARCANUM_STORAGE: join(tmp, 'a.db'), ARCANUM_MONOBANK_TOKEN: 't' }, groups);
      const s3 = spyStart(record3, 0);
      expect(await runGated({ kind: 'service' }, record3, stderr, s3.start as any)).toBe(0);
      expect(s3.calls).toEqual([['monobank']]);
      expect(lines).toEqual([]);
    });
  });
});

// Type level: runGated takes only the entry's own targets. Never called; the CI type-check fails
// if either marked line type-checks.
async function entryGateRefusesFrontEnds(): Promise<void> {
  const { runGated } = await gate();
  const { loadSettings } = await settings();
  const record = loadSettings({}, [await monoGroup()]);
  const stderr = (_line: string): void => {};
  const start = async (_sources: readonly any[]): Promise<number> => 0;
  // @ts-expect-error question is gated by its front end
  runGated({ kind: 'question' }, record, stderr, start);
  // @ts-expect-error assistant is gated by its front end
  runGated({ kind: 'assistant' }, record, stderr, start);
}
void entryGateRefusesFrontEnds;
