// Command-line question front end (S-191): handed a settings record, an uncalled opener, the
// family list and the catalogue; it checks the families against the catalogue (exit 70), looks up
// the command and its help, parses (exit 2), checks the storage location only (exit 1), opens the
// existing local copy (exit 1 for a refused open, 70 for a throwing opener), asks once through the
// command-line ask, and closes the store on every path after a successful open. Monobank's
// settings group is the `settingsGroup` its source module exports.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';

const entryModule = () => import('../../src/interfaces/question-entry');
const catalogueModule = () => import('../../src/interfaces/catalogue');
const renderModule = () => import('../../src/interfaces/render');
const handoffModule = () => import('../../src/interfaces/handoff');
const primitivesModule = () => import('../../src/core/primitives');
const settingsModule = () => import('../../src/config/settings');
const gateModule = () => import('../../src/start-gate');
const monobankModule = () => import('../../src/sources/monobank');

// A Writable collecting every chunk written to it as text.
const capture = () => {
  const sink = { text: '' };
  const stream = new Writable({
    write(c, _e, cb) {
      sink.text += String(c);
      cb();
    },
  });
  return { stream, sink };
};

// A registered family by name; only the name matters to the front end.
const fam = (name: string) => ({
  name,
  period: 'none' as const,
  movesPoint: name === 'new_since_last_asked',
  compute: () => ({ kind: 'body' as const, body: {} }),
});

// The catalogue entry of one family.
const entry = async (family: string) => {
  const { CATALOGUE_ENTRIES } = await catalogueModule();
  const e = CATALOGUE_ENTRIES.find((c) => c.family === family);
  if (!e) throw new Error('no catalogue entry for ' + family);
  return e;
};

type Channel = { write: (text: string) => Promise<void>; closed: Promise<void> };

// A core whose serve renders the fixed answer and writes it to the channel, as S-229's does.
const stubCore = (answer: unknown) => ({
  async serve(_q: unknown, render: (a: unknown) => string, ch: Channel) {
    let delivery: 'delivered' | 'failed' = 'delivered';
    try {
      await ch.write(render(answer));
    } catch {
      delivery = 'failed';
    }
    return { answer, delivery, receipt: false, recorded: null };
  },
});

// An opened copy over a core, counting its close calls.
const opened = (core: unknown) => {
  const counts = { close: 0 };
  return {
    value: {
      core,
      close() {
        counts.close += 1;
      },
    },
    counts,
  };
};

// An empty balance envelope asked at the command line.
const emptyBalanceEnvelope = () => ({
  kind: 'envelope',
  family: 'balance',
  asker: 'command_line',
  asOf: { instant: 1795341600000, localDateTime: '2026-11-22T10:00:00+01:00', position: 42 },
  timeZone: 'Europe/Warsaw',
  displayCurrency: 'EUR',
  scope: { narrowing: null, sources: ['monobank'], notOffering: [] },
  period: null,
  statements: { coveredRanges: [] },
  outcome: { kind: 'answered', body: { accounts: [] } },
});

// The harness: one run of the front end over a stub opener counting its calls.
const harness = async (behave: () => unknown = () => ({ kind: 'no_local_copy', location: '/d/a.db' })) => {
  const { runQuestionFrontEnd } = await entryModule();
  const { CATALOGUE_ENTRIES } = await catalogueModule();
  const { loadSettings } = await settingsModule();
  const groups = [(await monobankModule()).settingsGroup];
  const calls = { open: 0 };
  const open = () => {
    calls.open += 1;
    return behave();
  };
  const run = async (
    argv: string[],
    env: Record<string, string> = {},
    families: unknown[] = CATALOGUE_ENTRIES.map((e) => fam(e.family)),
  ) => {
    const out = capture();
    const err = capture();
    const code = await runQuestionFrontEnd({
      record: loadSettings(env, groups as never),
      open: open as never,
      families: families as never,
      catalogue: CATALOGUE_ENTRIES,
      argv,
      stdout: out.stream,
      stderr: err.stream,
    });
    return { code, out: out.sink.text, err: err.sink.text };
  };
  return { run, calls, groups };
};

const STORED = { ARCANUM_STORAGE: '/d/a.db' };
const COMMANDS = 'balance, jars, search, breakdown, rates, foreign, holdings';

describe('interfaces/question-entry', () => {
  test('parse before settings', async () => {
    const { parseRaw } = await catalogueModule();
    const { formatRefusal } = await renderModule();
    const { EXIT_USAGE, EXIT_REFUSED } = await handoffModule();
    const { loadSettings } = await settingsModule();
    const { checkStart } = await gateModule();
    const { run, calls, groups } = await harness();

    // 1. An unknown option together with a missing storage location: the option is reported, exit 2.
    const r1 = await run(['search', '--colour', 'red'], {});
    expect(r1.code).toBe(EXIT_USAGE);
    expect(r1.code).toBe(2);
    const refusal = parseRaw(await entry('transaction_search'), { wire: 'argv', args: ['--colour', 'red'] });
    expect(r1.err).toBe(formatRefusal(refusal as never) + '\n');
    expect(r1.err).toContain('--colour');
    expect(r1.out).toBe('');
    expect(calls.open).toBe(0);

    // 2. A missing storage location alone: checkStart's line, exit 1.
    const r2 = await run(['balance'], {});
    expect(r2.code).toBe(EXIT_REFUSED);
    expect(r2.code).toBe(1);
    const verdict = checkStart({ kind: 'question' }, loadSettings({}, groups as never));
    expect(verdict.ok).toBe(false);
    const lines = verdict.ok ? [] : verdict.lines;
    expect(r2.err).toBe(lines.map((l) => l + '\n').join(''));
    expect(r2.err).toBe('ARCANUM_STORAGE is missing: it has no value and no default\n');
    expect(r2.out).toBe('');
    expect(calls.open).toBe(0);

    // 3. The storage location set and every Monobank setting absent: the opener is reached.
    await run(['balance'], STORED);
    expect(calls.open).toBe(1);
  });

  test('open outcomes and close', async () => {
    const { CATALOGUE_ENTRIES } = await catalogueModule();
    const { formatAnswer, formatOpenRefusal } = await renderModule();
    const { EXIT_ANSWERED, EXIT_REFUSED, EXIT_WIRING } = await handoffModule();
    const { refuse } = await primitivesModule();

    // 1. A refused open: exit 1 with the open-refusal text.
    const noCopy = { kind: 'no_local_copy' as const, location: '/d/a.db' };
    const h1 = await harness(() => noCopy);
    const r1 = await h1.run(['balance'], STORED);
    expect(r1.code).toBe(EXIT_REFUSED);
    expect(r1.code).toBe(1);
    expect(r1.err).toBe(formatOpenRefusal(noCopy) + '\n');
    expect(r1.err).toContain('the service or a backfill creates one');
    expect(r1.out).toBe('');
    expect(h1.calls.open).toBe(1);

    // 2. A throwing opener: exit 70 with its message.
    const h2 = await harness(() => {
      throw new Error('duplicate answer family "balance"');
    });
    const r2 = await h2.run(['balance'], STORED);
    expect(r2.code).toBe(EXIT_WIRING);
    expect(r2.code).toBe(70);
    expect(r2.err).toBe('duplicate answer family "balance"\n');

    // 3. A handed family without a catalogue entry: exit 70 before the opener.
    const h3 = await harness();
    const r3 = await h3.run(['balance'], STORED, [fam('balance'), fam('trends')]);
    expect(r3.code).toBe(70);
    expect(r3.err).toBe('wiring fault: answer family "trends" has no catalogue entry\n');
    expect(h3.calls.open).toBe(0);

    // 4. An answer: exit 0, the answer text on stdout, the store closed once.
    const env = emptyBalanceEnvelope();
    const o4 = opened(stubCore(env));
    const h4 = await harness(() => o4.value);
    const r4 = await h4.run(['balance'], STORED);
    expect(r4.code).toBe(EXIT_ANSWERED);
    expect(r4.code).toBe(0);
    expect(r4.out).toBe(formatAnswer(env as never, CATALOGUE_ENTRIES) + '\n');
    expect(o4.counts.close).toBe(1);

    // 5. A question the core refused: exit 1, the refusal on stderr, the store still closed once.
    const ref = refuse('bad_option', 'amountRange', 'The minimum 5 is above the maximum 1.', '5..1');
    const o5 = opened(stubCore(ref));
    const h5 = await harness(() => o5.value);
    const r5 = await h5.run(['search', '--min-amount', '5', '--max-amount', '1'], STORED);
    expect(r5.code).toBe(1);
    expect(r5.err).toBe('Refused (amountRange): The minimum 5 is above the maximum 1.\n');
    expect(r5.out).toBe('');
    expect(o5.counts.close).toBe(1);

    // 6. A serve that rejects with a store error: exit 1, its message on stderr, closed once.
    const o6 = opened({ serve: () => Promise.reject(new Error('database is locked')) });
    const h6 = await harness(() => o6.value);
    const r6 = await h6.run(['balance'], STORED);
    expect(r6.code).toBe(1);
    expect(r6.err).toBe('database is locked\n');
    expect(o6.counts.close).toBe(1);
  });

  test('command table and help', async () => {
    const { commandEntries } = await entryModule();
    const { CATALOGUE_ENTRIES, commandUsage } = await catalogueModule();
    const { EXIT_ANSWERED, EXIT_USAGE } = await handoffModule();
    const { run, calls } = await harness();

    // 1. No command given.
    const r1 = await run([]);
    expect(r1.code).toBe(EXIT_USAGE);
    expect(r1.code).toBe(2);
    expect(r1.err).toBe('No command given. Commands: ' + COMMANDS + '.\n');

    // 2. 'new_since_last_asked' and a tool name are not commands.
    const r2 = await run(['new_since_last_asked']);
    expect(r2.code).toBe(2);
    expect(r2.err).toBe('Unknown command "new_since_last_asked". Commands: ' + COMMANDS + '.\n');
    const r2b = await run(['transaction_search']);
    expect(r2b.code).toBe(2);
    expect(r2b.err.startsWith('Unknown command "transaction_search"')).toBe(true);

    // 3. The table is built from the handed families, in catalogue order.
    const commands = commandEntries([fam('transaction_search'), fam('balance')] as never, CATALOGUE_ENTRIES).map(
      (e) => e.command,
    );
    expect(commands).toEqual(['balance', 'search']);
    const r3 = await run(['jars'], {}, [fam('balance'), fam('transaction_search')]);
    expect(r3.code).toBe(2);
    expect(r3.err).toBe('Unknown command "jars". Commands: balance, search.\n');

    // 4. Exactly '--help' prints the usage without settings or the opener.
    const r4 = await run(['search', '--help']);
    expect(r4.code).toBe(EXIT_ANSWERED);
    expect(r4.code).toBe(0);
    expect(r4.out).toBe(commandUsage(await entry('transaction_search')) + '\n');
    expect(r4.err).toBe('');

    // 5. '--help' among other arguments is parsed, and refused as a flag no option has.
    const r5 = await run(['search', '--help', 'x']);
    expect(r5.code).toBe(2);
    expect(r5.err).toContain('--help');
    expect(r5.out).toBe('');
    expect(calls.open).toBe(0);
  });
});
