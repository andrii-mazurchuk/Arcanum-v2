// Start gate end to end (S-213, S-212): the real process entry runs the gate before anything else
// the service command does, so a refused service exits 78 with checkStart's lines on standard error
// and never creates its store. Children start through the shared spawn helper (src/release/spawn),
// which gives each an explicit environment of the listed settings plus its host variables.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawn = () => import('../../src/release/spawn');
const gate = () => import('../../src/start-gate');

const TOKEN_MISSING = 'source monobank: ARCANUM_MONOBANK_TOKEN is missing: it has no value and no default';
const STORAGE_MISSING = 'ARCANUM_STORAGE is missing: it has no value and no default';
const BOUND_MS = 30_000;

// Runs `service` with the given settings; resolves its exit code and its standard error as lines.
async function runService(settings: Record<string, string>): Promise<{ code: number; lines: string[] }> {
  const { spawnProduct } = await spawn();
  const p = spawnProduct(['service'], settings, process.env);
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
  return { code, lines: (await stderr).split(/\r?\n/) };
}

describe('config/start-gate end to end', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'arcanum-start-gate-e2e-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test(
    'refused service touches nothing',
    async () => {
      const { SETTINGS_REFUSAL_EXIT } = await gate();

      // 1. A missing token: 78, the token line, and no store file.
      const r1 = await runService({ ARCANUM_STORAGE: join(tmp, 'arcanum.db') });
      expect(r1.code).toBe(78);
      expect(r1.code).toBe(SETTINGS_REFUSAL_EXIT);
      expect(r1.lines).toContain(TOKEN_MISSING);
      expect(readdirSync(tmp)).toEqual([]);

      // 2. No storage either: 78, the storage line, then the token line.
      const r2 = await runService({});
      expect(r2.code).toBe(78);
      const storageAt = r2.lines.indexOf(STORAGE_MISSING);
      expect(storageAt).toBeGreaterThanOrEqual(0);
      expect(r2.lines.indexOf(TOKEN_MISSING)).toBeGreaterThan(storageAt);
      expect(readdirSync(tmp)).toEqual([]);
    },
    2 * BOUND_MS + 10_000,
  );
});
