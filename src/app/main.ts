// Entry logic (S-249): loads settings once from the groups it is handed, picks the command
// by its first word, runs the start gate itself only for the service, backfill and release-check
// commands, and hands the record and the host variables to that command's starter. The assistant
// (stdio and HTTP) and question commands go ungated to their front ends, which run their own gate
// after their parse.
// Only app/bin calls main; it alone reads the environment and the arguments.

import type { SourceId } from '../core/primitives';
import { type SettingsRecord, type SourceSettingsGroup, loadSettings } from '../config/settings';
import { type EntryGateTarget, runGated } from '../start-gate';

export const USAGE_EXIT = 2;
export const STARTER_FAILURE_EXIT = 1;
export const HOST_VARIABLES = ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT'] as const;

type Env = Readonly<Record<string, string | undefined>>;

// What a child product needs from the host to start; not settings, never parsed by the product.
export function hostVariables(env: Env): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of HOST_VARIABLES) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return Object.freeze(out);
}

export interface ProcessIo { stdout(text: string): void; stderr(line: string): void }
export interface StartContext {
  record: SettingsRecord;          // the command's one record
  sources: readonly SourceId[];    // the gate's verdict for a gated command; [] for the assistant and question commands
  args: readonly string[];         // the arguments after the command word (after the source id for backfill; the whole argv for a question)
  host: Readonly<Record<string, string>>; // hostVariables(env): what a child product needs from the host to start
  io: ProcessIo;
}
export type CommandStarter = (ctx: StartContext) => Promise<number>; // resolves the command's exit code
export interface Starters {
  service: CommandStarter; assistant: CommandStarter; assistantHttp: CommandStarter; question: CommandStarter;
  backfill: CommandStarter; releaseCheck: CommandStarter;
}

const BACKFILL_USAGE = 'usage: backfill <source> <YYYY-MM-DD..YYYY-MM-DD> | --all';

type Dispatch =
  | { gated: true; target: EntryGateTarget; starter: CommandStarter; args: readonly string[] }
  | { gated: false; starter: CommandStarter; args: readonly string[] };

export async function main(
  argv: readonly string[],                                // the command-line arguments after the script path
  env: Env,
  groups: readonly SourceSettingsGroup[],
  starters: Starters,
  io: ProcessIo,
): Promise<number> {
  const record = loadSettings(env, groups);
  const host = hostVariables(env);

  let dispatch: Dispatch;
  switch (argv[0]) {
    case 'service':
      dispatch = { gated: true, target: { kind: 'service' }, starter: starters.service, args: argv.slice(1) };
      break;
    case 'release-check':
      dispatch = { gated: true, target: { kind: 'release-check' }, starter: starters.releaseCheck, args: argv.slice(1) };
      break;
    case 'backfill': {
      const sourceId = argv[1];
      if (sourceId === undefined) {
        io.stderr(BACKFILL_USAGE);
        return USAGE_EXIT;
      }
      dispatch = { gated: true, target: { kind: 'backfill', sourceId }, starter: starters.backfill, args: argv.slice(2) };
      break;
    }
    case 'mcp':
      dispatch = { gated: false, starter: starters.assistant, args: argv.slice(1) };
      break;
    case 'mcp-http':
      // The HTTP assistant connection (S-248).
      dispatch = { gated: false, starter: starters.assistantHttp, args: argv.slice(1) };
      break;
    default:
      // The question front end parses the whole argv and reports its own usage refusal.
      dispatch = { gated: false, starter: starters.question, args: argv };
  }

  const { starter, args } = dispatch;
  try {
    if (dispatch.gated) {
      return await runGated(dispatch.target, record, (line) => io.stderr(line), (sources) => starter({ record, sources, args, host, io }));
    }
    return await starter({ record, sources: [], args, host, io });
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return STARTER_FAILURE_EXIT;
  }
}
