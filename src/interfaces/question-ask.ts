// Command-line ask (S-180): the one parsed draft, stamped 'command_line' here and nowhere else in a
// question process, served once through the core with the shared formatter. A core refusal's text
// goes to standard error and an answer's to standard output, never both; the exit code says which.

import type { AnsweringCore, ReplyChannel } from '../core/core';
import { isRefusal } from '../core/primitives';
import type { Answer, Question, QuestionDraft } from '../core/question';
import type { Catalogue } from './catalogue';
import { EXIT_ANSWERED, EXIT_REFUSED } from './handoff';
import { formatAnswer } from './render';

export const UNDELIVERED_LINE = 'The answer could not be written to standard output.';

// Writes one chunk, resolving in its callback and rejecting on its error.
function writeTo(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      stream.write(text, (e?: Error | null) => (e ? reject(e) : resolve()));
    } catch (e) {
      reject(e);
    }
  });
}

// A closing line of this process's own: its failure has nowhere left to be told, so it never rejects.
function sayLine(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return writeTo(stream, text + '\n').catch(() => undefined);
}

export async function askAtCommandLine(core: AnsweringCore, draft: QuestionDraft, catalogue: Catalogue,
  stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): Promise<number> {
  const question: Question = { ...draft, asker: 'command_line' };
  let refused = false; // set by render, before the core writes
  const render = (a: Answer): string => {
    refused = isRefusal(a);
    return formatAnswer(a, catalogue);
  };
  let onError = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    onError = () => resolve();
  });
  // Left attached: a stream's 'error' can follow its failed write's callback, and one ask is a process.
  stdout.on('error', onError);
  stderr.on('error', onError);
  const channel: ReplyChannel = {
    write: (text) => writeTo(refused ? stderr : stdout, text + '\n'),
    closed,
  };
  try {
    const r = await core.serve(question, render, channel);
    if (isRefusal(r.answer)) return EXIT_REFUSED; // its line went to stderr through the channel
    if (r.delivery === 'delivered') return EXIT_ANSWERED;
    await sayLine(stderr, UNDELIVERED_LINE);
    return EXIT_REFUSED;
  } catch (e) {
    await sayLine(stderr, e instanceof Error ? e.message : String(e));
    return EXIT_REFUSED;
  }
}
