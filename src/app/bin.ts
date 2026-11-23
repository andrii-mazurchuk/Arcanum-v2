// Process entry executable (S-228): every product process starts here as `<word> ...`. The one
// product module that reads the process environment and arguments; everything else receives them
// through main, settings as the record and host variables as ctx.host. It sets the exit code
// rather than calling exit, so buffered output is flushed.
//
// The starters and the release check are reached by dynamic import() inside the command dispatch,
// after settings load and the start gate (spec ruling iss-1732/1733): a refused start needs no
// command module, and the entry does not depend on units built after it.

import { type CommandStarter, type ProcessIo, type Starters, main } from './main';
import { BUILT_GROUPS } from './sources';

const lazy = (load: () => Promise<CommandStarter>): CommandStarter => async (ctx) => (await load())(ctx);
const product = (name: Exclude<keyof Starters, 'releaseCheck'>) =>
  lazy(async () => (await import('./starters')).PRODUCT_STARTERS[name]);

const STARTERS: Starters = {
  service: product('service'),
  assistant: product('assistant'),
  question: product('question'),
  backfill: product('backfill'),
  releaseCheck: lazy(async () => (await import('../release/check')).releaseCheck),
};

const stdio: ProcessIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (line) => void process.stderr.write(`${line}\n`),
};

process.exitCode = await main(process.argv.slice(2), process.env, BUILT_GROUPS, STARTERS, stdio);
