// Assistant front end entry (S-190): the family check (exit 70) before the storage-only settings
// check (exit 1) before the existing-only open (exit 1 with no transport for 'no local copy', 70
// for a throw); then a protocol server over the observed stdio transport listing one tool per
// handed family and answering each call through the tool-call contract; at end of input every
// received call drains before the store is closed and 0 is returned. Nothing but protocol
// messages ever reaches standard output.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';

const entryModule = () => import('../../src/interfaces/assistant-entry');
const catalogueModule = () => import('../../src/interfaces/catalogue');
const renderModule = () => import('../../src/interfaces/render');
const handoffModule = () => import('../../src/interfaces/handoff');
const gateModule = () => import('../../src/start-gate');
const settingsModule = () => import('../../src/config/settings');
const monobankModule = () => import('../../src/sources/monobank');
const sdkTypes = () => import('@modelcontextprotocol/sdk/types.js');

// A family stub: only its name and movesPoint matter to the front end.
const fam = (name: string) => ({
  name,
  period: 'none' as const,
  movesPoint: name === 'new_since_last_asked',
  compute: () => ({ kind: 'body' as const, body: {} }),
});

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

// The settings groups every test loads with: Monobank's alone.
const groups = async () => [(await monobankModule()).settingsGroup];

const record = async (env: Record<string, string>) => {
  const { loadSettings } = await settingsModule();
  return loadSettings(env, await groups());
};

const line = (msg: unknown) => JSON.stringify(msg) + '\n';

const initialize = async (id = 1) => {
  const { LATEST_PROTOCOL_VERSION } = await sdkTypes();
  return line({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
};

const initialized = line({ jsonrpc: '2.0', method: 'notifications/initialized' });

const toolCall = (id: number, name: string, args: unknown) =>
  line({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

// The front end's code, or 'timed out' if it never returns: a wrong product hangs the test no
// longer than this.
const bounded = <T>(p: Promise<T>, ms = 2000): Promise<T | 'timed out'> =>
  Promise.race([p, Bun.sleep(ms).then(() => 'timed out' as const)]);

// A stub opener counting its calls.
const countingOpener = (result: () => unknown) => {
  const calls = { n: 0 };
  const open = () => {
    calls.n += 1;
    return result();
  };
  return { open, calls };
};

// An opener that must not be reached before the fault under test.
const unreachedOpener = () =>
  countingOpener(() => {
    throw new Error('the opener was called');
  });

function envelope(family: string, body: unknown): Record<string, unknown> {
  return {
    kind: 'envelope',
    family,
    asker: 'assistant',
    asOf: { instant: 1795341600000, localDateTime: '2026-11-22T10:00:00+01:00', position: 42 },
    timeZone: 'Europe/Warsaw',
    displayCurrency: 'PLN',
    scope: { narrowing: null, sources: ['monobank'], notOffering: [] },
    period: null,
    statements: { coveredRanges: [] },
    outcome: { kind: 'answered', body },
  };
}

type Channel = { write: (text: string) => Promise<void>; closed: Promise<void> };

// A stub core in S-229's order: render, then await the write; delivered when it resolves, failed
// when it rejects or render threw. `after` runs once the write has completed (the release write).
function stubCore(answerFor: (q: any) => unknown, after?: (q: any) => Promise<void>) {
  const served: any[] = [];
  const core = {
    async serve(q: any, render: (a: any) => string, ch: Channel) {
      served.push(q);
      const answer = answerFor(q);
      let text: string;
      try {
        text = render(answer);
      } catch {
        return { answer, delivery: 'failed', receipt: false, recorded: null };
      }
      try {
        await ch.write(text);
      } catch {
        return { answer, delivery: 'failed', receipt: false, recorded: null };
      }
      if (after) await after(q);
      return { answer, delivery: 'delivered', receipt: false, recorded: null };
    },
  };
  return { core, served };
}

// A capturing stdout that parses each complete line as one JSON-RPC message.
const protocolOut = () => {
  const out = capture();
  const lines = () => out.sink.text.split('\n').filter((l) => l !== '');
  const messages = () => lines().map((l) => JSON.parse(l));
  const responseTo = async (id: number, ms = 2000): Promise<any> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = messages().find((x: any) => x.id === id && ('result' in x || 'error' in x));
      if (m !== undefined) return m;
      if (Date.now() > deadline) throw new Error('no response to ' + id + ' in time');
      await Bun.sleep(1);
    }
  };
  return { out, lines, messages, responseTo };
};

describe('interfaces/assistant-entry', () => {
  test('settings fault exits 1 before the opener', async () => {
    const { runAssistantFrontEnd } = await entryModule();
    const { CATALOGUE_ENTRIES } = await catalogueModule();
    const { EXIT_REFUSED } = await handoffModule();
    const { checkStart } = await gateModule();

    const families = CATALOGUE_ENTRIES.map((e) => fam(e.family));

    // 1-2. Storage missing, the Monobank token missing too: only the storage line, exit 1.
    {
      const r = await record({});
      const { open, calls } = unreachedOpener();
      const stdin = new PassThrough();
      stdin.write(await initialize());
      const out = capture();
      const err = capture();
      const code = await bounded(
        runAssistantFrontEnd({
          record: r,
          open: open as never,
          families: families as never,
          catalogue: CATALOGUE_ENTRIES,
          stdin,
          stdout: out.stream,
          stderr: err.stream,
        }),
      );
      expect(code).toBe(EXIT_REFUSED);
      expect(code).toBe(1);
      expect(code).not.toBe(78);
      const verdict = checkStart({ kind: 'assistant' }, r);
      expect(verdict.ok).toBe(false);
      const expected = (verdict as { lines: readonly string[] }).lines.map((l) => l + '\n').join('');
      expect(err.sink.text).toBe(expected);
      expect(err.sink.text).toBe('ARCANUM_STORAGE is missing: it has no value and no default\n');
      expect(err.sink.text).not.toContain('MONOBANK');
      expect(out.sink.text).toBe('');
      expect(calls.n).toBe(0);
    }

    // 3. Storage given empty: the bad line, exit 1.
    {
      const r = await record({ ARCANUM_STORAGE: '' });
      const { open, calls } = unreachedOpener();
      const stdin = new PassThrough();
      stdin.write(await initialize());
      const out = capture();
      const err = capture();
      const code = await bounded(
        runAssistantFrontEnd({
          record: r,
          open: open as never,
          families: families as never,
          catalogue: CATALOGUE_ENTRIES,
          stdin,
          stdout: out.stream,
          stderr: err.stream,
        }),
      );
      expect(code).toBe(1);
      expect(err.sink.text).toBe('ARCANUM_STORAGE is bad: "": empty\n');
      expect(out.sink.text).toBe('');
      expect(calls.n).toBe(0);
    }
  });

  test('wiring and open faults', async () => {
    const { runAssistantFrontEnd } = await entryModule();
    const { CATALOGUE_ENTRIES } = await catalogueModule();
    const { formatOpenRefusal } = await renderModule();
    const { EXIT_WIRING, EXIT_REFUSED } = await handoffModule();

    const run = async (r: unknown, open: unknown, families: unknown[]) => {
      const stdin = new PassThrough();
      stdin.write(await initialize());
      const out = capture();
      const err = capture();
      const code = await bounded(
        runAssistantFrontEnd({
          record: r as never,
          open: open as never,
          families: families as never,
          catalogue: CATALOGUE_ENTRIES,
          stdin,
          stdout: out.stream,
          stderr: err.stream,
        }),
      );
      return { code, out: out.sink, err: err.sink };
    };

    // 1. A family with no catalogue entry is reported before the (also faulted) settings.
    {
      const { open, calls } = unreachedOpener();
      const res = await run(await record({}), open, [fam('balance'), fam('trends')]);
      expect(res.code).toBe(EXIT_WIRING);
      expect(res.code).toBe(70);
      expect(res.err.text).toBe('wiring fault: answer family "trends" has no catalogue entry\n');
      expect(res.out.text).toBe('');
      expect(calls.n).toBe(0);
    }

    const r = await record({ ARCANUM_STORAGE: '/d/a.db' });

    // 2. An opener that throws.
    {
      const { open, calls } = countingOpener(() => {
        throw new Error('duplicate answer family "balance"');
      });
      const res = await run(r, open, [fam('balance')]);
      expect(res.code).toBe(70);
      expect(res.err.text).toBe('duplicate answer family "balance"\n');
      expect(res.out.text).toBe('');
      expect(calls.n).toBe(1);
    }

    // 3. No local copy: exit 1, the refusal on stderr, and no transport ever answers the queued
    // initialize request.
    {
      const refusal = { kind: 'no_local_copy' as const, location: '/d/a.db' };
      const { open, calls } = countingOpener(() => refusal);
      const res = await run(r, open, [fam('balance')]);
      expect(res.code).toBe(EXIT_REFUSED);
      expect(res.code).toBe(1);
      expect(res.err.text).toBe(formatOpenRefusal(refusal) + '\n');
      expect(res.err.text).toContain('/d/a.db');
      await Bun.sleep(20);
      expect(res.out.text).toBe('');
      expect(calls.n).toBe(1);
    }
  });

  test('lists tools and answers calls over stdio', async () => {
    const { runAssistantFrontEnd } = await entryModule();
    const { CATALOGUE_ENTRIES, toolInputSchema } = await catalogueModule();
    const { formatAnswer, answerJson } = await renderModule();
    const { EXIT_ANSWERED } = await handoffModule();

    const families = [fam('balance'), fam('transaction_search'), fam('holdings'), fam('new_since_last_asked')];
    // Every Monobank setting absent: no source setting is required to start.
    const r = await record({ ARCANUM_STORAGE: ':memory:' });

    const env = envelope('balance', { netPosition: { minor: 0n, currency: 'PLN' } });
    const { core, served } = stubCore(() => env);
    const closes = { n: 0 };
    const { open, calls } = countingOpener(() => ({
      core,
      close: () => {
        closes.n += 1;
      },
    }));

    const stdin = new PassThrough();
    const po = protocolOut();
    const err = capture();

    // 1.
    const p = runAssistantFrontEnd({
      record: r,
      open: open as never,
      families: families as never,
      catalogue: CATALOGUE_ENTRIES,
      stdin,
      stdout: po.out.stream,
      stderr: err.stream,
    });

    // 2. Initialize, then the tool list: exactly the handed families, each with its input schema.
    stdin.write(await initialize(1));
    const init = await po.responseTo(1);
    expect(init.result).toBeDefined();
    stdin.write(initialized);
    stdin.write(line({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    const list = await po.responseTo(2);
    const entry = (name: string) => CATALOGUE_ENTRIES.find((e) => e.family === name)!;
    const expected = JSON.parse(
      JSON.stringify(
        families.map((f) => {
          const e = entry(f.name);
          return { name: e.tool, description: e.description, inputSchema: toolInputSchema(e) };
        }),
      ),
    );
    expect(list.result.tools).toEqual(expected);
    expect(list.result.tools.length).toBe(4);
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toContain('holdings');
    expect(names).toContain('new_since_last_asked');

    // 3. A balance call: the shared text and the answer's JSON value.
    stdin.write(toolCall(3, 'balance', {}));
    const call = await po.responseTo(3);
    expect(call.result.isError).toBe(false);
    const text = formatAnswer(env as never, CATALOGUE_ENTRIES);
    expect(call.result.content).toEqual([{ type: 'text', text }]);
    expect(text).toContain('Covered ranges: nothing held');
    expect(call.result.structuredContent).toEqual(JSON.parse(JSON.stringify(answerJson(env as never))));
    expect(served.length).toBe(1);
    expect(served[0]).toEqual({ family: 'balance', options: {}, asker: 'assistant' });

    // 4. A JSON number for a decimal option is the catalogue's refusal, never the core's.
    stdin.write(toolCall(4, 'transaction_search', { minAmount: 0.29 }));
    const bad = await po.responseTo(4);
    expect(bad.result).toBeDefined();
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain('minAmount');
    expect(served.length).toBe(1);

    // 5. End of input: exit 0, the store closed once, only protocol messages on stdout.
    stdin.end();
    const code = await bounded(p);
    expect(code).toBe(EXIT_ANSWERED);
    expect(code).toBe(0);
    expect(closes.n).toBe(1);
    expect(calls.n).toBe(1);
    for (const l of po.lines()) {
      const m = JSON.parse(l);
      expect(m.jsonrpc).toBe('2.0');
    }
    expect(po.out.sink.text.endsWith('\n')).toBe(true);
    expect(err.sink.text).toBe('');
  });

  test('end of input drains before close', async () => {
    const { runAssistantFrontEnd } = await entryModule();
    const { CATALOGUE_ENTRIES } = await catalogueModule();

    const families = [fam('balance'), fam('transaction_search'), fam('holdings'), fam('new_since_last_asked')];
    const r = await record({ ARCANUM_STORAGE: ':memory:' });

    const events: string[] = [];
    const env = envelope('new_since_last_asked', {
      transactions: [
        { merchant: 'Biedronka', amount: { minor: -1250n, currency: 'PLN' } },
        { merchant: 'Orlen', amount: { minor: -20000n, currency: 'PLN' } },
      ],
    });
    // The write completes, then 30 ms stand for the release write, then the marking.
    const { core } = stubCore(
      () => env,
      async () => {
        await Bun.sleep(30);
        events.push('marked');
      },
    );
    const { open } = countingOpener(() => ({
      core,
      close: () => {
        events.push('closed');
      },
    }));

    const stdin = new PassThrough();
    const po = protocolOut();
    const err = capture();

    // 1.
    const p = runAssistantFrontEnd({
      record: r,
      open: open as never,
      families: families as never,
      catalogue: CATALOGUE_ENTRIES,
      stdin,
      stdout: po.out.stream,
      stderr: err.stream,
    });
    stdin.write(await initialize(1));
    await po.responseTo(1);
    stdin.write(initialized);

    // 2. The call and end of input in one synchronous block.
    stdin.write(toolCall(9, 'new_since_last_asked', { cap: 2 }));
    stdin.end();

    // 3-4.
    const code = await bounded(p);
    expect(code).toBe(0);
    const reply = po.messages().find((m: any) => m.id === 9);
    expect(reply).toBeDefined();
    expect(reply.result.isError).toBe(false);
    expect(events).toEqual(['marked', 'closed']);
  });
});
