// Command-line question front end entry (S-191): handed the settings record, the uncalled opener,
// the family list and the catalogue by the process entry, it owns the command from there on. It
// checks the families against the catalogue, looks the command up, parses, checks the storage
// location (its one settings gate), opens the existing local copy, asks once and closes the store,
// stopping at the first refusal. It imports no family module and not the composition root.

import type { SettingsRecord } from '../config/settings';
import type { Family } from '../core/question';
import { isRefusal } from '../core/primitives';
import { checkStart } from '../start-gate';
import { catalogueFaults, commandUsage, parseRaw, type Catalogue, type CatalogueEntry } from './catalogue';
import {
  EXIT_ANSWERED, EXIT_REFUSED, EXIT_USAGE, EXIT_WIRING, isOpenRefusal, type AnsweringOpener,
  type OpenedAnswering, type OpenRefusal,
} from './handoff';
import { askAtCommandLine } from './question-ask';
import { formatOpenRefusal, formatRefusal } from './render';

export interface QuestionFrontEndInput {
  record: SettingsRecord;
  open: AnsweringOpener;            // uncalled
  families: readonly Family[];      // the composition's one family list, the same the opener registers
  catalogue: Catalogue;
  argv: readonly string[];          // [command, ...args], after whatever the process entry dispatched on
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

// Entries with a command whose family is handed, in catalogue order; 'new_since_last_asked' has none.
export function commandEntries(families: readonly Family[], catalogue: Catalogue): readonly CatalogueEntry[] {
  const names = new Set(families.map((f) => f.name));
  return catalogue.filter((e) => e.command !== null && names.has(e.family));
}

// Writes one chunk, resolving once the stream has taken it; a failed write has nowhere to be told.
function put(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      stream.write(text, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function lines(stream: NodeJS.WritableStream, texts: readonly string[]): Promise<void> {
  for (const t of texts) await put(stream, t + '\n');
}

export async function runQuestionFrontEnd(input: QuestionFrontEndInput): Promise<number> {
  const { record, open, families, catalogue, argv, stdout, stderr } = input;

  // 0. Wiring: every handed family has a catalogue entry.
  const faults = catalogueFaults(families.map((f) => f.name), catalogue);
  if (faults.length > 0) {
    await lines(stderr, faults);
    return EXIT_WIRING;
  }

  // 1. Parse: nothing here reads a setting or the store.
  const entries = commandEntries(families, catalogue);
  const commands = 'Commands: ' + entries.map((e) => e.command).join(', ') + '.';
  if (argv.length === 0) {
    await lines(stderr, ['No command given. ' + commands]);
    return EXIT_USAGE;
  }
  const entry = entries.find((e) => e.command === argv[0]);
  if (!entry) {
    await lines(stderr, ['Unknown command "' + argv[0] + '". ' + commands]);
    return EXIT_USAGE;
  }
  const args = argv.slice(1);
  if (args.length === 1 && args[0] === '--help') {
    await put(stdout, commandUsage(entry) + '\n');
    return EXIT_ANSWERED;
  }
  const draft = parseRaw(entry, { wire: 'argv', args });
  if (isRefusal(draft)) {
    await lines(stderr, [formatRefusal(draft)]);
    return EXIT_USAGE;
  }

  // 2. Settings: the storage location only, the question command's one gate.
  const verdict = checkStart({ kind: 'question' }, record);
  if (!verdict.ok) {
    await lines(stderr, verdict.lines);
    return EXIT_REFUSED;
  }

  // 3. Open the existing local copy.
  let o: OpenedAnswering | OpenRefusal;
  try {
    o = open();
  } catch (e) {
    await lines(stderr, [e instanceof Error ? e.message : String(e)]);
    return EXIT_WIRING;
  }
  if (isOpenRefusal(o)) {
    await lines(stderr, [formatOpenRefusal(o)]);
    return EXIT_REFUSED;
  }

  // 4. Ask once; 5. close on every path before the code is returned.
  try {
    return await askAtCommandLine(o.core, draft, catalogue, stdout, stderr);
  } finally {
    o.close();
  }
}
