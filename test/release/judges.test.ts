// Release judges (S-238): one pure judge per promise from src/release/judges, over what the phases
// observed and what the stand-ins (S-236) recorded. Records, answer values and settings are built
// here by hand; the dataset is the worked draw of S-233. Nothing is spawned and nothing is served.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const judges = () => import('../../src/release/judges');
const standIns = () => import('../../src/release/stand-ins');
const dataset = () => import('../../src/release/dataset');

const T0 = Date.UTC(2026, 10, 22, 10, 7, 37);
const RUN_ID = 'abcdefgh';

const workedDraw = async () => (await dataset()).buildDataset(T0, RUN_ID);

// The pinned runtime (S-240): package.json's engines.bun is the reference pin.
const BUN_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).engines.bun;

type Verdict = { pass: true } | { pass: false; observed: string[] };

// The observations of a failed verdict; a pass fails the test here, naming the judge.
function observedOf(v: Verdict, what: string): string[] {
  if (v.pass) throw new Error(`${what}: expected a fail, got a pass`);
  expect(v.observed.length).toBeGreaterThan(0);
  return v.observed;
}

// True iff some single observation contains every given text.
const someNames = (observed: string[], ...texts: string[]) =>
  observed.some((o) => texts.every((t) => o.includes(t)));

// A seq named as 'seq <n>', tolerating 'seq=<n>' or 'seq: <n>'.
const namesSeq = (o: string, n: number) => new RegExp(`seq\\D{0,3}${n}(?!\\d)`).test(o);

const clone = <T>(v: T): T => structuredClone(v);

describe('release/judges', () => {
  test('rate limits judged from call records', async () => {
    const { judgeRateLimits } = await judges();
    const { MONOBANK_STAND_IN_LIMITS, SECOND_STAND_IN_LIMITS } = await standIns();

    const rec = (seq: number, at: number, callClass: string, status = 200, refused = false) => ({
      seq,
      at,
      callClass,
      path: '/personal/statement/acc-uah/1',
      remote: '127.0.0.1',
      status,
      refused,
    });

    // A: the second statement call is one millisecond inside the first's window; nothing refused.
    const A = [rec(1, 0, 'statement'), rec(2, 59_999, 'statement')];
    const a = observedOf(judgeRateLimits(A, MONOBANK_STAND_IN_LIMITS, 'monobank'), 'A');
    expect(
      a.some(
        (o) =>
          o.includes('monobank') &&
          o.includes('statement') &&
          ((namesSeq(o, 1) && namesSeq(o, 2)) || (/\b1\b/.test(o) && /\b2\b/.test(o) && /\b0\b/.test(o) && o.includes('59999'))),
      ),
    ).toBe(true);

    // B: exactly a window apart (the window is half-open).
    const B = [rec(1, 0, 'statement'), rec(2, 60_000, 'statement')];
    expect(judgeRateLimits(B, MONOBANK_STAND_IN_LIMITS, 'monobank')).toEqual({ pass: true });

    // C: a refused record fails on its own, however far from the others.
    const C = [...B, rec(3, 200_000, 'client-info', 429, true)];
    const c = observedOf(judgeRateLimits(C, MONOBANK_STAND_IN_LIMITS, 'monobank'), 'C');
    expect(c.some((o) => namesSeq(o, 3))).toBe(true);

    // D: twenty currency calls in 20 ms (a class no limit counts), one client-info and one statement.
    const D = [
      ...Array.from({ length: 20 }, (_, i) => rec(i + 1, i, 'currency')),
      rec(21, 0, 'client-info'),
      rec(22, 0, 'statement'),
    ];
    expect(judgeRateLimits(D, MONOBANK_STAND_IN_LIMITS, 'monobank')).toEqual({ pass: true });

    // The second stand-in: five calls of any class per 10 s.
    const six = (step: number) =>
      Array.from({ length: 6 }, (_, i) => ({
        ...rec(i + 1, i * step, i % 2 === 0 ? 'accounts' : 'transactions'),
        path: i % 2 === 0 ? '/v1/accounts' : '/v1/accounts/sec-pln/transactions',
      }));
    const crowded = observedOf(judgeRateLimits(six(1000), SECOND_STAND_IN_LIMITS, 'second'), 'six in 5 s');
    expect(crowded.some((o) => [1, 2, 3, 4, 5, 6].every((n) => namesSeq(o, n)))).toBe(true);
    expect(judgeRateLimits(six(2000), SECOND_STAND_IN_LIMITS, 'second')).toEqual({ pass: true });
  });

  test('expected figures in PLN minor units', async () => {
    const { expectedPlnMinor, expectedNetPosition, servedText } = await judges();
    const ds = await workedDraw();

    // One exact product, rounded once, half away from zero.
    expect(expectedPlnMinor(-100n, 'USD')).toBe(-366n);
    expect(expectedPlnMinor(-444n, 'UAH')).toBe(-44n);
    expect(expectedPlnMinor(-445n, 'UAH')).toBe(-45n);
    expect(expectedPlnMinor(445n, 'UAH')).toBe(45n);
    expect(expectedPlnMinor(10_003n, 'EUR')).toBe(40_262n);
    expect(expectedPlnMinor(-277n, 'EUR')).toBe(-1_115n);
    expect(expectedPlnMinor(-1_503n, 'EUR')).toBe(-6_050n);
    expect(expectedPlnMinor(-999n, 'EUR')).toBe(-4_021n);
    expect(expectedPlnMinor(-5n, 'PLN')).toBe(-5n);

    // Own money: acc-uah's balance less its credit limit, acc-usd, the jar; then the second source.
    expect(expectedNetPosition(ds, false)).toBe(141_555n);
    expect(expectedNetPosition(ds, true)).toBe(431_818n);

    expect(servedText(141_555n)).toBe('1415.55');
    expect(servedText(-5n)).toBe('-0.05');
    expect(servedText(-200n)).toBe('-2.00');
    expect(servedText(431_818n)).toBe('4318.18');
    expect(servedText(0n)).toBe('0.00');
  });

  test('masked comparison of answer values', async () => {
    const { maskedDifference } = await judges();

    const before = {
      asOf: { instant: 1000 },
      statements: {
        coveredRanges: [
          {
            sourceId: 'monobank',
            ranges: [
              { startAt: 0, endAt: 60_000, start: 'a', end: 'b' },
              { startAt: 120_000, endAt: 600_000, start: 'c', end: 'd' },
            ],
          },
        ],
      },
      outcome: {
        body: {
          accounts: [{ ownMoney: { shown: { amount: '750.00', currency: 'PLN' }, asOf: 5 } }],
          rows: [{ category: 'Groceries', merchant: 'X' }],
        },
      },
    };
    const ranges = (v: typeof before) => v.statements.coveredRanges[0].ranges;

    expect(maskedDifference(before, clone(before))).toBeNull();

    // 1. Only clock-moved fields differ: every asOf, and the last range's end moved later.
    const c1 = clone(before);
    c1.asOf.instant = 2000;
    c1.outcome.body.accounts[0].ownMoney.asOf = 9;
    ranges(c1)[1].endAt = 660_000;
    ranges(c1)[1].end = 'e';
    expect(maskedDifference(before, c1)).toBeNull();

    // 2. A changed figure: its full path.
    const c2 = clone(before);
    c2.outcome.body.accounts[0].ownMoney.shown.amount = '751.00';
    const d2 = maskedDifference(before, c2);
    expect(d2).not.toBeNull();
    expect(d2!).toContain('outcome.body.accounts[0].ownMoney.shown.amount');

    // 3. A reclassified line.
    const c3 = clone(before);
    c3.outcome.body.rows[0].category = 'Restaurants';
    const d3 = maskedDifference(before, c3);
    expect(d3).not.toBeNull();
    expect(d3!).toContain('rows[0].category');

    // 4. The last range's start is not masked.
    const c4 = clone(before);
    ranges(c4)[1].startAt = 180_000;
    expect(typeof maskedDifference(before, c4)).toBe('string');

    // 5. The last range's end moved earlier.
    const c5 = clone(before);
    ranges(c5)[1].endAt = 540_000;
    expect(typeof maskedDifference(before, c5)).toBe('string');

    // 6. Only the last range's end is masked, not the first's.
    const c6 = clone(before);
    ranges(c6)[0].endAt = 90_000;
    expect(typeof maskedDifference(before, c6)).toBe('string');

    // 7. The number of ranges must match.
    const c7 = clone(before);
    ranges(c7).push({ startAt: 700_000, endAt: 800_000, start: 'f', end: 'g' });
    expect(typeof maskedDifference(before, c7)).toBe('string');
  });

  test('new pages list the second source exactly once', async () => {
    const { judgeNewPages, rowsOf } = await judges();
    const ds = await workedDraw();

    const ids = ds.second.initial.map((t) => t.id);
    expect(ids.length).toBe(9);
    const row = (sourceId: string, bankId: string) => ({
      sourceId,
      bankId,
      amount: '-1.00',
      shown: '-1.00',
      category: 'Other',
      merchant: 'm',
    });
    const page = (rows: ReturnType<typeof row>[]) => ({ outcome: { body: { rows } } });
    const second = (bankIds: string[]) => bankIds.map((b) => row('second', b));

    const good = [page(second(ids.slice(0, 5))), page(second(ids.slice(5))), page([])];
    expect(judgeNewPages(good, ds)).toEqual({ pass: true });

    const monoId = ds.monobank.initial[1].id;
    const withMono = [good[0], page([...second(ids.slice(5)), row('monobank', monoId)]), good[2]];
    expect(someNames(observedOf(judgeNewPages(withMono, ds), 'withMono'), monoId)).toBe(true);

    // Nine distinct ids still, one of them twice.
    const repeated = [good[0], page(second([...ids.slice(5), ids[2]])), good[2]];
    expect(someNames(observedOf(judgeNewPages(repeated, ds), 'repeated'), ids[2])).toBe(true);

    const missing = [good[0], page(second(ids.slice(5, 8))), good[2]];
    expect(someNames(observedOf(judgeNewPages(missing, ds), 'missing'), ids[8])).toBe(true);

    const firstRows = rowsOf(page(second(ids.slice(0, 5))));
    expect(firstRows.length).toBe(5);
    expect(firstRows.every((r) => r.sourceId === 'second')).toBe(true);
  });

  test('narrowed and bound judges', async () => {
    const { judgeNarrowedToSecond, judgeAnswerBound } = await judges();
    const ds = await workedDraw();

    // Narrowed to the second source.
    const ok = { outcome: { body: { rows: [{ sourceId: 'second', bankId: 'x', description: 'abcdefgh-0021' }] } } } as {
      outcome: { body: { rows: { [k: string]: string }[]; note?: string } };
    };
    expect(judgeNarrowedToSecond(ok, ds)).toEqual({ pass: true });

    const monoRow = clone(ok);
    monoRow.outcome.body.rows.push({ sourceId: 'monobank', bankId: 'y' });
    observedOf(judgeNarrowedToSecond(monoRow, ds), 'monoRow');

    // A Monobank marker in the text, on an object with no sourceId.
    const monoText = clone(ok);
    monoText.outcome.body.note = 'abcdefgh-0005';
    observedOf(judgeNarrowedToSecond(monoText, ds), 'monoText');

    const pairText = clone(ok);
    pairText.outcome.body.note = 'pair-abcdefgh';
    observedOf(judgeNarrowedToSecond(pairText, ds), 'pairText');

    // Answers from the local copy only.
    const cov = { coveredRanges: [{ sourceId: 'monobank', ranges: [] }] };
    const ans = (elapsedMs: number, refused: boolean, statements: object) =>
      ({ kind: 'answer', value: { statements }, text: 't', refused, elapsedMs }) as any;

    const r1 = { tool: 'balance', scope: 'combined', result: ans(120, false, cov) };
    expect(judgeAnswerBound([r1])).toEqual({ pass: true });

    const r2 = {
      tool: 'jars',
      scope: 'combined',
      result: { kind: 'failed', reason: 'no answer within 10 s', elapsedMs: 10_000 } as any,
    };
    expect(someNames(observedOf(judgeAnswerBound([r2]), 'r2'), 'jars', 'no answer within 10 s')).toBe(true);

    const r3 = { tool: 'balance', scope: 'combined', result: ans(50, true, cov) };
    expect(observedOf(judgeAnswerBound([r3]), 'r3').some((o) => /refus/i.test(o))).toBe(true);

    const r4 = { tool: 'balance', scope: 'combined', result: ans(10_001, false, cov) };
    observedOf(judgeAnswerBound([r4]), 'r4');

    const r5 = { tool: 'balance', scope: 'combined', result: ans(10, false, {}) };
    expect(observedOf(judgeAnswerBound([r5]), 'r5').some((o) => /covered/i.test(o))).toBe(true);

    expect(observedOf(judgeAnswerBound([r1, r2, r3]), 'r1..r3').length).toBeGreaterThanOrEqual(2);
  });

  test('single machine', async () => {
    const { judgeSingleMachine } = await judges();

    const rec = (seq: number, remote: string) => ({
      seq,
      at: seq * 1000,
      callClass: 'statement',
      path: '/personal/statement/acc-uah/1',
      remote,
      status: 200,
      refused: false,
    });
    const records = [rec(1, '127.0.0.1'), rec(2, '::1'), rec(3, '::ffff:127.0.0.1')];
    const folder = '/tmp/arcanum-release-x';
    const settings: Record<string, string> = {
      ARCANUM_STORAGE: '/tmp/arcanum-release-x/arcanum.db',
      ARCANUM_MONOBANK_BASE_URL: 'http://127.0.0.1:41001',
      ARCANUM_MONOBANK_PUSH_URL: 'http://127.0.0.1:41003',
      ARCANUM_SECOND_BASE_URL: 'http://127.0.0.1:41002',
    };

    expect(judgeSingleMachine(records, BUN_VERSION, settings, folder)).toEqual({ pass: true });

    const remote = observedOf(judgeSingleMachine([...records, rec(4, '10.0.0.5')], BUN_VERSION, settings, folder), 'remote');
    expect(someNames(remote, '10.0.0.5')).toBe(true);

    const runtime = observedOf(judgeSingleMachine(records, '0.0.1', settings, folder), 'runtime');
    expect(someNames(runtime, '0.0.1', BUN_VERSION)).toBe(true);

    // A loopback name is not the loopback address.
    observedOf(
      judgeSingleMachine(records, BUN_VERSION, { ...settings, ARCANUM_SECOND_BASE_URL: 'http://localhost:41002' }, folder),
      'localhost',
    );

    observedOf(
      judgeSingleMachine(records, BUN_VERSION, { ...settings, ARCANUM_STORAGE: '/tmp/other/arcanum.db' }, folder),
      'storage elsewhere',
    );

    // A sibling sharing the folder's name as a prefix is not inside it.
    observedOf(
      judgeSingleMachine(records, BUN_VERSION, { ...settings, ARCANUM_STORAGE: '/tmp/arcanum-release-xy/arcanum.db' }, folder),
      'sibling folder',
    );
  });

  test('fixture account narrowing', async () => {
    const { holdingNameFor } = await judges();

    const v1 = {
      outcome: {
        body: {
          accounts: [
            { holdingId: 'monobank:account:acc-uah' } as { holdingId: string; nested?: { holdingId: string } },
            { holdingId: 'monobank:account:acc-usd', nested: { holdingId: 'monobank:account:acc-usd' } },
          ],
          jars: [{ holdingId: 'monobank:jar:jar-1' }],
        },
      },
    };
    const v2 = clone(v1);
    v2.outcome.body.accounts = [{ holdingId: 'monobank:account:acc-uah' }];
    const v3 = clone(v1);
    v3.outcome.body.accounts.push({ holdingId: 'monobank:jar:acc-usd' });

    // The repeated value counts once.
    expect(holdingNameFor(v1, 'monobank', 'acc-usd')).toEqual({ name: 'monobank:account:acc-usd' });

    // None kept: every distinct holdingId, first-seen order.
    expect(holdingNameFor(v2, 'monobank', 'acc-usd')).toEqual({
      name: null,
      seen: ['monobank:account:acc-uah', 'monobank:jar:jar-1'],
    });

    // The source prefix must match too.
    expect(holdingNameFor(v1, 'second', 'acc-usd').name).toBeNull();

    // Two distinct values keep the suffix: several give null.
    const several = holdingNameFor(v3, 'monobank', 'acc-usd');
    expect(several.name).toBeNull();
    expect((several as { seen: string[] }).seen.length).toBe(4);
  });
});
