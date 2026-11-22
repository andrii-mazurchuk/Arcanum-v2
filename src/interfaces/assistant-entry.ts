// Assistant front end entry (S-190): the family check (exit 70), the command's one settings gate,
// the storage location only (exit 1), the existing-only open (exit 1 with no transport for a
// refusal, 70 for a throw), then the one protocol server of the assistant process over the
// observed stdio transport: one tool per handed family, each call answered through the tool-call
// contract. At end of input every received call drains, its marking write included, before the
// server and then the store are closed. Before the transport connects nothing reaches standard
// output; after, only the transport's framed messages do. Imports no family module and not the
// composition root.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { SettingsRecord } from '../config/settings';
import type { Family } from '../core/question';
import { observeStdio } from '../mcp/stdio';
import { checkStart } from '../start-gate';
import { answerToolCall, assistantToolSpecs } from './assistant-call';
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

export const SERVER_INFO = { name: 'arcanum', version: '1' } as const;

export interface AssistantFrontEndInput {
  record: SettingsRecord;
  open: AnsweringOpener;          // uncalled
  families: readonly Family[];    // the composition's one family list, the same the opener registers
  catalogue: Catalogue;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;  // given to the observed transport alone, at step 4
  stderr: NodeJS.WritableStream;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runAssistantFrontEnd(input: AssistantFrontEndInput): Promise<number> {
  const { record, open, families, catalogue, stdin, stdout, stderr } = input;
  const say = (text: string): void => {
    stderr.write(text + '\n');
  };

  // 1. Every handed family has a catalogue entry.
  const faults = catalogueFaults(families.map((f) => f.name), catalogue);
  if (faults.length > 0) {
    for (const l of faults) say(l);
    return EXIT_WIRING;
  }

  // 2. The storage location only: no source setting is required to answer (A-120).
  const v = checkStart({ kind: 'assistant' }, record);
  if (!v.ok) {
    for (const l of v.lines) say(l);
    return EXIT_REFUSED;
  }

  // 3. The existing-only open; a refusal means no transport at all.
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

  // 4. The one protocol server, over the observed transport.
  const io = observeStdio(stdin, stdout);
  const specs = assistantToolSpecs(families, catalogue);
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: specs.map((s) => ({ name: s.tool, description: s.description, inputSchema: s.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const result = await answerToolCall(
      opened.core,
      specs.find((s) => s.tool === req.params.name),
      req.params.name,
      req.params.arguments,
      {
        sent: io.sentFor(extra.requestId, extra.signal),
        closed: io.closed,
        track: (w) => io.track(extra.requestId, w),
        stderr,
      },
    );
    return { ...result };
  });
  try {
    await server.connect(io.transport);
  } catch (e) {
    say(messageOf(e));
    opened.close();
    return EXIT_REFUSED;
  }

  // 5. End of input: drain every received call, marking writes included, then close.
  await Promise.race([io.inputEnded, io.closed]);
  await io.drain();
  await server.close();
  opened.close();
  return EXIT_ANSWERED;
}
