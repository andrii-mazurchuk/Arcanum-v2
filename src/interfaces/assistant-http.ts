// HTTP assistant front end entry (S-248): the family check (exit 70), the command's one settings
// gate, the storage location and ARCANUM_MCP_PORT only (exit 1), the existing-only open (exit 1 with
// no listener for a refusal, 70 for a throw), then one HTTP server on 0.0.0.0:<port> serving only
// POST /mcp, each through a fresh protocol server and a fresh stateless Streamable HTTP transport
// with plain JSON responses, listing the stdio connection's tools and answering each call through
// the same tool-call contract. A 'new since last asked' reply is marked only after its response's
// finish. On stop no new connection is accepted, every received request and tracked serve drains,
// the store is closed and 0 is returned. Imports no family module and not the composition root;
// the HTTP server is the only listener and nothing goes outbound.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { settingValue, type SettingsRecord } from '../config/settings';
import type { Family } from '../core/question';
import { checkStart } from '../start-gate';
import { answerToolCall, assistantToolSpecs, type AssistantToolSpec, type CallWiring } from './assistant-call';
import { SERVER_INFO } from './assistant-entry';
import { catalogueFaults, type Catalogue } from './catalogue';
import {
  EXIT_ANSWERED,
  EXIT_REFUSED,
  EXIT_WIRING,
  isOpenRefusal,
  type AnsweringOpener,
  type OpenedAnswering,
  type OpenRefusal,
} from './handoff';
import { formatOpenRefusal } from './render';

export const MCP_PATH = '/mcp';

export interface HttpAssistantInput {
  record: SettingsRecord;
  open: AnsweringOpener;          // uncalled
  families: readonly Family[];    // the composition's one family list
  catalogue: Catalogue;
  stderr: NodeJS.WritableStream;
  stop: Promise<void>;            // settles on a termination or interrupt signal (the starter wires it)
  onListening?: (port: number) => void; // called once with the bound port; tests use it with port 0
}

const PORT_NEED = 'the HTTP assistant connection needs a port from 1 to 65535';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const settle = (ps: Iterable<Promise<unknown>>): Promise<unknown> => Promise.allSettled([...ps]);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Resolves on the response's 'finish', rejects on its 'close' before 'finish'.
function sentOf(res: ServerResponse): Promise<void> {
  const sent = new Promise<void>((resolve, reject) => {
    res.once('finish', () => resolve());
    res.once('close', () => {
      if (!res.writableFinished) reject(new Error('the response closed before it was sent in full'));
    });
  });
  sent.catch(() => {}); // observed by the core only when it writes a reply
  return sent;
}

export async function runHttpAssistantFrontEnd(input: HttpAssistantInput): Promise<number> {
  const { record, open, families, catalogue, stderr, stop, onListening } = input;
  const say = (text: string): void => {
    stderr.write(text + '\n');
  };

  // 1. Every handed family has a catalogue entry.
  const faults = catalogueFaults(families.map((f) => f.name), catalogue);
  if (faults.length > 0) {
    for (const l of faults) say(l);
    return EXIT_WIRING;
  }

  // 2. The storage location, then the port.
  const v = checkStart({ kind: 'assistant' }, record);
  if (!v.ok) {
    for (const l of v.lines) say(l);
    return EXIT_REFUSED;
  }
  const mcpPort = record.shared.mcpPort;
  if (mcpPort.state === 'missing') {
    say(`${mcpPort.name} is missing: ${PORT_NEED}`);
    return EXIT_REFUSED;
  }
  if (mcpPort.state === 'bad') {
    say(`${mcpPort.name} "${mcpPort.raw}" ${mcpPort.reason}: ${PORT_NEED}`);
    return EXIT_REFUSED;
  }
  const port = settingValue(mcpPort) as number;

  // 3. The existing-only open; a refusal means no listener at all.
  let o: OpenedAnswering | OpenRefusal;
  try {
    o = open();
  } catch (e) {
    say(messageOf(e));
    return EXIT_WIRING;
  }
  if (isOpenRefusal(o)) {
    say(formatOpenRefusal(o));
    return EXIT_REFUSED;
  }
  const opened = o;

  // 4. The one HTTP server.
  const specs = assistantToolSpecs(families, catalogue);
  const requests = new Set<Promise<void>>();
  const inFlight = new Set<Promise<unknown>>();
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const http = createServer((req, res) => {
    const ended = new Promise<void>((resolve) => {
      res.once('close', () => resolve());
    });
    requests.add(ended);
    void ended.then(() => requests.delete(ended));
    void handle(req, res).catch((e: unknown) => {
      say(messageOf(e));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== MCP_PATH) {
      req.resume();
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      req.resume();
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end();
      return;
    }

    const text = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null }));
      return;
    }

    const sent = sentOf(res);
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: specs.map((s) => ({ name: s.tool, description: s.description, inputSchema: s.inputSchema })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const wiring: CallWiring = {
        sent,
        closed,
        track: (work) => {
          inFlight.add(work);
          const done = (): void => {
            inFlight.delete(work);
          };
          work.then(done, done);
        },
        stderr,
      };
      const spec: AssistantToolSpec | undefined = specs.find((s) => s.tool === call.params.name);
      const result = await answerToolCall(opened.core, spec, call.params.name, call.params.arguments, wiring);
      return { ...result };
    });
    res.once('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const listened = await new Promise<{ ok: true; port: number } | { ok: false; error: unknown }>((resolve) => {
    const onError = (e: unknown): void => resolve({ ok: false, error: e });
    http.once('error', onError);
    http.listen(port, '0.0.0.0', () => {
      http.off('error', onError);
      const address = http.address();
      resolve({ ok: true, port: typeof address === 'object' && address !== null ? address.port : port });
    });
  });
  if (!listened.ok) {
    say(messageOf(listened.error));
    opened.close();
    return EXIT_REFUSED;
  }
  http.on('error', (e) => say(messageOf(e)));
  onListening?.(listened.port);
  say(`assistant over HTTP listening on port ${listened.port} at ${MCP_PATH}`);

  // 5. Stop: accept nothing new, drain every received request and tracked serve, then close.
  await stop;
  const serverClosed = new Promise<void>((resolve) => {
    http.close(() => resolve());
  });
  http.closeIdleConnections();
  while (requests.size > 0) await settle(requests);
  while (inFlight.size > 0) await settle(inFlight);
  markClosed();
  http.closeAllConnections();
  await serverClosed;
  opened.close();
  return EXIT_ANSWERED;
}
