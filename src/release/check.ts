// Release check (S-239): the one command that tells the holder whether every promise holds, without
// real credentials. One orchestrating run in a temporary folder: the stand-ins serve the run's
// dataset on loopback, the product runs only as separate processes started through the spawn helper
// with one explicit environment, and phases P1 to P7 run in order, each starting when the previous
// one's waits ended. It writes one verdict line per promise on standard output, progress on standard
// error, and cleans up on every exit path. It reads no environment: a child's host variables come as
// ctx.host.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandStarter, StartContext } from '../app/main';
import { ANSWER_CATALOGUE } from '../app/starters';
import type { Json } from '../interfaces/render';
import { ANSWER_BOUND_MS, type AskResult, type AssistantConnection, connectAssistant, coverageOf } from './assistant';
import { type Dataset, FIRST_FILL_DAYS, type MonoTxn, RUN_LIMIT_MS, buildDataset, localDate, marker } from './dataset';
import {
  type CommandLineAsk,
  PROMISES,
  type PromiseKey,
  type Verdict,
  backfillAlongside,
  expectedNetPosition,
  fixtureMarkers,
  holdingNameFor,
  judgeAnswerBound,
  judgeBackfill,
  judgeFixture,
  judgeInterfaceText,
  judgeNarrowedToSecond,
  judgeNewPages,
  judgeRateLimits,
  judgeSingleMachine,
  maskedDifference,
  olderMarkers,
  servedText,
} from './judges';
import { type ProductProcess, spawnProduct } from './spawn';
import {
  MONOBANK_STAND_IN_LIMITS,
  type MonobankStandIn,
  SECOND_STAND_IN_LIMITS,
  type StandIn,
  startMonobankStandIn,
  startSecondStandIn,
} from './stand-ins';
import { POLL_INTERVAL_MS, covers, monobankJobCalls, secondJobCalls, spacingMs, waitDeadlineMs, waitFor } from './waits';

export const STOP_BOUND_MS = 120_000; // a stopped service must exit within this, else it is killed; where signal steps apply, the step fails

export type SignalStep = 'P4 stop before restart' | 'P6 stop before switch-on' | 'P7 stop';
export const SIGNAL_STEPS: readonly SignalStep[] = ['P4 stop before restart', 'P6 stop before switch-on', 'P7 stop'];

export function signalStepsApplicable(platform: string): boolean {
  return platform !== 'win32';
}

const KILL_AFTER_MS = 10_000;
const RUN_LIMIT_TEXT = 'run reached 11 hours (harness fault)';
const NEW_FAMILY = 'new_since_last_asked';
const RATES_FAMILY = 'exchange_rates';
const PERIOD_FAMILIES = new Set(['transaction_search', 'spending_breakdown', 'foreign_spending', 'behaviour_patterns']);
const NEW_PAGE_LIMIT = 100; // pages of one 'new' drain before it is given up

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Resolves with p's value, or with undefined once ms have passed.
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

// --- settings and report -----------------------------------------------------------------------

export function productSettings(p: {
  folder: string;
  zone: string;
  pushPort: number;
  monobankBase: string;
  token: string;
  secret: string;
  second?: { base: string; token: string };
}): Record<string, string> {
  const settings: Record<string, string> = {
    ARCANUM_STORAGE: `${p.folder}/arcanum.db`,
    ARCANUM_FIRST_FILL_DAYS: String(FIRST_FILL_DAYS),
    ARCANUM_POLL_MINUTES: '1',
    ARCANUM_PUSH_PORT: String(p.pushPort),
    ARCANUM_TIME_ZONE: p.zone,
    ARCANUM_MONOBANK_ENABLED: 'on',
    ARCANUM_MONOBANK_BASE_URL: p.monobankBase,
    ARCANUM_MONOBANK_TOKEN: p.token,
    ARCANUM_MONOBANK_PUSH_URL: `http://127.0.0.1:${p.pushPort}`,
    ARCANUM_MONOBANK_PUSH_SECRET: p.secret,
  };
  if (p.second !== undefined) {
    settings.ARCANUM_SECOND_ENABLED = 'on';
    settings.ARCANUM_SECOND_BASE_URL = p.second.base;
    settings.ARCANUM_SECOND_TOKEN = p.second.token;
  }
  return settings;
}

export function verdictLines(
  verdicts: ReadonlyMap<PromiseKey, Verdict>,
  notApplicable?: readonly SignalStep[],
): { lines: string[]; exitCode: 0 | 1 } {
  const lines: string[] = [];
  const na = new Set(notApplicable ?? []);
  for (const step of SIGNAL_STEPS) {
    if (na.has(step)) lines.push(`N/A ${step}: termination signal not applicable on this host (promised on POSIX hosts only)`);
  }
  const failed: string[] = [];
  for (const { key, title } of PROMISES) {
    const v = verdicts.get(key) ?? { pass: false, observed: ['not judged'] };
    if (v.pass) {
      lines.push(`PASS ${title}`);
    } else {
      lines.push(`FAIL ${title}: ${v.observed.join('; ')}`);
      failed.push(title);
    }
  }
  lines.push(failed.length === 0 ? 'overall: pass' : `overall: fail: ${failed.join(', ')}`);
  return { lines, exitCode: failed.length === 0 ? 0 : 1 };
}

// --- interface questions -----------------------------------------------------------------------

export interface InterfaceQuestion {
  readonly question: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
}

export function interfaceQuestions(ds: Dataset): readonly InterfaceQuestion[] {
  const m = marker(ds.runId, 2);
  const today = localDate(ds.t0, ds.zone);
  const month = `${today.slice(0, 7)}-01..${today}`;
  return [
    { question: 'balance', tool: 'balance', args: {}, argv: ['balance'] },
    {
      question: 'search',
      tool: 'transaction_search',
      args: { text: m, period: ds.allPeriod },
      argv: ['search', '--text', m, '--period', ds.allPeriod],
    },
    { question: 'breakdown', tool: 'spending_breakdown', args: { period: month }, argv: ['breakdown', '--period', month] },
  ];
}

// --- product processes -------------------------------------------------------------------------

// Every product process still running, whichever run or helper started it; cleanup stops them all.
const LIVE = new Set<ProductProcess>();

function track(p: ProductProcess): ProductProcess {
  LIVE.add(p);
  void p.exited.then(
    () => LIVE.delete(p),
    () => LIVE.delete(p),
  );
  return p;
}

async function stopProcesses(): Promise<void> {
  const running = [...LIVE];
  for (const p of running) {
    try {
      p.signal('SIGTERM');
    } catch {
      // Already gone.
    }
  }
  const all = Promise.all(running.map((p) => p.exited.catch(() => null)));
  if ((await within(all, KILL_AFTER_MS)) !== undefined) return;
  for (const p of running) {
    if (!LIVE.has(p)) continue;
    try {
      p.signal('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  await within(all, KILL_AFTER_MS);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  try {
    return await new Response(stream).text();
  } catch {
    return '';
  }
}

// Calls line for every complete line of the stream, and for the rest once it ends.
async function eachLine(stream: ReadableStream<Uint8Array>, line: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let rest = '';
  try {
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const part of parts) line(part);
    }
    rest += decoder.decode();
  } catch {
    // A stream that errors ends where it is.
  }
  if (rest !== '') line(rest);
}

export async function runCommandLine(
  argv: readonly string[],
  settings: Readonly<Record<string, string>>,
  host: Readonly<Record<string, string>>,
  boundMs: number,
): Promise<CommandLineAsk> {
  const begun = performance.now();
  const p = track(spawnProduct(argv, settings, host));
  const stdout = readAll(p.stdout);
  void readAll(p.stderr);
  let code: number | null = (await within(p.exited, boundMs)) ?? null;
  let elapsedMs = performance.now() - begun;
  if (code === null) {
    p.signal('SIGKILL');
    await p.exited;
    elapsedMs = performance.now() - begun;
    code = null;
  }
  return { argv: [...argv], exitCode: code, elapsedMs, stdout: await stdout };
}

// --- the run -----------------------------------------------------------------------------------

class HarnessFault extends Error {}
class Stopped extends Error {}

type JsonObject = { [k: string]: Json };
const isObject = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

function at(v: Json | undefined, ...keys: string[]): Json | undefined {
  let cur = v;
  for (const k of keys) {
    if (!isObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

interface Row {
  sourceId: string;
  bankId: string;
  holdingId: string;
  description: string;
  amount: string;
  currency: string;
  category: Json;
  merchant: Json;
}

// The listed rows of a search or 'new' answer value.
function listedRows(value: Json): Row[] {
  const rows = at(value, 'outcome', 'body', 'rows');
  if (!Array.isArray(rows)) return [];
  return rows.filter(isObject).map((r) => ({
    sourceId: String(r.sourceId),
    bankId: String(r.bankId),
    holdingId: String(r.holdingId),
    description: String(r.description),
    amount: String(at(r, 'amount', 'amount')),
    currency: String(at(r, 'amount', 'currency')),
    category: r.category ?? null,
    merchant: r.merchant ?? null,
  }));
}

function balanceLines(value: Json): JsonObject[] {
  const lines = [at(value, 'outcome', 'body', 'accounts'), at(value, 'outcome', 'body', 'jars')];
  return lines.flatMap((l) => (Array.isArray(l) ? l.filter(isObject) : []));
}

const MONO_CURRENCY: Readonly<Record<number, string>> = { 980: 'UAH', 840: 'USD' };

interface Phase {
  readonly name: string;
  readonly serves: readonly PromiseKey[];
}

const PHASES = {
  P1: { name: 'P1 start', serves: ['complete_and_current'] },
  P2: { name: 'P2 push end to end', serves: ['complete_and_current', 'local_copy_only', 'exact_money'] },
  P3: { name: 'P3 lost notification', serves: ['complete_and_current'] },
  P4: {
    name: 'P4 restart and backfill',
    serves: ['complete_and_current', 'local_copy_only', 'rate_limits', 'exact_money'],
  },
  P5: { name: 'P5 unreachable', serves: ['local_copy_only'] },
  P6: {
    name: 'P6 source switch-on',
    serves: ['source_touches_only_itself', 'complete_and_current', 'exact_money', 'local_copy_only'],
  },
  P7: { name: 'P7 stop', serves: ['complete_and_current', 'local_copy_only'] },
} as const satisfies Record<string, Phase>;

const ALL_PROMISES: readonly PromiseKey[] = PROMISES.map((p) => p.key);

interface Child {
  readonly label: string;
  readonly p: ProductProcess;
  bidden: boolean;
  exitCode: number | null; // null while running
  lastStderr: string;
}

function randomRunId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => String.fromCharCode(97 + (b % 26))).join('');
}

async function freeLoopbackPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = server.port!;
  await server.stop(true);
  return port;
}

export const releaseCheck: CommandStarter = async (ctx: StartContext) => {
  const io = ctx.io;
  const host = ctx.host;
  const applicable = signalStepsApplicable(process.platform);
  const t0 = Math.floor(Date.now() / 1000) * 1000;
  const runId = randomRunId();
  const ds = buildDataset(t0, runId);
  const token = `stand-in-${runId}`;
  const secret = runId + runId;

  const observed = new Map<PromiseKey, string[]>(ALL_PROMISES.map((k) => [k, []]));
  const notApplicable: SignalStep[] = [];
  const fail = (keys: readonly PromiseKey[], ...texts: string[]) => {
    for (const k of keys) observed.get(k)!.push(...texts);
  };
  const progress = (line: string) => io.stderr(line);

  let folder: string | null = null;
  let mono: MonobankStandIn | null = null;
  let second: StandIn | null = null;
  let stopped = false;
  const stopController = new AbortController();

  let cleaning: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    if (cleaning !== null) return cleaning;
    stopped = true;
    stopController.abort();
    cleaning = (async () => {
      await stopProcesses();
      for (const s of [mono, second]) {
        try {
          await s?.close();
        } catch {
          // Already closed.
        }
      }
      if (folder !== null) {
        try {
          rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        } catch (e) {
          io.stderr(`cleanup: could not remove ${folder}: ${message(e)}`);
        }
      }
    })();
    return cleaning;
  };

  const onSignal = (sig: 'SIGINT' | 'SIGTERM') => {
    io.stderr(`release check: ${sig} received, cleaning up`);
    void cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  };
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  // Every sleep of the run wakes early, as a Stopped error, once the run stops.
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (stopController.signal.aborted) return reject(new Stopped('run stopped'));
      const timer = setTimeout(() => {
        stopController.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Stopped('run stopped'));
      };
      stopController.signal.addEventListener('abort', onAbort, { once: true });
    });

  // --- the run's product processes ---

  let currentPhase: Phase = { name: 'start', serves: ALL_PROMISES };
  let pushPort = 0;
  const settingsFor = (withSecond: boolean) =>
    productSettings({
      folder: folder!,
      zone: ds.zone.name,
      pushPort,
      monobankBase: mono!.baseAddress,
      token,
      secret,
      ...(withSecond ? { second: { base: second!.baseAddress, token } } : {}),
    });

  const startChild = (label: string, argv: readonly string[], settings: Record<string, string>, stdin?: 'pipe'): Child => {
    if (stopped) throw new Stopped('run stopped');
    let p: ProductProcess;
    try {
      p = track(spawnProduct(argv, settings, host, stdin ? { stdin } : undefined));
    } catch (e) {
      throw new HarnessFault(`${label} process did not start: ${message(e)} (harness fault)`);
    }
    const child: Child = { label, p, bidden: false, exitCode: null, lastStderr: '' };
    void p.exited.then((code) => {
      child.exitCode = code;
      if (child.bidden || stopped) return;
      const phase = currentPhase;
      const last = child.lastStderr === '' ? '' : `; last stderr line: ${child.lastStderr}`;
      fail(phase.serves, `${phase.name}: ${label} exited unbidden with code ${code}${last} (harness fault)`);
    });
    return child;
  };

  let service: Child | null = null;
  const startService = (withSecond: boolean): number => {
    const startedAt = Date.now();
    const child = startChild('service', ['service'], settingsFor(withSecond));
    void readAll(child.p.stdout);
    void eachLine(child.p.stderr, (line) => {
      if (line.trim() !== '') child.lastStderr = line.trim();
    });
    service = child;
    progress(`${currentPhase.name}: service started (pid ${child.p.pid})`);
    return startedAt;
  };

  // A sleep for waits on the service: a service that exited unbidden ends the wait as a harness fault.
  const serviceSleep = async (ms: number) => {
    await sleep(ms);
    if (service === null || (service.exitCode !== null && !service.bidden)) {
      throw new HarnessFault(`${currentPhase.name}: the service is not running (harness fault)`);
    }
  };

  const requireService = () => {
    if (service === null || service.exitCode !== null) {
      throw new HarnessFault(`${currentPhase.name}: the service is not running (harness fault)`);
    }
  };

  interface Connection extends AssistantConnection {
    child: Child;
  }

  const openConnection = async (withSecond: boolean): Promise<Connection> => {
    const child = startChild('assistant connection', ['mcp'], settingsFor(withSecond), 'pipe');
    child.bidden = true; // an exit while connecting is the connect failure below, named once
    try {
      const conn = await connectAssistant(child.p);
      if (child.exitCode !== null) throw new Error(`exited with code ${child.exitCode} right after connecting`);
      child.bidden = false;
      return Object.assign(conn, { child });
    } catch (e) {
      throw new HarnessFault(`assistant connection could not connect: ${message(e)} (harness fault)`);
    }
  };

  const closeConnection = async (conn: Connection | null) => {
    if (conn === null) return;
    conn.child.bidden = true;
    const code = await within(conn.close(), KILL_AFTER_MS);
    if (code === undefined) {
      conn.child.p.signal('SIGKILL');
      await conn.child.p.exited;
    }
  };

  // The signal step: SIGTERM, then SIGKILL past STOP_BOUND_MS; judged only where signal steps apply.
  const signalStep = async (step: SignalStep, keys: readonly PromiseKey[]) => {
    const s = service;
    service = null;
    if (!applicable) notApplicable.push(step);
    if (s === null || s.exitCode !== null) {
      fail(keys, `${step}: the service is not running (harness fault)`);
      return;
    }
    s.bidden = true;
    progress(`${step}: termination signal to the service`);
    s.p.signal('SIGTERM');
    const code = await within(s.p.exited, STOP_BOUND_MS);
    if (code === undefined) {
      s.p.signal('SIGKILL');
      await s.p.exited;
    }
    progress(`${step}: service ${code === undefined ? `killed after ${STOP_BOUND_MS} ms` : `exited with code ${code}`}`);
    if (!applicable) return;
    if (code === undefined) fail(keys, `${step}: the service did not exit within ${STOP_BOUND_MS} ms`);
    else if (code !== 0) fail(keys, `${step}: the service exited with code ${code}, expected 0`);
  };

  // --- asking ---

  const scopeOf = (args: Readonly<Record<string, unknown>>) =>
    typeof args.narrowing === 'string' ? args.narrowing : 'combined';

  // The answer value of an ask that answered without refusal; otherwise null, the failure kept under keys.
  const valueOf = (r: AskResult, what: string, keys: readonly PromiseKey[]): JsonObject | null => {
    if (r.kind === 'failed') {
      fail(keys, `${what}: ${r.reason}`);
      return null;
    }
    if (r.refused) {
      fail(keys, `${what}: refused: ${r.text}`);
      return null;
    }
    return r.value;
  };

  const baseArgs = (tool: string): Record<string, string> => (PERIOD_FAMILIES.has(tool) ? { period: ds.allPeriod } : {});

  // Monobank's covered ranges and the count of each Monobank row by description, in one probe pair.
  const searchAll = (conn: AssistantConnection, narrowing?: string) =>
    conn.ask('transaction_search', {
      text: runId,
      period: ds.allPeriod,
      ...(narrowing === undefined ? {} : { narrowing }),
    });

  const countsBy = (rows: readonly Row[]) => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.description, (counts.get(r.description) ?? 0) + 1);
    return counts;
  };

  const coverageProbe = async (conn: AssistantConnection, sourceId: string) => {
    const r = await conn.ask('holdings', { narrowing: sourceId });
    if (r.kind === 'failed') return { ranges: null, text: r.reason };
    if (r.refused) return { ranges: null, text: `refused: ${r.text}` };
    const ranges = coverageOf(r.value, sourceId);
    const text =
      ranges === null
        ? 'not stated'
        : ranges.map((x) => `${new Date(x.startAt).toISOString()}..${new Date(x.endAt).toISOString()}`).join(', ') || 'none';
    return { ranges, text };
  };

  // Waits until sourceId's coverage covers [from, until) and every awaited marker is found.
  const waitCoverage = async (
    conn: AssistantConnection,
    what: string,
    deadlineMs: number,
    sources: readonly { id: string; from: number; until: number }[],
    awaited: readonly string[],
  ) => {
    progress(`${currentPhase.name}: waiting for ${what}, deadline ${deadlineMs} ms`);
    const outcome = await waitFor(
      deadlineMs,
      async () => {
        const parts: string[] = [];
        let met = true;
        for (const s of sources) {
          const c = await coverageProbe(conn, s.id);
          const ok = covers(c.ranges, s.from, s.until);
          met &&= ok;
          parts.push(`${s.id} coverage ${c.text}${ok ? '' : ` (awaited ${new Date(s.from).toISOString()}..${new Date(s.until).toISOString()})`}`);
        }
        const r = await searchAll(conn);
        if (r.kind === 'failed' || r.refused) {
          met = false;
          parts.push(`search: ${r.kind === 'failed' ? r.reason : `refused: ${r.text}`}`);
        } else {
          const counts = countsBy(listedRows(r.value));
          const missing = awaited.filter((m) => !counts.has(m));
          if (missing.length > 0) {
            met = false;
            parts.push(`missing markers ${missing.join(', ')}`);
          }
        }
        return { met, observed: parts.join('; ') };
      },
      () => Date.now(),
      serviceSleep,
    );
    progress(`${currentPhase.name}: wait for ${what} ${outcome.met ? 'met' : 'not met'} after ${outcome.elapsedMs} ms: ${outcome.observed}`);
    return outcome;
  };

  const monoDeadline = waitDeadlineMs({
    runningCalls: monobankJobCalls(3),
    nextCalls: monobankJobCalls(3),
    spacingMs: spacingMs(MONOBANK_STAND_IN_LIMITS),
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  const initialMarkers = ds.monobank.initial.map((t) => t.description);
  const earliestInitial = Math.min(...ds.monobank.initial.map((t) => t.time!));
  const servedMono = (): MonoTxn[] => {
    const m = ds.monobank;
    return [...m.initial, m.pushed, m.dropped, ...m.whileStopped, ...m.older].filter((t) => t.time !== null);
  };

  // Every Monobank row's amount equals the served amount exactly; the pair carries one category and merchant.
  const judgeMonoRows = (rows: readonly Row[], what: string) => {
    const served = new Map(servedMono().map((t) => [t.id, t]));
    for (const r of rows) {
      if (r.sourceId !== 'monobank') continue;
      const t = served.get(r.bankId);
      if (t === undefined) continue;
      const amount = servedText(BigInt(t.amount));
      const currency = MONO_CURRENCY[t.currencyCode];
      if (r.amount !== amount || r.currency !== currency) {
        fail(['exact_money'], `${what}: row ${r.bankId} amount ${r.amount} ${r.currency}, served ${amount} ${currency}`);
      }
    }
    const pair = rows.filter((r) => r.sourceId === 'monobank' && r.description === ds.pair.text);
    if (pair.length === 2) {
      const [a, b] = pair;
      if (JSON.stringify(a.category) !== JSON.stringify(b.category) || JSON.stringify(a.merchant) !== JSON.stringify(b.merchant)) {
        fail(
          ['exact_money'],
          `${what}: the pair differs: category ${JSON.stringify(a.category)} / ${JSON.stringify(b.category)}, merchant ${JSON.stringify(a.merchant)} / ${JSON.stringify(b.merchant)}`,
        );
      }
    }
  };

  const judgeNet = (value: JsonObject | null, withSecond: boolean, what: string) => {
    if (value === null) return;
    const expected = servedText(expectedNetPosition(ds, withSecond));
    const net = at(value, 'outcome', 'body', 'netPosition');
    const amount = at(net, 'amount');
    const currency = at(net, 'currency');
    if (amount !== expected || currency !== 'PLN') {
      fail(['exact_money'], `${what}: net position ${String(amount)} ${String(currency)}, expected ${expected} PLN`);
    }
  };

  // --- phases ---

  // Runs body; a failure out of it fails the promises p serves, naming the precondition.
  const guard = async (p: Phase, body: () => Promise<void>) => {
    try {
      await body();
    } catch (e) {
      if (e instanceof Stopped || stopped) throw e;
      fail(p.serves, e instanceof HarnessFault ? message(e) : `${p.name}: ${message(e)} (harness fault)`);
    }
  };

  const phase = async (p: Phase, body: () => Promise<void>) => {
    if (stopped) throw new Stopped('run stopped');
    currentPhase = p;
    progress(`${p.name}: starting`);
    await guard(p, body);
    progress(`${p.name}: ended`);
  };

  const withConnection = async (withSecond: boolean, body: (conn: Connection) => Promise<void>) => {
    const conn = await openConnection(withSecond);
    try {
      await body(conn);
    } finally {
      await closeConnection(conn);
    }
  };

  const run = async (): Promise<void> => {
    let p1Start = 0;
    await phase(PHASES.P1, async () => {
      p1Start = startService(false);
      await withConnection(false, async (conn) => {
        const o = await waitCoverage(
          conn,
          'the first fill',
          monoDeadline,
          [{ id: 'monobank', from: earliestInitial, until: p1Start }],
          initialMarkers,
        );
        if (!o.met) fail(PHASES.P1.serves, `P1 first fill not met within ${monoDeadline} ms: ${o.observed}`);
      });
    });

    await phase(PHASES.P2, async () => {
      requireService();
      const pushed = await mono!.gain(ds.monobank.pushed, 'send');
      if (pushed.status !== 200) {
        fail(['complete_and_current', 'local_copy_only'], `P2 push acknowledgement status ${pushed.status ?? 'none'}, expected 200`);
      }
      await withConnection(false, async (conn) => {
        const tools = await conn.listTools();
        const missing = ANSWER_CATALOGUE.map((e) => e.tool).filter((t) => !tools.includes(t));
        if (missing.length > 0) fail(['complete_and_current', 'local_copy_only'], `P2 tools not listed: ${missing.join(', ')}`);

        const keys: PromiseKey[] = ['complete_and_current', 'local_copy_only'];
        const search = valueOf(
          await conn.ask('transaction_search', { text: ds.pair.text, period: ds.allPeriod }),
          'P2 search for the pair',
          keys,
        );
        if (search !== null) {
          const rows = listedRows(search);
          const expected = servedText(BigInt(ds.monobank.pushed.amount));
          const row = rows.find((r) => r.bankId === ds.pair.pushedId);
          if (row === undefined) fail(keys, `P2 search for ${ds.pair.text}: the pushed transaction is not listed`);
          else if (row.amount !== expected || row.currency !== 'UAH') {
            fail(['exact_money'], `P2 pushed row amount ${row.amount} ${row.currency}, served ${expected} UAH`);
          }
        }
        const balance = valueOf(await conn.ask('balance', {}), 'P2 balance', keys);
        if (balance !== null) {
          const line = balanceLines(balance).find((l) => typeof l.holdingId === 'string' && l.holdingId.endsWith(':acc-uah'));
          const asOf = Number(at(line, 'asOf', 'instant'));
          if (line === undefined) fail(keys, 'P2 balance: no line for acc-uah');
          else if (!(asOf >= ds.monobank.pushed.time!)) {
            fail(keys, `P2 balance of acc-uah as of ${asOf}, before the pushed moment ${ds.monobank.pushed.time}`);
          }
        }
      });
    });

    await phase(PHASES.P3, async () => {
      requireService();
      await mono!.gain(ds.monobank.dropped, 'drop');
      await withConnection(false, async (conn) => {
        const o = await waitCoverage(conn, 'the dropped transaction', monoDeadline, [], [ds.monobank.dropped.description]);
        if (!o.met) fail(PHASES.P3.serves, `P3 lost notification not found within ${monoDeadline} ms: ${o.observed}`);
      });
    });

    await phase(PHASES.P4, async () => {
      await signalStep('P4 stop before restart', PHASES.P4.serves);
      for (const t of ds.monobank.whileStopped) await mono!.gain(t, 'drop');
      const lastGain = Math.max(...ds.monobank.whileStopped.map((t) => t.time!));
      startService(false);
      await withConnection(false, async (conn) => {
        const c = PHASES.P4.serves.filter((k) => k === 'complete_and_current');
        const o = await waitCoverage(
          conn,
          'the start catch-up',
          monoDeadline,
          [{ id: 'monobank', from: earliestInitial, until: lastGain }],
          ds.monobank.whileStopped.map((t) => t.description),
        );
        if (!o.met) fail(c, `P4 catch-up not met within ${monoDeadline} ms: ${o.observed}`);

        // Every Monobank marker served so far, the older set excluded, found exactly once; the pair twice.
        const all = valueOf(await searchAll(conn, 'monobank'), 'P4 search of every marker', c);
        if (all !== null) {
          const counts = countsBy(listedRows(all));
          const served = [...ds.monobank.initial, ds.monobank.dropped, ...ds.monobank.whileStopped]
            .map((t) => t.description)
            .filter((d) => d !== ds.pair.text);
          for (const m of served) {
            const n = counts.get(m) ?? 0;
            if (n !== 1) fail(c, `P4 marker ${m} found ${n} times, expected once`);
          }
          const pairs = counts.get(ds.pair.text) ?? 0;
          if (pairs !== 2) fail(c, `P4 pair text ${ds.pair.text} found ${pairs} times, expected twice`);
        }

        // The backfill, beside the running service.
        requireService();
        const coverage = async () => {
          const r = await conn.ask('holdings', { narrowing: 'monobank' });
          return r.kind === 'answer' && !r.refused ? coverageOf(r.value, 'monobank') : null;
        };
        const before = await coverage();
        const backfill = startChild('backfill', ['backfill', 'monobank', ds.backfill.arg], settingsFor(false));
        backfill.bidden = true; // a backfill is expected to end
        const stdout = readAll(backfill.p.stdout);
        void eachLine(backfill.p.stderr, (line) => progress(`backfill: ${line}`));
        progress(`P4: backfill started over ${ds.backfill.arg}, deadline ${monoDeadline} ms`);
        let exitCode: number | null = (await within(backfill.p.exited, monoDeadline)) ?? null;
        if (exitCode === null) {
          backfill.p.signal('SIGINT');
          if ((await within(backfill.p.exited, KILL_AFTER_MS)) === undefined) {
            backfill.p.signal('SIGKILL');
            await backfill.p.exited;
          }
          exitCode = null;
        }
        progress(`P4: backfill ${exitCode === null ? 'did not exit within its deadline' : `exited with code ${exitCode}`}`);
        const after = await coverage();
        const searches = new Map<string, Json>();
        const older = olderMarkers(ds);
        for (const m of [...older.inRange, ...older.outOfRange]) {
          const r = await conn.ask('transaction_search', { text: m, period: ds.allPeriod });
          if (r.kind === 'answer' && !r.refused) searches.set(m, r.value);
          else fail(c, `P4 search for older marker ${m}: ${r.kind === 'failed' ? r.reason : `refused: ${r.text}`}`);
        }
        const verdict = judgeBackfill({ exitCode, stdout: await stdout, before, after, searches }, ds);
        if (!verdict.pass) fail(c, ...verdict.observed.map((o) => `P4 ${o}`));
        const alongside = backfillAlongside(mono!.calls(), ds);
        if (!alongside.met) fail(['complete_and_current', 'rate_limits'], `P4 ${alongside.observed}`);

        // Exact money over the Monobank figures.
        const e: PromiseKey[] = ['exact_money'];
        const everything = valueOf(await searchAll(conn, 'monobank'), 'P4 search of every Monobank row', e);
        if (everything !== null) judgeMonoRows(listedRows(everything), 'P4 search');
        judgeNet(valueOf(await conn.ask('balance', {}), 'P4 balance', e), false, 'P4 balance');

        const narrowed = valueOf(await conn.ask('balance', { narrowing: 'monobank' }), 'P4 balance narrowed to monobank', e);
        if (narrowed !== null) {
          const name = holdingNameFor(narrowed, 'monobank', ds.fixture.holding);
          if (name.name === null) {
            fail(e, `fixture holding ${ds.fixture.holding} not named exactly once in the balance answer: seen ${name.seen.join(', ') || 'none'}`);
          } else {
            const b = await conn.ask('spending_breakdown', {
              narrowing: name.name,
              period: `${ds.fixture.day}..${ds.fixture.day}`,
              displayCurrency: 'PLN',
            });
            const breakdown: Json = b.kind === 'answer' && !b.refused ? b.value : null;
            if (breakdown === null) fail(e, `fixture breakdown: ${b.kind === 'failed' ? b.reason : `refused: ${b.text}`}`);
            const fixtureSearches = new Map<string, Json>();
            for (const f of fixtureMarkers(ds)) {
              const r = await conn.ask('transaction_search', { text: f, period: ds.allPeriod, displayCurrency: 'PLN' });
              if (r.kind === 'answer' && !r.refused) fixtureSearches.set(f, r.value);
            }
            const v = judgeFixture(breakdown, fixtureSearches, ds);
            if (!v.pass) fail(e, ...v.observed);
          }
        }
      });
    });

    await phase(PHASES.P5, async () => {
      requireService();
      await mono!.close();
      await second!.close();
      const keys: PromiseKey[] = ['local_copy_only'];
      try {
        await askUnreachable(keys);
      } finally {
        await mono!.reopen();
        await second!.reopen();
      }
    });

    async function askUnreachable(keys: PromiseKey[]) {
      await withConnection(false, async (conn) => {
        const tools = await conn.listTools();
        const results: { tool: string; scope: string; result: AskResult }[] = [];
        for (const tool of tools) {
          const args = baseArgs(tool);
          results.push({ tool, scope: scopeOf(args), result: await conn.ask(tool, args) });
        }
        const bound = judgeAnswerBound(results);
        if (!bound.pass) fail(keys, ...bound.observed.map((o) => `P5 ${o}`));

        const pairs: { question: string; cli: CommandLineAsk; assistant: AskResult }[] = [];
        for (const q of interfaceQuestions(ds)) {
          if (stopped) throw new Stopped('run stopped');
          let cli: CommandLineAsk;
          try {
            cli = await runCommandLine(q.argv, settingsFor(false), host, ANSWER_BOUND_MS);
          } catch (e) {
            throw new HarnessFault(`command-line question ${q.question} did not start: ${message(e)} (harness fault)`);
          }
          const assistant = await conn.ask(q.tool, q.args);
          pairs.push({ question: q.question, cli, assistant });
        }
        const text = judgeInterfaceText(pairs);
        if (!text.pass) fail(keys, ...text.observed.map((o) => `P5 ${o}`));
      });
    }

    await phase(PHASES.P6, async () => {
      mono!.freeze();
      const s: PromiseKey[] = ['source_touches_only_itself'];
      const c: PromiseKey[] = ['complete_and_current'];
      const e: PromiseKey[] = ['exact_money'];

      // Every family but 'new' in every scope for Monobank, and the 'new' drain, combined only.
      const observe = async (conn: AssistantConnection, sourceId: string, label: string) => {
        const tools = (await conn.listTools()).filter((t) => t !== NEW_FAMILY);
        const balance = valueOf(await conn.ask('balance', { narrowing: sourceId }), `${label} balance narrowed to ${sourceId}`, s);
        const account = at(balance ?? null, 'outcome', 'body', 'accounts');
        const accountName = Array.isArray(account) && isObject(account[0]) ? account[0].holdingId : undefined;
        if (typeof accountName !== 'string') fail(s, `${label}: no account named in the balance narrowed to ${sourceId}`);
        const values = new Map<string, AskResult>();
        for (const tool of tools) {
          const scopes: (string | null)[] =
            tool === RATES_FAMILY ? [null] : [null, sourceId, ...(typeof accountName === 'string' ? [accountName] : [])];
          for (const narrowing of scopes) {
            const args = { ...baseArgs(tool), ...(narrowing === null ? {} : { narrowing }) };
            values.set(`${tool} (${narrowing ?? 'combined'})`, await conn.ask(tool, args));
          }
        }
        return { values, accountName: typeof accountName === 'string' ? accountName : null };
      };
      const drainNew = async (conn: AssistantConnection, label: string) => {
        const pages: Json[] = [];
        for (let n = 0; n < NEW_PAGE_LIMIT; n++) {
          const v = valueOf(await conn.ask(NEW_FAMILY, {}), `${label} new since last asked page ${n + 1}`, s);
          if (v === null) return pages;
          if (listedRows(v).length === 0) return pages;
          pages.push(v);
        }
        fail(s, `${label}: new since last asked still listing after ${NEW_PAGE_LIMIT} pages`);
        return pages;
      };

      // A failed before observation is kept and the switch-on still runs.
      let before: Map<string, AskResult> = new Map();
      await guard(PHASES.P6, () =>
        withConnection(false, async (conn) => {
          before = (await observe(conn, 'monobank', 'P6 before')).values;
          await drainNew(conn, 'P6 before');
        }),
      );

      await signalStep('P6 stop before switch-on', PHASES.P6.serves);
      const restartAt = startService(true);

      await withConnection(true, async (conn) => {
        const perAccount = ds.second.accounts.map((a) => ds.second.initial.filter((t) => t.account === a.id).length);
        const deadline = Math.max(
          waitDeadlineMs({
            runningCalls: secondJobCalls(perAccount),
            nextCalls: secondJobCalls(perAccount),
            spacingMs: spacingMs(SECOND_STAND_IN_LIMITS),
            pollIntervalMs: POLL_INTERVAL_MS,
          }),
          monoDeadline,
        );
        const o = await waitCoverage(
          conn,
          "the second source's fill",
          deadline,
          [
            { id: 'second', from: Math.min(...ds.second.initial.map((t) => t.bookedAt)), until: restartAt },
            { id: 'monobank', from: earliestInitial, until: restartAt },
          ],
          ds.second.initial.map((t) => t.description),
        );
        if (!o.met) fail([...c, ...s], `P6 second-source fill not met within ${deadline} ms: ${o.observed}`);

        // The 'new' drain first, before any other ask.
        const pages = await drainNew(conn, 'P6 after');
        const newVerdict = judgeNewPages(pages, ds);
        if (!newVerdict.pass) fail(s, ...newVerdict.observed);

        // The same questions again: each Monobank-scoped value equals its before value, masked.
        const afterMono = await observe(conn, 'monobank', 'P6 after');
        for (const [key, b] of before) {
          if (key.endsWith('(combined)')) continue;
          const a = afterMono.values.get(key);
          const bv = valueOf(b, `P6 before ${key}`, s);
          const av = a === undefined ? null : valueOf(a, `P6 after ${key}`, s);
          if (a === undefined) fail(s, `P6 after ${key}: not asked`);
          if (bv === null || av === null) continue;
          const d = maskedDifference(bv, av);
          if (d !== null) fail(s, `P6 ${key} changed after the switch-on: ${d}`);
        }

        // Every family but 'new' narrowed to the second source and to its first account.
        const afterSecond = await observe(conn, 'second', 'P6 after');
        for (const [key, r] of afterSecond.values) {
          if (key.endsWith('(combined)')) continue;
          if (key.startsWith('jars (second')) {
            if (r.kind !== 'answer' || r.refused || at(r.value, 'outcome', 'kind') !== 'not_available') {
              fail(s, `P6 ${key}: expected not available`);
            }
            continue;
          }
          const v = valueOf(r, `P6 ${key}`, s);
          if (v === null) continue;
          const verdict = judgeNarrowedToSecond(v, ds);
          if (!verdict.pass) fail(s, ...verdict.observed.map((x) => `P6 ${key}: ${x}`));
        }

        // The combined checks: accounts, markers, totals and jars.
        const balance = valueOf(await conn.ask('balance', {}), 'P6 combined balance', [...s, ...e]);
        if (balance !== null) {
          const names = balanceLines(balance).map((l) => String(l.holdingId));
          for (const a of ds.second.accounts) {
            if (!names.some((n) => n.startsWith('second:') && n.endsWith(`:${a.id}`))) {
              fail(s, `P6 combined balance misses second-source account ${a.id}`);
            }
          }
          judgeNet(balance, true, 'P6 combined balance');
        }
        const search = valueOf(await searchAll(conn), 'P6 combined search', [...s, ...c, ...e]);
        if (search !== null) {
          const rows = listedRows(search);
          const counts = countsBy(rows);
          for (const t of ds.second.initial) {
            const n = counts.get(t.description) ?? 0;
            if (n !== 1) fail([...s, ...c], `P6 second-source marker ${t.description} found ${n} times, expected once`);
            const row = rows.find((r) => r.sourceId === 'second' && r.bankId === t.id);
            if (row !== undefined && (row.amount !== t.amount || row.currency !== t.currency)) {
              fail(e, `P6 second-source row ${t.id} amount ${row.amount} ${row.currency}, served ${t.amount} ${t.currency}`);
            }
          }
        }
        const jars = valueOf(await conn.ask('jars', {}), 'P6 combined jars', s);
        if (jars !== null) {
          const lines = at(jars, 'outcome', 'body', 'jars');
          const held = Array.isArray(lines) ? lines.filter(isObject).map((j) => String(j.name)) : [];
          for (const h of ds.monobank.holdings.filter((x) => x.kind === 'jar')) {
            if (!held.some((n) => n.startsWith('monobank:') && n.endsWith(`:${h.id}`))) {
              fail(s, `P6 combined jars miss Monobank jar ${h.id}`);
            }
          }
          const notOffering = at(jars, 'scope', 'notOffering');
          if (!Array.isArray(notOffering) || !notOffering.includes('second')) {
            fail(s, 'P6 combined jars do not name the second source as not offering jars');
          }
        }
      });
    });

    await phase(PHASES.P7, async () => {
      await signalStep('P7 stop', PHASES.P7.serves);
    });

    // The whole call records, each stand-in by its own limits; then single-machine operation.
    const monoCalls = mono!.calls();
    const secondCalls = second!.calls();
    for (const v of [
      judgeRateLimits(monoCalls, MONOBANK_STAND_IN_LIMITS, 'monobank stand-in'),
      judgeRateLimits(secondCalls, SECOND_STAND_IN_LIMITS, 'second stand-in'),
    ]) {
      if (!v.pass) fail(['rate_limits'], v.observed.join('; '));
    }
    const single = judgeSingleMachine([...monoCalls, ...secondCalls], Bun.version, settingsFor(true), folder!);
    if (!single.pass) fail(['single_machine'], single.observed.join('; '));
  };

  // --- start, run, report ---

  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    folder = mkdtempSync(join(tmpdir(), 'arcanum-release-'));
    progress(`release check: run ${runId}, t0 ${new Date(t0).toISOString()}, zone ${ds.zone.name}, folder ${folder}`);
    const [m, s] = await Promise.allSettled([
      startMonobankStandIn(ds, token, () => Date.now()),
      startSecondStandIn(ds, token, () => Date.now()),
    ]);
    if (m.status === 'fulfilled') mono = m.value;
    if (s.status === 'fulfilled') second = s.value;
    const faults: string[] = [];
    if (m.status === 'rejected') faults.push(`monobank stand-in cannot listen: ${message(m.reason)} (harness fault)`);
    if (s.status === 'rejected') faults.push(`second stand-in cannot listen: ${message(s.reason)} (harness fault)`);
    if (faults.length === 0) {
      try {
        pushPort = await freeLoopbackPort();
      } catch (e) {
        faults.push(`no free loopback port for the push receiver: ${message(e)} (harness fault)`);
      }
    }

    if (faults.length > 0) {
      for (const f of faults) fail(ALL_PROMISES, f);
    } else {
      const limit = new Promise<'limit'>((resolve) => {
        limitTimer = setTimeout(() => resolve('limit'), Math.max(0, t0 + RUN_LIMIT_MS - Date.now()));
      });
      const running = run();
      running.catch(() => {});
      const ended = await Promise.race([running.then(() => 'done' as const), limit]);
      if (ended === 'limit') fail(ALL_PROMISES, RUN_LIMIT_TEXT);
    }
  } catch (e) {
    if (!(e instanceof Stopped)) fail(ALL_PROMISES, `release check error: ${message(e)} (harness fault)`);
  } finally {
    clearTimeout(limitTimer);
    await cleanup();
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }

  const verdicts = new Map<PromiseKey, Verdict>(
    ALL_PROMISES.map((k) => {
      const obs = observed.get(k)!;
      return [k, obs.length === 0 ? { pass: true } : { pass: false, observed: obs }];
    }),
  );
  const { lines, exitCode } = verdictLines(verdicts, notApplicable);
  io.stdout(lines.map((l) => `${l}\n`).join(''));
  return exitCode;
};
