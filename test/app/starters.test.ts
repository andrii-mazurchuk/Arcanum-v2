// Product starters (S-206, src/app/starters): answeringOpener opens only an existing local copy and
// maps open faults to the two refusals; the question command answers over a store the service's
// installer list created; the service command creates its store and stops with exit 0 on SIGTERM.
// The child processes run the real process entry through the spawn helper.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const starters = () => import('../../src/app/starters');
const sources = () => import('../../src/app/sources');
const settings = () => import('../../src/config/settings');
const db = () => import('../../src/db/index');
const render = () => import('../../src/interfaces/render');
const spawn = () => import('../../src/release/spawn');
const dataset = () => import('../../src/release/dataset');
const standIns = () => import('../../src/release/stand-ins');

const ANSWER_BOUND_MS = 20_000;
const STORE_APPEAR_MS = 15_000;
const STOP_BOUND_MS = 30_000;

function removeFolder(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A child still holding the file on some platforms; the folder is temporary either way.
  }
}

// Resolves the exit code, or kills the child and rejects after ms.
async function exitWithin(p: { exited: Promise<number>; signal(s: string): void }, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), ms);
  });
  const code = await Promise.race([p.exited, timeout]);
  clearTimeout(timer);
  if (code === 'timeout') {
    p.signal('SIGKILL');
    throw new Error(`${what} did not exit within ${ms} ms`);
  }
  return code;
}

describe('app/starters', () => {
  test(
    'existing-only opener',
    async () => {
      const { answeringOpener, STORE_SCHEMAS } = await starters();
      const { BUILT_GROUPS } = await sources();
      const { loadSettings } = await settings();
      const { openStore } = await db();
      const { formatOpenRefusal } = await render();
      const { spawnProduct } = await spawn();

      const dir = mkdtempSync(join(tmpdir(), 'arcanum-starters-'));
      const dir2 = mkdtempSync(join(tmpdir(), 'arcanum-starters-none-'));
      try {
        const location = join(dir, 'arcanum.db');
        const record = loadSettings({ ARCANUM_STORAGE: location }, BUILT_GROUPS);

        // 1. No store: the refusal is returned, not thrown, and nothing is created.
        const open = answeringOpener(location, record);
        const r = await open();
        expect(r).toEqual({ kind: 'no_local_copy', location });
        expect(readdirSync(dir)).toEqual([]);

        // 2. An existing store: a core and a close that is harmless the second time.
        const s = openStore(location, STORE_SCHEMAS, 'create');
        s.close();
        const r2: any = await answeringOpener(location, record)();
        expect(r2.core).toBeDefined();
        expect(r2.core).not.toBeNull();
        expect(typeof r2.close).toBe('function');
        r2.close();
        expect(() => r2.close()).not.toThrow();

        // 3. The assistant command over a missing copy: exit 1, the refusal line, nothing created.
        const location2 = join(dir2, 'arcanum.db');
        const p = spawnProduct(['mcp'], { ARCANUM_STORAGE: location2 }, process.env, { stdin: 'pipe' });
        p.stdin!.end();
        const stdout = new Response(p.stdout).text();
        const stderr = new Response(p.stderr).text();
        expect(await exitWithin(p, ANSWER_BOUND_MS, 'mcp')).toBe(1);
        const errText = await stderr;
        expect(errText).toContain(formatOpenRefusal({ kind: 'no_local_copy', location: location2 }));
        expect(errText).toContain('ARCANUM_STORAGE');
        expect(errText).toContain(location2);
        expect(await stdout).toBe('');
        expect(readdirSync(dir2)).toEqual([]);

        // 4. A location inside a folder that does not exist: a refusal, never a throw, nothing made.
        const missing = join(dir, 'missing', 'arcanum.db');
        const before = readdirSync(dir).sort();
        let r4: any;
        let thrown: unknown;
        try {
          r4 = await answeringOpener(missing, loadSettings({ ARCANUM_STORAGE: missing }, BUILT_GROUPS))();
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeUndefined();
        expect(['no_local_copy', 'open_failed']).toContain(r4?.kind);
        expect(r4.location).toBe(missing);
        expect(existsSync(join(dir, 'missing'))).toBe(false);
        expect(readdirSync(dir).sort()).toEqual(before);
      } finally {
        removeFolder(dir);
        removeFolder(dir2);
      }
    },
    40_000,
  );

  test(
    'question over a created store',
    async () => {
      const { STORE_SCHEMAS, ANSWER_CATALOGUE } = await starters();
      const { openStore } = await db();
      const { spawnProduct } = await spawn();

      const dir = mkdtempSync(join(tmpdir(), 'arcanum-starters-question-'));
      try {
        const location = join(dir, 'arcanum.db');
        openStore(location, STORE_SCHEMAS, 'create').close();
        const title = ANSWER_CATALOGUE.find((e: any) => e.family === 'holdings')!.title;

        const p = spawnProduct(['holdings'], { ARCANUM_STORAGE: location }, process.env);
        const stdout = new Response(p.stdout).text();
        const stderr = new Response(p.stderr).text();
        const code = await exitWithin(p, ANSWER_BOUND_MS, 'holdings');
        const out = await stdout;
        const err = await stderr;
        expect(err).toBe('');
        expect(code).toBe(0);
        expect(out.split(/\r?\n/)[0]).toBe(title);
        expect(out).toMatch(/^Covered ranges:/m);

        // An unknown option: the usage refusal, exit 2, naming the option.
        const p2 = spawnProduct(['holdings', '--bogus', 'x'], { ARCANUM_STORAGE: location }, process.env);
        const out2 = new Response(p2.stdout).text();
        const err2 = new Response(p2.stderr).text();
        expect(await exitWithin(p2, ANSWER_BOUND_MS, 'holdings --bogus')).toBe(2);
        expect((await out2) + (await err2)).toContain('--bogus');
      } finally {
        removeFolder(dir);
      }
    },
    45_000,
  );

  test.skipIf(process.platform === 'win32')(
    'service stops on SIGTERM',
    async () => {
      const { buildDataset } = await dataset();
      const { startMonobankStandIn } = await standIns();
      const { spawnProduct } = await spawn();

      const ds = buildDataset(Math.floor(Date.now() / 1000) * 1000, 'svcstart');
      const m = await startMonobankStandIn(ds, 'tok', Date.now);
      const dir = mkdtempSync(join(tmpdir(), 'arcanum-starters-service-'));
      try {
        const location = join(dir, 'arcanum.db');
        const config = {
          ARCANUM_STORAGE: location,
          ARCANUM_FIRST_FILL_DAYS: '7',
          ARCANUM_PUSH_PORT: '0',
          ARCANUM_TIME_ZONE: ds.zone.name,
          ARCANUM_MONOBANK_BASE_URL: m.baseAddress,
          ARCANUM_MONOBANK_TOKEN: 'tok',
        };

        const p = spawnProduct(['service'], config, process.env);
        const stderr = new Response(p.stderr).text();
        const deadline = Date.now() + STORE_APPEAR_MS;
        while (!existsSync(location) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const appeared = existsSync(location);
        if (!appeared) p.signal('SIGKILL');
        expect(appeared).toBe(true);

        // SIGTERM reaches the service's stop handler: a clean exit 0, not death by signal (143).
        p.signal('SIGTERM');
        const code = await exitWithin(p, STOP_BOUND_MS, 'service');
        if (code !== 0) throw new Error(`service exited ${code}: ${await stderr}`);
        expect(code).toBe(0);

        // The store is closed and whole: a later question opens it.
        const q = spawnProduct(['holdings'], { ARCANUM_STORAGE: location }, process.env);
        const qErr = new Response(q.stderr).text();
        const qCode = await exitWithin(q, ANSWER_BOUND_MS, 'holdings');
        if (qCode !== 0) throw new Error(`holdings exited ${qCode}: ${await qErr}`);
        expect(qCode).toBe(0);
      } finally {
        await m.close();
        removeFolder(dir);
      }
    },
    80_000,
  );
});
