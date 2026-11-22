// Release assistant client (S-234): the release check's one way of asking the product, an MCP client
// over an assistant connection's own standard streams. processTransport frames the protocol as one
// JSON line per message both ways; coverageOf reads a source's covered ranges out of an answer's
// value; openAssistant starts the real `mcp` command through the spawn helper and asks it.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProductProcess } from '../../src/release/spawn';

const assistant = () => import('../../src/release/assistant');
const db = () => import('../../src/db/index');
const starters = () => import('../../src/app/starters');

const DRAIN_BOUND_MS = 2_000;

// Resolves once cond() holds, or rejects after DRAIN_BOUND_MS; then yields a few more turns so
// anything delivered late (a duplicate message, a second error) is seen before asserting.
async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + DRAIN_BOUND_MS;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

function removeFolder(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A child still holding the file on some platforms; the folder is temporary either way.
  }
}

describe('release/assistant', () => {
  test('stdio framing', async () => {
    const { processTransport } = await assistant();

    let out!: ReadableStreamDefaultController<Uint8Array>;
    const written: string[] = [];
    let ended = false;
    const p: ProductProcess = {
      pid: 4242,
      stdin: {
        write(t: string) {
          written.push(t);
        },
        end() {
          ended = true;
        },
      },
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          out = c;
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      exited: new Promise<number>(() => {}),
      signal() {},
    };

    const got: any[] = [];
    const errors: unknown[] = [];
    let closes = 0;
    const tr = processTransport(p);
    tr.onmessage = (m: unknown) => {
      got.push(m);
    };
    tr.onerror = (e: Error) => {
      errors.push(e);
    };
    tr.onclose = () => {
      closes++;
    };
    await tr.start();

    const enc = new TextEncoder();
    // Two whole messages in one chunk.
    out.enqueue(enc.encode('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{}}\n'));
    // One message over two chunks, the second also ending in an empty line.
    out.enqueue(enc.encode('{"jsonrpc":"2.0","id":3,'));
    out.enqueue(enc.encode('"result":{}}\n\n'));
    // A line that is not JSON.
    out.enqueue(enc.encode('not json\n'));
    // 'ł' (two UTF-8 bytes) split between two chunks.
    const line = enc.encode('{"jsonrpc":"2.0","method":"n","params":{"t":"ł"}}\n');
    const cut = line.indexOf(0xc5) + 1;
    expect(cut).toBeGreaterThan(0);
    out.enqueue(line.slice(0, cut));
    out.enqueue(line.slice(cut));

    await until(() => got.length >= 4 && errors.length >= 1, 'four messages and one error');

    expect(got.length).toBe(4);
    expect(got.map((m) => m.id)).toEqual([1, 2, 3, undefined]);
    expect(got[3].method).toBe('n');
    expect(got[3].params.t).toBe('ł');
    expect(errors.length).toBe(1);

    await tr.send({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect(written).toEqual(['{"jsonrpc":"2.0","id":9,"method":"tools/list"}\n']);

    await tr.close();
    expect(ended).toBe(true);
    out.close();
    await until(() => closes >= 1, 'onclose');
    expect(closes).toBe(1);
  });

  test('coverageOf', async () => {
    const { coverageOf } = await assistant();

    const v = {
      statements: {
        coveredRanges: [
          {
            sourceId: 'monobank',
            ranges: [
              { startAt: 60_000, endAt: 120_000, start: 's', end: 'e' },
              { startAt: 180_000, endAt: 240_000, start: 's2', end: 'e2' },
            ],
          },
          { sourceId: 'second', ranges: [] },
        ],
      },
    };

    // Only the two numbers per range, every range, in order.
    expect(coverageOf(v, 'monobank')).toEqual([
      { startAt: 60_000, endAt: 120_000 },
      { startAt: 180_000, endAt: 240_000 },
    ]);
    // A source present but holding nothing.
    expect(coverageOf(v, 'second')).toEqual([]);
    // An absent source, an absent statement, absent statements: null, never [].
    expect(coverageOf(v, 'x')).toBeNull();
    expect(coverageOf({ statements: {} }, 'monobank')).toBeNull();
    expect(coverageOf({}, 'monobank')).toBeNull();
  });

  test(
    'ask the real assistant connection',
    async () => {
      const { openAssistant, ANSWER_BOUND_MS } = await assistant();
      const { openStore } = await db();
      const { STORE_SCHEMAS } = await starters();

      const dir = mkdtempSync(join(tmpdir(), 'arcanum-assistant-'));
      const dir2 = mkdtempSync(join(tmpdir(), 'arcanum-assistant-none-'));
      try {
        // An empty local copy with the service's installers; its register holds no source row.
        const location = join(dir, 'arcanum.db');
        openStore(location, STORE_SCHEMAS, 'create').close();
        const settings = { ARCANUM_STORAGE: location };
        // A bad zone present only in the caller's environment.
        const host = { ...process.env, ARCANUM_TIME_ZONE: 'Mars/Olympus' };

        const c = await openAssistant(settings, host);

        const tools = await c.listTools();
        expect(tools.length).toBe(13);
        expect(new Set(tools).size).toBe(13);
        expect(tools).toContain('balance');
        expect(tools).toContain('transaction_search');
        expect(tools).toContain('holdings');

        // An answer: its structured value carries an empty covered-ranges statement.
        const a = await c.ask('holdings', {});
        if (a.kind !== 'answer') throw new Error(`holdings failed: ${a.reason}`);
        expect(a.refused).toBe(false);
        expect(a.text.length).toBeGreaterThan(0);
        expect(a.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(a.elapsedMs).toBeLessThan(ANSWER_BOUND_MS);
        expect((a.value.statements as any).coveredRanges).toEqual([]);

        // The core's period refusal carries structured content and is marked refused.
        const r = await c.ask('transaction_search', { period: 'not-a-period' });
        if (r.kind !== 'answer') throw new Error(`transaction_search failed: ${r.reason}`);
        expect(r.refused).toBe(true);
        expect(r.text.startsWith('Refused (')).toBe(true);

        // The assistant front end exits 0 at end of input.
        expect(await c.close()).toBe(0);

        // No local copy: the child exits 1 naming the setting, and creates nothing.
        let message = '';
        try {
          await openAssistant({ ARCANUM_STORAGE: join(dir2, 'arcanum.db') }, process.env);
          message = 'resolved';
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        expect(message).not.toBe('resolved');
        expect(message).toContain('1');
        expect(message).toContain('ARCANUM_STORAGE');
        expect(readdirSync(dir2)).toEqual([]);
      } finally {
        removeFolder(dir);
        removeFolder(dir2);
      }
    },
    30_000,
  );
});
