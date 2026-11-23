// Release assistant client (S-234): the release check's only way to ask the product a question
// through the assistant connection, an MCP client over a product process's own standard streams. It
// starts that connection through the spawn helper only, never through the protocol library's own
// process-starting transport, which would bypass the explicit environment.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Json } from '../interfaces/render';
import { COVERED_RANGES_KEY } from '../local/covered-ranges';
import { type ProductProcess, spawnProduct } from './spawn';

export const ANSWER_BOUND_MS = 10_000;

// How long a failed connect waits for the process to exit, and for its last stderr to arrive.
const EXIT_BOUND_MS = 2_000;

export type AskResult =
  | { kind: 'answer'; value: { [k: string]: Json }; text: string; refused: boolean; elapsedMs: number } // value: the result's structuredContent
  | { kind: 'failed'; reason: string; elapsedMs: number };

export interface AssistantConnection {
  listTools(): Promise<string[]>; // tool names in listed order
  ask(tool: string, args: Readonly<Record<string, unknown>>, boundMs?: number): Promise<AskResult>; // boundMs default ANSWER_BOUND_MS
  close(): Promise<number>; // ends its input, resolves the exit code
}

interface Framed {
  transport: Transport;
  lastStderrLine(): string;
  stderrEnded: Promise<void>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Resolves with p's value, or with undefined once ms have passed.
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

function frame(p: ProductProcess): Framed {
  let log = '';
  let started = false;
  let inputEnded = false;
  let closed = false;

  // The connection's log: kept, never parsed.
  const stderrEnded = (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of p.stderr) log += decoder.decode(chunk, { stream: true });
      log += decoder.decode();
    } catch {
      // A stream that errors ends the log where it is.
    }
  })();

  const endInput = () => {
    if (inputEnded) return;
    inputEnded = true;
    try {
      p.stdin?.end();
    } catch {
      // Already ended by the process going away.
    }
  };

  const transport: Transport = {
    async start() {
      if (started) throw new Error('transport already started');
      started = true;
      void (async () => {
        const decoder = new TextDecoder();
        let buffer = '';
        const deliver = (line: string) => {
          if (line.trim() === '') return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch (e) {
            transport.onerror?.(new Error(`unparsable line from the assistant connection: ${message(e)}`));
            return;
          }
          transport.onmessage?.(parsed as JSONRPCMessage);
        };
        try {
          for await (const chunk of p.stdout) {
            buffer += decoder.decode(chunk, { stream: true });
            let at = buffer.indexOf('\n');
            while (at >= 0) {
              const line = buffer.slice(0, at);
              buffer = buffer.slice(at + 1);
              deliver(line);
              at = buffer.indexOf('\n');
            }
          }
          buffer += decoder.decode();
          deliver(buffer);
        } catch (e) {
          transport.onerror?.(e instanceof Error ? e : new Error(String(e)));
        }
        if (!closed) {
          closed = true;
          transport.onclose?.();
        }
      })();
    },
    async send(m: JSONRPCMessage) {
      if (!p.stdin || inputEnded) throw new Error('the assistant connection input is closed');
      p.stdin.write(JSON.stringify(m) + '\n');
    },
    async close() {
      endInput();
    },
  };

  const lastStderrLine = () => {
    const lines = log.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    return lines[lines.length - 1] ?? '';
  };

  return { transport, lastStderrLine, stderrEnded };
}

export function processTransport(p: ProductProcess): Transport {
  return frame(p).transport;
}

export async function connectAssistant(p: ProductProcess): Promise<AssistantConnection> {
  if (p.stdin === null) throw new TypeError('the assistant connection needs a process started with stdin pipe');
  const framed = frame(p);
  const client = new Client({ name: 'arcanum-release-check', version: '1.0.0' });

  const exitedFirst = p.exited.then((code) => {
    throw new Error(`exited with code ${code} before connecting`);
  });
  try {
    await Promise.race([client.connect(framed.transport), exitedFirst]);
  } catch (e) {
    void framed.transport.close();
    let code = await within(p.exited, EXIT_BOUND_MS);
    if (code === undefined) {
      p.signal('SIGKILL');
      code = await p.exited;
    }
    await within(framed.stderrEnded, EXIT_BOUND_MS);
    throw new Error(
      `assistant connection failed (${message(e)}); exit code ${code}; last stderr line: ${framed.lastStderrLine() || '(none)'}`,
    );
  }
  exitedFirst.catch(() => {});

  return {
    async listTools() {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        for (const tool of page.tools) names.push(tool.name);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return names;
    },

    async ask(tool, args, boundMs = ANSWER_BOUND_MS) {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), boundMs);
      });
      const begun = performance.now();
      const call = client.callTool({ name: tool, arguments: { ...args } }, undefined, {
        signal: abort.signal,
        timeout: boundMs + 1_000,
      });
      call.catch(() => {});
      try {
        const result = await Promise.race([call, late]);
        const elapsedMs = performance.now() - begun;
        if (result === 'late') {
          abort.abort(new Error('no answer within bound'));
          return { kind: 'failed', reason: `no answer within ${boundMs / 1000} s`, elapsedMs };
        }
        const value: unknown = result.structuredContent;
        if (!isObject(value)) {
          return { kind: 'failed', reason: `the result of ${tool} carries no structuredContent`, elapsedMs };
        }
        const content = Array.isArray(result.content) ? result.content : [];
        const first = content.find((c) => isObject(c) && c.type === 'text');
        const text = first && typeof first.text === 'string' ? first.text : '';
        return {
          kind: 'answer',
          value: value as { [k: string]: Json },
          text,
          refused: result.isError === true,
          elapsedMs,
        };
      } catch (e) {
        return { kind: 'failed', reason: message(e), elapsedMs: performance.now() - begun };
      } finally {
        clearTimeout(timer);
      }
    },

    async close() {
      await framed.transport.close();
      return p.exited;
    },
  };
}

export function openAssistant(
  settings: Readonly<Record<string, string>>,
  host: Readonly<Record<string, string | undefined>>,
): Promise<AssistantConnection> {
  const p = spawnProduct(['mcp'], settings, host, { stdin: 'pipe' });
  return connectAssistant(p);
}

export function coverageOf(value: { [k: string]: Json }, sourceId: string): { startAt: number; endAt: number }[] | null {
  const statements = value.statements;
  if (!isObject(statements)) return null;
  const statement = statements[COVERED_RANGES_KEY];
  if (!Array.isArray(statement)) return null;
  const member = statement.find((s) => isObject(s) && s.sourceId === sourceId);
  if (!isObject(member) || !Array.isArray(member.ranges)) return null;
  const ranges: unknown[] = member.ranges;
  return ranges.filter(isObject).map((r) => ({ startAt: Number(r.startAt), endAt: Number(r.endAt) }));
}
