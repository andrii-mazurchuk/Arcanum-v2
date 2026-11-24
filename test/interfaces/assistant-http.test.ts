// HTTP assistant front end (S-248, over S-177's tool calls and S-190's server info): one HTTP server
// serving only POST /mcp through a fresh stateless Streamable HTTP transport per request, with the
// stdio connection's exact tools and answers; GET /mcp is 405 with Allow: POST, any other path 404,
// and neither touches the store. A 'new since last asked' call is marked after its response has
// finished. A missing storage location, a bad ARCANUM_MCP_PORT or no local copy is exit 1 with
// nothing listening; on stop every request drains, the store is closed and 0 is returned.
//
// Every test runs over a temporary store a service-side composition (src/core/compose with the lists
// of src/app/starters) created and wrote; the front end is handed an existing-only opener over it
// with a fixed clock, so two answers to the same question are equal to the byte.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

const httpModule = () => import('../../src/interfaces/assistant-http');
const entryModule = () => import('../../src/interfaces/assistant-entry');
const renderModule = () => import('../../src/interfaces/render');
const handoffModule = () => import('../../src/interfaces/handoff');
const starters = () => import('../../src/app/starters');
const sources = () => import('../../src/app/sources');
const settings = () => import('../../src/config/settings');
const compose = () => import('../../src/core/compose');
const register = () => import('../../src/core/register');
const db = () => import('../../src/db/index');
const transactions = () => import('../../src/local/transactions');
const classifier = () => import('../../src/local/classifier');
const balances = () => import('../../src/sync/balances');
const moneyModule = () => import('../../src/money/money');
const dataset = () => import('../../src/release/dataset');
const sdkTypes = () => import('@modelcontextprotocol/sdk/types.js');

// The fixed clock of every core in this file, in whole seconds.
const NOW = Date.parse('2026-11-21T12:00:00Z');
const RUN_ID = 'httpmcpx';
const ACC_UAH = 'monobank:account:acc-uah';
const MCP_PORT_NAME = 'ARCANUM_MCP_PORT';

// The front end's code, or 'timed out' if it never returns: a wrong product hangs the test no
// longer than this.
const bounded = <T>(p: Promise<T>, ms = 5000): Promise<T | 'timed out'> =>
  Promise.race([p, Bun.sleep(ms).then(() => 'timed out' as const)]);

const waitUntil = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(5);
  }
  return true;
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// A Writable collecting every chunk written to it as text.
const capture = () => {
  const sink = { text: '' };
  const stream = new Writable({
    write(c, _e, cb) {
      sink.text += String(c);
      cb();
    },
  });
  return { stream, sink };
};

function removeFolder(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A connection still holding the file on some platforms; the folder is temporary either way.
  }
}

// A port nothing listens on right now.
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port as number;
  server.stop(true);
  return port;
}

// True when something accepts a connection on the loopback port.
async function listensOn(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(3_000) });
    return true;
  } catch (e) {
    // Accepted but never answered is still a listener; a refused connection is not.
    return (e as Error)?.name === 'TimeoutError';
  }
}

// The settings record of the run: storage as loaded, the port setting as the literal state given.
async function recordWith(env: Record<string, string>, mcpPort: unknown): Promise<any> {
  const { loadSettings } = await settings();
  const { BUILT_GROUPS } = await sources();
  const r = loadSettings(env, BUILT_GROUPS);
  return { ...r, shared: { ...r.shared, mcpPort } };
}

const givenPort = (value: number) => ({ state: 'given', name: MCP_PORT_NAME, value });

// The core's question settings for every composition in this file.
const questionView = async () => {
  const { buildDataset } = await dataset();
  const ds = buildDataset(NOW, RUN_ID);
  return () => ({ timeZone: ds.zone.name, sources: ['monobank'] });
};

// Creates the store at location with the service's installer list and writes the dataset's acc-uah,
// its first two transactions and its balance. Returns each written transaction's bank id -> position.
async function seedStore(location: string): Promise<Map<string, number>> {
  const { STORE_SCHEMAS, ANSWER_FAMILIES, ANSWER_CONTRIBUTORS } = await starters();
  const { BUILT_SOURCES } = await sources();
  const { composeAnswering } = await compose();
  const { narrowingName } = await register();
  const { insertTransaction } = await transactions();
  const { CATEGORIES } = await classifier();
  const { recordBalances } = await balances();
  const { money } = await moneyModule();
  const { buildDataset } = await dataset();

  const ds = buildDataset(NOW, RUN_ID);
  const holding = ds.monobank.holdings.find((h) => h.id === 'acc-uah')!;
  const txns = ds.monobank.initial.filter((t) => t.holding === 'acc-uah').slice(0, 2);
  expect(txns.length).toBe(2);
  const mono = BUILT_SOURCES.find((s) => s.id === 'monobank')!;

  const c = composeAnswering({
    location,
    schemas: STORE_SCHEMAS,
    now: () => NOW,
    settings: await questionView(),
    families: ANSWER_FAMILIES,
    contributors: ANSWER_CONTRIBUTORS,
  });
  const positions = new Map<string, number>();
  try {
    c.store.write((tx) => {
      tx.registerSource({ id: mono.id, capabilities: mono.capabilities } as never);
      tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'acc-uah', currency: 'UAH' } as never);
      for (const t of txns) {
        const position = tx.claimPosition();
        positions.set(t.id, position);
        insertTransaction(
          tx,
          {
            sourceId: 'monobank',
            bankId: t.id,
            holdingId: narrowingName('monobank', 'account', 'acc-uah'),
            occurredAt: t.time!,
            amount: money(BigInt(t.amount), 'UAH'),
            originalAmount: null,
            cashback: null,
            settled: true,
            mcc: t.mcc,
            originalMcc: null,
            merchantText: null,
            description: t.description,
            comment: null,
            counterpart: null,
          } as never,
          position,
          { category: CATEGORIES[0], merchant: t.description } as never,
        );
      }
      recordBalances(
        tx,
        'monobank' as never,
        [
          {
            holdingId: ACC_UAH as never,
            balance: money(BigInt(holding.balance), 'UAH'),
            creditLimit: money(BigInt(holding.creditLimit), 'UAH'),
          },
        ],
        NOW - 60_000,
        'restated',
      );
    });
  } finally {
    c.store.close();
  }
  return positions;
}

// An existing-only opener over location with the fixed clock, counting its opens and closes; a
// missing local copy is the 'no_local_copy' refusal.
async function countingOpener(location: string) {
  const { STORE_SCHEMAS, ANSWER_FAMILIES, ANSWER_CONTRIBUTORS } = await starters();
  const { composeAnswering } = await compose();
  const { openStore, NoLocalCopyError } = await db();
  const view = await questionView();
  const counts = { opens: 0, closes: 0 };
  const open = () => {
    counts.opens += 1;
    let c: ReturnType<typeof composeAnswering>;
    try {
      c = composeAnswering({
        location,
        schemas: STORE_SCHEMAS,
        now: () => NOW,
        settings: view,
        families: ANSWER_FAMILIES,
        contributors: ANSWER_CONTRIBUTORS,
        open: (l, s) => openStore(l, s, 'existing'),
      });
    } catch (e) {
      if (e instanceof NoLocalCopyError) return { kind: 'no_local_copy' as const, location };
      throw e;
    }
    let closed = false;
    return {
      core: c.core,
      close: () => {
        if (closed) return;
        closed = true;
        counts.closes += 1;
        c.store.close();
      },
    };
  };
  return { open, counts };
}

// Whether each position has its listed mark, read over a short-lived existing-only connection.
async function listed(location: string, ps: readonly number[]): Promise<boolean[]> {
  const { STORE_SCHEMAS } = await starters();
  const { openStore } = await db();
  const s = openStore(location, STORE_SCHEMAS, 'existing');
  try {
    return s.readSnapshot((snap) => ps.map((p) => snap.isListed(p as never)));
  } finally {
    s.close();
  }
}

const initializeRequest = async (id: number) => {
  const { LATEST_PROTOCOL_VERSION } = await sdkTypes();
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
  };
};

const listRequest = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });

const callRequest = (id: number, name: string, args: unknown) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

// One POST of a JSON-RPC message to the path, as a Streamable HTTP client sends it; no session header.
const post = (port: number, message: unknown, path = '/mcp') =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000),
  });

// The stdio front end over the same families, catalogue and store: one session that initializes,
// asks each request in turn and ends its input. Returns the response to each request, in order.
async function stdioResponses(location: string, requests: readonly unknown[]): Promise<any[]> {
  const { runAssistantFrontEnd } = await entryModule();
  const { ANSWER_FAMILIES, ANSWER_CATALOGUE } = await starters();
  const { open } = await countingOpener(location);
  const r = await recordWith({ ARCANUM_STORAGE: location }, givenPort(0));
  const stdin = new PassThrough();
  const out = capture();
  const err = capture();
  const p = runAssistantFrontEnd({
    record: r,
    open: open as never,
    families: ANSWER_FAMILIES,
    catalogue: ANSWER_CATALOGUE,
    stdin,
    stdout: out.stream,
    stderr: err.stream,
  });
  const messages = () =>
    out.sink.text
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l));
  const responseTo = async (id: number): Promise<any> => {
    let m: any;
    const ok = await waitUntil(() => {
      m = messages().find((x: any) => x.id === id && ('result' in x || 'error' in x));
      return m !== undefined;
    });
    if (!ok) throw new Error(`stdio: no response to ${id} in time (stderr: ${err.sink.text})`);
    return m;
  };
  stdin.write(JSON.stringify(await initializeRequest(1)) + '\n');
  await responseTo(1);
  stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const responses: any[] = [];
  for (const req of requests) {
    stdin.write(JSON.stringify(req) + '\n');
    responses.push(await responseTo((req as { id: number }).id));
  }
  stdin.end();
  expect(await bounded(p)).toBe(0);
  return responses;
}

describe('assistant over HTTP', () => {
  test(
    'serves POST /mcp statelessly with the stdio tools and answers, and stops with 0',
    async () => {
      const { runHttpAssistantFrontEnd, MCP_PATH } = await httpModule();
      const { ANSWER_FAMILIES, ANSWER_CATALOGUE, STORE_SCHEMAS, ANSWER_CONTRIBUTORS } = await starters();
      const { answerJson } = await renderModule();
      const { EXIT_ANSWERED } = await handoffModule();
      const { composeAnswering } = await compose();
      const { openStore } = await db();

      expect(MCP_PATH).toBe('/mcp');

      const dir = mkdtempSync(join(tmpdir(), 'arcanum-assistant-http-'));
      try {
        const location = join(dir, 'arcanum.db');
        const positions = await seedStore(location);

        // The core's own balance answer for the same store, as the assistant asks it.
        const direct = composeAnswering({
          location,
          schemas: STORE_SCHEMAS,
          now: () => NOW,
          settings: await questionView(),
          families: ANSWER_FAMILIES,
          contributors: ANSWER_CONTRIBUTORS,
          open: (l, s) => openStore(l, s, 'existing'),
        });
        let coreBalance: unknown;
        try {
          const served = await direct.core.serve(
            { family: 'balance', options: {}, asker: 'assistant' } as never,
            (a) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
            { write: async () => {}, closed: new Promise<void>(() => {}) },
          );
          coreBalance = JSON.parse(JSON.stringify(answerJson(served.answer as never)));
        } finally {
          direct.store.close();
        }
        expect((coreBalance as any).kind).toBe('envelope');

        // The stdio connection's list and answers over the same store, before the HTTP one runs.
        const [stdioList, stdioBalance, stdioBad] = await stdioResponses(location, [
          listRequest(2),
          callRequest(3, 'balance', {}),
          callRequest(4, 'transaction_search', { minAmount: 0.29 }),
        ]);
        expect(stdioList.result.tools.length).toBe(ANSWER_FAMILIES.length);
        expect(stdioBalance.result.structuredContent).toEqual(coreBalance);

        // The HTTP front end on any free port.
        const { open, counts } = await countingOpener(location);
        const stop = deferred();
        const err = capture();
        const ports: number[] = [];
        const r = await recordWith({ ARCANUM_STORAGE: location }, givenPort(0));
        const run = runHttpAssistantFrontEnd({
          record: r,
          open: open as never,
          families: ANSWER_FAMILIES,
          catalogue: ANSWER_CATALOGUE,
          stderr: err.stream,
          stop: stop.promise,
          onListening: (port) => {
            ports.push(port);
          },
        });
        let settled = false;
        try {
          const listening = await waitUntil(() => ports.length > 0, 5000);
          if (!listening) throw new Error(`never listened: ${err.sink.text}`);
          const port = ports[0]!;
          expect(port).toBeGreaterThan(0);
          expect(counts.opens).toBe(1);
          expect(err.sink.text).toBe(`assistant over HTTP listening on port ${port} at /mcp\n`);

          // 1. initialize, then tools/list in a separate POST with no session header: the stdio list,
          // and no session issued.
          const initRes = await post(port, await initializeRequest(1));
          expect(initRes.status).toBe(200);
          expect(initRes.headers.get('mcp-session-id')).toBeNull();
          const init: any = await initRes.json();
          expect(init.result).toBeDefined();
          expect(init.result.serverInfo.name).toBe('arcanum');

          const listRes = await post(port, listRequest(2));
          expect(listRes.status).toBe(200);
          expect(listRes.headers.get('mcp-session-id')).toBeNull();
          const list: any = await listRes.json();
          expect(list.result.tools).toEqual(stdioList.result.tools);
          expect(list.result.tools.map((t: any) => t.name)).toEqual(stdioList.result.tools.map((t: any) => t.name));

          // 2. balance: the stdio connection's answer, the core's answer for the same store.
          const balRes = await post(port, callRequest(3, 'balance', {}));
          expect(balRes.status).toBe(200);
          expect(balRes.headers.get('mcp-session-id')).toBeNull();
          const bal: any = await balRes.json();
          expect(bal.result.isError).toBe(false);
          expect(bal.result.structuredContent).toEqual(coreBalance);
          expect(bal.result.structuredContent).toEqual(stdioBalance.result.structuredContent);
          expect(bal.result.content).toEqual(stdioBalance.result.content);
          const accounts: any[] = bal.result.structuredContent.outcome.body.accounts;
          expect(accounts.map((a) => a.holdingId)).toContain(ACC_UAH);

          // 3. A JSON number for a decimal option: the catalogue's refusal, as the stdio one gives it.
          const badRes = await post(port, callRequest(4, 'transaction_search', { minAmount: 0.29 }));
          expect(badRes.status).toBe(200);
          const bad: any = await badRes.json();
          expect(bad.error).toBeUndefined();
          expect(bad.result.isError).toBe(true);
          expect(bad.result.content[0].text).toContain('minAmount');
          expect(bad.result).toEqual(stdioBad.result);

          // 4. GET /mcp is 405 with Allow: POST; any other path is 404; the store is not touched.
          const mtime = statSync(location).mtimeMs;
          const getMcp = await fetch(`http://127.0.0.1:${port}/mcp`, { signal: AbortSignal.timeout(10_000) });
          expect(getMcp.status).toBe(405);
          expect(getMcp.headers.get('allow')).toBe('POST');
          expect(await getMcp.text()).toBe('');
          const getOther = await fetch(`http://127.0.0.1:${port}/other`, { signal: AbortSignal.timeout(10_000) });
          expect(getOther.status).toBe(404);
          expect(await getOther.text()).toBe('');
          const postOther = await post(port, listRequest(5), '/other');
          expect(postOther.status).toBe(404);
          expect(await postOther.text()).toBe('');
          expect(statSync(location).mtimeMs).toBe(mtime);
          expect(counts.opens).toBe(1);

          // 5. Two concurrent balance calls, neither carrying a session: both answered alike.
          const [c1, c2] = await Promise.all([
            post(port, callRequest(6, 'balance', {})),
            post(port, callRequest(7, 'balance', {})),
          ]);
          expect(c1.status).toBe(200);
          expect(c2.status).toBe(200);
          const [b1, b2]: any[] = await Promise.all([c1.json(), c2.json()]);
          expect(b1.result.structuredContent).toEqual(b2.result.structuredContent);
          expect(b1.result.structuredContent).toEqual(coreBalance);

          // 6. new_since_last_asked: both written transactions listed, unmarked until the response;
          // marked once it has finished; a second call lists none of them.
          const wanted = [...positions.values()];
          expect(await listed(location, wanted)).toEqual([false, false]);
          const newRes = await post(port, callRequest(8, 'new_since_last_asked', {}));
          expect(newRes.status).toBe(200);
          const fresh: any = await newRes.json();
          expect(fresh.result.isError).toBe(false);
          const rows: any[] = fresh.result.structuredContent.outcome.body.rows;
          expect(rows.map((x) => x.bankId).sort()).toEqual([...positions.keys()].sort());
          const listedPositions = rows.map((x) => positions.get(x.bankId)!);
          let marks: boolean[] = [];
          const markedInTime = await (async () => {
            const deadline = Date.now() + 3000;
            for (;;) {
              marks = await listed(location, listedPositions);
              if (marks.every((m) => m)) return true;
              if (Date.now() > deadline) return false;
              await Bun.sleep(10);
            }
          })();
          expect(markedInTime).toBe(true);
          expect(marks).toEqual([true, true]);
          const againRes = await post(port, callRequest(9, 'new_since_last_asked', {}));
          expect(againRes.status).toBe(200);
          const again: any = await againRes.json();
          expect(again.result.isError).toBe(false);
          expect(again.result.structuredContent.outcome.body.rows).toEqual([]);

          // 7. Stop: 0, the store closed once, and the test's own existing-only open is the only
          // connection (leaving WAL mode needs every other connection gone).
          stop.resolve();
          const code = await bounded(run);
          settled = true;
          expect(code).toBe(EXIT_ANSWERED);
          expect(code).toBe(0);
          expect(counts.opens).toBe(1);
          expect(counts.closes).toBe(1);
          expect(await listensOn(port)).toBe(false);
          const reopened = openStore(location, STORE_SCHEMAS, 'existing');
          reopened.close();
          const raw = new Database(location);
          let mode: string;
          try {
            mode = String((raw.query('PRAGMA journal_mode = DELETE').get() as { journal_mode: string }).journal_mode);
          } catch (e) {
            mode = `refused: ${(e as Error).message}`;
          } finally {
            raw.close();
          }
          expect(mode).toBe('delete');
        } finally {
          if (!settled) {
            stop.resolve();
            await bounded(run);
          }
        }
      } finally {
        removeFolder(dir);
      }
    },
    60_000,
  );

  test(
    'refuses a missing storage location, a bad port and no local copy with 1, nothing listening',
    async () => {
      const { runHttpAssistantFrontEnd } = await httpModule();
      const { ANSWER_FAMILIES, ANSWER_CATALOGUE } = await starters();
      const { formatOpenRefusal } = await renderModule();
      const { EXIT_REFUSED } = await handoffModule();

      const dir = mkdtempSync(join(tmpdir(), 'arcanum-assistant-http-refusals-'));
      const empty = mkdtempSync(join(tmpdir(), 'arcanum-assistant-http-none-'));
      try {
        const location = join(dir, 'arcanum.db');
        await seedStore(location);

        // The stop promise never settles: a refusal returns without it.
        const run = async (record: unknown, open: unknown) => {
          const err = capture();
          const ports: number[] = [];
          const code = await bounded(
            runHttpAssistantFrontEnd({
              record: record as never,
              open: open as never,
              families: ANSWER_FAMILIES,
              catalogue: ANSWER_CATALOGUE,
              stderr: err.stream,
              stop: new Promise<void>(() => {}),
              onListening: (port) => {
                ports.push(port);
              },
            }),
          );
          return { code, err: err.sink.text, ports };
        };

        // ARCANUM_STORAGE absent: 1 naming it, the opener never called, nothing listening.
        {
          const port = freePort();
          const { open, counts } = await countingOpener(location);
          const res = await run(await recordWith({}, givenPort(port)), open);
          expect(res.code).toBe(EXIT_REFUSED);
          expect(res.code).toBe(1);
          expect(res.err).toContain('ARCANUM_STORAGE');
          expect(res.err.endsWith('\n')).toBe(true);
          expect(res.err).not.toContain('listening');
          expect(res.ports).toEqual([]);
          expect(counts.opens).toBe(0);
          expect(await listensOn(port)).toBe(false);
        }

        // ARCANUM_MCP_PORT '70000': 1 naming the setting and its raw value, the opener never called.
        {
          const { open, counts } = await countingOpener(location);
          const bad = { state: 'bad', name: MCP_PORT_NAME, raw: '70000', reason: 'not between 1 and 65535' };
          const res = await run(await recordWith({ ARCANUM_STORAGE: location }, bad), open);
          expect(res.code).toBe(1);
          expect(res.err).toContain(MCP_PORT_NAME);
          expect(res.err).toContain('"70000"');
          expect(res.err).toContain('1 to 65535');
          expect(res.err.split('\n').filter((l) => l !== '').length).toBe(1);
          expect(res.err).not.toContain('listening');
          expect(res.ports).toEqual([]);
          expect(counts.opens).toBe(0);
        }

        // A folder with no local copy: 1 naming the location, nothing listening, nothing created.
        {
          const missing = join(empty, 'arcanum.db');
          const port = freePort();
          const { open, counts } = await countingOpener(missing);
          const res = await run(await recordWith({ ARCANUM_STORAGE: missing }, givenPort(port)), open);
          expect(res.code).toBe(1);
          expect(res.err).toBe(formatOpenRefusal({ kind: 'no_local_copy', location: missing }) + '\n');
          expect(res.err).toContain(missing);
          expect(res.ports).toEqual([]);
          expect(counts.opens).toBe(1);
          expect(await listensOn(port)).toBe(false);
          expect(readdirSync(empty)).toEqual([]);
        }
      } finally {
        removeFolder(dir);
        removeFolder(empty);
      }
    },
    60_000,
  );
});
