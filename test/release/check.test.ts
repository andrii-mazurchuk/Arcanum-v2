// Release check (S-239): the one command that runs phases P1 to P7 against the stand-in banks and
// writes one verdict line per promise. verdictLines turns the verdicts into the report and the exit
// code; productSettings is the explicit environment every product process of the check gets; and
// an interrupt during P1 must leave no product process running and no temporary folder behind.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const check = () => import('../../src/release/check');
const judges = () => import('../../src/release/judges');
const spawn = () => import('../../src/release/spawn');

// The pinned runtime (S-240): package.json's engines.bun is the reference pin.
const BUN_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).engines.bun;

const FOLDER_PREFIX = 'arcanum-release-';
const releaseFolders = () => readdirSync(tmpdir()).filter((n) => n.startsWith(FOLDER_PREFIX));

const P1_BOUND_MS = 60_000;
const SETTLE_MS = 2_000;
const EXIT_BOUND_MS = 60_000;
const GONE_BOUND_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every running process as { pid, ppid, args }, read with `ps -eo pid,ppid,args`.
function processes(): { pid: number; ppid: number; args: string }[] {
  const r = Bun.spawnSync(['ps', '-eo', 'pid,ppid,args']);
  return new TextDecoder()
    .decode(r.stdout)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

describe('release/check', () => {
  test('verdict lines', async () => {
    const { verdictLines, SIGNAL_STEPS, signalStepsApplicable } = await check();
    const { PROMISES } = await judges();
    type Key = (typeof PROMISES)[number]['key'];
    type V = { pass: true } | { pass: false; observed: string[] };

    const allPass = new Map<Key, V>(PROMISES.map((p) => [p.key, { pass: true }]));
    const oneFail = new Map<Key, V>(allPass);
    oneFail.set('exact_money' as Key, { pass: false, observed: ['fixture total 10.97, expected 10.98', 'x'] });
    // Inserted exact money first, then rate limits: the Map's order differs from PROMISES order.
    const twoFail = new Map<Key, V>();
    twoFail.set('exact_money' as Key, { pass: false, observed: ['a'] });
    twoFail.set('rate_limits' as Key, { pass: false, observed: ['b'] });
    for (const p of PROMISES) if (p.key !== 'exact_money' && p.key !== 'rate_limits') twoFail.set(p.key, { pass: true });
    expect(twoFail.size).toBe(6);

    const passLines = [
      'PASS local copy complete and current',
      'PASS answers from the local copy only',
      'PASS rate limits respected',
      'PASS exact money',
      'PASS adding a source touches only that source',
      'PASS single-machine operation',
    ];

    // All passed: six PASS lines in PROMISES order, then the overall pass, exit 0.
    expect(verdictLines(allPass)).toEqual({ lines: [...passLines, 'overall: pass'], exitCode: 0 });

    // One failure: its observations joined by '; ', and the overall fail names its title.
    const one = verdictLines(oneFail);
    expect(one.lines).toHaveLength(7);
    expect(one.lines[3]).toBe('FAIL exact money: fixture total 10.97, expected 10.98; x');
    expect(one.lines[6]).toBe('overall: fail: exact money');
    expect(one.exitCode).toBe(1);

    // Two failures: lines and the overall list follow PROMISES order, not the Map's.
    const two = verdictLines(twoFail);
    expect(two.lines[2]).toBe('FAIL rate limits respected: b');
    expect(two.lines[3]).toBe('FAIL exact money: a');
    expect(two.lines[6]).toBe('overall: fail: rate limits respected, exact money');
    expect(two.exitCode).toBe(1);

    // Not-applicable signal steps come first and never change the verdict or the exit code.
    const na = (step: string) => `N/A ${step}: termination signal not applicable on this host (promised on POSIX hosts only)`;
    const withNa = verdictLines(allPass, SIGNAL_STEPS);
    expect(withNa).toEqual({
      lines: [na('P4 stop before restart'), na('P6 stop before switch-on'), na('P7 stop'), ...passLines, 'overall: pass'],
      exitCode: 0,
    });
    const none = verdictLines(allPass, []);
    expect(none.lines).toHaveLength(7);
    expect(none.lines.some((l) => l.startsWith('N/A'))).toBe(false);
    const oneWithNa = verdictLines(oneFail, SIGNAL_STEPS);
    expect(oneWithNa.lines[oneWithNa.lines.length - 1]).toBe('overall: fail: exact money');
    expect(oneWithNa.exitCode).toBe(1);

    expect(SIGNAL_STEPS).toEqual(['P4 stop before restart', 'P6 stop before switch-on', 'P7 stop']);
    expect(signalStepsApplicable('win32')).toBe(false);
    expect(signalStepsApplicable('linux')).toBe(true);
    expect(signalStepsApplicable('darwin')).toBe(true);
  });

  test('product settings', async () => {
    const { productSettings } = await check();
    const { judgeSingleMachine } = await judges();

    const p = {
      folder: '/tmp/arcanum-release-ab',
      zone: 'Etc/GMT-2',
      pushPort: 41003,
      monobankBase: 'http://127.0.0.1:41001',
      token: 'stand-in-abcdefgh',
      secret: 'abcdefghabcdefgh',
    };
    const ten = {
      ARCANUM_FIRST_FILL_DAYS: '7',
      ARCANUM_MONOBANK_BASE_URL: 'http://127.0.0.1:41001',
      ARCANUM_MONOBANK_ENABLED: 'on',
      ARCANUM_MONOBANK_PUSH_SECRET: 'abcdefghabcdefgh',
      ARCANUM_MONOBANK_PUSH_URL: 'http://127.0.0.1:41003',
      ARCANUM_MONOBANK_TOKEN: 'stand-in-abcdefgh',
      ARCANUM_POLL_MINUTES: '1',
      ARCANUM_PUSH_PORT: '41003',
      // The folder text, then '/arcanum.db': never the platform's join, so '/' on win32 too.
      ARCANUM_STORAGE: '/tmp/arcanum-release-ab/arcanum.db',
      ARCANUM_TIME_ZONE: 'Etc/GMT-2',
    };

    const s = productSettings(p);
    expect(Object.keys(s).sort()).toEqual(Object.keys(ten));
    expect(s).toEqual(ten);
    expect(s.ARCANUM_STORAGE).toBe('/tmp/arcanum-release-ab/arcanum.db');

    const s2 = productSettings({ ...p, second: { base: 'http://127.0.0.1:41002', token: 't2' } });
    expect(Object.keys(s2)).toHaveLength(13);
    expect(s2).toEqual({
      ...ten,
      ARCANUM_SECOND_ENABLED: 'on',
      ARCANUM_SECOND_BASE_URL: 'http://127.0.0.1:41002',
      ARCANUM_SECOND_TOKEN: 't2',
    });
    const addresses = Object.entries(s2).filter(([k]) => k.endsWith('_BASE_URL') || k.endsWith('_PUSH_URL'));
    expect(addresses).toHaveLength(3);
    for (const [, v] of addresses) expect(new URL(v).hostname).toBe('127.0.0.1');

    expect(judgeSingleMachine([], BUN_VERSION, s2, p.folder)).toEqual({ pass: true });
  });

  test.skipIf(process.platform === 'win32')(
    'interrupt during P1 cleans up',
    async () => {
      const { spawnProduct } = await spawn();

      const before = releaseFolders();
      const c = spawnProduct(['release-check'], {}, process.env);
      let exited = false;
      void c.exited.then(() => {
        exited = true;
      });
      let children: number[] = [];

      try {
        // Drain both streams throughout, so the child never blocks on a full pipe.
        const stderrLines: string[] = [];
        void (async () => {
          const decoder = new TextDecoder();
          let rest = '';
          for await (const chunk of c.stderr as ReadableStream<Uint8Array>) {
            rest += decoder.decode(chunk, { stream: true });
            const parts = rest.split(/\r?\n/);
            rest = parts.pop() ?? '';
            stderrLines.push(...parts);
          }
          if (rest) stderrLines.push(rest);
        })();
        void new Response(c.stdout).text();

        // A progress line naming P1, then 2 s more so the service child is running.
        const p1Deadline = Date.now() + P1_BOUND_MS;
        while (!stderrLines.some((l) => /\bP1\b/.test(l))) {
          if (exited) throw new Error(`release check exited before P1:\n${stderrLines.join('\n')}`);
          if (Date.now() > p1Deadline) throw new Error(`no progress line naming P1 within ${P1_BOUND_MS} ms`);
          await sleep(50);
        }
        await sleep(SETTLE_MS);

        // The run's own folder: the one new 'arcanum-release-' entry, which exists now.
        const added = releaseFolders().filter((n) => !before.includes(n));
        expect(added).toHaveLength(1);
        const folder = join(tmpdir(), added[0]);

        // The check's product children, captured before the signal.
        children = processes()
          .filter((q) => q.ppid === c.pid)
          .map((q) => q.pid);

        c.signal('SIGINT');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const code = await Promise.race([
          c.exited,
          new Promise<'timeout'>((r) => {
            timer = setTimeout(() => r('timeout'), EXIT_BOUND_MS);
          }),
        ]);
        clearTimeout(timer);
        expect(code).not.toBe('timeout');

        expect(releaseFolders()).toEqual(before);

        // Within 15 s: no product process of that folder runs, and every captured child is gone.
        const leftovers = () => ({
          running: processes()
            .filter((q) => q.args.includes(folder) && q.args.includes('src/app/bin.ts'))
            .map((q) => q.args),
          alive: children.filter(alive),
        });
        const goneDeadline = Date.now() + GONE_BOUND_MS;
        let left = leftovers();
        while ((left.running.length > 0 || left.alive.length > 0) && Date.now() < goneDeadline) {
          await sleep(200);
          left = leftovers();
        }
        expect(left).toEqual({ running: [], alive: [] });
      } finally {
        if (!exited) c.signal('SIGKILL');
        for (const pid of children) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    },
    P1_BOUND_MS + SETTLE_MS + EXIT_BOUND_MS + GONE_BOUND_MS + 10_000,
  );
});
