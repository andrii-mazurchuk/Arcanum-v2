// Image check, pure part (S-231): the step plan, the constants the run uses, and the verdict of each
// step over the container engine's recorded outputs. It drives no engine and reads no file, network
// or clock, so the suite judges it without a container engine; tools/image-check/run does the calls.

import { sourceSettingName } from '../../src/config/settings';
import { checkPinnedBun } from '../../src/release/pinned-bun';
import { SETTINGS_REFUSAL_EXIT } from '../../src/start-gate';

export type StepName = 'clean-build' | 'pinned-bun' | 'refused-start' | 'running-start-stop';
export const STEPS: readonly StepName[] = ['clean-build', 'pinned-bun', 'refused-start', 'running-start-stop'];
export const DEPENDS_ON: { readonly [K in StepName]: readonly StepName[] } = {
  'clean-build': [],
  'pinned-bun': ['clean-build'],
  'refused-start': ['clean-build'],
  'running-start-stop': ['clean-build'],
};
export type StepVerdict = { step: StepName; status: 'pass' | 'fail' | 'not-run'; detail: string };

export const STORE_FILE = 'arcanum.db'; // the store file under /data, as the run definition names it
export const START_WAIT_MS = 30_000; // bound for the push receiver to acknowledge
export const STOP_TIMEOUT_S = 30; // `docker stop --time`, the engine's wait before a kill
export const PUSH_PATH = '/image-check-push';
export const UNKNOWN_ACCOUNT = 'image-check-unknown-account';

const STDERR_TAIL_LINES = 20;
const KILLED_EXIT = 137;

const nonBlankLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

const verdict = (step: StepName, failures: string[], passDetail: string): StepVerdict =>
  failures.length === 0
    ? { step, status: 'pass', detail: passDetail }
    : { step, status: 'fail', detail: failures.join('; ') };

export function judgeBuild(exitCode: number, stderr: string): StepVerdict {
  if (exitCode === 0) return { step: 'clean-build', status: 'pass', detail: 'image built' };
  const tail = String(stderr).replace(/\s+$/, '').split(/\r?\n/).slice(-STDERR_TAIL_LINES).join('\n');
  return { step: 'clean-build', status: 'fail', detail: `build exited ${exitCode}:\n${tail}` };
}

export function judgePinnedBun(packageJsonText: string, versionStdout: string): StepVerdict {
  const reported = String(versionStdout).trim();
  const result = checkPinnedBun(String(packageJsonText), reported);
  const detail = `pinned ${result.pinned ?? '(none)'}, image ${reported}`;
  return { step: 'pinned-bun', status: result.ok ? 'pass' : 'fail', detail };
}

export function judgeRefusedStart(exitCode: number, stderr: string, volumeListing: string): StepVerdict {
  const token = sourceSettingName('monobank', 'TOKEN');
  const failures: string[] = [];
  if (exitCode !== SETTINGS_REFUSAL_EXIT) failures.push(`exit code ${exitCode}, expected ${SETTINGS_REFUSAL_EXIT}`);
  if (!String(stderr).includes(token)) failures.push(`stderr does not name ${token}`);
  const files = nonBlankLines(String(volumeListing));
  if (files.length > 0) failures.push(`volume not empty: ${files.join(', ')}`);
  return verdict('refused-start', failures, `refused with exit ${SETTINGS_REFUSAL_EXIT} naming ${token}, volume empty`);
}

export function parsePublishedPort(dockerPortStdout: string): number | null {
  for (const line of String(dockerPortStdout).split('\n')) {
    const m = /:(\d+)\s*$/.exec(line);
    if (m) {
      const port = Number(m[1]);
      return port >= 1 && port <= 65535 ? port : null;
    }
  }
  return null;
}

export function judgeRunning(ackStatus: number | null, exitCode: number | null, volumeListing: string): StepVerdict {
  const failures: string[] = [];
  if (ackStatus === null) failures.push(`no acknowledgement within ${START_WAIT_MS} ms`);
  else if (ackStatus !== 200) failures.push(`push answered ${ackStatus}, expected 200`);
  if (exitCode === KILLED_EXIT) failures.push(`exit code ${KILLED_EXIT}: killed after the ${STOP_TIMEOUT_S} s stop timeout`);
  else if (exitCode === null) failures.push('no exit code');
  else if (exitCode !== 0) failures.push(`exit code ${exitCode}, expected 0`);
  const files = nonBlankLines(String(volumeListing));
  if (!files.includes(STORE_FILE)) failures.push(`volume lacks ${STORE_FILE}`);
  const others = files.filter((f) => f !== STORE_FILE && !f.startsWith(`${STORE_FILE}-`));
  if (others.length > 0) failures.push(`volume holds other files: ${others.join(', ')}`);
  return verdict('running-start-stop', failures, `push acknowledged, stopped with exit 0, volume ${files.join(', ')}`);
}

export function notRun(step: StepName, failed: StepName): StepVerdict {
  return { step, status: 'not-run', detail: `not run: ${failed} failed` };
}

const LABEL: { readonly [K in StepVerdict['status']]: string } = { pass: 'PASS', fail: 'FAIL', 'not-run': 'NOT RUN' };

export function reportLines(verdicts: readonly StepVerdict[]): string[] {
  return verdicts.map((v) => `${LABEL[v.status]} ${v.step}: ${v.detail}`);
}

export function exitCodeOf(verdicts: readonly StepVerdict[]): 0 | 1 {
  return verdicts.length === STEPS.length && verdicts.every((v) => v.status === 'pass') ? 0 : 1;
}

export function unknownAccountPush(): string {
  return JSON.stringify({
    type: 'StatementItem',
    data: {
      account: UNKNOWN_ACCOUNT,
      statementItem: {
        id: 'image-check-1',
        time: 1767225600,
        description: 'image check',
        mcc: 5411,
        originalMcc: 5411,
        hold: false,
        amount: -100,
        operationAmount: -100,
        currencyCode: 980,
        commissionRate: 0,
        cashbackAmount: 0,
        balance: 0,
      },
    },
  });
}
