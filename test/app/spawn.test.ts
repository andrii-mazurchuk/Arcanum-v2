// Spawn helper (S-235): every product child process a test or the release check starts gets exactly
// its stated settings plus the host variables its caller passes, never the caller's environment.
// childEnvironment builds that environment; spawnProduct starts the real process entry with it.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const spawn = () => import('../../src/release/spawn');

const TOKEN_MISSING_PREFIX = 'source monobank: ARCANUM_MONOBANK_TOKEN is missing: ';
const BOUND_MS = 20_000;

describe('release/spawn', () => {
  test('child environment', async () => {
    const { childEnvironment } = await spawn();

    const host = {
      PATH: '/usr/bin',
      TMPDIR: '/tmp',
      TEMP: undefined,
      HOME: '/home/x',
      ARCANUM_MONOBANK_TOKEN: 'real',
      ARCANUM_STORAGE: '/home/x/real.db',
    };
    const settings = { ARCANUM_STORAGE: ':memory:' };

    // Host variables with a defined value, then the settings; HOME and the exported token dropped.
    expect(childEnvironment(settings, host)).toEqual({ PATH: '/usr/bin', TMPDIR: '/tmp', ARCANUM_STORAGE: ':memory:' });

    // No settings: no ARCANUM_ name comes through from the host.
    expect(childEnvironment({}, host)).toEqual({ PATH: '/usr/bin', TMPDIR: '/tmp' });

    // A setting not named ARCANUM_ is a test bug.
    expect(() => childEnvironment({ HOME: '/x' }, host)).toThrow(TypeError);
    expect(() => childEnvironment({ arcanum_storage: 'x' }, {})).toThrow(TypeError);
  });

  test(
    'exported token never reaches the child',
    async () => {
      const { spawnProduct } = await spawn();

      // The token is added in the object passed, not in the runner's own environment.
      const host = { ...process.env, ARCANUM_MONOBANK_TOKEN: 'exported-real-token' };

      // Runs `service`; resolves its exit code and its whole standard error.
      async function runService(settings: Record<string, string>) {
        const p = spawnProduct(['service'], settings, host);
        const stderr = new Response(p.stderr).text();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((r) => {
          timer = setTimeout(() => r('timeout'), BOUND_MS);
        });
        const code = await Promise.race([p.exited, timeout]);
        clearTimeout(timer);
        if (code === 'timeout') {
          p.signal('SIGKILL');
          throw new Error(`service did not exit within ${BOUND_MS} ms`);
        }
        return { p, code, text: await stderr };
      }

      // 1. Only a storage setting: the child sees no token and refuses.
      const r1 = await runService({ ARCANUM_STORAGE: ':memory:' });
      expect(r1.code).toBe(78);
      expect(r1.text.split(/\r?\n/).some((line) => line.startsWith(TOKEN_MISSING_PREFIX))).toBe(true);
      expect(r1.text).not.toContain('exported-real-token');
      expect(r1.p.stdin).toBeNull();

      // 2. The stated settings do arrive: the token passes and the bad switch is refused.
      const r2 = await runService({
        ARCANUM_STORAGE: ':memory:',
        ARCANUM_MONOBANK_TOKEN: 't',
        ARCANUM_MONOBANK_ENABLED: 'maybe',
      });
      expect(r2.code).toBe(78);
      expect(r2.text).toContain('ARCANUM_MONOBANK_ENABLED');
      expect(r2.text).not.toContain(TOKEN_MISSING_PREFIX);
    },
    2 * BOUND_MS + 5_000,
  );
});
