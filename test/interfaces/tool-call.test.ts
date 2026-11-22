// Assistant tool call (S-177): one spec per handed family from its catalogue entry; a call is
// parsed before anything else and a parse refusal is answered without the core; a draft is served
// once stamped 'assistant', and the tool result carries the shared text, the answer's JSON value as
// structured content, and isError exactly for a refusal; the core's reply write completes only when
// the wiring's sent does, and the serve promise is tracked before the result is returned.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const callModule = () => import('../../src/interfaces/assistant-call');
const renderModule = () => import('../../src/interfaces/render');
const catalogueModule = () => import('../../src/interfaces/catalogue');
const primitivesModule = () => import('../../src/core/primitives');

// A family stub: only its name and movesPoint matter to the spec list.
const fam = (name: string) => ({
  name,
  period: 'none' as const,
  movesPoint: name === 'new_since_last_asked',
  compute: () => ({ kind: 'body' as const, body: {} }),
});

const entryOf = async (family: string) => {
  const { CATALOGUE_ENTRIES } = await catalogueModule();
  const e = CATALOGUE_ENTRIES.find((x) => x.family === family);
  if (e === undefined) throw new Error('no catalogue entry for ' + family);
  return e;
};

// A stream that keeps everything written to it as one string.
function capture(): { stream: any; text: () => string } {
  let text = '';
  return {
    stream: {
      write(chunk: unknown, ...rest: unknown[]) {
        text += String(chunk);
        const cb = rest.find((x) => typeof x === 'function') as (() => void) | undefined;
        if (cb) cb();
        return true;
      },
    },
    text: () => text,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const never = () => new Promise<never>(() => {});

function envelope(family: string, outcome: unknown): Record<string, unknown> {
  return {
    kind: 'envelope',
    family,
    asker: 'assistant',
    asOf: { instant: 1795341600000, localDateTime: '2026-11-22T10:00:00+01:00', position: 42 },
    timeZone: 'Europe/Warsaw',
    displayCurrency: 'PLN',
    scope: { narrowing: null, sources: ['monobank'], notOffering: [] },
    period: null,
    statements: { coveredRanges: [] },
    outcome,
  };
}

// A stub core in S-229's order: render, then write unless render threw, delivered when the write
// resolves, failed when it rejects or render threw. Keeps the questions served, each write promise
// and each serve promise.
function answeringCore(answerFor: (q: any) => unknown) {
  const served: any[] = [];
  const writes: Promise<void>[] = [];
  const serves: Promise<any>[] = [];
  const core = {
    serve(q: any, render: (a: any) => string, ch: { write: (t: string) => Promise<void>; closed: Promise<void> }) {
      served.push(q);
      const p = (async () => {
        const answer = answerFor(q);
        let text: string;
        try {
          text = render(answer);
        } catch {
          return { answer, delivery: 'failed', receipt: false, recorded: null };
        }
        const wp = ch.write(text);
        writes.push(wp);
        try {
          await wp;
          return { answer, delivery: 'delivered', receipt: false, recorded: null };
        } catch {
          return { answer, delivery: 'failed', receipt: false, recorded: null };
        }
      })();
      serves.push(p);
      return p;
    },
  };
  return { core: core as any, served, writes, serves };
}

describe('assistant tool specs', () => {
  test('assistantToolSpecs follows the handed families', async () => {
    const { assistantToolSpecs } = await callModule();
    const { CATALOGUE_ENTRIES, toolInputSchema, parseRaw } = await catalogueModule();
    const { formatAnswer, answerJson } = await renderModule();
    const { isRefusal } = await primitivesModule();

    const specs = assistantToolSpecs(
      [fam('transaction_search'), fam('balance'), fam('trends'), fam('new_since_last_asked')] as never,
      CATALOGUE_ENTRIES,
    );
    // Family order, not catalogue order; no spec for 'trends'; not one per catalogue entry.
    expect(specs.map((s) => s.tool)).toEqual(['transaction_search', 'balance', 'new_since_last_asked']);

    const s = specs[0]!;
    const e = await entryOf('transaction_search');
    expect(s.description).toBe(e.description);
    expect(s.inputSchema).toEqual(toolInputSchema(e));
    expect(s.parse({ minAmount: '1' })).toEqual(parseRaw(e, { wire: 'json', args: { minAmount: '1' } }));
    const numeric = s.parse({ minAmount: 1 });
    expect(isRefusal(numeric)).toBe(true);
    expect((numeric as any).subject).toBe('minAmount');

    const a = envelope('balance', { kind: 'answered', body: { netPosition: { minor: -235n, currency: 'PLN' } } });
    expect(specs[1]!.render(a as never)).toBe(formatAnswer(a as never, CATALOGUE_ENTRIES));
    expect(specs[1]!.structured(a as never)).toEqual(answerJson(a as never) as never);
  });
});

describe('answerToolCall', () => {
  test('parse refusals never reach the core', async () => {
    const { assistantToolSpecs, answerToolCall } = await callModule();
    const { CATALOGUE_ENTRIES, parseRaw } = await catalogueModule();
    const { formatRefusal } = await renderModule();
    const { DISPLAY_CURRENCIES } = await primitivesModule();

    const served: unknown[] = [];
    const core = {
      serve(q: unknown) {
        served.push(q);
        return never();
      },
    } as any;
    const tracked: unknown[] = [];
    const err = capture();
    const w = { sent: Promise.resolve(), closed: never(), track: (p: Promise<unknown>) => void tracked.push(p), stderr: err.stream };
    const specs = assistantToolSpecs([fam('balance'), fam('transaction_search')] as never, CATALOGUE_ENTRIES);
    const spec = (t: string) => specs.find((s) => s.tool === t);

    // 1. A JSON number for a decimal option is refused, never coerced to its text.
    const r1 = await answerToolCall(core, spec('transaction_search'), 'transaction_search', { minAmount: 0.29 }, w);
    expect(r1.isError).toBe(true);
    const expected = formatRefusal(
      parseRaw(await entryOf('transaction_search'), { wire: 'json', args: { minAmount: 0.29 } }) as never,
    );
    expect(r1.content).toEqual([{ type: 'text', text: expected }]);
    expect(r1.content[0]!.text).toContain('minAmount');
    expect('structuredContent' in r1).toBe(false);

    // 2. A display currency outside its list.
    const r2 = await answerToolCall(core, spec('balance'), 'balance', { displayCurrency: 'GBP' }, w);
    expect(r2.isError).toBe(true);
    expect(r2.content[0]!.text).toContain('displayCurrency');
    expect(r2.content[0]!.text).toContain('Use one of: ' + DISPLAY_CURRENCIES.join(', '));

    // 3. An asker argument is an unknown option, never passed through.
    const r3 = await answerToolCall(core, spec('balance'), 'balance', { asker: 'command_line' }, w);
    expect(r3.isError).toBe(true);
    expect(r3.content[0]!.text).toContain('asker');

    // 4. A tool no spec has.
    const r4 = await answerToolCall(core, undefined, 'nope', {}, w);
    expect(r4).toEqual({ content: [{ type: 'text', text: 'Unknown tool "nope".' }], isError: true });

    // 5.
    expect(served.length).toBe(0);
    expect(tracked.length).toBe(0);
    expect(err.text()).toBe('');
  });

  test('answers carry text, structure and isError', async () => {
    const { assistantToolSpecs, answerToolCall } = await callModule();
    const { CATALOGUE_ENTRIES } = await catalogueModule();
    const { formatAnswer, formatRefusal, answerJson } = await renderModule();
    const { refuse } = await primitivesModule();

    const specs = assistantToolSpecs([fam('balance'), fam('transaction_search'), fam('jars')] as never, CATALOGUE_ENTRIES);
    const spec = (t: string) => specs.find((s) => s.tool === t);
    const wiring = () => {
      const tracked: unknown[] = [];
      return { sent: Promise.resolve(), closed: never(), track: (p: Promise<unknown>) => void tracked.push(p), stderr: capture().stream };
    };

    // 1. Answered: served once stamped 'assistant', shared text, answerJson as structured content.
    const env = envelope('balance', { kind: 'answered', body: { netPosition: { minor: -235n, currency: 'PLN' } } });
    const c1 = answeringCore(() => env);
    const r1 = await answerToolCall(c1.core, spec('balance'), 'balance', { displayCurrency: 'USD' }, wiring());
    expect(c1.served[0]).toEqual({ family: 'balance', displayCurrency: 'USD', options: {}, asker: 'assistant' });
    expect(c1.served.length).toBe(1);
    expect(r1.isError).toBe(false);
    expect(r1.content).toEqual([{ type: 'text', text: formatAnswer(env as never, CATALOGUE_ENTRIES) }]);
    expect(r1.content[0]!.text).toContain('Covered ranges: nothing held');
    expect(r1.structuredContent).toEqual(answerJson(env as never) as never);

    // 2. A core refusal: isError true, and structured content still present.
    const ref = refuse('scope_not_found', 'narrowing', 'No source or holding is named "Savings".', 'Savings');
    const c2 = answeringCore(() => ref);
    const r2 = await answerToolCall(c2.core, spec('balance'), 'balance', { narrowing: 'Savings' }, wiring());
    expect(c2.served.length).toBe(1);
    expect(r2.isError).toBe(true);
    expect(r2.content[0]!.text).toBe(formatRefusal(ref));
    expect('structuredContent' in r2).toBe(true);
    expect(r2.structuredContent).toEqual(answerJson(ref) as never);

    // 3. Not available is not an error.
    const na = envelope('jars', { kind: 'not_available', capability: 'jars', sources: ['second'] });
    const c3 = answeringCore(() => na);
    const r3 = await answerToolCall(c3.core, spec('jars'), 'jars', {}, wiring());
    expect(r3.isError).toBe(false);
    expect(r3.structuredContent).toEqual(answerJson(na as never) as never);
  });

  test('write waits for sent and the call is tracked first', async () => {
    const { assistantToolSpecs, answerToolCall } = await callModule();
    const { CATALOGUE_ENTRIES } = await catalogueModule();

    const specs = assistantToolSpecs([fam('balance'), fam('transaction_search')] as never, CATALOGUE_ENTRIES);
    const spec = (t: string) => specs.find((s) => s.tool === t);
    const env = envelope('balance', { kind: 'answered', body: { netPosition: { minor: -235n, currency: 'PLN' } } });
    const stderr = capture().stream;

    // 1.
    const sent = deferred();
    const tracked: unknown[] = [];
    const c = answeringCore(() => env);
    const r = await answerToolCall(c.core, spec('balance'), 'balance', {}, {
      sent: sent.promise,
      closed: never(),
      track: (p) => void tracked.push(p),
      stderr,
    });

    // 2. The result is back while sent is pending; the write and the serve are not done.
    const wp = c.writes[0]!;
    const servedPromise = c.serves[0]!;
    let writeDone = false;
    let serveDone = false;
    wp.then(
      () => {
        writeDone = true;
      },
      () => {},
    );
    servedPromise.then(() => {
      serveDone = true;
    });
    expect(r.isError).toBe(false);
    expect(tracked.length).toBe(1);
    expect(tracked[0]).toBe(servedPromise);
    await Bun.sleep(5);
    expect(writeDone).toBe(false);
    expect(serveDone).toBe(false);

    // 3. Sent resolves: the write completes and the serve is delivered.
    sent.resolve();
    await wp;
    await servedPromise;
    expect(writeDone).toBe(true);
    expect((await servedPromise).delivery).toBe('delivered');

    // 4. Sent rejects after the result returns: the write fails and the serve is not delivered.
    const sent2 = deferred();
    const c2 = answeringCore(() => env);
    const r2 = await answerToolCall(c2.core, spec('balance'), 'balance', {}, {
      sent: sent2.promise,
      closed: never(),
      track: () => {},
      stderr,
    });
    expect(r2.isError).toBe(false);
    sent2.reject(new Error('transport closed'));
    expect((await c2.serves[0]!).delivery).toBe('failed');
  });

  test('unanswered calls', async () => {
    const { assistantToolSpecs, answerToolCall, UNANSWERED_TEXT } = await callModule();
    const { CATALOGUE_ENTRIES } = await catalogueModule();

    const specs = assistantToolSpecs([fam('balance'), fam('transaction_search')] as never, CATALOGUE_ENTRIES);
    const spec = (t: string) => specs.find((s) => s.tool === t)!;
    const withinBound = <T>(p: Promise<T>): Promise<T | 'timed out'> =>
      Promise.race([p, Bun.sleep(1000).then(() => 'timed out' as const)]);

    expect(UNANSWERED_TEXT).toBe('The answer could not be produced. Please ask again.');

    // 1. serve rejects.
    const err1 = capture();
    const rejecting = { serve: () => Promise.reject(new Error('disk I/O error')) } as any;
    const r1 = await withinBound(
      answerToolCall(rejecting, spec('balance'), 'balance', {}, {
        sent: Promise.resolve(),
        closed: never(),
        track: () => {},
        stderr: err1.stream,
      }),
    );
    expect(r1).not.toBe('timed out');
    expect(r1).toEqual({ content: [{ type: 'text', text: UNANSWERED_TEXT }], isError: true });
    expect('structuredContent' in (r1 as object)).toBe(false);
    expect(err1.text()).toBe('balance: disk I/O error\n');

    // 2. render throws: the core never writes and resolves failed.
    const err2 = capture();
    const s2 = {
      ...spec('balance'),
      render: () => {
        throw new Error('render broke');
      },
    };
    const env = envelope('balance', { kind: 'answered', body: {} });
    const c = answeringCore(() => env);
    const r2 = await withinBound(
      answerToolCall(c.core, s2 as never, 'balance', {}, {
        sent: Promise.resolve(),
        closed: never(),
        track: () => {},
        stderr: err2.stream,
      }),
    );
    expect(r2).not.toBe('timed out');
    expect((r2 as any).content).toEqual([{ type: 'text', text: UNANSWERED_TEXT }]);
    expect((r2 as any).isError).toBe(true);
    expect(c.writes.length).toBe(0);
    expect(err2.text()).toBe('balance: render broke\n');
  });
});
