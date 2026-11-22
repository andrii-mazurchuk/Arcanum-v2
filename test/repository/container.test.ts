// Image and run definitions (S-241): the Dockerfile is a frozen production install on the pinned
// Bun that checks its own Bun and starts the service directly, with no setting baked in; the
// compose service keeps its store under /data, passes the token without a value, publishes only
// the push port and restarts unless stopped.
//
// Files are read inside the test, not at the top: a missing file then fails the test on its own
// instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const DOCKERFILE = [
  'FROM oven/bun:1.3.14',
  'WORKDIR /app',
  'COPY package.json bun.lock tsconfig.json ./',
  'RUN bun install --frozen-lockfile --production',
  'COPY src ./src',
  'RUN bun run check:bun',
  'VOLUME /data',
  'EXPOSE 8080',
  'CMD ["bun", "src/app/bin.ts", "service"]',
];

// Trimmed, with one pair of matching surrounding quotes (both ' or both ") removed.
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1);
  return t;
}

// The short-syntax port mappings of the single `ports:` key, in flow or block form.
function publishedPorts(lines: string[]): string[] {
  const at = lines
    .map((line, i) => ({ i, m: line.match(/^(\s*)ports:\s*(.*?)\s*$/) }))
    .filter((x): x is { i: number; m: RegExpMatchArray } => x.m !== null);
  expect(at.length).toBe(1);
  const { i, m } = at[0]!;
  const ind = m[1]!.length;
  const rest = m[2]!;

  if (rest !== '') {
    const flow = rest.match(/^\[(.*)\]$/);
    expect(flow).not.toBeNull();
    return flow![1]!
      .split(',')
      .map(unquote)
      .filter((part) => part !== '');
  }

  const mappings: string[] = [];
  for (const line of lines.slice(i + 1)) {
    if (line.trim() === '') continue;
    const item = line.match(/^(\s*)-\s*(.+?)\s*$/);
    if (item === null || item[1]!.length < ind) break;
    mappings.push(unquote(item[2]!));
  }
  return mappings;
}

describe('repository/container', () => {
  test('image and run definitions', () => {
    const dockerText = read('Dockerfile');
    const docker = dockerText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(docker).toEqual(DOCKERFILE);
    expect(docker.some((line) => line.startsWith('ENV'))).toBe(false);
    expect(dockerText).not.toContain('ARCANUM_');

    const text = read('compose.yaml');
    const lines = text.split(/\r?\n/);
    const has = (re: RegExp): boolean => lines.some((line) => re.test(line));

    expect(has(/^\s+arcanum:\s*$/)).toBe(true);
    expect(has(/^\s*build:\s*\.\s*$/)).toBe(true);

    expect(has(/^\s*ARCANUM_STORAGE:\s*\/data\/arcanum\.db\s*$/)).toBe(true);

    expect(has(/^\s*(-\s*)?ARCANUM_MONOBANK_TOKEN:?\s*$/)).toBe(true);
    expect(has(/ARCANUM_MONOBANK_TOKEN\s*[:=]\s*\S/)).toBe(false);

    expect(publishedPorts(lines)).toEqual(['8080:8080']);
    expect(text.match(/\d+:\d+/g) ?? []).toEqual(['8080:8080']);

    expect(text).toContain('arcanum-data:/data');
    const volumes = lines.indexOf('volumes:');
    expect(volumes).toBeGreaterThanOrEqual(0);
    expect(lines.slice(volumes + 1).find((line) => line.trim() !== '')).toMatch(/^\s+arcanum-data:\s*$/);
    expect(has(/^\s*restart:\s*unless-stopped\s*$/)).toBe(true);
  });
});
