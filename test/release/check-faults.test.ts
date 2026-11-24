// Release check (S-239), harness faults: a run whose Monobank stand-in cannot listen fails every
// promise naming the precondition, resolves 1 rather than rejecting, and leaves no temporary folder
// behind. Its own file, because mock.module replaces release/stand-ins for every importer in it.
//
// The modules are imported inside the test, not at the top: a missing module then fails the test
// on its own instead of failing the whole file at load, and release/check must load after the mock.

import { describe, expect, mock, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const FOLDER_PREFIX = 'arcanum-release-';
const releaseFolders = () => readdirSync(tmpdir()).filter((n) => n.startsWith(FOLDER_PREFIX));

// The six promise titles, in PROMISES order (S-238).
const TITLES = [
  'local copy complete and current',
  'answers from the local copy only',
  'rate limits respected',
  'exact money',
  'adding a source touches only that source',
  'single-machine operation',
];

describe('release/check faults', () => {
  test(
    'stand-in cannot listen',
    async () => {
      const real = { ...(await import('../../src/release/stand-ins')) };
      const seconds: { baseAddress: string }[] = [];
      mock.module('../../src/release/stand-ins', () => ({
        ...real,
        startMonobankStandIn: async () => {
          throw new Error('listen EADDRINUSE 127.0.0.1');
        },
        startSecondStandIn: async (...a: Parameters<typeof real.startSecondStandIn>) => {
          const s = await real.startSecondStandIn(...a);
          seconds.push(s);
          return s;
        },
      }));
      try {
      const before = releaseFolders();

      const { releaseCheck } = await import('../../src/release/check');
      const { loadSettings } = await import('../../src/config/settings');
      const { BUILT_GROUPS } = await import('../../src/app/sources');
      const { hostVariables } = await import('../../src/app/main');

      let out = '';
      const err: string[] = [];
      const io = { stdout: (text: string) => void (out += text), stderr: (line: string) => void err.push(line) };

      // Resolves, never rejects: the stand-in failure is a harness fault, not an error out of the check.
      const code = await releaseCheck({
        record: loadSettings({}, BUILT_GROUPS),
        sources: [],
        args: [],
        host: hostVariables(process.env),
        io,
      } as any);
      expect(code).toBe(1);

      const lines = out.split(/\r?\n/).filter((l) => l !== '');
      // Every promise fails, not only those P1 serves, each naming the precondition.
      for (const title of TITLES) {
        const line = lines.find((l) => l.startsWith(`FAIL ${title}: `));
        expect(line).toBeDefined();
        expect(/EADDRINUSE|monobank stand-in/i.test(line!)).toBe(true);
      }
      expect(lines.some((l) => l.startsWith('PASS '))).toBe(false);
      expect(lines[lines.length - 1]!.startsWith('overall: fail: ')).toBe(true);

      // Cleanup ran on this early path too.
      expect(releaseFolders()).toEqual(before);
      for (const s of seconds) {
        const refused = await fetch(s.baseAddress).then(
          () => false,
          () => true,
        );
        expect(refused).toBe(true);
      }
      } finally {
        // Bun keeps a module mock for the whole run: restore the real stand-ins so later files see them.
        mock.module('../../src/release/stand-ins', () => real);
      }
    },
    60_000,
  );
});
