// Command-line ask (S-180): one parsed draft stamped 'command_line' served once through the core
// with the shared formatter; a core refusal's text goes to standard error and an answer's to
// standard output, never both; exit 0 for a delivered answer, 1 for a refusal, an undelivered
// answer or a serve that rejects.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';

const askModule = () => import('../../src/interfaces/question-ask');
const catalogueModule = () => import('../../src/interfaces/catalogue');
const renderModule = () => import('../../src/interfaces/render');
const handoffModule = () => import('../../src/interfaces/handoff');
const primitivesModule = () => import('../../src/core/primitives');

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

// The catalogue entry of one family.
const entryOf = async (family: string) => {
  const { CATALOGUE_ENTRIES } = await catalogueModule();
  const e = CATALOGUE_ENTRIES.find((c) => c.family === family);
  if (!e) throw new Error('no catalogue entry for ' + family);
  return e;
};

type Channel = { write: (text: string) => Promise<void>; closed: Promise<void> };

// A core whose serve renders and writes as S-229's does: it records the question, renders the
// answer, writes the text to the channel, and reports delivery 'failed' when that write rejects.
const stubCore = (answer: unknown) => {
  const served: Record<string, unknown>[] = [];
  const core = {
    async serve(q: Record<string, unknown>, render: (a: unknown) => string, ch: Channel) {
      served.push(q);
      let delivery: 'delivered' | 'failed' = 'delivered';
      try {
        const text = render(answer);
        await ch.write(text);
      } catch {
        delivery = 'failed';
      }
      return { answer, delivery, receipt: false, recorded: null };
    },
  };
  return { core, served };
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

describe('interfaces/question-ask', () => {
  test('a core refusal goes to stderr', async () => {
    const { askAtCommandLine } = await askModule();
    const { CATALOGUE_ENTRIES, parseRaw } = await catalogueModule();
    const { formatRefusal } = await renderModule();
    const { EXIT_REFUSED } = await handoffModule();
    const { refuse } = await primitivesModule();

    const out = capture();
    const err = capture();
    const draft = parseRaw(await entryOf('transaction_search'), {
      wire: 'argv',
      args: ['--min-amount', '5', '--max-amount', '1'],
    });
    const ref = refuse('bad_option', 'amountRange', 'The minimum 5 is above the maximum 1.', '5..1');
    const { core, served } = stubCore(ref);

    const code = await askAtCommandLine(core as never, draft as never, CATALOGUE_ENTRIES, out.stream, err.stream);

    expect(code).toBe(EXIT_REFUSED);
    expect(code).toBe(1);
    expect(err.sink.text).toBe(formatRefusal(ref) + '\n');
    expect(err.sink.text).toBe('Refused (amountRange): The minimum 5 is above the maximum 1.\n');
    expect(out.sink.text).toBe('');
    expect(served.length).toBe(1);
    expect(served[0]).toEqual({ ...(draft as object), asker: 'command_line' });
    expect(served[0]!.options).toEqual({ minAmount: '5', maxAmount: '1' });
  });

  test('an answer goes to stdout', async () => {
    const { askAtCommandLine } = await askModule();
    const { CATALOGUE_ENTRIES, parseRaw } = await catalogueModule();
    const { formatAnswer } = await renderModule();
    const { EXIT_ANSWERED } = await handoffModule();

    const out = capture();
    const err = capture();
    const env = emptyBalanceEnvelope();
    const { core, served } = stubCore(env);
    const draft = parseRaw(await entryOf('balance'), { wire: 'argv', args: ['--display-currency', 'EUR'] });

    const code = await askAtCommandLine(core as never, draft as never, CATALOGUE_ENTRIES, out.stream, err.stream);

    expect(code).toBe(EXIT_ANSWERED);
    expect(code).toBe(0);
    expect(out.sink.text).toBe(formatAnswer(env as never, CATALOGUE_ENTRIES) + '\n');
    expect(out.sink.text).toContain('Covered ranges: nothing held');
    expect(out.sink.text).toContain('Accounts: none');
    expect(err.sink.text).toBe('');
    expect(served[0]).toEqual({ family: 'balance', displayCurrency: 'EUR', options: {}, asker: 'command_line' });
  });

  test('undelivered and rejected asks', async () => {
    const { askAtCommandLine, UNDELIVERED_LINE } = await askModule();
    const { CATALOGUE_ENTRIES, parseRaw } = await catalogueModule();
    const { EXIT_REFUSED } = await handoffModule();

    expect(UNDELIVERED_LINE).toBe('The answer could not be written to standard output.');
    const draft = parseRaw(await entryOf('balance'), { wire: 'argv', args: ['--display-currency', 'EUR'] });

    // 1. Standard output fails on write: the answer is an envelope, yet nothing reached the holder.
    const failingOut = new Writable({
      write(_c, _e, cb) {
        cb(new Error('EPIPE'));
      },
    });
    failingOut.on('error', () => {});
    const err1 = capture();
    const { core } = stubCore(emptyBalanceEnvelope());
    const code1 = await askAtCommandLine(core as never, draft as never, CATALOGUE_ENTRIES, failingOut, err1.stream);
    expect(code1).toBe(EXIT_REFUSED);
    expect(code1).toBe(1);
    expect(err1.sink.text).toBe(UNDELIVERED_LINE + '\n');

    // 2. serve rejects with a store error: askAtCommandLine resolves with 1 and names it on stderr.
    const out2 = capture();
    const err2 = capture();
    const rejecting = {
      serve: () => Promise.reject(new Error('database disk image is malformed')),
    };
    let rejected = false;
    const code2 = await askAtCommandLine(
      rejecting as never,
      draft as never,
      CATALOGUE_ENTRIES,
      out2.stream,
      err2.stream,
    ).catch(() => {
      rejected = true;
      return undefined;
    });
    expect(rejected).toBe(false);
    expect(code2).toBe(1);
    expect(err2.sink.text).toBe('database disk image is malformed\n');
    expect(out2.sink.text).toBe('');
  });
});
