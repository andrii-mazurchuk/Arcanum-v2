// Pin consistency (S-240): the one pinned Bun version is written literally in package.json
// (engines.bun and @types/bun), every CI bun-version line and every Dockerfile FROM tag, and
// all of them are the exact version BUN_VERSION. A lone change in any one place fails here.
//
// Files are read inside each test, not at the top: a missing file then fails the test on its
// own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The reference figure the pin-consistency test compares against.
export const BUN_VERSION = '1.3.14';

const root = join(import.meta.dir, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const EXACT = /^[0-9]+\.[0-9]+\.[0-9]+$/;

describe('repository/pins', () => {
  test('pin consistency', () => {
    const pkg = JSON.parse(read('package.json'));
    const ci = read('.github/workflows/ci.yml').split(/\r?\n/);
    const docker = read('Dockerfile').split(/\r?\n/);

    const ref = pkg.engines?.bun;
    expect(ref).toMatch(EXACT);
    expect(ref).toBe(BUN_VERSION);

    expect(pkg.devDependencies?.['@types/bun']).toBe(ref);

    const bunVersions = ci
      .map((line) => line.match(/^\s*bun-version:\s*(\S+)\s*$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => m[1]);
    expect(bunVersions.length).toBeGreaterThanOrEqual(1);
    for (const v of bunVersions) expect(v).toBe(ref);

    const froms = docker.filter((line) => /^FROM\s+/.test(line));
    expect(froms.length).toBeGreaterThanOrEqual(1);
    for (const line of froms) {
      const m = line.match(/^FROM\s+oven\/bun:(\S+)/);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(ref);
    }
  });
});
