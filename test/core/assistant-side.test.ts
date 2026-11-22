// Assistant side of the answer frame (S-186): no frame module imports the protocol SDK or touches
// standard input or output, and none exports an assistant front end; and the ReplyChannel rule the
// downstream front end relies on (S-229, src/core/core): the ask claim stays held and nothing is
// marked while a delivered reply's write is in flight, and a transport that closes first fails the
// receipt so the page is listed again.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load. The type import is erased at run time.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Family, QuestionContext, Settings } from '../../src/core/question';

const core = () => import('../../src/core/core');
const store = () => import('../../src/db/index');

// The modules implementing the answer frame's entries, each by the specifier the other tests import
// it by: S-01, S-49, S-52, S-134, S-229, S-183, S-242, S-07.
const FRAME_MODULES: readonly (readonly [string, string])[] = [
  ['core/primitives', '../../src/core/primitives'],
  ['core/register', '../../src/core/register'],
  ['core/calendar', '../../src/analytics/dates'],
  ['core/question', '../../src/core/question'],
  ['core/core', '../../src/core/core'],
  ['core/compose', '../../src/core/compose'],
  ['store/store', '../../src/db/index'],
  ['families/holdings', '../../src/families/holdings'],
];

// Standard input or output references, then protocol SDK imports (static, dynamic or require).
const assistantRefs = (text: string): string[] => [
  ...(text.match(/process\s*\.\s*(stdin|stdout)\b/g) ?? []),
  ...(text.match(/(from|import|require)\s*\(?\s*['"]@modelcontextprotocol\/sdk/g) ?? []),
];

// Saturday 2026-11-21 12:00 in Warsaw.
const NOW = Date.UTC(2026, 10, 21, 11, 0, 0);

const settings = (): Settings => ({ timeZone: undefined, sources: [] });
const render = (a: unknown) => JSON.stringify(a);
const tick = () => new Promise((r) => setTimeout(r, 0));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// Rejects when p has not settled within ms.
const within = <T>(p: Promise<T>, ms = 2000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

// Lists the unmarked positions 1..ctx.position, ascending, and hands them back as pending.
const probeNew: Family = {
  name: 'probe_new',
  period: 'none',
  movesPoint: true,
  compute: (ctx: QuestionContext) => {
    const listed: number[] = [];
    for (let p = 1; p <= ctx.position; p++) if (!ctx.snapshot.isListed(p)) listed.push(p);
    return { kind: 'body', body: { listed }, pending: listed };
  },
};

// Memory store: altbank declares nothing and holds account X9; monobank declares jars and holds
// account A1 and jar J1; three positions claimed. A core over it with probe_new alone.
const setup = async () => {
  const { createCore } = await core();
  const { openStore, MEMORY_LOCATION } = await store();
  const s = openStore(MEMORY_LOCATION);
  s.write((tx: any) => {
    tx.registerSource({ id: 'altbank', capabilities: [] });
    tx.registerSource({ id: 'monobank', capabilities: ['jars'] });
    tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'A1', currency: 'UAH' });
    tx.registerHolding({ kind: 'jar', sourceId: 'monobank', bankId: 'J1', currency: 'UAH' });
    tx.registerHolding({ kind: 'account', sourceId: 'altbank', bankId: 'X9', currency: 'EUR' });
  });
  s.write((tx: any) => {
    tx.claimPosition();
    tx.claimPosition();
    tx.claimPosition();
  });
  const c = createCore({ store: s, now: () => NOW, settings, families: [probeNew], contributors: [] } as any);
  const marks = () => s.readSnapshot((snap: any) => [1, 2, 3].map((p) => snap.isListed(p)));
  const claimed = () => s.readSnapshot((snap: any) => snap.claim('probe_new'));
  return { s, c, marks, claimed };
};

const askNew = () => ({ asker: 'assistant' as const, family: 'probe_new', options: {} });

describe('answer frame', () => {
  test('answer frame has no assistant side', async () => {
    // 1. The scanner flags a static and a dynamic SDK import and a standard-input read, and leaves
    // standard error alone.
    const dir = mkdtempSync(join(tmpdir(), 'assistant-side-'));
    const planted = (name: string, text: string) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return assistantRefs(readFileSync(path, 'utf8'));
    };
    expect(planted('a.ts', "import { Server } from '@modelcontextprotocol/sdk/server/index.js';\n")).toHaveLength(1);
    expect(
      planted(
        'b.ts',
        'const t = await import("@modelcontextprotocol/sdk/server/stdio.js"); process.stdin.on(\'data\', f);\n',
      ),
    ).toHaveLength(2);
    expect(planted('c.ts', 'export const x = process.stderr;\n')).toHaveLength(0);

    // 2. No frame module's source references standard input or output or the SDK.
    for (const [name, specifier] of FRAME_MODULES) {
      const file = Bun.resolveSync(specifier, import.meta.dir);
      const found = assistantRefs(readFileSync(file, 'utf8'));
      expect({ module: name, matches: found }).toEqual({ module: name, matches: [] });
    }

    // 3. No frame module exports an assistant front end.
    for (const [name, specifier] of FRAME_MODULES) {
      const keys = Object.keys(await import(specifier));
      for (const withdrawn of ['startAssistantFrontEnd', 'UNANSWERED_TEXT', 'ToolMapping']) {
        expect({ module: name, exports: withdrawn, present: keys.includes(withdrawn) }).toEqual({
          module: name,
          exports: withdrawn,
          present: false,
        });
      }
    }
  });

  test('claim held while the reply is in flight', async () => {
    const { ASK_CLAIM_DEADLINE_MS } = await core();
    const { s, c, marks, claimed } = await setup();
    const d = deferred();
    let called = false;
    const ch = {
      write: (_rendered: string) => {
        called = true;
        return d.promise;
      },
      closed: new Promise<void>(() => {}),
    };

    // 1.
    const p = c.serve(askNew(), render, ch);
    for (let i = 0; i < 50 && !called; i++) await tick();
    expect(called).toBe(true);
    for (let i = 0; i < 10; i++) await tick();

    // 2.
    expect(marks()).toEqual([false, false, false]);
    const held = claimed();
    expect(held).not.toBeNull();
    expect(held.deadline).toBe(NOW + ASK_CLAIM_DEADLINE_MS);
    expect(s.write((tx: any) => tx.takeClaim('probe_new', 'other', NOW, NOW + 1))).toBe(false);

    // 3.
    d.resolve();
    const r = (await within(p)) as any;
    expect(r.delivery).toBe('delivered');
    expect(r.recorded).toEqual([1, 2, 3]);
    expect(marks()).toEqual([true, true, true]);
    expect(claimed()).toBeNull();

    // 4.
    expect(s.write((tx: any) => tx.takeClaim('probe_new', 'other', NOW, NOW + 1))).toBe(true);

    s.close();
  });

  test('transport closing first fails the receipt', async () => {
    const { s, c, marks, claimed } = await setup();
    const d = deferred();
    const closed = deferred();
    let called = false;
    const chA = {
      write: (_rendered: string) => {
        called = true;
        return d.promise;
      },
      closed: closed.promise,
    };
    const chB = {
      write: async (_rendered: string) => {},
      closed: new Promise<void>(() => {}),
    };

    // 1.
    const p = c.serve(askNew(), render, chA);
    for (let i = 0; i < 50 && !called; i++) await tick();
    expect(called).toBe(true);

    // 2. The transport closes while the write is unfinished.
    closed.resolve();
    const r = (await within(p)) as any;
    expect(r.delivery).toBe('failed');
    expect(r.receipt).toBe(true);
    expect(r.recorded).toBeNull();
    expect(marks()).toEqual([false, false, false]);
    expect(claimed()).toBeNull();

    // 3. The abandoned write completes late.
    d.resolve();
    for (let i = 0; i < 10; i++) await tick();
    expect(marks()).toEqual([false, false, false]);

    // 4.
    const r2 = (await within(c.serve(askNew(), render, chB))) as any;
    expect(r2.answer.outcome.body).toEqual({ listed: [1, 2, 3] });
    expect(r2.recorded).toEqual([1, 2, 3]);
    expect(marks()).toEqual([true, true, true]);

    s.close();
  });
});
