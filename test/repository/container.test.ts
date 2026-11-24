// Image and run definitions (S-246): the Dockerfile is a frozen production install on the pinned
// Bun that checks its own Bun and starts the service directly, with no setting baked in; the
// poll-only compose runs the service and the HTTP assistant connection from one image on one
// read-write volume, publishing no port and fixing no container name; the push override publishes
// only the push port.
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

    // compose.yaml: poll-only.
    const text = read('compose.yaml');
    const lines = text.split(/\r?\n/);
    const has = (re: RegExp): boolean => lines.some((line) => re.test(line));
    const count = (re: RegExp): number => lines.filter((line) => re.test(line)).length;

    expect(has(/^\s+arcanum:\s*$/)).toBe(true);
    expect(has(/^\s+arcanum-mcp:\s*$/)).toBe(true);
    expect(count(/^\s*build:\s*\.\s*$/)).toBe(2);

    expect(count(/^\s*ARCANUM_STORAGE:\s*\/data\/arcanum\.db\s*$/)).toBe(2);

    expect(has(/^\s*(-\s*)?ARCANUM_MONOBANK_TOKEN:?\s*$/)).toBe(true);
    expect(has(/ARCANUM_MONOBANK_TOKEN\s*[:=]\s*\S/)).toBe(false);
    expect(has(/^\s*(-\s*)?ARCANUM_MCP_PORT:?\s*$/)).toBe(true);
    expect(has(/ARCANUM_MCP_PORT\s*[:=]\s*\S/)).toBe(false);

    expect(has(/^\s*command:\s*\[\s*"bun",\s*"src\/app\/bin\.ts",\s*"mcp-http"\s*\]\s*$/)).toBe(true);

    expect(has(/^\s*ports:/)).toBe(false);
    expect(text.match(/\d+:\d+/g) ?? []).toEqual([]);

    expect(lines.some((line) => line.includes('container_name'))).toBe(false);

    expect(text.split('arcanum-data:/data').length - 1).toBe(2);
    expect(lines.some((line) => line.includes(':ro'))).toBe(false);
    const volumes = lines.indexOf('volumes:');
    expect(volumes).toBeGreaterThanOrEqual(0);
    expect(lines.slice(volumes + 1).find((line) => line.trim() !== '')).toMatch(/^\s+arcanum-data:\s*$/);
    expect(count(/^\s*restart:\s*unless-stopped\s*$/)).toBe(2);

    // compose.push.yaml: the push override, for arcanum only.
    const pushText = read('compose.push.yaml');
    const pushLines = pushText.split(/\r?\n/);
    expect(pushLines.some((line) => /^\s+arcanum:\s*$/.test(line))).toBe(true);
    expect(pushLines.some((line) => /^\s+arcanum-mcp:\s*$/.test(line))).toBe(false);
    expect(publishedPorts(pushLines)).toEqual(['8080:8080']);
    expect(pushText.match(/\d+:\d+/g) ?? []).toEqual(['8080:8080']);
    expect(pushLines.some((line) => line.includes('container_name'))).toBe(false);
  });
});
