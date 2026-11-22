// The answering core (S-229, src/core/core) over a memory store (S-242, src/db/index): admission
// by the in-process gate and the store-held ask claim, the receipt that marks exactly the listed
// positions once the reply's write has completed, the release on every failure, the refusal order,
// asOf and asker symmetry, and createCore's configuration check.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load. The type import is erased at run time.

import { describe, expect, test } from 'bun:test';
import type { Family, Question, QuestionContext, Settings } from '../../src/core/question';

const core = () => import('../../src/core/core');
const store = () => import('../../src/db/index');
const holdings = () => import('../../src/families/holdings');

// Saturday 2026-11-21 12:00 in Warsaw.
const NOW = Date.UTC(2026, 10, 21, 11, 0, 0);

const settings = (): Settings => ({ timeZone: undefined, sources: [] });
const render = (a: unknown) => JSON.stringify(a);

// Core fixture K: altbank declares nothing and holds account X9; monobank declares jars and holds
// account A1 and jar J1.
const fixtureK = async () => {
  const { openStore, MEMORY_LOCATION } = await store();
  const s = openStore(MEMORY_LOCATION);
  s.write((tx: any) => {
    tx.registerSource({ id: 'altbank', capabilities: [] });
    tx.registerSource({ id: 'monobank', capabilities: ['jars'] });
    tx.registerHolding({ kind: 'account', sourceId: 'monobank', bankId: 'A1', currency: 'UAH' });
    tx.registerHolding({ kind: 'jar', sourceId: 'monobank', bankId: 'J1', currency: 'UAH' });
    tx.registerHolding({ kind: 'account', sourceId: 'altbank', bankId: 'X9', currency: 'EUR' });
  });
  return s;
};

const claim = (s: any, n: number) =>
  s.write((tx: any) => {
    for (let i = 0; i < n; i++) tx.claimPosition();
  });

// Write resolves at once; the channel never closes.
const channel = () => ({
  write: async (_rendered: string) => {},
  closed: new Promise<void>(() => {}),
});

const ask = (asker: Question['asker'], family: string, extra: Partial<Question> = {}): Question => ({
  asker,
  family,
  options: {},
  ...extra,
});

// Rejects when p has not settled within ms.
const within = <T>(p: Promise<T>, ms = 2000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

// Lists the unmarked positions 1..ctx.position, ascending, and hands them back as pending.
const probeNew: Family = {
  name: 'probe_new',
  period: 'none',
  movesPoint: true,
  compute: (ctx: QuestionContext) => {
    const listed: number[] = [];
    for (let p = 1; p <= ctx.position; p++) if (!ctx.snapshot.isListed(p)) listed.push(p);
    return { kind: 'body', body: { listed }, pending: listed };
  },
};

// A store wrapper that hands each write a transaction whose takeClaim and releaseClaim go through
// the given hooks.
const wrap = (
  s: any,
  hooks: {
    takeClaim?: (tx: any, f: string, t: string, n: number, d: number) => boolean;
    releaseClaim?: (tx: any, f: string, t: string, l: readonly number[] | null) => unknown;
  },
) => ({
  location: s.location,
  readSnapshot: (b: any) => s.readSnapshot(b),
  write: (b: any) =>
    s.write((tx: any) =>
      b({
        db: tx.db,
        claimPosition: () => tx.claimPosition(),
        register: () => tx.register(),
        registerSource: (r: any) => tx.registerSource(r),
        registerHolding: (h: any) => tx.registerHolding(h),
        takeClaim: (f: string, t: string, n: number, d: number) =>
          hooks.takeClaim ? hooks.takeClaim(tx, f, t, n, d) : tx.takeClaim(f, t, n, d),
        releaseClaim: (f: string, t: string, l: readonly number[] | null) =>
          hooks.releaseClaim ? hooks.releaseClaim(tx, f, t, l) : tx.releaseClaim(f, t, l),
      }),
    ),
  close() {},
});

describe('core/core', () => {
  test('a narrowed ask marks exactly its listed positions; a bad pending list marks nothing', async () => {
    const { createCore, PendingPointError } = await core();
    const { openStore, MEMORY_LOCATION } = await store();

    // Ten transactions over twelve claimed positions: 3, 7, 9 and 12 at xbank, 1, 2, 4, 5, 8 and 10
    // at ybank; positions 6 and 11 hold no transaction of this table.
    const s = openStore(MEMORY_LOCATION, [
      (db: any) =>
        db.run('CREATE TABLE IF NOT EXISTS probe_tx (position INTEGER PRIMARY KEY, holding TEXT NOT NULL)'),
    ]);
    const atX = [3, 7, 9, 12];
    const atY = [1, 2, 4, 5, 8, 10];
    s.write((tx: any) => {
      tx.registerSource({ id: 'xbank', capabilities: [] });
      tx.registerSource({ id: 'ybank', capabilities: [] });
      const x = tx.registerHolding({ kind: 'account', sourceId: 'xbank', bankId: 'X1', currency: 'PLN' });
      const y = tx.registerHolding({ kind: 'account', sourceId: 'ybank', bankId: 'Y1', currency: 'PLN' });
      for (let i = 0; i < 12; i++) {
        const p = tx.claimPosition();
        if (atX.includes(p)) tx.db.run('INSERT INTO probe_tx VALUES (?, ?)', [p, x.id]);
        if (atY.includes(p)) tx.db.run('INSERT INTO probe_tx VALUES (?, ?)', [p, y.id]);
      }
    });

    const seen: number[][] = [];
    const scoped: Family = {
      name: 'scoped_new',
      period: 'none',
      movesPoint: true,
      compute: (ctx: QuestionContext) => {
        const rows = ctx.snapshot.db
          .query('SELECT position, holding FROM probe_tx ORDER BY position')
          .all() as { position: number; holding: string }[];
        const listed = rows
          .filter((r) => ctx.scope.holdings.has(r.holding) && !ctx.snapshot.isListed(r.position))
          .map((r) => r.position);
        seen.push(listed);
        return { kind: 'body', body: { listed }, pending: listed };
      },
    };
    const c = createCore({ store: s, now: () => NOW, settings, families: [scoped], contributors: [] } as any);
    const marks = () =>
      s.readSnapshot((snap: any) => Array.from({ length: 12 }, (_, i) => snap.isListed(i + 1)));
    const listedOf = (ps: number[]) => Array.from({ length: 12 }, (_, i) => ps.includes(i + 1));

    const r1 = await within(c.serve(ask('assistant', 'scoped_new', { narrowing: 'xbank' }), render, channel()));
    expect(r1.delivery).toBe('delivered');
    expect(r1.recorded).toEqual([3, 7, 9, 12]);
    expect(marks()).toEqual(listedOf(atX));

    const r2 = await within(c.serve(ask('assistant', 'scoped_new'), render, channel()));
    expect(seen[1]).toEqual(atY);
    expect(r2.recorded).toEqual(atY);
    expect(marks()).toEqual(listedOf([...atX, ...atY]));
    s.close();

    // A fresh store at position 10 and a family whose pending list the test sets.
    const f = openStore(MEMORY_LOCATION);
    claim(f, 10);
    let pending: number[] = [];
    const stub: Family = {
      name: 'stub_new',
      period: 'none',
      movesPoint: true,
      compute: () => ({ kind: 'body', body: {}, pending }),
    };
    const fc = createCore({ store: f, now: () => NOW, settings, families: [stub], contributors: [] } as any);
    let writes = 0;
    const counting = () => ({
      write: async (_rendered: string) => {
        writes++;
      },
      closed: new Promise<void>(() => {}),
    });
    const state = () =>
      f.readSnapshot((snap: any) => [
        Array.from({ length: 10 }, (_, i) => snap.isListed(i + 1)),
        snap.claim('stub_new'),
      ]);
    const none = Array.from({ length: 10 }, () => false);

    for (const bad of [[7, 3], [0], [11]]) {
      pending = bad;
      await expect(within(fc.serve(ask('assistant', 'stub_new'), render, counting()))).rejects.toBeInstanceOf(
        PendingPointError,
      );
      expect(state()).toEqual([none, null]);
    }

    // 3 is marked by an earlier ask; listing it again breaks the pending rule.
    f.write((tx: any) => {
      tx.takeClaim('setup', 'setup-token', NOW, NOW + 1000);
      tx.releaseClaim('setup', 'setup-token', [3]);
    });
    const only3 = none.map((_, i) => i + 1 === 3);
    pending = [3];
    await expect(within(fc.serve(ask('assistant', 'stub_new'), render, counting()))).rejects.toBeInstanceOf(
      PendingPointError,
    );
    expect(state()).toEqual([only3, null]);
    expect(writes).toBe(0);

    // The next assistant ask is admitted at once.
    pending = [1, 2];
    const ok = await within(fc.serve(ask('assistant', 'stub_new'), render, counting()));
    expect(ok.delivery).toBe('delivered');
    expect(ok.recorded).toEqual([1, 2]);

    // A command-line ask of the same family records and marks nothing.
    pending = [4, 5];
    const cl = await within(fc.serve(ask('command_line', 'stub_new'), render, counting()));
    expect(cl.delivery).toBe('delivered');
    expect(cl.recorded).toBeNull();
    expect(state()).toEqual([none.map((_, i) => [1, 2, 3].includes(i + 1)), null]);
    f.close();
  });

  test('receipt marks on delivery', async () => {
    const { createCore } = await core();
    const { holdingsFamily } = await holdings();
    const s = await fixtureK();
    claim(s, 3);
    const c = createCore({
      store: s,
      now: () => NOW,
      settings,
      families: [holdingsFamily, probeNew],
      contributors: [],
    } as any);
    const marks = (n: number) =>
      s.readSnapshot((snap: any) => Array.from({ length: n }, (_, i) => snap.isListed(i + 1)));
    const claimed = () => s.readSnapshot((snap: any) => snap.claim('probe_new'));
    const serve = async (asker: Question['asker'], family: string) =>
      (await c.serve(ask(asker, family), render, channel())) as any;

    // 1.
    let r = await serve('assistant', 'probe_new');
    expect(r.delivery).toBe('delivered');
    expect(r.receipt).toBe(true);
    expect(r.recorded).toEqual([1, 2, 3]);
    expect(r.answer.outcome.body).toEqual({ listed: [1, 2, 3] });
    expect(marks(3)).toEqual([true, true, true]);
    expect(claimed()).toBeNull();

    // 2.
    claim(s, 2);
    r = await serve('assistant', 'probe_new');
    expect(r.answer.outcome.body).toEqual({ listed: [4, 5] });
    expect(r.recorded).toEqual([4, 5]);
    expect(marks(5)).toEqual([true, true, true, true, true]);

    // 3.
    claim(s, 1);
    r = await serve('command_line', 'probe_new');
    expect(r.receipt).toBe(false);
    expect(r.recorded).toBeNull();
    expect(r.delivery).toBe('delivered');
    expect(r.answer.outcome.body).toEqual({ listed: [6] });
    expect(marks(6)[5]).toBe(false);
    expect(claimed()).toBeNull();

    // 4.
    r = await serve('command_line', 'probe_new');
    expect(r.answer.outcome.body).toEqual({ listed: [6] });
    expect(r.recorded).toBeNull();

    // 5.
    r = await serve('assistant', 'holdings');
    expect(r.receipt).toBe(false);
    expect(r.recorded).toBeNull();
    expect(marks(6)[5]).toBe(false);

    // 6.
    r = await serve('assistant', 'probe_new');
    expect(r.answer.outcome.body).toEqual({ listed: [6] });
    expect(r.recorded).toEqual([6]);
    expect(marks(6)).toEqual([true, true, true, true, true, true]);

    s.close();
  });

  test('a capped page marks only what it listed', async () => {
    const { createCore } = await core();
    const s = await fixtureK();
    claim(s, 5);
    const capped: Family = {
      name: 'capped',
      period: 'none',
      movesPoint: true,
      compute: (ctx: QuestionContext) => {
        const listed: number[] = [];
        for (let p = 1; p <= ctx.position && listed.length < 2; p++) if (!ctx.snapshot.isListed(p)) listed.push(p);
        return { kind: 'body', body: { listed }, pending: listed };
      },
    };
    const c = createCore({ store: s, now: () => NOW, settings, families: [capped], contributors: [] } as any);
    const marks = () => s.readSnapshot((snap: any) => [1, 2, 3, 4, 5].map((p) => snap.isListed(p)));
    const serve = async () => (await c.serve(ask('assistant', 'capped'), render, channel())) as any;

    // 1.
    let r = await serve();
    expect(r.answer.outcome.body).toEqual({ listed: [1, 2] });
    expect(r.recorded).toEqual([1, 2]);
    expect(marks()).toEqual([true, true, false, false, false]);

    // 2.
    r = await serve();
    expect(r.answer.outcome.body).toEqual({ listed: [3, 4] });
    expect(r.recorded).toEqual([3, 4]);
    expect(marks()).toEqual([true, true, true, true, false]);

    // 3.
    r = await serve();
    expect(r.answer.outcome.body).toEqual({ listed: [5] });
    expect(r.recorded).toEqual([5]);
    expect(marks()).toEqual([true, true, true, true, true]);

    // 4.
    r = await serve();
    expect(r.answer.outcome.body).toEqual({ listed: [] });
    expect(r.recorded).toEqual([]);
    expect(r.delivery).toBe('delivered');
    expect(s.readSnapshot((snap: any) => snap.claim('capped'))).toBeNull();

    s.close();
  });

  test('failed deliveries mark nothing', async () => {
    const { createCore } = await core();
    const s = await fixtureK();
    claim(s, 3);
    const deps = { store: s, now: () => NOW, settings, families: [probeNew], contributors: [] };
    const c = createCore(deps as any);
    let writes = 0;
    const never = () => new Promise<void>(() => {});
    const after = () =>
      s.readSnapshot((snap: any) => [[1, 2, 3].map((p) => snap.isListed(p)), snap.claim('probe_new')]);
    const q = ask('assistant', 'probe_new');
    const failed = (r: any) => {
      expect(r.delivery).toBe('failed');
      expect(r.receipt).toBe(true);
      expect(r.recorded).toBeNull();
      expect(after()).toEqual([[false, false, false], null]);
    };

    // 1. The write rejects.
    failed(
      await within(
        c.serve(q, render, {
          write: (_t: string) => {
            writes++;
            return Promise.reject(new Error('pipe'));
          },
          closed: never(),
        }),
      ),
    );

    // 2. The write throws synchronously.
    failed(
      await within(
        c.serve(q, render, {
          write: (_t: string): Promise<void> => {
            writes++;
            throw new Error('sync');
          },
          closed: never(),
        }),
      ),
    );

    // 3. The write never settles; the channel is closed first.
    failed(
      await within(
        c.serve(q, render, {
          write: (_t: string) => {
            writes++;
            return never();
          },
          closed: Promise.resolve(),
        }),
      ),
    );

    // 4. Render throws; write is not called.
    const before = writes;
    failed(
      await within(
        c.serve(
          q,
          () => {
            throw new Error('render');
          },
          {
            write: async (_t: string) => {
              writes++;
            },
            closed: never(),
          },
        ),
      ),
    );
    expect(writes).toBe(before);

    // 5. The marking release write throws; the claim write and the empty release go through.
    const w = wrap(s, {
      releaseClaim: (tx, f, t, l) => {
        if (l !== null) throw new Error('disk full');
        return tx.releaseClaim(f, t, l);
      },
    });
    const c2 = createCore({ ...deps, store: w } as any);
    const beforeRelease = writes;
    failed(
      await within(
        c2.serve(q, render, {
          write: async (_t: string) => {
            writes++;
          },
          closed: never(),
        }),
      ),
    );
    expect(writes).toBe(beforeRelease + 1);

    // 6. A completed delivery on the original core.
    const r = (await within(c.serve(q, render, channel()))) as any;
    expect(r.delivery).toBe('delivered');
    expect(r.recorded).toEqual([1, 2, 3]);
    expect(r.answer.outcome.body).toEqual({ listed: [1, 2, 3] });
    expect(after()).toEqual([[true, true, true], null]);

    s.close();
  });

  test('thrown questions release the claim and the gate', async () => {
    const { createCore, PendingPointError } = await core();
    const s = await fixtureK();
    claim(s, 3);
    const body = (pending?: number[]) => (pending === undefined ? { kind: 'body', body: {} } : { kind: 'body', body: {}, pending });
    const families: Family[] = [
      probeNew,
      { name: 'no_pending', period: 'none', movesPoint: true, compute: () => body() as any },
      { name: 'too_far', period: 'none', movesPoint: true, compute: (ctx) => body([ctx.position + 1]) as any },
      { name: 'fractional', period: 'none', movesPoint: true, compute: () => body([1.5]) as any },
      { name: 'descending', period: 'none', movesPoint: true, compute: () => body([2, 1]) as any },
      {
        name: 'boom',
        period: 'none',
        movesPoint: true,
        compute: () => {
          throw new Error('kaput');
        },
      },
      { name: 'quiet', period: 'none', movesPoint: false, compute: () => body() as any },
    ];
    const contrib = {
      key: 'c',
      contribute: (ctx: QuestionContext) => {
        if (ctx.options.explode) throw new Error('contrib');
        return 1;
      },
    };
    const c = createCore({ store: s, now: () => NOW, settings, families, contributors: [contrib] } as any);
    let writes = 0;
    let renders = 0;
    const counted = (a: unknown) => {
      renders++;
      return JSON.stringify(a);
    };
    const ch = () => ({
      write: async (_t: string) => {
        writes++;
      },
      closed: new Promise<void>(() => {}),
    });
    const clean = (f: string) =>
      s.readSnapshot((snap: any) => [[1, 2, 3].map((p) => snap.isListed(p)), snap.claim(f)]);

    // 1.
    for (const name of ['no_pending', 'too_far', 'fractional', 'descending']) {
      await expect(within(c.serve(ask('assistant', name), counted, ch()))).rejects.toBeInstanceOf(PendingPointError);
      expect(clean(name)).toEqual([[false, false, false], null]);
    }

    // 2.
    await expect(within(c.serve(ask('assistant', 'boom'), counted, ch()))).rejects.toThrow('kaput');
    expect(clean('boom')).toEqual([[false, false, false], null]);

    // 3.
    await expect(
      within(c.serve(ask('assistant', 'quiet', { options: { explode: true } }), counted, ch())),
    ).rejects.toThrow('contrib');

    // 4.
    expect(renders).toBe(0);
    expect(writes).toBe(0);

    // 5. Without a receipt pending is ignored.
    const r5 = (await within(c.serve(ask('command_line', 'no_pending'), counted, ch()))) as any;
    expect(r5.delivery).toBe('delivered');
    expect(r5.recorded).toBeNull();

    // 6.
    const r6 = (await within(c.serve(ask('assistant', 'probe_new'), counted, ch()))) as any;
    expect(r6.recorded).toEqual([1, 2, 3]);

    s.close();
  });

  test('admission gate', async () => {
    const { createCore, ASK_CLAIM_RETRY_MS } = await core();
    const s = await fixtureK();
    claim(s, 3);
    let takes = 0;
    const w = wrap(s, {
      takeClaim: (tx, f, t, n, d) => {
        takes++;
        return tx.takeClaim(f, t, n, d);
      },
    });
    const calls: string[] = [];
    const probe: Family = {
      ...probeNew,
      compute: (ctx: QuestionContext) => {
        calls.push(ctx.asker);
        return probeNew.compute(ctx);
      },
    };
    const c = createCore({ store: w, now: () => NOW, settings, families: [probe], contributors: [] } as any);

    let release!: () => void;
    const d1 = new Promise<void>((resolve) => {
      release = resolve;
    });
    let aCalled = false;
    const chA = {
      write: (_t: string) => {
        aCalled = true;
        return d1;
      },
      closed: new Promise<void>(() => {}),
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const pause = () => new Promise((r) => setTimeout(r, 4 * ASK_CLAIM_RETRY_MS + 20));

    // 1.
    const p1 = c.serve(ask('assistant', 'probe_new'), render, chA);
    for (let i = 0; i < 50 && !aCalled; i++) await tick();
    expect(aCalled).toBe(true);
    expect(takes).toBe(1);

    // 2.
    claim(s, 2);
    const p2 = c.serve(ask('assistant', 'probe_new'), render, channel());
    const r3 = (await c.serve(ask('command_line', 'probe_new'), render, channel())) as any;
    await pause();

    // 3.
    expect(calls).toEqual(['assistant', 'command_line']);
    expect(r3.answer.outcome.body).toEqual({ listed: [1, 2, 3, 4, 5] });
    expect(r3.recorded).toBeNull();
    expect(takes).toBe(1);

    // 4.
    release();
    const r1 = (await p1) as any;
    expect(r1.recorded).toEqual([1, 2, 3]);

    // 5.
    const r2 = (await p2) as any;
    expect(r2.answer.outcome.body).toEqual({ listed: [4, 5] });
    expect(r2.recorded).toEqual([4, 5]);
    expect(calls).toEqual(['assistant', 'command_line', 'assistant']);
    expect(takes).toBe(2);
    expect(s.readSnapshot((snap: any) => [1, 2, 3, 4, 5].map((p) => snap.isListed(p)))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);

    s.close();
  });

  test('refusal order', async () => {
    const { createCore } = await core();
    const s = await fixtureK();
    let tz: string | undefined;
    const families: Family[] = [
      { name: 'req_fam', period: 'required', movesPoint: false, compute: () => ({ kind: 'body', body: {} }) },
      { name: 'none_fam', period: 'none', movesPoint: false, compute: () => ({ kind: 'body', body: {} }) },
    ];
    const c = createCore({
      store: s,
      now: () => NOW,
      settings: (): Settings => ({ timeZone: tz, sources: [] }),
      families,
      contributors: [],
    } as any);
    const texts: string[] = [];
    const ch = () => ({
      write: async (t: string) => {
        texts.push(t);
      },
      closed: new Promise<void>(() => {}),
    });

    // Asks under both askers; both resolve with the same refusal, which the channel received.
    const refusal = async (draft: Omit<Question, 'asker' | 'options'>, want: Record<string, string>) => {
      const answers: any[] = [];
      for (const asker of ['assistant', 'command_line'] as const) {
        const r = (await c.serve({ asker, options: {}, ...draft }, render, ch())) as any;
        expect(r.answer.kind).toBe('refused');
        expect(r.answer).toMatchObject(want);
        expect(texts[texts.length - 1]).toBe(JSON.stringify(r.answer));
        answers.push(r.answer);
      }
      expect(answers[0]).toEqual(answers[1]);
    };

    // 1.
    tz = 'Mars/Base';
    await refusal(
      { family: 'nope', displayCurrency: 'GBP', narrowing: 'Monobank' },
      { reason: 'unknown_time_zone', subject: 'timeZone', value: 'Mars/Base' },
    );

    // 2.
    tz = undefined;
    await refusal({ family: 'nope', displayCurrency: 'GBP' }, { reason: 'bad_option', subject: 'family' });

    // 3.
    await refusal(
      { family: 'req_fam', displayCurrency: 'GBP', narrowing: 'Monobank', period: 'Last-week' },
      { reason: 'bad_display_currency', subject: 'displayCurrency' },
    );

    // 4.
    await refusal(
      { family: 'req_fam', narrowing: 'Monobank', period: 'Last-week' },
      { reason: 'scope_not_found', subject: 'Monobank' },
    );

    // 5.
    await refusal(
      { family: 'req_fam', period: 'Last-week' },
      { reason: 'bad_period', subject: 'form', value: 'Last-week' },
    );

    // 6.
    await refusal({ family: 'none_fam', period: 'today' }, { reason: 'bad_option', subject: 'period' });

    // 7.
    await refusal({ family: 'req_fam' }, { reason: 'bad_period', subject: 'missing' });

    // 8.
    await refusal(
      { family: 'req_fam', period: 'last-0-days' },
      { reason: 'bad_period', subject: 'n', value: '0' },
    );

    const e = ((await c.serve(ask('assistant', 'req_fam', { period: 'today' }), render, ch())) as any).answer;
    expect(e.kind).toBe('envelope');
    expect(e.displayCurrency).toBe('PLN');
    expect(e.timeZone).toBe('Europe/Warsaw');

    s.close();
  });

  test('asOf, askers and configuration', async () => {
    const { createCore, CoreConfigError } = await core();
    const { holdingsFamily } = await holdings();
    const s = await fixtureK();
    claim(s, 3);
    let tz: string | undefined;
    const deps = {
      store: s,
      now: () => NOW,
      settings: (): Settings => ({ timeZone: tz, sources: [] }),
      families: [holdingsFamily],
      contributors: [],
    };
    const c = createCore(deps as any);
    const envelope = async (asker: Question['asker']) =>
      ((await c.serve(ask(asker, 'holdings', { narrowing: 'monobank' }), render, channel())) as any).answer;

    tz = undefined;
    const e1 = await envelope('assistant');
    const e2 = await envelope('command_line');
    expect(e1.asker).toBe('assistant');
    expect(e2.asker).toBe('command_line');
    const { asker: _a1, ...rest1 } = e1;
    const { asker: _a2, ...rest2 } = e2;
    expect(rest1).toEqual(rest2);
    expect(e1.asOf).toEqual({ instant: NOW, localDateTime: '2026-11-21T12:00:00+01:00', position: 3 });
    expect(e1.timeZone).toBe('Europe/Warsaw');

    tz = 'UTC';
    const eu = await envelope('assistant');
    expect(eu.asOf.localDateTime).toBe('2026-11-21T11:00:00+00:00');
    expect(eu.timeZone).toBe('UTC');

    tz = 'America/New_York';
    const en = await envelope('assistant');
    expect(en.asOf.localDateTime).toBe('2026-11-21T06:00:00-05:00');

    expect(() => createCore({ ...deps, families: [holdingsFamily, holdingsFamily] } as any)).toThrow(CoreConfigError);
    expect(() =>
      createCore({
        ...deps,
        contributors: [
          { key: 'c', contribute: () => 1 },
          { key: 'c', contribute: () => 2 },
        ],
      } as any),
    ).toThrow(CoreConfigError);

    s.close();
  });
});
