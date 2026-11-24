// Confinement scan (S-256): reads every product module under src/ and reports each use of a
// loader, network, file, process, database or environment facility, of test code, of a
// development-only dependency or of the release-check part, outside the allowed lists below.
// Test code: never imported by product code. Comments are removed before matching; inside a
// string or template literal a token counts only as the literal's whole content.

import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
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

interface Views { plain: string; code: string }

// Keywords after which a '/' starts a regex literal rather than a division.
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
  'else', 'yield', 'await',
]);

// Two views of the text, both with line and block comments blanked to spaces (newlines kept, so
// indices and lines stay put). `plain` keeps every string and template literal; `code` blanks a
// literal's content unless that whole content is one identifier ('fetch', `process`), the shape
// aliasing takes, so a word inside prose is not matched. `${...}` inside a template stays code.
function views(text: string): Views {
  const plain = text.split('');
  const code = text.split('');
  const blank = (out: string[], from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  const n = text.length;
  const braces: number[] = []; // per open `${`, the brace depth inside it
  let i = 0;
  // The content of a literal piece from `from` to `to`; `whole` when it is the literal's whole
  // content, so an identifier there is kept.
  const piece = (from: number, to: number, whole: boolean): void => {
    if (whole && /^[A-Za-z_$][\w$]*$/.test(text.slice(from, to))) return;
    blank(code, from, to);
  };
  const skipQuoted = (q: string): void => {
    const start = ++i;
    while (i < n && text[i] !== q && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    piece(start, Math.min(i, n), true);
    i++;
  };
  // Inside a template literal from `start`: returns after its closing backtick or after an
  // opening `${`; `first` tells whether this piece began at the opening backtick.
  const skipTemplate = (first: boolean): void => {
    const start = i;
    while (i < n) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '`') { piece(start, i, first); i++; return; }
      else if (c === '$' && text[i + 1] === '{') { piece(start, i, false); i += 2; braces.push(0); return; }
      else i++;
    }
    piece(start, n, false);
  };
  // The index of the last code character before the one being read (comments skipped), so a '/'
  // can be told apart as a regex literal (expression position) or a division.
  let last = -1;
  const regexStarts = (): boolean => {
    if (last === -1) return true;
    const p = text[last]!;
    if ('(,=:[!&|?{};+-*%<>~^'.includes(p)) return true;
    if (!/[\w$]/.test(p)) return false;
    let s = last;
    while (s > 0 && /[\w$]/.test(text[s - 1]!)) s--;
    return REGEX_KEYWORDS.has(text.slice(s, last + 1));
  };
  // Past a regex literal at `i`, honouring escapes and [...] classes, to its closing '/' and flags
  // on the same line; false, with `i` unmoved, when the line holds no closing '/'.
  const skipRegex = (): boolean => {
    let k = i + 1;
    let inClass = false;
    while (k < n && text[k] !== '\n') {
      const c = text[k];
      if (c === '\\') k += 2;
      else if (c === '[') { inClass = true; k++; }
      else if (c === ']') { inClass = false; k++; }
      else if (c === '/' && !inClass) {
        k++;
        while (k < n && /[A-Za-z]/.test(text[k]!)) k++;
        i = k;
        return true;
      } else k++;
    }
    return false;
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c !== '/' || (d !== '/' && d !== '*')) {
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '/' && regexStarts() && skipRegex()) { last = i - 1; continue; }
    }
    const before = i;
    if (c === '/' && d === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(plain, i, stop);
      blank(code, i, stop);
      i = stop;
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(plain, i, stop);
      blank(code, i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      skipQuoted(c);
    } else if (c === '`') {
      i++;
      skipTemplate(true);
    } else if (c === '{' && braces.length > 0) {
      braces[braces.length - 1]!++;
      i++;
    } else if (c === '}' && braces.length > 0) {
      i++;
      if (braces[braces.length - 1] === 0) { braces.pop(); skipTemplate(false); }
      else braces[braces.length - 1]!--;
    } else {
      i++;
    }
    if (!(c === '/' && (d === '/' || d === '*'))) last = Math.max(before, Math.min(i, n) - 1);
  }
  return { plain: plain.join(''), code: code.join('') };
}

// The HTTP assistant front end may name the server module to listen, never anything outbound.
const LISTEN_ONLY = 'interfaces/assistant-http';

// Outbound capability in the listen-only module: fetch, WebSocket, createConnection, Bun.connect
// or Bun.listen, the socket modules, connect on them or as a bare call, or a source client import.
function outboundHits(moduleId: string, code: string, plain: string, specs: readonly Specifier[]): Hit[] {
  const hits: Hit[] = [
    ...word(code, 'fetch'),
    ...word(code, 'WebSocket'),
    ...word(code, 'createConnection'),
    ...bunMembers(code, ['connect', 'listen']),
    ...named(plain, specs, ['net', 'tls', 'dgram']),
  ];
  for (const m of all(code, /\b(net|tls|dgram)\s*\.\s*connect\b/)) hits.push({ match: m[0], index: m.index });
  for (const m of all(code, /\bconnect\s*\(/)) {
    if (!/\.\s*$/.test(code.slice(0, m.index))) hits.push({ match: m[0], index: m.index });
  }
  for (const s of specs) {
    const p = isRelative(s.spec) ? resolveRelative(moduleId, s.spec) : s.spec;
    if (/(^|\/)src\/sources(\/|$)/.test(p)) hits.push({ match: s.match, index: s.index });
  }
  // No outbound HTTP client (iss-1758): no https or http2, no package but the protocol SDK, from
  // the HTTP module only createServer and types, and no request or get called on it.
  hits.push(...named(plain, specs, ['https', 'http2']));
  for (const s of specs) {
    if (isRelative(s.spec) || s.spec.startsWith('node:') || s.spec.startsWith('bun:') || isBuiltin(s.spec)) continue;
    if (s.spec === MCP_SDK || s.spec.startsWith(`${MCP_SDK}/`)) continue;
    hits.push({ match: s.match, index: s.index });
  }
  hits.push(...httpImportHits(plain));
  for (const m of all(code, /\bhttps?\s*\.\s*(request|get)\s*\(/)) hits.push({ match: m[0], index: m.index });
  return hits;
}

const MCP_SDK = '@modelcontextprotocol/sdk';

// Imports from 'http' / 'node:http' that bring in anything but createServer and types: a default
// or namespace binding, a named binding other than createServer, or a dynamic import.
function httpImportHits(plain: string): Hit[] {
  const hits: Hit[] = [];
  const re = /\b(import|export)\s+(type\s+)?([^'";]*?)\s*\bfrom\s*(['"])(node:)?http\4/;
  for (const m of all(plain, re)) {
    if (m[2]) continue;
    const clause = m[3]!.trim();
    const braced = /^\{([^}]*)\}$/.exec(clause);
    const names = braced ? braced[1]!.split(',').map((x) => x.trim()).filter((x) => x !== '') : null;
    const ok = names !== null && names.every((x) => x.startsWith('type ') || /^createServer(\s+as\s+[\w$]+)?$/.test(x));
    if (!ok) hits.push({ match: m[0], index: m.index });
  }
  for (const m of all(plain, /\bimport\s*\(\s*(['"])(node:)?http\1/)) hits.push({ match: m[0], index: m.index });
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
  for (const { moduleId, text: raw } of files) {
    const { plain, code } = views(raw);
    const lineAt = (index: number): number => raw.slice(0, index).split('\n').length;
    const add = (rule: Rule, hits: readonly Hit[]): void => {
      for (const h of [...hits].sort((a, b) => a.index - b.index)) {
        out.push({ moduleId, rule, match: h.match, line: lineAt(h.index) });
      }
    };
    const specs = moduleSpecifiers(plain);

    add('loader', loaderHits(code));

    if (!allowed(NETWORK_ALLOWED, moduleId)) {
      add('network', [...NETWORK_TOKENS.flatMap((t) => word(code, t)), ...named(plain, specs, NETWORK_SPECIFIERS)]);
    } else if (moduleId === LISTEN_ONLY) {
      add('network', outboundHits(moduleId, code, plain, specs));
    }

    const fileAllowed = allowed(FILE_ALLOWED, moduleId);
    const processAllowed = allowed(PROCESS_ALLOWED, moduleId);
    if (!fileAllowed) add('file', [...named(plain, specs, FILE_SPECIFIERS), ...bunMembers(code, BUN_FILE_MEMBERS)]);
    if (!processAllowed) add('process', [...named(plain, specs, PROCESS_SPECIFIERS), ...bunMembers(code, BUN_PROCESS_MEMBERS)]);

    if (!allowed(SQLITE_ALLOWED, moduleId)) {
      const hits = named(plain, specs, SQLITE_SPECIFIERS, true);
      for (const re of [/\battach\s+(database\b|['"`?:@$])/i, /\bvacuum\s+into\b/i]) {
        for (const m of all(plain, re)) hits.push({ match: m[0], index: m.index });
      }
      add('sqlite', hits);
    }

    // The 'process' and 'node:process' specifiers name the process object too.
    if (!allowed(ENV_ALLOWED, moduleId)) {
      const hits = envHits(code, processAllowed);
      for (const h of named(plain, specs, ['process'])) {
        if (!hits.some((x) => x.index >= h.index && x.index < h.index + h.match.length)) hits.push(h);
      }
      add('env', hits);
    }

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
