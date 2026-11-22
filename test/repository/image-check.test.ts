// Image check (S-231): repository tooling under tools/image-check builds the image from a clean
// export of the committed tree, compares the image's Bun with the pin and starts the default
// command twice. Its pure judge is tested here over recorded engine outputs, with no engine; its
// run module is checked as text for the setting names it sets and the environment it passes.
//
// Modules and files are loaded inside each test, not at the top: a missing one then fails the
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const judge = () => import('../../tools/image-check/judge');
const gate = () => import('../../src/start-gate');
const settings = () => import('../../src/config/settings');
const monobank = () => import('../../src/sources/monobank');

const root = join(import.meta.dir, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

// Every judge function is total: the call must not throw, and its result is returned.
function total<T>(call: () => T): T {
  let out: T | undefined;
  expect(() => {
    out = call();
  }).not.toThrow();
  return out as T;
}

describe('repository/image-check', () => {
  test('build, pinned-bun and refused-start verdicts', async () => {
    const { judgeBuild, judgePinnedBun, judgeRefusedStart } = await judge();
    const { SETTINGS_REFUSAL_EXIT } = await gate();
    const P = '{"engines":{"bun":"1.3.14"}}';
    const ERR25 = Array.from({ length: 25 }, (_, i) => `line-${String(i + 1).padStart(2, '0')}`).join('\n');
    const TOK = 'source monobank: ARCANUM_MONOBANK_TOKEN is missing: it has no value and no default\n';

    // 1. The build passes on exit 0; a failure carries the last 20 lines of stderr.
    expect(total(() => judgeBuild(0, ''))).toMatchObject({ step: 'clean-build', status: 'pass' });
    expect(total(() => judgeBuild(1, 'x')).status).toBe('fail');
    const v = total(() => judgeBuild(1, ERR25));
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('line-25');
    expect(v.detail).toContain('line-06');
    expect(v.detail).not.toContain('line-05');

    // 2. The trimmed image version must equal the exact pin byte for byte.
    const ok = total(() => judgePinnedBun(P, '1.3.14\n'));
    expect(ok.step).toBe('pinned-bun');
    expect(ok.status).toBe('pass');
    expect(ok.detail).toBe('pinned 1.3.14, image 1.3.14');
    expect(total(() => judgePinnedBun(P, '  1.3.14 \r\n')).status).toBe('pass');
    const newer = total(() => judgePinnedBun(P, '1.3.15\n'));
    expect(newer.status).toBe('fail');
    expect(newer.detail).toBe('pinned 1.3.14, image 1.3.15');
    expect(total(() => judgePinnedBun(P, '1.3.14-canary\n')).status).toBe('fail');
    expect(total(() => judgePinnedBun('{"engines":{"bun":"^1.3.14"}}', '1.3.14\n')).status).toBe('fail');
    expect(total(() => judgePinnedBun('not json', '1.3.14')).status).toBe('fail');

    // 3. A refusal: exit 78, Monobank's token named, and a volume with no non-blank line.
    const refused = total(() => judgeRefusedStart(78, TOK, ''));
    expect(refused.status).toBe('pass');
    expect(refused.step).toBe('refused-start');
    expect(total(() => judgeRefusedStart(SETTINGS_REFUSAL_EXIT, TOK, '\n  \n')).status).toBe('pass');

    // 4. Each condition alone fails the verdict.
    expect(total(() => judgeRefusedStart(78, TOK, 'arcanum.db\n')).status).toBe('fail');
    expect(total(() => judgeRefusedStart(1, TOK, '')).status).toBe('fail');
    const alt = 'source alt: ARCANUM_ALT_TOKEN is missing: it has no value and no default\n';
    expect(total(() => judgeRefusedStart(78, alt, '')).status).toBe('fail');
    expect(total(() => judgeRefusedStart(78, '', '')).status).toBe('fail');

    // 5. Every failed condition is named, so three failures say more than one.
    const three = total(() => judgeRefusedStart(1, '', 'arcanum.db\n'));
    const one = total(() => judgeRefusedStart(78, '', ''));
    expect(three.status).toBe('fail');
    expect(three.detail.length).toBeGreaterThan(one.detail.length);
  });

  test('published port and running verdict', async () => {
    const { parsePublishedPort, judgeRunning } = await judge();
    const OK = 'arcanum.db\narcanum.db-shm\narcanum.db-wal\n';

    // 1-3. The first matching line wins, and its number must be 1..65535.
    expect(total(() => parsePublishedPort('127.0.0.1:49153\n'))).toBe(49153);
    expect(total(() => parsePublishedPort('127.0.0.1:49153\r\n'))).toBe(49153);
    expect(total(() => parsePublishedPort(''))).toBeNull();
    expect(total(() => parsePublishedPort('0.0.0.0:49153\n[::]:49154\n'))).toBe(49153);
    expect(total(() => parsePublishedPort('127.0.0.1:0\n'))).toBeNull();
    expect(total(() => parsePublishedPort('127.0.0.1:70000\n'))).toBeNull();
    expect(total(() => parsePublishedPort('Error: No public port published\n'))).toBeNull();

    // 4. A 200 acknowledgement, exit 0, and the store file with only its companions.
    const v = total(() => judgeRunning(200, 0, OK));
    expect(v.step).toBe('running-start-stop');
    expect(v.status).toBe('pass');
    expect(total(() => judgeRunning(200, 0, 'arcanum.db\n')).status).toBe('pass');
    expect(total(() => judgeRunning(200, 0, 'arcanum.db\narcanum.db-journal\n')).status).toBe('pass');

    // 5. Anything else fails.
    const failing: [number | null, number | null, string][] = [
      [null, 0, OK],
      [500, 0, OK],
      [200, 1, OK],
      [200, 0, 'arcanum.db\nother.log\n'],
      [200, 0, ''],
      [200, 0, 'arcanum.db-wal\n'],
      [200, 0, 'arcanum.db\narcanum.dbx\n'],
    ];
    for (const [ack, exit, listing] of failing) {
      expect(total(() => judgeRunning(ack, exit, listing)).status).toBe('fail');
    }

    // 6. A kill after the stop timeout is named.
    const killed = total(() => judgeRunning(200, 137, OK));
    expect(killed.status).toBe('fail');
    expect(killed.detail).toContain('137');
  });

  test('step plan and report', async () => {
    const m = await judge();
    const { STEPS, DEPENDS_ON, judgeBuild, notRun, reportLines, exitCodeOf, unknownAccountPush } = m;
    type Step = (typeof STEPS)[number];
    const pass = (s: Step) => ({ step: s, status: 'pass' as const, detail: 'ok' });

    // 1. The four steps and their dependencies.
    expect([...STEPS]).toEqual(['clean-build', 'pinned-bun', 'refused-start', 'running-start-stop']);
    expect(DEPENDS_ON).toEqual({
      'clean-build': [],
      'pinned-bun': ['clean-build'],
      'refused-start': ['clean-build'],
      'running-start-stop': ['clean-build'],
    });

    // 2. The declared constants.
    expect(m.STORE_FILE).toBe('arcanum.db');
    expect(m.START_WAIT_MS).toBe(30000);
    expect(m.STOP_TIMEOUT_S).toBe(30);
    expect(m.PUSH_PATH).toBe('/image-check-push');
    expect(m.UNKNOWN_ACCOUNT).toBe('image-check-unknown-account');

    // 3. A not-run verdict names the failed step it depended on.
    expect(notRun('pinned-bun', 'clean-build')).toEqual({
      step: 'pinned-bun',
      status: 'not-run',
      detail: 'not run: clean-build failed',
    });

    // 4. A failed build leaves the three later steps not run, reported as NOT RUN.
    const vs = [
      judgeBuild(1, 'boom'),
      ...STEPS.slice(1)
        .filter((s) => DEPENDS_ON[s].includes('clean-build'))
        .map((s) => notRun(s, 'clean-build')),
    ];
    expect(vs.length).toBe(4);
    expect(exitCodeOf(vs)).toBe(1);
    const lines = reportLines(vs);
    expect(lines[0]!.startsWith('FAIL clean-build: ')).toBe(true);
    expect(lines.slice(1)).toEqual([
      'NOT RUN pinned-bun: not run: clean-build failed',
      'NOT RUN refused-start: not run: clean-build failed',
      'NOT RUN running-start-stop: not run: clean-build failed',
    ]);

    // 5. Four passes give 0.
    expect(exitCodeOf(STEPS.map(pass))).toBe(0);
    expect(reportLines(STEPS.map(pass))).toEqual([
      'PASS clean-build: ok',
      'PASS pinned-bun: ok',
      'PASS refused-start: ok',
      'PASS running-start-stop: ok',
    ]);

    // 6. Fewer than four passes, or a not-run step, give 1.
    expect(exitCodeOf(STEPS.slice(0, 3).map(pass))).toBe(1);
    expect(exitCodeOf([...STEPS.slice(0, 3).map(pass), notRun('running-start-stop', 'clean-build')])).toBe(1);
    expect(exitCodeOf([])).toBe(1);

    // 7. The push is a Monobank statement item for an account the holder does not have.
    const b = JSON.parse(unknownAccountPush());
    expect(b.type).toBe('StatementItem');
    expect(b.data.account).toBe(m.UNKNOWN_ACCOUNT);
    expect(b.data.statementItem).toEqual({
      id: 'image-check-1',
      time: 1767225600,
      description: 'image check',
      mcc: 5411,
      originalMcc: 5411,
      hold: false,
      amount: -100,
      operationAmount: -100,
      currencyCode: 980,
      commissionRate: 0,
      cashbackAmount: 0,
      balance: 0,
    });
  });

  test('run names and pure judge', async () => {
    const RUN = read('tools/image-check/run.ts');
    const JUDGE = read('tools/image-check/judge.ts');
    const { settingNames } = await settings();
    const MONO = (await monobank()).settingsGroup;
    const NAMES = new Set(settingNames([MONO]));

    // 1. Every literal setting name in the run is one the loader produces for Monobank's group.
    for (const name of RUN.match(/ARCANUM_[A-Z0-9_]+/g) ?? []) {
      expect(NAMES.has(name)).toBe(true);
    }

    // 2. No env file and no spread of the caller's environment.
    expect(RUN).not.toContain('--env-file');
    expect(RUN).not.toContain('...process.env');
    expect(RUN).not.toContain('...Bun.env');

    // 3. The judge uses no engine, clock or timer, and imports no file, process or network module.
    for (const w of ['Bun', 'fetch', 'Date', 'setTimeout', 'setInterval', 'performance']) {
      expect(new RegExp(`\\b${w}\\b`).test(JUDGE)).toBe(false);
    }
    const specifiers = [
      ...JUDGE.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
      ...JUDGE.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
      ...JUDGE.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((x) => x[1]!);
    const forbidden = ['fs', 'fs/promises', 'child_process', 'net', 'http', 'https'];
    for (const spec of specifiers) {
      expect(forbidden.includes(spec) || forbidden.map((f) => `node:${f}`).includes(spec)).toBe(false);
    }

    // 4. Its relative imports resolve under src/, never to the run module.
    for (const spec of specifiers.filter((s) => s.startsWith('.'))) {
      const at = relative(root, resolve(root, 'tools', 'image-check', spec)).split(sep).join('/');
      expect(at.startsWith('src/')).toBe(true);
      expect(at.startsWith('tools/image-check/run')).toBe(false);
    }
  });
});
