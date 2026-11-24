// Confinement scan (S-254): reads every product module under src/ and reports each use of a
// loader, network, file, process, database or environment facility, of test code, of a
// development-only dependency or of the release-check part, outside the allowed lists below.
// Test code: never imported by product code. Comments are removed before matching; strings and
// template literals are still matched.

import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export interface ScanFile { moduleId: string; text: string } // moduleId: path under src/ without '.ts', '/' separated
export type Rule = 'loader' | 'network' | 'file' | 'process' | 'sqlite' | 'env' | 'test-import' | 'dev-dependency' | 'release-import';
export interface Violation { moduleId: string; rule: Rule; match: string; line: number } // line is 1-based

export const NETWORK_ALLOWED: readonly string[] = ['sources/*/client', 'app/network', 'sync/push-receiver', 'interfaces/assistant-http', 'release/*'];
export const FILE_ALLOWED: readonly string[] = ['release/*', 'db/index'];
export const PROCESS_ALLOWED: readonly string[] = ['release/*'];
export const SQLITE_ALLOWED: readonly string[] = ['db/index'];
export const ENV_ALLOWED: readonly string[] = ['app/bin'];
export const RELEASE_IMPORT_ALLOWED: readonly string[] = ['release/*', 'app/bin'];
export const LOADER_TOKENS = ['require', 'createRequire', 'getBuiltinModule', 'eval', 'Function', 'dlopen'] as const;
export const NETWORK_TOKENS = ['Bun', 'fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'globalThis'] as const;
export const NETWORK_SPECIFIERS = ['bun', 'net', 'http', 'https', 'tls', 'dgram', 'http2', 'undici', 'ws'] as const;
export const FILE_SPECIFIERS = ['fs', 'fs/promises'] as const;
export const PROCESS_SPECIFIERS = ['child_process', 'worker_threads', 'cluster'] as const;
export const SQLITE_SPECIFIERS = ['bun:sqlite', 'sqlite'] as const;
export const BUN_FILE_MEMBERS = ['file', 'write', 'mmap'] as const;
export const BUN_PROCESS_MEMBERS = ['spawn', 'spawnSync', '$'] as const;
export const PROCESS_MEMBERS_ALLOWED = ['on', 'once', 'off', 'removeListener', 'exitCode', 'stdout', 'stderr', 'stdin', 'pid', 'platform', 'execPath', 'hrtime', 'nextTick', 'uptime', 'memoryUsage'] as const;
export const ENV_TOKENS = ['globalThis', 'self'] as const;

// Every .ts file under src/, recursively, in a stable order.
export function listProductFiles(repoRoot: string): ScanFile[] {
  const out: ScanFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile() && e.name.endsWith('.ts')) {
        out.push({ moduleId: rel.slice(0, -3), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(join(repoRoot, 'src'), '');
  return out;
}

// '*' matches exactly one path segment.
function matchesPattern(pattern: string, moduleId: string): boolean {
  const p = pattern.split('/');
  const m = moduleId.split('/');
  return p.length === m.length && p.every((s, i) => s === '*' || s === m[i]);
}

function allowed(list: readonly string[], moduleId: string): boolean {
  return list.some((p) => matchesPattern(p, moduleId));
}

interface Hit { match: string; index: number }

interface Specifier { spec: string; index: number; match: string; typeOnly: boolean }

const IDENT = /^[A-Za-z_$][\w$]*/;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function all(text: string, re: RegExp): RegExpExecArray[] {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return [...text.matchAll(new RegExp(re.source, flags))];
}

function word(text: string, token: string): Hit[] {
  return all(text, new RegExp(`\\b${escape(token)}\\b`)).map((m) => ({ match: m[0], index: m.index }));
}

// The identifier right after `X.` at `end`, taken whole, or null when there is none.
function memberAfter(text: string, end: number): string | null {
  if (text[end] !== '.') return null;
  const m = IDENT.exec(text.slice(end + 1));
  return m ? m[0] : null;
}

// Specifiers in module position: `from '...'`, `import '...'`, `import('...')`.
function moduleSpecifiers(text: string): Specifier[] {
  const typeOnlyAt = new Set<number>();
  for (const m of all(text, /\bimport\s+type\s+[^'";]*?\bfrom\s*(['"])([^'"\n]*)\1/)) {
    typeOnlyAt.add(m.index + m[0].length - m[2]!.length - 2);
  }
  const out: Specifier[] = [];
  const seen = new Set<number>();
  for (const re of [/\bfrom\s*(['"])([^'"\n]*)\1/, /\bimport\s*(['"])([^'"\n]*)\1/, /\bimport\s*\(\s*(['"])([^'"\n]*)\1/]) {
    for (const m of all(text, re)) {
      const quoteAt = m.index + m[0].length - m[2]!.length - 2;
      if (seen.has(quoteAt)) continue;
      seen.add(quoteAt);
      out.push({ spec: m[2]!, index: m.index, match: m[0], typeOnly: typeOnlyAt.has(quoteAt) });
    }
  }
  return out;
}

// A specifier list named in module position (member or 'node:'+member), or anywhere as a quoted
// literal 'node:'+member. `skipTypeOnly` leaves out type-only import statements.
function named(text: string, specs: readonly Specifier[], list: readonly string[], skipTypeOnly = false): Hit[] {
  const hits: Hit[] = [];
  const typeOnlyRanges = specs.filter((s) => s.typeOnly).map((s) => [s.index, s.index + s.match.length]);
  for (const s of specs) {
    if (skipTypeOnly && s.typeOnly) continue;
    if (list.some((n) => s.spec === n || s.spec === `node:${n}`)) hits.push({ match: s.match, index: s.index });
  }
  for (const n of list) {
    for (const m of all(text, new RegExp(`(['"\`])node:${escape(n)}\\1`))) {
      if (skipTypeOnly && typeOnlyRanges.some(([a, b]) => m.index >= a! && m.index < b!)) continue;
      if (hits.some((h) => m.index >= h.index && m.index < h.index + h.match.length)) continue;
      hits.push({ match: m[0], index: m.index });
    }
  }
  return hits;
}

function bunMembers(text: string, members: readonly string[]): Hit[] {
  return word(text, 'Bun').filter((h) => {
    const m = memberAfter(text, h.index + h.match.length);
    return m !== null && members.includes(m);
  }).map((h) => ({ match: `Bun.${memberAfter(text, h.index + h.match.length)}`, index: h.index }));
}

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

// The repo-relative path a relative specifier resolves to from the module's folder under src/.
function resolveRelative(moduleId: string, spec: string): string {
  return posix.normalize(posix.join('src', posix.dirname(moduleId), spec));
}

// The text with line comments and block comments blanked to spaces (newlines kept, so indices
// and lines stay put). Quoted strings and template literals, `${...}` included, are kept.
function stripComments(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  const braces: number[] = []; // per open `${`, the brace depth inside it
  let i = 0;
  const n = text.length;
  const skipQuoted = (q: string): void => {
    i++;
    while (i < n && text[i] !== q && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    i++;
  };
  // Inside a template literal: returns at its closing backtick or after an opening `${`.
  const skipTemplate = (): void => {
    while (i < n) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '`') { i++; return; }
      else if (c === '$' && text[i + 1] === '{') { i += 2; braces.push(0); return; }
      else i++;
    }
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      skipQuoted(c);
    } else if (c === '`') {
      i++;
      skipTemplate();
    } else if (c === '{' && braces.length > 0) {
      braces[braces.length - 1]!++;
      i++;
    } else if (c === '}' && braces.length > 0) {
      i++;
      if (braces[braces.length - 1] === 0) { braces.pop(); skipTemplate(); }
      else braces[braces.length - 1]!--;
    } else {
      i++;
    }
  }
  return out.join('');
}

// The HTTP assistant front end may name the server module to listen, never anything outbound.
const LISTEN_ONLY = 'interfaces/assistant-http';

// Outbound routes in the listen-only module: fetch, connect, or an import of a source client.
function outboundHits(moduleId: string, text: string, specs: readonly Specifier[]): Hit[] {
  const hits: Hit[] = [...word(text, 'fetch'), ...word(text, 'connect')];
  for (const s of specs) {
    const p = isRelative(s.spec) ? resolveRelative(moduleId, s.spec).replace(/\.(ts|js)$/, '') : s.spec;
    if (/(^|\/)src\/sources\/[^/]+\/client$/.test(p)) hits.push({ match: s.match, index: s.index });
  }
  return hits;
}

function loaderHits(text: string): Hit[] {
  const hits: Hit[] = LOADER_TOKENS.flatMap((t) => word(text, t));
  for (const m of all(text, /constructor\s*\.\s*constructor/)) hits.push({ match: m[0], index: m.index });
  for (const m of all(text, /\bimport\s*\(\s*[^'"\s]/)) hits.push({ match: m[0], index: m.index });
  return hits;
}

// `anyMember`: a module in PROCESS_ALLOWED may use every member of the process object but env.
function envHits(text: string, anyMember: boolean): Hit[] {
  const hits: Hit[] = [];
  for (const h of word(text, 'process')) {
    const m = memberAfter(text, h.index + h.match.length);
    if (m !== null && (anyMember ? m !== 'env' : (PROCESS_MEMBERS_ALLOWED as readonly string[]).includes(m))) continue;
    hits.push(m === null ? h : { match: `process.${m}`, index: h.index });
  }
  for (const h of word(text, 'Bun')) {
    const m = memberAfter(text, h.index + h.match.length);
    if (m === null) hits.push(h);
    else if (m === 'env') hits.push({ match: 'Bun.env', index: h.index });
  }
  for (const m of all(text, /import\.meta\.env/)) hits.push({ match: m[0], index: m.index });
  hits.push(...ENV_TOKENS.flatMap((t) => word(text, t)));
  return hits;
}

export function scanProduct(files: readonly ScanFile[], devDependencies: readonly string[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    const moduleId = file.moduleId;
    const text = stripComments(file.text);
    const lineAt = (index: number): number => text.slice(0, index).split('\n').length;
    const add = (rule: Rule, hits: readonly Hit[]): void => {
      for (const h of [...hits].sort((a, b) => a.index - b.index)) {
        out.push({ moduleId, rule, match: h.match, line: lineAt(h.index) });
      }
    };
    const specs = moduleSpecifiers(text);

    add('loader', loaderHits(text));

    if (!allowed(NETWORK_ALLOWED, moduleId)) {
      add('network', [...NETWORK_TOKENS.flatMap((t) => word(text, t)), ...named(text, specs, NETWORK_SPECIFIERS)]);
    } else if (moduleId === LISTEN_ONLY) {
      add('network', outboundHits(moduleId, text, specs));
    }

    const fileAllowed = allowed(FILE_ALLOWED, moduleId);
    const processAllowed = allowed(PROCESS_ALLOWED, moduleId);
    if (!fileAllowed) add('file', [...named(text, specs, FILE_SPECIFIERS), ...bunMembers(text, BUN_FILE_MEMBERS)]);
    if (!processAllowed) add('process', [...named(text, specs, PROCESS_SPECIFIERS), ...bunMembers(text, BUN_PROCESS_MEMBERS)]);

    if (!allowed(SQLITE_ALLOWED, moduleId)) {
      const hits = named(text, specs, SQLITE_SPECIFIERS, true);
      for (const re of [/\battach\s+(database\b|['"`?:@$])/i, /\bvacuum\s+into\b/i]) {
        for (const m of all(text, re)) hits.push({ match: m[0], index: m.index });
      }
      add('sqlite', hits);
    }

    if (!allowed(ENV_ALLOWED, moduleId)) add('env', envHits(text, processAllowed));

    // A module in FILE_ALLOWED may import the repository's package.json (a file read).
    add('test-import', specs.filter((s) => {
      if (s.spec === 'bun:test') return true;
      if (!isRelative(s.spec)) return false;
      const p = resolveRelative(moduleId, s.spec);
      if (fileAllowed && p === 'package.json') return false;
      return !p.startsWith('src/');
    }));

    add('dev-dependency', specs.filter((s) => devDependencies.some((d) => s.spec === d || s.spec.startsWith(`${d}/`))));

    if (!allowed(RELEASE_IMPORT_ALLOWED, moduleId)) {
      add('release-import', specs.filter((s) => {
        if (isRelative(s.spec)) {
          const p = resolveRelative(moduleId, s.spec).replace(/\.(ts|js)$/, '');
          return p === 'src/release' || p.startsWith('src/release/');
        }
        return /(^|\/)src\/release(\/|\.ts$|\.js$|$)/.test(s.spec);
      }));
    }
  }
  return out;
}
