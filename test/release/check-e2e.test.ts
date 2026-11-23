// Release check (S-239), end to end: `release-check` run from the repository against the real
// product reports six PASS lines and 'overall: pass' with exit 0, N/A lines only on win32, names
// the phases P1 to P7 in order on standard error and leaves no temporary folder behind.
//
// The modules under test are imported inside the test, not at the top: a missing module then fails
// the test on its own instead of failing the whole file at load. The dataset module is the one
// exception: the test's timeout is its RUN_LIMIT_MS, which must be known when the test is declared.

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const { RUN_LIMIT_MS } = await import('../../src/release/dataset');

const spawn = () => import('../../src/release/spawn');

const FOLDER_PREFIX = 'arcanum-release-';
const releaseFolders = () => readdirSync(tmpdir()).filter((n) => n.startsWith(FOLDER_PREFIX));

// The check's own start before t0 and its cleanup after the limit.
const START_AND_CLEANUP_MS = 300_000;

const PASS_LINES = [
  'PASS local copy complete and current',
  'PASS answers from the local copy only',
  'PASS rate limits respected',
  'PASS exact money',
  'PASS adding a source touches only that source',
  'PASS single-machine operation',
];
const NA_LINES = ['P4 stop before restart', 'P6 stop before switch-on', 'P7 stop'].map(
  (step) => `N/A ${step}: termination signal not applicable on this host (promised on POSIX hosts only)`,
);

describe('release/check end to end', () => {
  test(
    'release check passes on the product',
    async () => {
      const { spawnProduct } = await spawn();

      const before = releaseFolders();
      const c = spawnProduct(['release-check'], {}, process.env);

      // Standard error is forwarded as it comes, so a run cut short shows its last wait observation.
      let stderr = '';
      const readStderr = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of c.stderr as ReadableStream<Uint8Array>) {
          const text = decoder.decode(chunk, { stream: true });
          stderr += text;
          process.stderr.write(text);
        }
      })();
      const [stdout, code] = await Promise.all([new Response(c.stdout).text(), c.exited, readStderr]);

      const lines = stdout.split(/\r?\n/).filter((l) => l !== '');
      const na = lines.filter((l) => l.startsWith('N/A '));
      expect(lines.slice(0, na.length)).toEqual(na);
      expect(na).toEqual(process.platform === 'win32' ? NA_LINES : []);
      expect(lines.slice(na.length)).toEqual([...PASS_LINES, 'overall: pass']);
      expect(code).toBe(0);

      // Every phase is named on standard error, in order.
      const errLines = stderr.split(/\r?\n/);
      const firsts = [1, 2, 3, 4, 5, 6, 7].map((n) => errLines.findIndex((l) => new RegExp(`\\bP${n}\\b`).test(l)));
      for (const i of firsts) expect(i).toBeGreaterThanOrEqual(0);
      expect([...firsts].sort((a, b) => a - b)).toEqual(firsts);

      expect(releaseFolders().filter((n) => !before.includes(n))).toEqual([]);
    },
    RUN_LIMIT_MS + START_AND_CLEANUP_MS,
  );
});
