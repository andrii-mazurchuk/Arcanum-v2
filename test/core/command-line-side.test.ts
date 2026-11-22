// Command-line side of the answer frame (S-185): no module implementing an answer-frame entry reads
// process arguments or writes standard output or error, and none exports a command-line front end;
// a command-line ask (S-229, src/core/core) over a memory store (S-242, src/db/index) takes no ask
// claim and marks nothing, even while another process holds that claim.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load. The type import is erased at run time.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Family, QuestionContext, Settings } from '../../src/core/question';

const core = () => import('../../src/core/core');
const store = () => import('../../src/db/index');

// The modules implementing this slice's entries, each with the specifier the other tests import it
// by: S-01, S-49, S-52, S-134, S-229, S-183, S-242, S-07.
const FRAME_MODULES: [string, string][] = [
  ['core/primitives', '../../src/core/primitives'],
  ['core/register', '../../src/core/register'],
  ['core/calendar', '../../src/analytics/dates'],
  ['core/question', '../../src/core/question'],
  ['core/core', '../../src/core/core'],
  ['core/compose', '../../src/core/compose'],
  ['store/store', '../../src/db/index'],
  ['families/holdings', '../../src/families/holdings'],
];

const CLI_EXPORTS = ['runQuestionCommand', 'UsageError', 'CommandMapping'];

// The process-argument and standard-stream references in a source text, spaced member access included.
const cliRefs = (text: string): string[] => [
  ...Array.from(text.matchAll(/process\s*\.\s*(argv|stdout|stderr)\b/g), (m) => m[0]),
  ...Array.from(text.matchAll(/Bun\s*\.\s*argv\b/g), (m) => m[0]),
];

// The module's source file, or null when it does not resolve to an existing file.
const sourceOf = (specifier: string): string | null => {
  try {
    const path = Bun.resolveSync(specifier, import.meta.dir);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
};

// Saturday 2026-11-21 12:00 in Warsaw.
const NOW = Date.UTC(2026, 10, 21, 11, 0, 0);

const settings = (): Settings => ({ timeZone: undefined, sources: [] });
const render = (a: unknown) => JSON.stringify(a);

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

// Rejects when p has not settled within ms.
const within = <T>(p: Promise<T>, ms = 500): Promise<T> => {
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

describe('core/command-line-side', () => {
  test('answer frame has no command-line side', async () => {
    // 1. The scanner flags planted lines and passes a clean one.
    const dir = mkdtempSync(join(tmpdir(), 'arcanum-cli-side-'));
    try {
      const planted: [string, string, number][] = [
        ['bad.ts', 'export function out(t: string) { process.stdout.write(t); }', 1],
        ['bad2.ts', 'const a = Bun.argv.slice(2); console.error(process . stderr);', 2],
        ['clean.ts', 'export const answer = 1;', 0],
      ];
      for (const [name, text] of planted) writeFileSync(join(dir, name), text);
      for (const [name, , n] of planted) expect(cliRefs(readFileSync(join(dir, name), 'utf8'))).toHaveLength(n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // 2. Every frame module's file exists and references no argument or standard stream.
    const findings: string[] = [];
    for (const [name, specifier] of FRAME_MODULES) {
      const path = sourceOf(specifier);
      if (path === null) {
        findings.push(`${name}: no source file for ${specifier}`);
        continue;
      }
      for (const ref of cliRefs(readFileSync(path, 'utf8'))) findings.push(`${name}: ${ref}`);
    }
    expect(findings).toEqual([]);

    // 3. No frame module exports a command-line front end.
    const exported: string[] = [];
    for (const [name, specifier] of FRAME_MODULES) {
      const keys = Object.keys(await import(specifier));
      for (const k of CLI_EXPORTS) if (keys.includes(k)) exported.push(`${name}: ${k}`);
    }
    expect(exported).toEqual([]);
  });

  test('command line ignores a held ask claim', async () => {
    const { createCore, ASK_CLAIM_DEADLINE_MS } = await core();
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
    // The clock never advances, so a claim taken at NOW never expires during the test.
    const c = createCore({ store: s, now: () => NOW, settings, families: [probeNew], contributors: [] } as any);

    // Another process's ask holds the claim.
    expect(s.write((tx: any) => tx.takeClaim('probe_new', 'other', NOW, NOW + ASK_CLAIM_DEADLINE_MS))).toBe(true);
    const marks = () => s.readSnapshot((snap: any) => [1, 2, 3].map((p) => snap.isListed(p)));
    const held = () => s.readSnapshot((snap: any) => snap.claim('probe_new'));
    const serve = async () =>
      (await within(c.serve({ asker: 'command_line', family: 'probe_new', options: {} }, render, channel()))) as any;

    // 1.
    let r = await serve();
    expect(r.receipt).toBe(false);
    expect(r.recorded).toBeNull();
    expect(r.delivery).toBe('delivered');
    expect(r.answer.asker).toBe('command_line');
    expect(r.answer.outcome.body).toEqual({ listed: [1, 2, 3] });

    // 2.
    expect(marks()).toEqual([false, false, false]);
    expect(held()).toEqual({ token: 'other', deadline: NOW + ASK_CLAIM_DEADLINE_MS });

    // 3.
    r = await serve();
    expect(r.answer.outcome.body).toEqual({ listed: [1, 2, 3] });
    expect(r.recorded).toBeNull();
    expect(marks()).toEqual([false, false, false]);
    expect(held().token).toBe('other');

    s.close();
  });
});
