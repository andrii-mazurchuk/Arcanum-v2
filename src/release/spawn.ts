// Spawn helper (S-235): every product child a test or the release check starts gets exactly its
// stated settings plus the host variables its caller passes, never the caller's environment. This
// module reads no environment itself: the host variables are always a parameter.

import { HOST_VARIABLES } from '../app/main';

const BIN_FILE = Bun.fileURLToPath(new URL('../app/bin.ts', import.meta.url));
const REPOSITORY_ROOT = Bun.fileURLToPath(new URL('../../', import.meta.url));

export function childEnvironment(
  settings: Readonly<Record<string, string>>,
  host: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  for (const name of Object.keys(settings)) {
    if (!name.startsWith('ARCANUM_')) throw new TypeError(`setting ${name} is not named ARCANUM_`);
  }
  const result: Record<string, string> = {};
  for (const name of HOST_VARIABLES) {
    const value = host[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(settings)) result[name] = value;
  return result;
}

export interface ProductProcess {
  readonly pid: number;
  readonly stdin: { write(text: string): void; end(): void } | null; // null unless stdin: 'pipe'
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>; // the exit code
  signal(sig: 'SIGTERM' | 'SIGINT' | 'SIGKILL'): void;
}

export function spawnProduct(
  args: readonly string[], // e.g. ['service'], ['mcp'], ['backfill', 'monobank', ...]
  settings: Readonly<Record<string, string>>,
  host: Readonly<Record<string, string | undefined>>, // the release check passes ctx.host; a test passes its own environment
  opts?: { stdin?: 'pipe' | 'ignore' },
): ProductProcess {
  const piped = opts?.stdin === 'pipe';
  const child = Bun.spawn([process.execPath, BIN_FILE, ...args], {
    cwd: REPOSITORY_ROOT,
    env: childEnvironment(settings, host),
    stdin: piped ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const sink = piped ? (child.stdin as import('bun').FileSink) : null;
  return {
    pid: child.pid,
    stdin: sink
      ? {
          write: (text) => void sink.write(text),
          end: () => void sink.end(),
        }
      : null,
    stdout: child.stdout as ReadableStream<Uint8Array>,
    stderr: child.stderr as ReadableStream<Uint8Array>,
    exited: child.exited,
    signal: (sig) => child.kill(sig),
  };
}
