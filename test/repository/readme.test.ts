// The deployment manual (S-258): README.md at the repository root holds the five deployment
// sections in order; its Settings section names every setting the loader produces (S-244
// settingNames over S-221 BUILT_GROUPS) and no other; the Assistant section names the /mcp
// endpoint, the arcanum-mcp service and its port setting; the Deploy section names the push
// override and the Monobank token every recreate needs; the History section the backfill command;
// the Smoke test section the balance command; and no token value is published anywhere in it.
//
// The file and the modules are read inside the test, not at the top: a missing file or module then
// fails the test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const settings = () => import('../../src/config/settings');
const sources = () => import('../../src/app/sources');

const HEADINGS = ['Settings', 'Deploy', 'History', 'Assistant over HTTP', 'Smoke test'];

// The text split on lines starting '## ': each heading (trimmed) with the lines under it, up to the
// next such line.
function sections(text: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      if (current) out.push({ heading: current.heading, body: current.lines.join('\n') });
      current = { heading: line.slice(3).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push({ heading: current.heading, body: current.lines.join('\n') });
  return out;
}

describe('deployment manual', () => {
  test('README.md holds the five sections, the loader setting names and no other, and no token value', async () => {
    const { settingNames } = await settings();
    const { BUILT_GROUPS } = await sources();
    const text = readFileSync(join(root, 'README.md'), 'utf8');
    const all = sections(text);

    // The five headings, in this order (other sections may sit around them).
    const positions = HEADINGS.map((h) => all.findIndex((s) => s.heading === h));
    for (const [i, h] of HEADINGS.entries()) expect({ heading: h, at: positions[i]! >= 0 }).toEqual({ heading: h, at: true });
    for (let i = 1; i < positions.length; i++) expect(positions[i]!).toBeGreaterThan(positions[i - 1]!);

    const section = (h: string): string => all.find((s) => s.heading === h)!.body;

    // Every loader name documented, and no other ARCANUM_ name in the Settings section.
    const names = settingNames(BUILT_GROUPS);
    const settingsText = section('Settings');
    for (const n of names) expect({ name: n, documented: settingsText.includes(n) }).toEqual({ name: n, documented: true });
    const mentioned = new Set(settingsText.match(/ARCANUM_[A-Z_]+/g) ?? []);
    expect([...mentioned].sort()).toEqual([...new Set(names)].sort());

    const assistant = section('Assistant over HTTP');
    expect(assistant).toContain('/mcp');
    expect(assistant).toContain('arcanum-mcp');
    expect(assistant).toContain('ARCANUM_MCP_PORT');

    // The push override, and the token every recreate needs from the host environment.
    const deploy = section('Deploy');
    expect(deploy).toContain('compose.push.yaml');
    expect(deploy).toContain('ARCANUM_MONOBANK_TOKEN');
    expect(section('History')).toContain('backfill monobank');
    expect(section('Smoke test')).toContain('bin.ts balance');

    expect(text).not.toMatch(/TOKEN\s*=\s*\S/);
  });
});
