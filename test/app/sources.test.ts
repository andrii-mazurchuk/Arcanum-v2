// Built source list (S-221): the composition root's ordered list from src/app/sources, the
// groups, balance conventions and money part taken from it, and sourceListFaults; then a source
// scan showing that nothing outside the composition root (app/bin, app/starters, app/sources)
// imports app/sources or app/starters.
//
// The module is imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve, sep } from 'node:path';

const sources = () => import('../../src/app/sources');

const REPO = resolve(import.meta.dir, '../..');

// --- source scan --------------------------------------------------------------------------------

// Composition-root files, relative to the scanned root, which alone may import the root modules.
const isRoot = (rel: string): boolean =>
  rel === 'src/app/bin.ts' ||
  rel === 'src/app/starters.ts' ||
  rel.startsWith('src/app/starters/') ||
  rel === 'src/app/sources.ts';

const ROOT_MODULE = /^src\/app\/(sources|starters)(\.[cm]?[jt]sx?|\/index(\.[cm]?[jt]sx?)?)?$/;

const SPECIFIERS = [
  /\bfrom\s*['"]([^'"]+)['"]/g, // import … from '…', export … from '…'
  /\bimport\s*['"]([^'"]+)['"]/g, // import '…'
  /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, // import('…')
];

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() && e.name.endsWith('.ts') ? [p] : [];
  });

const toPosix = (p: string): string => p.split(sep).join('/');

// Every .ts file under <root>/src outside the composition root (scanned), and those of them that
// import app/sources or app/starters (offending), all as root-relative posix paths.
function scanRootImports(root: string): { scanned: string[]; offending: string[] } {
  const scanned: string[] = [];
  const offending: string[] = [];
  for (const file of walk(join(root, 'src'))) {
    const rel = toPosix(relative(root, file));
    if (isRoot(rel)) continue;
    scanned.push(rel);
    const text = readFileSync(file, 'utf8');
    const specs = SPECIFIERS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]!));
    const hit = specs.some((spec) => {
      const s = spec.replace(/\\/g, '/');
      let target: string;
      if (s.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(rel), s));
      else if (s.startsWith('/') || /^[A-Za-z]:\//.test(s)) target = toPosix(relative(root, s));
      else target = s.startsWith('src/') ? s : s.replace(/^.*?\/(src\/app\/)/, '$1');
      return ROOT_MODULE.test(target);
    });
    if (hit) offending.push(rel);
  }
  return { scanned: scanned.sort(), offending: offending.sort() };
}

describe('app/sources', () => {
  test('built source list', async () => {
    const { BUILT_SOURCES, BUILT_GROUPS, BALANCE_CONVENTIONS, MONEY_PART, sourceListFaults } =
      await sources();

    expect(BUILT_SOURCES.map((d) => d.id)).toEqual(['monobank', 'second']);
    expect(Object.isFrozen(BUILT_SOURCES)).toBe(true);
    expect(Object.isFrozen(BUILT_GROUPS)).toBe(true);
    expect(BUILT_GROUPS[0]).toBe(BUILT_SOURCES[0]!.settingsGroup);
    expect(BUILT_GROUPS[1]).toBe(BUILT_SOURCES[1]!.settingsGroup);
    expect(BALANCE_CONVENTIONS.get('monobank')).toBe('includes_credit_limit');
    expect(BALANCE_CONVENTIONS.get('second')).toBe('own_money_as_reported');
    expect(BALANCE_CONVENTIONS.size).toBe(2);
    expect(MONEY_PART.rateSource).toBe('monobank');

    expect(sourceListFaults(BUILT_SOURCES)).toEqual([]);
    expect(sourceListFaults([BUILT_SOURCES[0]!, BUILT_SOURCES[1]!, BUILT_SOURCES[0]!])).toEqual([
      'duplicate source "monobank" in the built source list',
    ]);
    const bad = { ...BUILT_SOURCES[1]!, id: 'third' } as (typeof BUILT_SOURCES)[number];
    expect(sourceListFaults([BUILT_SOURCES[0]!, bad])).toEqual([
      'source "third": settings group names "second"',
    ]);
  });

  test('nothing outside the root imports it', () => {
    // Planted check first: the same scanner sees a relative import of app/sources.
    const tmp = mkdtempSync(join(tmpdir(), 'arcanum-root-scan-'));
    try {
      mkdirSync(join(tmp, 'src', 'release'), { recursive: true });
      writeFileSync(
        join(tmp, 'src', 'release', 'x.ts'),
        "import { BUILT_SOURCES } from '../app/sources';\nexport const n = BUILT_SOURCES.length;\n",
      );
      const planted = scanRootImports(tmp);
      expect(planted.scanned).toEqual(['src/release/x.ts']);
      expect(planted.offending).toEqual(['src/release/x.ts']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    const { scanned, offending } = scanRootImports(REPO);
    expect(offending).toEqual([]);
    expect(scanned.length).toBeGreaterThanOrEqual(1);
    expect(scanned).toContain('src/release/check.ts');
  });
});
