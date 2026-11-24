// Confinement scan (S-254): scanProduct over one fixture module at a time, asserting the exact
// set of rules it reports, from scripts/confinement.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const confinement = () => import('../../scripts/confinement');

type Case = [moduleId: string, text: string, rules: string[]];

async function expectRules(cases: Case[], dev: readonly string[]): Promise<void> {
  const { scanProduct } = await confinement();
  for (const [moduleId, text, rules] of cases) {
    const v = scanProduct([{ moduleId, text }], dev);
    const got = [...new Set(v.map((x) => x.rule))].sort();
    expect<any>({ moduleId, text, rules: got }).toEqual({ moduleId, text, rules: [...rules].sort() });
    for (const x of v) expect(x.moduleId).toBe(moduleId);
  }
}

describe('confinement/scan', () => {
  test('loader network env rules', async () => {
    const DEV = ['typescript', '@types/bun'];
    await expectRules(
      [
        // 1-2
        ['answer/x', "const h = process.getBuiltinModule('node:https')", ['loader', 'network', 'env']],
        ['sources/monobank/client', "const h = process.getBuiltinModule('node:https')", ['loader', 'env']],
        // 3-5
        ['answer/x', "const m = 'net'", []],
        ['answer/x', "import { connect } from 'net'", ['network']],
        ['answer/x', 'const m = await import(`./x`)', ['loader']],
        // 6-8
        ['answer/x', "globalThis['fetch']", ['network', 'env']],
        ['answer/x', 'const B = Bun; B.serve(0)', ['network', 'env']],
        ['sources/monobank/client', 'const B = Bun; B.serve(0)', ['env']],
        ['sources/monobank/client', 'const t = Bun.env.HOME', ['env']],
        // 9
        ['answer/x', 'type F = Function', ['loader']],
        ['answer/x', "x.constructor . constructor('return 1')", ['loader']],
        // 10
        ['answer/x', 'const { env } = process', ['env']],
        ['answer/x', "import { env } from 'node:process'", ['env']],
        ['answer/x', 'const p = process', ['env']],
        ['answer/x', 'const u = import.meta.env.X', ['env']],
        ['answer/x', 'const w = self.location', ['env']],
        ['answer/x', 'processRows(x)', []],
        // 11-12
        ['service/main', "process.on('SIGTERM', f); process.exitCode = 0", []],
        ['release/spawn', 'process.env.X', ['env']],
        ['app/bin', 'process.env.X', []],
        // 13
        ['sources/a/b/client', 'export const f = fetch', ['network']],
        ['sources/a/client', 'export const f = fetch', []],
        ['release/x', "fetch('http://127.0.0.1:1')", []],
      ],
      DEV,
    );
  });

  test('file process sqlite test dev rules', async () => {
    const DEV = ['typescript', '@types/bun'];
    await expectRules(
      [
        // 1-3
        ['sources/monobank/client', "Bun.write('/tmp/x', s)", ['file']],
        ['sources/monobank/client', 'const p = Bun.fileURLToPath(u)', []],
        ['sync/push-receiver', "import { readFileSync } from 'fs'", ['file']],
        ['sync/push-receiver', "import x from 'node:fs/promises'", ['file']],
        ['answer/x', "const k = 'node:fs'", ['file']],
        ['answer/x', "const k = 'fs'", []],
        // 4-5
        ['answer/x', "Bun.spawn(['ls'])", ['network', 'process']],
        ['release/spawn', "Bun.spawn(['ls'])", []],
        ['sources/monobank/client', 'Bun.$`ls`', ['process']],
        ['service/x', "import { spawn } from 'node:child_process'", ['process']],
        // 6
        ['sync/log', "import { Database } from 'bun:sqlite'", ['sqlite']],
        ['sync/log', "import type { Database } from 'bun:sqlite'", []],
        ['sync/log', `db.exec("ATTACH DATABASE '/tmp/x.db' AS x")`, ['sqlite']],
        ['sync/log', `db.exec("attach '/tmp/x.db' as x")`, ['sqlite']],
        ['sync/log', `db.exec("VACUUM INTO '/tmp/b.db'")`, ['sqlite']],
        ['sync/log', 'const attachments = 1', []],
        ['sync/log', "import { DatabaseSync } from 'node:sqlite'", ['sqlite']],
        // 7
        ['db/index', "import { Database } from 'bun:sqlite'", []],
        // 8
        ['service/sync', "import { h } from '../../test/helpers'", ['test-import']],
        ['service/sync', "import { expect } from 'bun:test'", ['test-import']],
        // 9
        ['answer/x', "import ts from 'typescript'", ['dev-dependency']],
        ['answer/x', "import x from 'typescript/lib/tsserverlibrary'", ['dev-dependency']],
        ['answer/x', "import x from 'typescript-eslint'", []],
      ],
      DEV,
    );
  });

  test('release-import rule', async () => {
    const DEV: string[] = [];
    await expectRules(
      [
        ['service/sync', "import { spawnProduct } from '../release/spawn'", ['release-import']],
        ['sources/monobank/client', "const m = await import('../../release/stand-in')", ['release-import']],
        ['sources/monobank/client', "const m = await import('../release/stand-in')", []],
        ['app/main', "import type { X } from '../release/check'", ['release-import']],
        ['app/bin', "import { releaseCheckStarter } from '../release/check'", []],
        ['release/check', "import { spawnProduct } from './spawn'", []],
        ['sync/x', "import { y } from '../releases/y'", []],
        ['service/sync', "export { x } from '../release/check'", ['release-import']],
        ['answer/x', "import x from '/repo/src/release/check'", ['release-import']],
      ],
      DEV,
    );

    const { scanProduct } = await confinement();
    const v = scanProduct(
      [{ moduleId: 'service/sync', text: "const a = 1;\nconst b = 2;\nimport { s } from '../release/spawn';" }],
      DEV,
    );
    expect(v.length).toBe(1);
    expect(v[0]!.moduleId).toBe('service/sync');
    expect(v[0]!.rule).toBe('release-import');
    expect(v[0]!.line).toBe(3);
  });

  test('assistant-http allowance', async () => {
    const { scanProduct } = await confinement();
    const scan = (moduleId: string, text: string) => scanProduct([{ moduleId, text }], []);
    const listen = "import { createServer } from 'node:http'";

    // The HTTP front end may name the server module; the allowance is that one module only.
    expect(scan('interfaces/assistant-http', listen).filter((x) => x.rule === 'network')).toEqual([]);
    expect(scan('interfaces/assistant-entry', listen).some((x) => x.rule === 'network')).toBe(true);

    // Listening only: no outbound call, no connect, no source client.
    for (const text of [
      'await fetch(u)',
      "import { connect } from 'net'",
      "import { monobankClient } from '../sources/monobank/client'",
    ]) {
      expect({ text, flagged: scan('interfaces/assistant-http', text).length > 0 }).toEqual({ text, flagged: true });
    }

    // A member call .connect( on another object (the protocol server binding its transport) is
    // allowed; connect on the socket modules, as a bare call or through Bun, is not.
    expect(scan('interfaces/assistant-http', 'await server.connect(transport)')).toEqual([]);
    for (const text of [
      "import { connect } from 'node:net'",
      'net.connect(80)',
      'createConnection(80)',
      'Bun.connect({})',
    ]) {
      expect({ text, flagged: scan('interfaces/assistant-http', text).length > 0 }).toEqual({ text, flagged: true });
    }
  });
});
