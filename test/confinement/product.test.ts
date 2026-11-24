// Confinement over the real product (S-254, S-246): every .ts file under src/ passes scanProduct,
// and the floors hold, so no allowed pattern is dead and no scan passes by inspecting nothing.
//
// The module is imported inside the test, not at the top: a missing module then fails the test
// instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const confinement = () => import('../../scripts/confinement');

const root = resolve(import.meta.dir, '..', '..');

// '*' matches exactly one path segment.
function matches(pattern: string, moduleId: string): boolean {
  const p = pattern.split('/');
  const m = moduleId.split('/');
  return p.length === m.length && p.every((s, i) => s === '*' || s === m[i]);
}

describe('confinement/product', () => {
  test('product is confined', async () => {
    const {
      listProductFiles,
      scanProduct,
      NETWORK_ALLOWED,
      FILE_ALLOWED,
      PROCESS_ALLOWED,
      SQLITE_ALLOWED,
      ENV_ALLOWED,
      RELEASE_IMPORT_ALLOWED,
    } = await confinement();
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const DEV = Object.keys(pkg.devDependencies ?? {});
    const files = listProductFiles(root);
    const ids = files.map((f) => f.moduleId);

    // 1. moduleIds are '/'-separated, extensionless, and the scan is recursive.
    for (const id of ids) {
      expect(id.includes('\\')).toBe(false);
      expect(id.endsWith('.ts')).toBe(false);
    }
    expect(ids).toContain('sources/monobank/client');
    expect(ids).toContain('db/index');
    expect(ids).toContain('app/bin');
    expect(ids.some((id) => id.startsWith('release/'))).toBe(true);

    // 2. Every allowed pattern matches at least one listed file, so a list entry naming a module
    // label instead of a path ('store/store' for src/db/index.ts) fails here. The one exception is
    // an entry naming a module a later unit builds (ruling of 2026-11-24): the HTTP assistant front
    // end, which once src/interfaces/assistant-http.ts exists is matched like any other.
    const later = ['interfaces/assistant-http'];
    const lists = [NETWORK_ALLOWED, FILE_ALLOWED, PROCESS_ALLOWED, SQLITE_ALLOWED, ENV_ALLOWED, RELEASE_IMPORT_ALLOWED];
    const patterns = [...new Set(lists.flat())];
    const dead = patterns.filter((p) => !later.includes(p) && !ids.some((id) => matches(p, id)));
    expect(dead).toEqual([]);

    // 3. At least one file lies outside every list.
    expect(ids.some((id) => !patterns.some((p) => matches(p, id)))).toBe(true);

    // 4. No violation; on failure each one is listed.
    const v = scanProduct(files, DEV);
    expect(v.map((x) => `${x.moduleId} ${x.rule} ${JSON.stringify(x.match)} line ${x.line}`)).toEqual([]);

    // Rule cases over literal files: the store's file allowance, the release check's whole process
    // object and package.json import, and comments removed before matching.
    const scan = (moduleId: string, text: string) => scanProduct([{ moduleId, text }], DEV);
    const rules = (moduleId: string, text: string) => scan(moduleId, text).map((x) => x.rule);
    expect(rules('db/index', "import { statSync } from 'node:fs'")).not.toContain('file');
    expect(rules('db/index', "import { spawn } from 'node:child_process'")).toContain('process');
    expect(scan('release/check', 'process.exit(1)')).toEqual([]);
    expect(scan('release/judges', "import pkg from '../../package.json'")).toEqual([]);
    expect(rules('sync/service', 'process.exit(1)')).toContain('env');
    expect(scan('sync/service', '// we fetch nothing here')).toEqual([]);
    expect(rules('sync/service', "const f = globalThis['fetch']")).toContain('network');
    expect(scan('sync/service', '/* process.exit */')).toEqual([]);

    // String cases: inside a literal a token counts only as the literal's whole content.
    expect(scan('sync/jobs', "log('rates fetch failed source=' + id)")).toEqual([]);
    expect(rules('sync/jobs', "const k = 'fetch'; globalThis[k]")).toContain('network');
    expect(scan('release/judges', "'Bun ' + v")).toEqual([]);
    expect(rules('sync/service', "Bun['serve']")).toContain('network');
  });
});
