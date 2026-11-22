// Build definition and type-check configuration (S-240): package.json's module type, scripts and
// dependencies, the committed lockfile, and the one no-emit tsconfig over src, test, tests and tools.
//
// Files are read inside the test, not at the top: a missing file then fails the test on its own
// instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('repository/build', () => {
  test('build definition and tsconfig', () => {
    const pkg = JSON.parse(read('package.json'));
    const ts = JSON.parse(read('tsconfig.json'));

    expect(pkg.type).toBe('module');

    const scripts = pkg.scripts ?? {};
    expect(scripts.typecheck).toBe('tsc -p tsconfig.json');
    expect(scripts.test).toBe('bun test');
    expect(scripts.service).toBe('bun src/app/bin.ts service');
    expect(scripts['release-check']).toBe('bun src/app/bin.ts release-check');
    expect(scripts['check:bun']).toBe('bun src/release/pinned-bun.ts');
    expect(scripts['image-check']).toBe('bun tools/image-check/run.ts');

    expect(pkg.dependencies?.['@modelcontextprotocol/sdk']).toBe('^1.29.0');
    expect('zod' in (pkg.dependencies ?? {})).toBe(true);
    expect('typescript' in (pkg.devDependencies ?? {})).toBe(true);

    expect(existsSync(join(root, 'bun.lock'))).toBe(true);
    expect(existsSync(join(root, 'src/app/bin.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/release/pinned-bun.ts'))).toBe(true);
    expect(existsSync(join(root, 'tools/image-check/run.ts'))).toBe(true);

    const opts = ts.compilerOptions ?? {};
    expect(opts.noEmit).toBe(true);
    expect(opts.strict).toBe(true);
    expect(opts.target).toBe('ESNext');
    expect(opts.module).toBe('ESNext');
    expect(opts.moduleResolution).toBe('bundler');
    expect(opts.types).toEqual(['bun']);
    expect(ts.include).toEqual(['src', 'test', 'tests', 'tools']);
  });
});
