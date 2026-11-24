// Process entry (S-249): main's dispatch on the first word, which commands it gates (service,
// backfill, release-check) and what it hands each starter, mcp-http included; hostVariables; and a
// rejecting starter becoming one stderr line and exit 1.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const entry = () => import('../../src/app/main');
const sources = () => import('../../src/app/sources');

type Ctx = {
  record: any;
  sources: readonly string[];
  args: readonly string[];
  host: Readonly<Record<string, string>>;
  io: unknown;
};
type Name = 'service' | 'assistant' | 'assistantHttp' | 'question' | 'backfill' | 'releaseCheck';

const CODES: Record<Name, number> = {
  service: 10,
  assistant: 11,
  assistantHttp: 15,
  question: 12,
  backfill: 13,
  releaseCheck: 14,
};

// Stub starters, each recording its ctx and resolving its own code unless overridden.
function stubs(overrides: Partial<Record<Name, (ctx: Ctx) => Promise<number>>> = {}) {
  const calls: Record<Name, Ctx[]> = {
    service: [],
    assistant: [],
    assistantHttp: [],
    question: [],
    backfill: [],
    releaseCheck: [],
  };
  const make = (name: Name) => async (ctx: Ctx) => {
    calls[name].push(ctx);
    const o = overrides[name];
    return o !== undefined ? o(ctx) : CODES[name];
  };
  const starters = {
    service: make('service'),
    assistant: make('assistant'),
    assistantHttp: make('assistantHttp'),
    question: make('question'),
    backfill: make('backfill'),
    releaseCheck: make('releaseCheck'),
  };
  const total = () => Object.values(calls).reduce((n, c) => n + c.length, 0);
  return { starters, calls, total };
}

function collectingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (text: string) => void out.push(text), stderr: (line: string) => void err.push(line) }, out, err };
}

describe('app/main', () => {
  test('dispatch and gating', async () => {
    const { main } = await entry();
    const { BUILT_GROUPS } = await sources();

    // 1. service with no settings: the gate's two lines, 78, no starter.
    {
      const s = stubs();
      const c = collectingIo();
      expect(await main(['service'], {}, BUILT_GROUPS, s.starters as any, c.io)).toBe(78);
      expect(c.err.length).toBe(2);
      expect(c.err[0]).toContain('ARCANUM_STORAGE');
      expect(c.err[1]).toContain('ARCANUM_MONOBANK_TOKEN');
      expect(s.total()).toBe(0);
    }

    // 2. mcp goes ungated to the assistant starter.
    {
      const s = stubs();
      const c = collectingIo();
      expect(await main(['mcp'], {}, BUILT_GROUPS, s.starters as any, c.io)).toBe(11);
      expect(s.calls.assistant.length).toBe(1);
      expect(s.calls.assistant[0]!.sources).toEqual([]);
      expect(s.calls.assistant[0]!.args).toEqual([]);
      expect(s.total()).toBe(1);
      expect(c.err).toEqual([]);
    }

    // 3. any other first word, or none: ungated question starter with the whole argv.
    {
      const s = stubs();
      const c = collectingIo();
      expect(await main(['balance'], {}, BUILT_GROUPS, s.starters as any, c.io)).toBe(12);
      expect(s.calls.question.length).toBe(1);
      expect(s.calls.question[0]!.args).toEqual(['balance']);
      expect(s.calls.question[0]!.sources).toEqual([]);
      expect(c.err).toEqual([]);

      expect(await main(['balance', '--display-currency', 'EUR'], {}, BUILT_GROUPS, s.starters as any, c.io)).toBe(
        12,
      );
      expect(s.calls.question[1]!.args).toEqual(['balance', '--display-currency', 'EUR']);

      expect(await main([], {}, BUILT_GROUPS, s.starters as any, c.io)).toBe(12);
      expect(s.calls.question[2]!.args).toEqual([]);
      expect(s.calls.question[2]!.sources).toEqual([]);
      expect(s.total()).toBe(3);
    }

    // 4. backfill without a source: the usage line and 2, gate not run.
    {
      const s = stubs();
      const c = collectingIo();
      expect(await main(['backfill'], {}, BUILT_GROUPS, s.starters as any, c.io)).toBe(2);
      expect(c.err).toEqual(['usage: backfill <source> <YYYY-MM-DD..YYYY-MM-DD> | --all']);
      expect(s.total()).toBe(0);
    }

    // 5. backfill of a switched-off source: refused by the gate.
    {
      const s = stubs();
      const c = collectingIo();
      expect(
        await main(['backfill', 'second', '--all'], { ARCANUM_STORAGE: ':memory:' }, BUILT_GROUPS, s.starters as any, c.io),
      ).toBe(78);
      expect(c.err).toContain('source second is switched off (ARCANUM_SECOND_ENABLED)');
      expect(s.total()).toBe(0);
    }

    // 6. backfill of a switched-on source: the source id goes to sources, not args.
    {
      const s = stubs();
      const c = collectingIo();
      const env = {
        ARCANUM_STORAGE: ':memory:',
        ARCANUM_MONOBANK_ENABLED: 'off',
        ARCANUM_SECOND_ENABLED: 'on',
        ARCANUM_SECOND_BASE_URL: 'http://127.0.0.1:9',
        ARCANUM_SECOND_TOKEN: 't',
      };
      expect(await main(['backfill', 'second', '--all'], env, BUILT_GROUPS, s.starters as any, c.io)).toBe(13);
      expect(s.calls.backfill.length).toBe(1);
      expect(s.calls.backfill[0]!.sources).toEqual(['second']);
      expect(s.calls.backfill[0]!.args).toEqual(['--all']);
      expect(s.total()).toBe(1);
      expect(c.err).toEqual([]);
    }

    // 7. release-check requires no setting.
    {
      const s = stubs();
      const c = collectingIo();
      expect(await main(['release-check'], {}, BUILT_GROUPS, s.starters as any, c.io)).toBe(14);
      expect(s.calls.releaseCheck.length).toBe(1);
      expect(s.calls.releaseCheck[0]!.args).toEqual([]);
      expect(s.total()).toBe(1);
      expect(c.err).toEqual([]);
    }
  });

  test('host variables and starter failure', async () => {
    const { main, hostVariables, HOST_VARIABLES, STARTER_FAILURE_EXIT } = await entry();
    const { BUILT_GROUPS } = await sources();

    expect(HOST_VARIABLES).toEqual(['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT']);
    expect(STARTER_FAILURE_EXIT).toBe(1);

    const env = {
      HOME: '/home/x',
      SYSTEMROOT: 'C:\\Windows',
      TMPDIR: undefined,
      PATH: '/usr/bin',
      ARCANUM_STORAGE: ':memory:',
      ARCANUM_MONOBANK_TOKEN: 'real',
      TEMP: '/t',
    };
    const h = hostVariables(env);
    expect(Object.keys(h)).toEqual(['PATH', 'TEMP', 'SYSTEMROOT']);
    expect(h).toEqual({ PATH: '/usr/bin', TEMP: '/t', SYSTEMROOT: 'C:\\Windows' });
    expect(h.PATH).toBe('/usr/bin');
    expect(Object.isFrozen(h)).toBe(true);
    expect(hostVariables({})).toEqual({});

    // main hands the host variables, and the one settings record, to the starter.
    {
      const s = stubs();
      const c = collectingIo();
      expect(await main(['mcp'], env, BUILT_GROUPS, s.starters as any, c.io)).toBe(11);
      expect(s.calls.assistant.length).toBe(1);
      const ctx = s.calls.assistant[0]!;
      expect(ctx.host).toEqual(h);
      expect(Object.keys(ctx.host)).toEqual(['PATH', 'TEMP', 'SYSTEMROOT']);
      expect(ctx.record.shared.storage).toEqual({ state: 'given', name: 'ARCANUM_STORAGE', value: ':memory:' });
      expect(ctx.io).toBe(c.io);
    }

    // An ungated starter rejecting: one stderr line, exit 1, main never rejects.
    {
      const s = stubs({ question: () => Promise.reject(new Error('boom')) });
      const c = collectingIo();
      const code = await main(['holdings'], {}, BUILT_GROUPS, s.starters as any, c.io);
      expect(code).toBe(STARTER_FAILURE_EXIT);
      expect(c.err).toEqual(['boom']);
      expect(s.calls.question.length).toBe(1);
    }

    // A gated starter rejecting after a passing gate: the same.
    {
      const s = stubs({ service: () => Promise.reject(new Error('x')) });
      const c = collectingIo();
      const code = await main(
        ['service'],
        { ARCANUM_STORAGE: ':memory:', ARCANUM_MONOBANK_TOKEN: 't' },
        BUILT_GROUPS,
        s.starters as any,
        c.io,
      );
      expect(code).toBe(1);
      expect(c.err).toEqual(['x']);
      expect(s.calls.service.length).toBe(1);
    }
  });

  test('mcp-http dispatch', async () => {
    const { main } = await entry();
    const { BUILT_GROUPS } = await sources();

    // Every starter resolves 7, so the exit code alone cannot tell which one ran.
    const seven = async () => 7;
    const s = stubs({
      service: seven,
      assistant: seven,
      assistantHttp: seven,
      question: seven,
      backfill: seven,
      releaseCheck: seven,
    });
    const c = collectingIo();
    // Ungated, though ARCANUM_STORAGE and the Monobank token are absent.
    expect(await main(['mcp-http'], {}, BUILT_GROUPS, s.starters as any, c.io)).toBe(7);
    expect(s.calls.assistantHttp.length).toBe(1);
    expect(s.calls.assistantHttp[0]!.sources).toEqual([]);
    expect(s.calls.assistantHttp[0]!.args).toEqual([]);
    expect(s.total()).toBe(1);
    expect(c.err).toEqual([]);
  });
});
