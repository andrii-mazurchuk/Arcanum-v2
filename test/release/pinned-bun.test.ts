// Pinned-Bun check (S-246): checkPinnedBun is ok only for an exact engines.bun equal byte for byte
// to the running version, and the check:bun script run during the image build exits 1 on a
// mismatch, so an image whose Bun differs from the pin fails to build.
//
// The module is imported inside each test, not at the top: a missing module then fails the test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const SCRIPT = 'src/release/pinned-bun.ts';
const TIMEOUT_MS = 30_000;

type Result = { ok: boolean; pinned: string | null; running: string };

// The runner's environment without any setting: the child sees no ARCANUM_* name.
function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('ARCANUM_')) env[name] = value;
  }
  return env;
}

async function runScript(cwd: string): Promise<{ code: number; lastLine: string | undefined }> {
  const child = Bun.spawn([process.execPath, SCRIPT], {
    cwd,
    env: hostEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: TIMEOUT_MS,
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  return { code, lastLine: lines.at(-1) };
}

describe('release/pinned-bun', () => {
  test('checkPinnedBun', async () => {
    const { checkPinnedBun } = await import('../../src/release/pinned-bun');
    const P = '{"engines":{"bun":"1.3.14"}}';
    const call = (text: string, running: string): Result => {
      let result: Result | undefined;
      expect(() => {
        result = checkPinnedBun(text, running);
      }).not.toThrow();
      return result!;
    };

    expect(call(P, '1.3.14')).toEqual({ ok: true, pinned: '1.3.14', running: '1.3.14' });
    expect(call(P, '1.3.15')).toEqual({ ok: false, pinned: '1.3.14', running: '1.3.15' });

    const range = call('{"engines":{"bun":"^1.3.14"}}', '1.3.14');
    expect(range.ok).toBe(false);
    expect(range.running).toBe('1.3.14');

    expect(call(P, '1.3.14-canary').ok).toBe(false);

    expect(call('not json', '1.3.14')).toEqual({ ok: false, pinned: null, running: '1.3.14' });

    const empty = call('{}', '1.3.14');
    expect(empty.ok).toBe(false);
    expect(empty.pinned).toBeNull();

    const repo = call(readFileSync(join(root, 'package.json'), 'utf8'), Bun.version);
    expect(repo.ok).toBe(Bun.version === '1.3.14');
  });

  test(
    'check:bun script exit codes',
    async () => {
      const here = await runScript(root);
      expect(here.lastLine).toBe(`pinned 1.3.14, running ${Bun.version}`);
      expect(here.code).toBe(Bun.version === '1.3.14' ? 0 : 1);

      const tmp = mkdtempSync(join(tmpdir(), 'arcanum-pinned-bun-'));
      try {
        writeFileSync(join(tmp, 'package.json'), '{"engines":{"bun":"0.0.1"}}');
        cpSync(join(root, 'src'), join(tmp, 'src'), { recursive: true });
        cpSync(join(root, 'tsconfig.json'), join(tmp, 'tsconfig.json'));
        if (existsSync(join(root, 'node_modules'))) {
          symlinkSync(join(root, 'node_modules'), join(tmp, 'node_modules'), 'junction');
        }

        const there = await runScript(tmp);
        expect(there.lastLine).toBe(`pinned 0.0.1, running ${Bun.version}`);
        expect(there.code).toBe(1);
      } finally {
        // The link goes first, on its own, so the recursive removal never walks into the
        // repository's node_modules through it.
        const link = join(tmp, 'node_modules');
        if (existsSync(link)) {
          try {
            unlinkSync(link);
          } catch {
            rmdirSync(link);
          }
        }
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    2 * TIMEOUT_MS + 10_000,
  );
});
