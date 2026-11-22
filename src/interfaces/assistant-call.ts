// Assistant tool call (S-177): one spec per handed family from its catalogue entry, and the answer
// to one call. A call is parsed before anything else and a parse refusal is answered without the
// core; a draft is served once, stamped 'assistant' here and nowhere else in the assistant process.
// The result carries the shared text, the answer's JSON value as structured content, and isError
// exactly for a refusal. The core's reply write completes only when the response's send has.
// Pure of transport: it never touches standard output; the protocol server sends what it returns.

import { isRefusal, type Refusal } from '../core/primitives';
import type { Answer, Family, Question, QuestionDraft } from '../core/question';
import type { AnsweringCore, ReplyChannel, ServeResult } from '../core/core';
import { parseRaw, toolInputSchema, type Catalogue, type ToolInputSchema } from './catalogue';
import { answerJson, formatAnswer, formatRefusal, type Json } from './render';

export interface AssistantToolSpec {
  tool: string;                                      // entry.tool
  description: string;                               // entry.description
  inputSchema: ToolInputSchema;                      // toolInputSchema(entry), listed to the assistant as the tool's input description
  parse(args: unknown): QuestionDraft | Refusal;     // parseRaw(entry, { wire: 'json', args })
  render(answer: Answer): string;                    // formatAnswer(answer, catalogue), refusals included
  structured(answer: Answer): { [k: string]: Json }; // answerJson(answer)
}

export function assistantToolSpecs(families: readonly Family[], catalogue: Catalogue): readonly AssistantToolSpec[] {
  const specs: AssistantToolSpec[] = [];
  for (const f of families) {
    const entry = catalogue.find((e) => e.family === f.name);
    if (entry === undefined) continue; // refused at start by catalogueFaults before anything is built
    specs.push({
      tool: entry.tool,
      description: entry.description,
      inputSchema: toolInputSchema(entry),
      parse: (args) => parseRaw(entry, { wire: 'json', args }),
      render: (answer) => formatAnswer(answer, catalogue),
      structured: (answer) => answerJson(answer),
    });
  }
  return specs;
}

export const UNANSWERED_TEXT = 'The answer could not be produced. Please ask again.';

export interface ToolResult {
  content: { type: 'text'; text: string }[];         // exactly one item
  structuredContent?: { [k: string]: Json };         // present exactly when the core gave an answer
  isError: boolean;
}

export interface CallWiring {
  sent: Promise<void>;                 // resolves when this call's response has been sent in full; rejects when the send fails, the call is cancelled or the transport closes first
  closed: Promise<void>;               // settles when the transport closes
  track(work: Promise<unknown>): void; // registers the call's serve promise as in flight
  stderr: NodeJS.WritableStream;
}

const textResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function answerToolCall(
  core: AnsweringCore,
  spec: AssistantToolSpec | undefined,
  toolName: string,
  args: unknown,
  w: CallWiring,
): Promise<ToolResult> {
  if (spec === undefined) return Promise.resolve(textResult(`Unknown tool "${toolName}".`));

  const d = spec.parse(args);
  if (isRefusal(d)) return Promise.resolve(textResult(formatRefusal(d)));

  const question: Question = { ...d, asker: 'assistant' };

  let result: ToolResult | undefined;
  let renderError: { error: unknown } | undefined;
  let written = false;
  let hand!: (r: ToolResult) => void;
  const handed = new Promise<ToolResult>((resolve) => {
    hand = resolve;
  });

  const render = (a: Answer): string => {
    try {
      const text = spec.render(a);
      result = { content: [{ type: 'text', text }], structuredContent: spec.structured(a), isError: isRefusal(a) };
      return text;
    } catch (e) {
      renderError = { error: e };
      throw e;
    }
  };
  const channel: ReplyChannel = {
    write: (_rendered) => {
      written = true;
      hand(result as ToolResult); // always set: the core renders before it writes
      return w.sent;
    },
    closed: w.closed,
  };

  let p: Promise<ServeResult>;
  try {
    p = core.serve(question, render, channel);
  } catch (e) {
    p = Promise.reject(e);
  }
  w.track(p);

  const unanswered = p.then(
    () => (renderError ? renderError.error : new Error('no reply was written')),
    (e: unknown) => e,
  ).then((error) => {
    if (written) return new Promise<ToolResult>(() => {}); // the handed result wins
    w.stderr.write(`${toolName}: ${messageOf(error)}\n`);
    return textResult(UNANSWERED_TEXT);
  });

  return Promise.race([handed, unanswered]);
}
