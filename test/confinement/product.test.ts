// Confinement over the real product (S-211, S-241): every .ts file under src/ passes scanProduct,
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
      FILE_PROCESS_ALLOWED,
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
    expect(ids).toContain('store/store');
    expect(ids).toContain('app/bin');
    expect(ids.some((id) => id.startsWith('release/'))).toBe(true);

    // 2. Every allowed pattern matches at least one listed file.
    const lists = [NETWORK_ALLOWED, FILE_PROCESS_ALLOWED, SQLITE_ALLOWED, ENV_ALLOWED, RELEASE_IMPORT_ALLOWED];
    const patterns = [...new Set(lists.flat())];
    const dead = patterns.filter((p) => !ids.some((id) => matches(p, id)));
    expect(dead).toEqual([]);

    // 3. At least one file lies outside every list.
    expect(ids.some((id) => !patterns.some((p) => matches(p, id)))).toBe(true);

    // 4. No violation; on failure each one is listed.
    const v = scanProduct(files, DEV);
    expect(v.map((x) => `${x.moduleId} ${x.rule} ${JSON.stringify(x.match)} line ${x.line}`)).toEqual([]);
  });
});
