// CI workflow shape (S-240): push and pull_request on ubuntu-latest; checkout, then setup-bun,
// then exactly frozen install, typecheck and test, in that order; nothing that can mask a failure.
//
// The workflow is read inside the test, not at the top: a missing file then fails the test on
// its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');

describe('repository/ci', () => {
  test('workflow shape', () => {
    const text = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const lines = text.split(/\r?\n/);

    expect(text).toContain('push');
    expect(text).toContain('pull_request');
    expect(lines.some((line) => /^\s*runs-on:\s*ubuntu-latest\s*$/.test(line))).toBe(true);

    expect(text).not.toContain('continue-on-error');

    const runPattern = /^\s*(?:-\s*)?run:\s*(.+?)\s*$/;
    const runs = lines
      .map((line) => line.match(runPattern))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => m[1]);
    expect(runs).toEqual(['bun install --frozen-lockfile', 'bun run typecheck', 'bun test']);

    const checkout = lines.findIndex((line) => line.includes('actions/checkout'));
    const setupBun = lines.findIndex((line) => line.includes('oven-sh/setup-bun'));
    const firstRun = lines.findIndex((line) => runPattern.test(line));
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(setupBun).toBeGreaterThan(checkout);
    expect(firstRun).toBeGreaterThan(setupBun);
  });
});
