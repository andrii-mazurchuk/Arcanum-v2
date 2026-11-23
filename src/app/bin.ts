// Process entry executable (S-228): every product process starts here as `<word> ...`. The one
// product module that reads the process environment and arguments; everything else receives them
// through main, settings as the record and host variables as ctx.host. It sets the exit code
// rather than calling exit, so buffered output is flushed.

import { releaseCheck } from '../release/check';
import { type ProcessIo, type Starters, main } from './main';
import { BUILT_GROUPS } from './sources';
import { PRODUCT_STARTERS } from './starters';

const STARTERS: Starters = { ...PRODUCT_STARTERS, releaseCheck };

const stdio: ProcessIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (line) => void process.stderr.write(`${line}\n`),
};

process.exitCode = await main(process.argv.slice(2), process.env, BUILT_GROUPS, STARTERS, stdio);
