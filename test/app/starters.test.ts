// Product starters (S-253, src/app/starters): answeringOpener opens only an existing local copy and
// maps open faults to the two refusals; the question command answers over a store the service's
// installer list created; the service command creates its store and stops with exit 0 on SIGTERM,
// even when the signal arrives before it has started; the HTTP assistant command answers tools/list
// over POST /mcp and stops with exit 0. The child processes run the real process entry through the
// spawn helper.
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

// Reads a child's stream as it arrives, so a test can wait for a line while the child runs.
function watch(stream: ReadableStream<Uint8Array>) {
  let text = '';
  const decoder = new TextDecoder();
  const done = (async () => {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();
    return text;
  })();
  return {
    text: () => text,
    done,
    // Resolves true once the text contains what, false after ms or when the stream ends without it.
    async waitFor(what: string, ms: number): Promise<boolean> {
      const deadline = Date.now() + ms;
      let ended = false;
      void done.then(() => {
        ended = true;
      });
      while (!text.includes(what)) {
        if (ended || Date.now() >= deadline) return text.includes(what);
        await new Promise((r) => setTimeout(r, 25));
      }
      return true;
    },
  };
}

// A port nothing listens on right now.
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port as number;
  server.stop(true);
  return port;
}

// True when something answers HTTP on the loopback port.
async function listensOn(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5_000) });
    return true;
  } catch (e) {
    // Accepted but never answered is still a listener; a refused connection is not.
    return (e as Error)?.name === 'TimeoutError';
  }
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

  test.skipIf(process.platform === 'win32')(
    'service stops on an early signal',
    async () => {
      const { STORE_SCHEMAS } = await starters();
      const { NoLocalCopyError, openStore } = await db();
      const { buildDataset } = await dataset();
      const { startMonobankStandIn } = await standIns();
      const { spawnProduct } = await spawn();

      const ds = buildDataset(Math.floor(Date.now() / 1000) * 1000, 'svcearly');
      const m = await startMonobankStandIn(ds, 't', Date.now);
      const dir = mkdtempSync(join(tmpdir(), 'arcanum-starters-early-'));
      try {
        const location = join(dir, 'a.db');
        // The push receiver on any free port, so repeated starts never contend for the default one.
        const config = {
          ARCANUM_STORAGE: location,
          ARCANUM_MONOBANK_TOKEN: 't',
          ARCANUM_MONOBANK_BASE_URL: m.baseAddress,
          ARCANUM_PUSH_PORT: '0',
        };

        // Signalled as soon as the pid is known, before any stderr line.
        const earlyRun = async (what: string): Promise<number> => {
          const p = spawnProduct(['service'], config, process.env);
          expect(p.pid).toBeGreaterThan(0);
          p.signal('SIGTERM');
          const err = watch(p.stderr);
          void new Response(p.stdout).text();
          const code = await exitWithin(p, STOP_BOUND_MS, what);
          if (code !== 0) throw new Error(`${what} exited ${code} (143 is death by the default action): ${await err.done}`);
          return code;
        };

        // 1. One early signal: exit 0, and the store is left openable or absent, never locked.
        expect(await earlyRun('service (early signal)')).toBe(0);
        // Opened or no local copy; a lock wait surfaces as the store's busy error and fails here.
        try {
          openStore(location, STORE_SCHEMAS, 'existing').close();
        } catch (e) {
          if (!(e instanceof NoLocalCopyError)) throw e;
        }

        // 2. Ten in a row, no delay: every one exits 0.
        const codes: number[] = [];
        for (let i = 0; i < 10; i++) codes.push(await earlyRun(`service (early signal ${i + 1})`));
        expect(codes).toEqual(Array(10).fill(0));

        // 3. After 'service started': one stop sequence, exit 0; a second signal during it changes nothing.
        const p = spawnProduct(['service'], config, process.env);
        const err = watch(p.stderr);
        void new Response(p.stdout).text();
        const started = await err.waitFor('service started', STOP_BOUND_MS);
        if (!started) p.signal('SIGKILL');
        expect(started).toBe(true);
        p.signal('SIGTERM');
        p.signal('SIGTERM');
        const code = await exitWithin(p, STOP_BOUND_MS, 'service (signal after start)');
        if (code !== 0) throw new Error(`service exited ${code}: ${await err.done}`);
        expect(code).toBe(0);
        openStore(location, STORE_SCHEMAS, 'existing').close();
      } finally {
        await m.close();
        removeFolder(dir);
      }
    },
    150_000,
  );

  test(
    'mcp-http process',
    async () => {
      const { STORE_SCHEMAS, ANSWER_FAMILIES, ANSWER_CATALOGUE } = await starters();
      const { openStore } = await db();
      const { spawnProduct } = await spawn();

      const dir = mkdtempSync(join(tmpdir(), 'arcanum-starters-http-'));
      const empty = mkdtempSync(join(tmpdir(), 'arcanum-starters-http-none-'));
      try {
        // A store created with the service starter's one installer list.
        const location = join(dir, 'arcanum.db');
        openStore(location, STORE_SCHEMAS, 'create').close();
        const port = freePort();

        const p = spawnProduct(['mcp-http'], { ARCANUM_STORAGE: location, ARCANUM_MCP_PORT: String(port) }, process.env);
        const err = watch(p.stderr);
        void new Response(p.stdout).text();
        try {
          const listening = await err.waitFor(`assistant over HTTP listening on port ${port} at /mcp`, 10_000);
          if (!listening) throw new Error(`mcp-http never listened: ${err.text()}`);

          const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
            signal: AbortSignal.timeout(10_000),
          });
          expect(res.status).toBe(200);
          const body: any = await res.json();
          const names: string[] = body.result.tools.map((t: any) => t.name);
          const expected = ANSWER_FAMILIES.map((f: any) => ANSWER_CATALOGUE.find((e: any) => e.family === f.name)!.tool);
          expect(names.length).toBe(ANSWER_FAMILIES.length);
          expect([...names].sort()).toEqual([...expected].sort());

          // A termination signal: the one stop, exit 0 within the bound.
          if (process.platform !== 'win32') {
            p.signal('SIGTERM');
            const code = await exitWithin(p, STOP_BOUND_MS, 'mcp-http');
            if (code !== 0) throw new Error(`mcp-http exited ${code}: ${await err.done}`);
            expect(code).toBe(0);
          }
        } finally {
          // Windows delivers no termination signal a process can handle; there the child is ended.
          p.signal('SIGKILL');
        }

        // No local copy: exit 1 naming the location, no listener, the folder stays empty.
        const missing = join(empty, 'arcanum.db');
        const port2 = freePort();
        const p2 = spawnProduct(['mcp-http'], { ARCANUM_STORAGE: missing, ARCANUM_MCP_PORT: String(port2) }, process.env);
        const err2 = watch(p2.stderr);
        void new Response(p2.stdout).text();
        expect(await exitWithin(p2, STOP_BOUND_MS, 'mcp-http (no local copy)')).toBe(1);
        const errText = await err2.done;
        expect(errText).toContain(missing);
        expect(errText).not.toContain('listening');
        expect(await listensOn(port2)).toBe(false);
        expect(readdirSync(empty)).toEqual([]);
      } finally {
        removeFolder(dir);
        removeFolder(empty);
      }
    },
    80_000,
  );
});
