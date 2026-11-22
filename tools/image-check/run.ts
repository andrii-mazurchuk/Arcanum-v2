// Image check, engine part (S-231): the only module that drives the container engine, run by the
// build definition's `image-check` script. It builds the image from a clean export of the committed
// tree, compares the image's Bun with the pin, and starts the unmodified default command twice; the
// verdicts come from tools/image-check/judge. Every image, container, volume and temporary folder it
// creates carries a name unique to the run and is removed on every exit. Containers get only the
// environment given here with `-e NAME=value`; nothing passes from the caller's environment.

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARED_NAMES, sourceSettingName } from '../../src/config/settings';
import {
  DEPENDS_ON,
  PUSH_PATH,
  START_WAIT_MS,
  STEPS,
  STOP_TIMEOUT_S,
  STORE_FILE,
  type StepName,
  type StepVerdict,
  exitCodeOf,
  judgeBuild,
  judgePinnedBun,
  judgeRefusedStart,
  judgeRunning,
  notRun,
  parsePublishedPort,
  reportLines,
  unknownAccountPush,
} from './judge';

const REPO = join(import.meta.dir, '..', '..');
const POLL_EVERY_MS = 500;
const PUSH_ATTEMPT_TIMEOUT_MS = 2_000;
const CONTAINER_PORT = 8080;

const STORAGE = SHARED_NAMES.storage;
const TOKEN = sourceSettingName('monobank', 'TOKEN');
const BASE_URL = sourceSettingName('monobank', 'BASE_URL');
const PUSH_URL = sourceSettingName('monobank', 'PUSH_URL');

function runName(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `arcanum-imagecheck-${stamp}-${hex}`;
}

const RUN = runName();
const IMAGE = `${RUN}:image`;
const REFUSED = `${RUN}-refused`;
const RUNNING = `${RUN}-running`;
const VOLUME_3 = `${RUN}-v3`;
const VOLUME_4 = `${RUN}-v4`;
const FOLDER = join(tmpdir(), RUN);
const STORE_PATH = `/data/${STORE_FILE}`;

type Outcome = { exitCode: number; stdout: string; stderr: string };

async function exec(cmd: string[], cwd = REPO): Promise<Outcome> {
  const proc = Bun.spawn(cmd, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const env = (name: string, value: string): string[] => ['-e', `${name}=${value}`];

const listVolume = async (volume: string): Promise<string> =>
  (await exec(['docker', 'run', '--rm', '-v', `${volume}:/data`, '--entrypoint', 'ls', IMAGE, '-A', '/data'])).stdout;

// The committed tree, not the working folder: `git archive HEAD` extracted into a fresh folder.
async function exportTree(): Promise<Outcome> {
  mkdirSync(FOLDER, { recursive: true });
  const archive = Bun.spawn(['git', 'archive', '--format=tar', 'HEAD'], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  const extract = Bun.spawn(['tar', '-x', '-f', '-', '-C', FOLDER], { stdin: archive.stdout, stdout: 'pipe', stderr: 'pipe' });
  const [archiveErr, extractErr, archiveExit, extractExit] = await Promise.all([
    new Response(archive.stderr).text(),
    new Response(extract.stderr).text(),
    archive.exited,
    extract.exited,
  ]);
  return { exitCode: archiveExit !== 0 ? archiveExit : extractExit, stdout: '', stderr: archiveErr + extractErr };
}

async function cleanBuild(): Promise<StepVerdict> {
  const exported = await exportTree();
  if (exported.exitCode !== 0) return judgeBuild(exported.exitCode, `export failed:\n${exported.stderr}`);
  const built = await exec(['docker', 'build', '-t', IMAGE, FOLDER]);
  return judgeBuild(built.exitCode, built.stderr);
}

async function pinnedBun(): Promise<StepVerdict> {
  const packageJson = await Bun.file(join(FOLDER, 'package.json')).text();
  const version = await exec(['docker', 'run', '--rm', '--entrypoint', 'bun', IMAGE, '--version']);
  return judgePinnedBun(packageJson, version.stdout);
}

async function refusedStart(): Promise<StepVerdict> {
  await exec(['docker', 'volume', 'create', VOLUME_3]);
  const started = await exec(['docker', 'run', '--name', REFUSED, '-v', `${VOLUME_3}:/data`, ...env(STORAGE, STORE_PATH), IMAGE]);
  return judgeRefusedStart(started.exitCode, started.stderr, await listVolume(VOLUME_3));
}

async function pushOnce(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${PUSH_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: unknownAccountPush(),
      signal: AbortSignal.timeout(PUSH_ATTEMPT_TIMEOUT_MS),
    });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return null;
  }
}

async function runningStartStop(): Promise<StepVerdict> {
  await exec(['docker', 'volume', 'create', VOLUME_4]);
  const startedAt = performance.now();
  await exec([
    'docker', 'run', '-d', '--name', RUNNING, '-v', `${VOLUME_4}:/data`, '-p', `127.0.0.1::${CONTAINER_PORT}`,
    ...env(STORAGE, STORE_PATH),
    ...env(TOKEN, 'image-check-placeholder'),
    ...env(BASE_URL, 'http://127.0.0.1:9'),
    ...env(PUSH_URL, `http://127.0.0.1:${CONTAINER_PORT}${PUSH_PATH}`),
    IMAGE,
  ]);
  const port = parsePublishedPort((await exec(['docker', 'port', RUNNING, `${CONTAINER_PORT}/tcp`])).stdout);
  if (port === null) return { step: 'running-start-stop', status: 'fail', detail: 'no published port' };

  let ackStatus: number | null = null;
  while (performance.now() - startedAt < START_WAIT_MS) {
    const status = await pushOnce(port);
    if (status !== null) ackStatus = status;
    if (status === 200) break;
    await Bun.sleep(POLL_EVERY_MS);
  }

  await exec(['docker', 'stop', '--time', String(STOP_TIMEOUT_S), RUNNING]);
  const inspected = await exec(['docker', 'inspect', '--format', '{{.State.ExitCode}}', RUNNING]);
  const code = inspected.exitCode === 0 && /^\d+$/.test(inspected.stdout.trim()) ? Number(inspected.stdout.trim()) : null;
  return judgeRunning(ackStatus, code, await listVolume(VOLUME_4));
}

const STEP_RUNNERS: { readonly [K in StepName]: () => Promise<StepVerdict> } = {
  'clean-build': cleanBuild,
  'pinned-bun': pinnedBun,
  'refused-start': refusedStart,
  'running-start-stop': runningStartStop,
};

// Removes everything the run created, ignoring 'no such' errors; synchronous so a signal handler
// can finish it before exiting.
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  const quiet = { cwd: REPO, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' } as const;
  Bun.spawnSync(['docker', 'rm', '-f', REFUSED, RUNNING], quiet);
  Bun.spawnSync(['docker', 'volume', 'rm', '-f', VOLUME_3, VOLUME_4], quiet);
  Bun.spawnSync(['docker', 'rmi', '-f', IMAGE], quiet);
  try {
    rmSync(FOLDER, { recursive: true, force: true });
  } catch {
    // already gone
  }
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(code);
  });
}
process.on('exit', cleanup);

async function main(): Promise<0 | 1> {
  const verdicts: StepVerdict[] = [];
  for (const step of STEPS) {
    const failed = DEPENDS_ON[step].find((dep) => verdicts.find((v) => v.step === dep)?.status !== 'pass');
    if (failed !== undefined) {
      verdicts.push(notRun(step, failed));
      continue;
    }
    try {
      verdicts.push(await STEP_RUNNERS[step]());
    } catch (err) {
      verdicts.push({ step, status: 'fail', detail: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  for (const line of reportLines(verdicts)) console.log(line);
  return exitCodeOf(verdicts);
}

let exitCode: 0 | 1 = 1;
try {
  exitCode = await main();
} finally {
  cleanup();
}
process.exit(exitCode);
