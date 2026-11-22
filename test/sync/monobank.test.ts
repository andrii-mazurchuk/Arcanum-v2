// Monobank source (S-219): the exact JSON reader, the seconds window, translation of statement
// items, statements, client info and rates, the push translator, from src/sources/monobank/source,
// and the client's calls and failure classes against a fake GatedHttp, from
// src/sources/monobank/client.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const sourceModule = () => import('../../src/sources/monobank/source');
const clientModule = () => import('../../src/sources/monobank/client');
const contract = () => import('../../src/sync/source-contract');
const registerModule = () => import('../../src/core/register');
const moneyModule = () => import('../../src/money/money');
const exactModule = () => import('../../src/money/exact');
const translatedModule = () => import('../../src/local/translated');

// Runs fn and returns what it threw, failing when it returns.
function thrown(fn: () => unknown): any {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw, got a return');
}

async function rejected(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection, got a resolution');
}

async function expectCallError(e: any, kind: string): Promise<void> {
  const { SourceCallError } = await contract();
  expect(e).toBeInstanceOf(SourceCallError);
  expect(e.kind).toBe(kind);
}

async function uahHolding(bankId = 'u1'): Promise<any> {
  const { narrowingName } = await registerModule();
  return { id: narrowingName('monobank', 'account', bankId), sourceId: 'monobank', kind: 'account', bankId, currency: 'UAH' };
}

// mulberry32: a small seeded generator, so the random bodies are the same on every run.
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sources/monobank/source', () => {
  test('exact JSON reader', async () => {
    const { readJsonExact, writeJsonExact, JsonNumber, translateStatementItem } = await sourceModule();
    const { money } = await moneyModule();

    // 1. Every number keeps its literal text; other values are plain.
    const v: any = readJsonExact('{"a": 41.10, "b": 9007199254740993, "c": -0, "d": 1e5, "e": [true, null, "x"]}');
    expect(v.a).toBeInstanceOf(JsonNumber);
    expect(v.a.text).toBe('41.10');
    expect(v.b).toBeInstanceOf(JsonNumber);
    expect(v.b.text).toBe('9007199254740993');
    expect(v.c.text).toBe('-0');
    expect(v.d.text).toBe('1e5');
    expect(v.e).toEqual([true, null, 'x']);

    // 2. A repeated key keeps its last value.
    expect((readJsonExact('{"a": 1, "a": 2}') as any).a.text).toBe('2');

    // 3. Anything but exactly one JSON value.
    for (const bad of ['', '1 2', '{"a": 1', '{a: 1}', '[1,]', '01', 'NaN', "'x'"]) {
      expect(readJsonExact(bad)).toBeUndefined();
    }

    // 4. Surrounding whitespace is standard grammar.
    const arr: any = readJsonExact('  [1]  ');
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(1);
    expect(arr[0]).toBeInstanceOf(JsonNumber);
    expect(arr[0].text).toBe('1');

    // 5. Numbers are written back as written.
    const text = '{"r":41.10,"n":9007199254740993}';
    expect(writeJsonExact(readJsonExact(text) as any)).toBe(text);

    // 6. A whole figure past 2^53 reaches the held amount exactly.
    const big = readJsonExact(
      '{"id":"big","time":1700000000,"amount":9007199254740993,"operationAmount":9007199254740993,"currencyCode":980}',
    );
    const r: any = translateStatementItem(big as any, await uahHolding(), 1_800_000_000_000);
    expect(r.kind).toBe('held');
    expect(r.record.amount).toEqual(money(9007199254740993n, 'UAH'));
  });

  test('seconds window', async () => {
    const { secondsWindow, MONOBANK_MAX_WINDOW_MS } = await sourceModule();
    const sw = (a: number, b: number) => secondsWindow([a, b] as any);

    // 1–4. ceil for both ends, the end exclusive; empty gives null.
    expect(sw(1_700_000_000_500, 1_700_000_060_500)).toEqual({ from: 1_700_000_001, to: 1_700_000_060 });
    expect(sw(1_700_000_000_000, 1_700_000_060_000)).toEqual({ from: 1_700_000_000, to: 1_700_000_059 });
    expect(sw(1_700_000_000_200, 1_700_000_000_700)).toBeNull();
    expect(sw(1_700_000_000_000, 1_700_000_001_000)).toEqual({ from: 1_700_000_000, to: 1_700_000_000 });

    // 5. The longest window stays within the bank's span.
    expect(MONOBANK_MAX_WINDOW_MS).toBe(2_682_000_000);
    expect(MONOBANK_MAX_WINDOW_MS).toBe(31 * 86_400_000 + 3_600_000);
    const s0 = 1_700_000_000_000;
    const w0: any = sw(s0, s0 + 2_682_000_000);
    expect(w0).toEqual({ from: 1_700_000_000, to: 1_702_681_999 });
    expect(w0.to - w0.from).toBe(2_681_999);
    const s1 = 1_700_000_000_001;
    const w1: any = sw(s1, s1 + 2_682_000_000);
    expect(w1).toEqual({ from: 1_700_000_001, to: 1_702_682_000 });
    expect(w1.to - w1.from).toBe(2_681_999);
  });

  test('statement item', async () => {
    const { readJsonExact, writeJsonExact, translateStatementItem } = await sourceModule();
    const { money } = await moneyModule();
    const { checkTranslated } = await translatedModule();

    const UAH = await uahHolding('u1');
    const seenAt = 1_800_000_000_000;
    const it = (fields: Record<string, unknown>): any =>
      readJsonExact(
        JSON.stringify({ id: 'a1', time: 1700000000, amount: -12345, operationAmount: -12345, currencyCode: 980, ...fields }),
      );
    const tr = (x: any): any => translateStatementItem(x, UAH, seenAt);
    const held = (x: any): any => {
      const r = tr(x);
      expect(r.kind).toBe('held');
      return r.record;
    };

    // 1. The held fields.
    const r1 = tr(it({ cashbackAmount: 123, mcc: 5411 }));
    expect(r1.kind).toBe('held');
    expect(r1.sourceId).toBe('monobank');
    expect(r1.bankId).toBe('a1');
    expect(r1.record).toEqual({
      sourceId: 'monobank',
      bankId: 'a1',
      holdingId: UAH.id,
      occurredAt: 1_700_000_000_000,
      amount: money(-12345n, 'UAH'),
      originalAmount: null,
      cashback: money(123n, 'UAH'),
      settled: true,
      mcc: 5411,
      originalMcc: null,
      merchantText: null,
      description: '',
      comment: null,
      counterpart: null,
    });
    expect(() => checkTranslated(r1.record)).not.toThrow();

    // 2. The hold flag.
    expect(held(it({ hold: true })).settled).toBe(false);
    expect(held(it({ hold: false })).settled).toBe(true);

    // 3. The operation's own amount when its currency differs.
    const r3 = held(it({ amount: -41100, operationAmount: -1000, currencyCode: 840 }));
    expect(r3.originalAmount).toEqual(money(-1000n, 'USD'));
    expect(r3.amount).toEqual(money(-41100n, 'UAH'));

    // 4. A stated zero cashback is kept; an absent one is null.
    expect(held(it({ cashbackAmount: 0 })).cashback).toEqual(money(0n, 'UAH'));
    expect(held(it({})).cashback).toBeNull();

    // 5. Codes outside 0..9999 are null; strings verbatim.
    const r5 = held(it({ mcc: 10000, originalMcc: 4829, description: 'Shop', comment: 'hi' }));
    expect(r5.mcc).toBeNull();
    expect(r5.originalMcc).toBe(4829);
    expect(r5.description).toBe('Shop');
    expect(r5.comment).toBe('hi');

    // 6. In the holding's currency operationAmount is not judged.
    expect(held(it({ currencyCode: 980, operationAmount: 'x' })).originalAmount).toBeNull();

    // 7–11. Quarantined, with its reason and the record's own moment.
    const quarantined = (fields: Record<string, unknown>, reason: string, occurredAt: number | null | undefined) => {
      const x = it(fields);
      const r = tr(x);
      expect(r.kind).toBe('quarantined');
      expect(r.entry.reason).toBe(reason);
      if (occurredAt !== undefined) expect(r.entry.occurredAt).toBe(occurredAt);
      expect(r.entry.seenAt).toBe(seenAt);
      expect(r.entry.sourceId).toBe('monobank');
      expect(r.entry.bankId).toBe('a1');
      expect(r.entry.raw).toBe(writeJsonExact(x));
    };
    quarantined({ currencyCode: 999 }, 'unknown_currency', 1_700_000_000_000);
    quarantined({ cashbackAmount: -5 }, 'malformed', 1_700_000_000_000);
    quarantined({ time: '1700000000' }, 'malformed', null);
    quarantined({ time: 1700000000.5 }, 'malformed', null);
    quarantined({ amount: 12.5 }, 'malformed', 1_700_000_000_000);
    quarantined({ amount: -41100, operationAmount: 1000, currencyCode: 840 }, 'malformed', undefined);

    // Unreadable: not an object, or no id.
    await expectCallError(thrown(() => tr(readJsonExact('[1]'))), 'other');
    await expectCallError(thrown(() => tr(it({ id: '' }))), 'other');
  });

  test('statement paging', async () => {
    const { readJsonExact, translateStatement, MONOBANK_PAGE_CAP } = await sourceModule();
    const { money } = await moneyModule();

    const UAH = await uahHolding('u1');
    const seenAt = 1_800_000_000_000;
    const W: any = [1_700_000_000_000, 1_702_682_000_000];
    const V: any = [1_700_000_000_000, 1_700_000_060_000];
    const item = (id: string, time: number, extra: Record<string, unknown> = {}) => ({
      id,
      time,
      amount: -100,
      operationAmount: -100,
      currencyCode: 980,
      ...extra,
    });
    const reply = (list: unknown[]): any => readJsonExact(JSON.stringify(list));
    const page = (body: any, w: any): any => translateStatement(body, UAH, w, seenAt);
    const newestFirst = (n: number) => Array.from({ length: n }, (_, k) => item(`i${k}`, 1_701_000_499 - k));

    // 1. A full reply continues from its oldest second, that second included.
    expect(MONOBANK_PAGE_CAP).toBe(500);
    const full = page(reply(newestFirst(500)), W);
    expect(full.items.length).toBe(500);
    expect(full.next).toEqual([1_700_000_000_000, 1_701_000_001_000]);

    // 2. One short of the cap: no continuation.
    expect(page(reply(newestFirst(499)), W).next).toBeNull();

    // 3. Over the cap.
    await expectCallError(thrown(() => page(reply(newestFirst(501)), W)), 'other');

    // 4. A full reply whose continuation would not shorten the window.
    const stuck = Array.from({ length: 500 }, (_, k) => item(`s${k}`, 1_700_000_059));
    await expectCallError(thrown(() => page(reply(stuck), V)), 'other');

    // 5. An item outside the window.
    await expectCallError(thrown(() => page(reply([item('o', 1_700_000_060)]), V)), 'other');

    // 6. A repeated id keeps its first.
    const twice = page(
      reply([item('r1', 1_701_000_000), item('r1', 1_701_000_000, { amount: -200, operationAmount: -200 })]),
      W,
    );
    expect(twice.items.length).toBe(1);
    expect(twice.items[0].kind).toBe('held');
    expect(twice.items[0].record.amount).toEqual(money(-100n, 'UAH'));

    // 7. Not an array.
    await expectCallError(thrown(() => page(readJsonExact('{}'), W)), 'other');
  });

  test('client info and rates', async () => {
    const { readJsonExact, translateClientInfo, translateCurrency } = await sourceModule();
    const { narrowingName } = await registerModule();
    const { money } = await moneyModule();
    const { parseExactDecimal } = await exactModule();

    const body = (webHook: Record<string, unknown>): any =>
      readJsonExact(
        JSON.stringify({
          accounts: [
            { id: 'acc1', balance: 150000, creditLimit: 50000, currencyCode: 980, type: 'black' },
            { id: 'accX', balance: 1, creditLimit: 0, currencyCode: 999 },
          ],
          jars: [
            { id: 'jar1', balance: 2000, goal: 100000, currencyCode: 980 },
            { id: 'jar2', balance: 0, currencyCode: 980 },
            { id: 'jar3', balance: 5, goal: null, currencyCode: 980 },
          ],
          ...webHook,
        }),
      );

    // 1. Holdings in reply order, the unknown currency left out.
    const r: any = translateClientInfo(body({ webHookUrl: '' }));
    expect(r.holdings).toEqual([
      { kind: 'account', sourceId: 'monobank', bankId: 'acc1', currency: 'UAH' },
      { kind: 'jar', sourceId: 'monobank', bankId: 'jar1', currency: 'UAH' },
      { kind: 'jar', sourceId: 'monobank', bankId: 'jar2', currency: 'UAH' },
      { kind: 'jar', sourceId: 'monobank', bankId: 'jar3', currency: 'UAH' },
    ]);

    // 2. Credit limit on accounts, goal on every jar.
    const balanceOf = (kind: 'account' | 'jar', id: string) =>
      r.balances.find((b: any) => b.holdingId === narrowingName('monobank', kind, id));
    const acc1 = balanceOf('account', 'acc1');
    expect(acc1).toBeDefined();
    expect(acc1.balance).toEqual(money(150000n, 'UAH'));
    expect(acc1.creditLimit).toEqual(money(50000n, 'UAH'));
    expect('goal' in acc1).toBe(false);
    expect('order' in acc1).toBe(false);
    const jar1 = balanceOf('jar', 'jar1');
    expect(jar1.balance).toEqual(money(2000n, 'UAH'));
    expect(jar1.creditLimit).toBeNull();
    expect(jar1.goal).toEqual(money(100000n, 'UAH'));
    for (const id of ['jar2', 'jar3']) {
      const jar = balanceOf('jar', id);
      expect(jar).toBeDefined();
      expect('goal' in jar).toBe(true);
      expect(jar.goal).toBeNull();
    }
    expect(r.balances.some((b: any) => String(b.holdingId).endsWith(':accX'))).toBe(false);
    expect(r.balances.length).toBe(4);

    // 3. The held push address.
    expect(r.pushAddress).toBeNull();
    const hook = 'https://h.example/hook/abcdefghijklmnop';
    expect((translateClientInfo(body({ webHookUrl: hook })) as any).pushAddress).toBe(hook);
    expect((translateClientInfo(body({})) as any).pushAddress).toBeNull();

    // 4. Unreadable client info.
    const bad = [
      { jars: [], webHookUrl: '' },
      { accounts: [{ id: 'a', balance: 1.5, creditLimit: 0, currencyCode: 980 }] },
      {
        accounts: [
          { id: 'a', balance: 1, creditLimit: 0, currencyCode: 980 },
          { id: 'a', balance: 2, creditLimit: 0, currencyCode: 980 },
        ],
      },
    ];
    for (const b of bad) {
      await expectCallError(thrown(() => translateClientInfo(readJsonExact(JSON.stringify(b)) as any)), 'other');
    }

    // 5. Rates kept as written.
    const rates: any[] = translateCurrency(
      readJsonExact(
        '[{"currencyCodeA":840,"currencyCodeB":980,"date":1700000000,"rateBuy":41.10,"rateSell":41.4012},' +
          '{"currencyCodeA":985,"currencyCodeB":980,"rateCross":10.3},' +
          '{"currencyCodeA":999,"currencyCodeB":980,"rateCross":1},' +
          '{"currencyCodeA":978,"currencyCodeB":980,"rateBuy":45}]',
      ) as any,
    );
    expect(rates.length).toBe(2);
    expect(rates[0].pair).toEqual({ base: 'USD', quote: 'UAH' });
    expect(rates[0].figures).toEqual({ kind: 'buy_sell', buy: parseExactDecimal('41.10'), sell: parseExactDecimal('41.4012') });
    expect(rates[0].figures.buy.scale).toBe(2);
    expect(rates[0].figures.sell.scale).toBe(4);
    expect(rates[0].statedFrom).toBe(1_700_000_000_000);
    expect(rates[1].pair).toEqual({ base: 'PLN', quote: 'UAH' });
    expect(rates[1].figures).toEqual({ kind: 'cross', rate: parseExactDecimal('10.3') });
    expect(rates[1].statedFrom).toBeUndefined();
  });

  test('push translator', async () => {
    const { monobankPush } = await sourceModule();
    const { narrowingName } = await registerModule();
    const { money } = await moneyModule();

    const register = {
      sources: [],
      holdings: [
        { id: narrowingName('monobank', 'account', 'usd1'), sourceId: 'monobank', kind: 'account', bankId: 'usd1', currency: 'USD' },
        { id: narrowingName('monobank', 'jar', 'jar1'), sourceId: 'monobank', kind: 'jar', bankId: 'jar1', currency: 'UAH' },
        { id: narrowingName('stub', 'account', 'other'), sourceId: 'stub', kind: 'account', bankId: 'other', currency: 'PLN' },
      ],
    };
    const ctx: any = { register, now: 1_800_000_000_000 };
    const note = (account: unknown, item: unknown) =>
      JSON.stringify({ type: 'StatementItem', data: { account, statementItem: item } });
    const it = { id: 'p1', time: 1700000000, amount: -500, operationAmount: -500, currencyCode: 840, balance: 98765 };
    const read = (body: string, contentType: string | null = null): any => monobankPush.read(body, contentType, ctx);
    const usd1 = narrowingName('monobank', 'account', 'usd1');

    // 1. An account: the item and balance in the registered currency.
    const r1 = read(note('usd1', it));
    expect(r1.kind).toBe('notification');
    expect(r1.holdingId).toBe(usd1);
    expect(r1.holdingKind).toBe('account');
    expect(r1.item.kind).toBe('held');
    expect(r1.item.record.amount).toEqual(money(-500n, 'USD'));
    expect(r1.item.record.originalAmount).toBeNull();
    expect(r1.item.record.occurredAt).toBe(1_700_000_000_000);
    expect(r1.balance).toEqual({ holdingId: usd1, balance: money(98765n, 'USD'), creditLimit: null });
    expect('goal' in r1.balance).toBe(false);
    expect('order' in r1.balance).toBe(false);

    // 2. A jar, content type not judged.
    const r2 = read(note('jar1', { ...it, currencyCode: 980 }), 'text/plain');
    expect(r2.kind).toBe('notification');
    expect(r2.holdingKind).toBe('jar');
    expect(r2.holdingId).toBe(narrowingName('monobank', 'jar', 'jar1'));
    expect(r2.item.record.amount).toEqual(money(-500n, 'UAH'));
    expect(r2.balance.balance).toEqual(money(98765n, 'UAH'));

    // 3. No balance on the item.
    const r3 = read(note('usd1', { ...it, balance: undefined }));
    expect(r3.kind).toBe('notification');
    expect(r3.balance).toBeNull();

    // 4. Unregistered, and another source's row never matched.
    expect(read(note('zz', it))).toEqual({ kind: 'unknown_holding', holdingId: narrowingName('monobank', 'account', 'zz') });
    expect(read(note('other', it))).toEqual({
      kind: 'unknown_holding',
      holdingId: narrowingName('monobank', 'account', 'other'),
    });

    // 5. A quarantined item is still a notification.
    const r5 = read(note('usd1', { ...it, currencyCode: 999 }));
    expect(r5.kind).toBe('notification');
    expect(r5.item.kind).toBe('quarantined');
    expect(r5.item.entry.reason).toBe('unknown_currency');
    expect(r5.item.entry.occurredAt).toBe(1_700_000_000_000);
    expect(r5.item.entry.seenAt).toBe(1_800_000_000_000);

    // 6. Not the shape.
    const malformed = [
      'nope',
      '[]',
      JSON.stringify({ type: 'Other', data: { account: 'usd1', statementItem: it } }),
      note('', it),
      JSON.stringify({ type: 'StatementItem', data: { account: 'usd1' } }),
      note('usd1', { ...it, id: '' }),
      note('usd1', [1]),
    ];
    for (const body of malformed) {
      expect(read(body).kind).toBe('not_well_formed');
    }

    // 7. Total: never throws.
    const rand = seeded(219);
    const bodies: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const len = Math.floor(rand() * 201);
      let s = '';
      for (let j = 0; j < len; j++) s += String.fromCharCode(32 + Math.floor(rand() * 95));
      bodies.push(s);
    }
    for (const body of malformed) {
      for (let i = 0; i < 10; i++) {
        const at = Math.floor(rand() * body.length);
        bodies.push(body.slice(0, at) + body.slice(at + 1));
      }
    }
    const kinds = ['notification', 'unknown_holding', 'not_well_formed'];
    for (const body of bodies) {
      let r: any;
      expect(() => {
        r = read(body);
      }).not.toThrow();
      expect(kinds).toContain(r.kind);
    }
  });
});

describe('sources/monobank/client', () => {
  interface Recorded {
    callClass: string;
    method: string;
    url: string;
    headers: Headers;
    body: unknown;
    signal: AbortSignal;
  }

  // A fake GatedHttp recording each call and answering the next queued reply (default 200 '[]').
  function fakeHttp() {
    const calls: Recorded[] = [];
    const queue: (() => Promise<Response>)[] = [];
    const http = {
      request(callClass: string, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
        calls.push({ callClass, method: init.method ?? 'GET', url, headers: new Headers(init.headers), body: init.body, signal });
        const next = queue.shift();
        return next ? next() : Promise.resolve(new Response('[]', { status: 200 }));
      },
    };
    const reply = (status: number, body: string) => queue.push(() => Promise.resolve(new Response(body, { status })));
    const fail = (e: unknown) => queue.push(() => Promise.reject(e));
    return { http, calls, reply, fail };
  }

  async function open(http: unknown, credential: string | null = 'tok'): Promise<any> {
    const { source } = await sourceModule();
    return (source as any).open({ baseAddress: 'http://bank.test', credential, extras: {}, http });
  }

  test('calls and replies', async () => {
    const { MONOBANK_LIMITS, MONOBANK_MAX_WINDOW_MS, monobankPush, source } = await sourceModule();
    const { openMonobankClient } = await clientModule();
    expect(typeof openMonobankClient).toBe('function');

    const A = await uahHolding('acc1');
    const ac = new AbortController();
    const classes: string[] = [];

    // 1. Client info: GET with the token and the caller's signal.
    {
      const f = fakeHttp();
      f.reply(200, '{"accounts":[]}');
      await (await open(f.http)).refreshHoldings(ac.signal);
      expect(f.calls.length).toBe(1);
      const c = f.calls[0];
      expect(c.callClass).toBe('client_info');
      expect(c.method).toBe('GET');
      expect(c.url).toBe('http://bank.test/personal/client-info');
      expect(c.headers.get('X-Token')).toBe('tok');
      expect(c.signal).toBe(ac.signal);
      classes.push(...f.calls.map((x) => x.callClass));
    }

    // 2. A statement over the window's inclusive seconds.
    {
      const f = fakeHttp();
      const page = await (await open(f.http)).fetchWindow(A, [1_700_000_000_000, 1_700_000_060_000], ac.signal);
      expect(f.calls.length).toBe(1);
      expect(f.calls[0].callClass).toBe('statement');
      expect(f.calls[0].url).toBe('http://bank.test/personal/statement/acc1/1700000000/1700000059');
      expect(f.calls[0].headers.get('X-Token')).toBe('tok');
      expect(f.calls[0].signal).toBe(ac.signal);
      expect(page).toEqual({ items: [], next: null });
      classes.push(...f.calls.map((x) => x.callClass));
    }

    // 3. An empty window makes no call.
    {
      const f = fakeHttp();
      const page = await (await open(f.http)).fetchWindow(A, [1_700_000_000_200, 1_700_000_000_700], ac.signal);
      expect(page).toEqual({ items: [], next: null });
      expect(f.calls.length).toBe(0);
    }

    // 4. Push registration.
    {
      const f = fakeHttp();
      f.reply(200, '');
      const hook = 'https://h.example/hook/abcdefghijklmnop';
      await (await open(f.http)).registerPush(hook, ac.signal);
      expect(f.calls.length).toBe(1);
      const c = f.calls[0];
      expect(c.callClass).toBe('webhook');
      expect(c.method).toBe('POST');
      expect(c.url).toBe('http://bank.test/personal/webhook');
      expect(c.headers.get('X-Token')).toBe('tok');
      expect(JSON.parse(String(c.body))).toEqual({ webHookUrl: hook });
      expect(c.signal).toBe(ac.signal);
      classes.push(...f.calls.map((x) => x.callClass));
    }

    // 5. Public rates: no token.
    {
      const f = fakeHttp();
      const rates = await (await open(f.http)).fetchRates(ac.signal);
      expect(rates).toEqual([]);
      expect(f.calls.length).toBe(1);
      expect(f.calls[0].callClass).toBe('currency');
      expect(f.calls[0].url).toBe('http://bank.test/bank/currency');
      expect(f.calls[0].headers.has('X-Token')).toBe(false);
      expect(f.calls[0].signal).toBe(ac.signal);
      classes.push(...f.calls.map((x) => x.callClass));
    }

    // 6. Replies and their kinds, 7. each call made once.
    {
      const f = fakeHttp();
      const client = await open(f.http);
      const W = [1_700_000_000_000, 1_700_000_060_000];
      const hook = 'https://h.example/hook/abcdefghijklmnop';

      f.reply(429, '');
      await expectCallError(await rejected(client.fetchWindow(A, W, ac.signal)), 'rate_refused');
      f.reply(400, '');
      await expectCallError(await rejected(client.fetchWindow(A, W, ac.signal)), 'date_refused');
      f.reply(400, '');
      await expectCallError(await rejected(client.refreshHoldings(ac.signal)), 'other');
      f.reply(500, '');
      await expectCallError(await rejected(client.fetchWindow(A, W, ac.signal)), 'other');
      f.reply(200, 'not json');
      await expectCallError(await rejected(client.refreshHoldings(ac.signal)), 'other');
      f.fail(new TypeError('fetch failed'));
      await expectCallError(await rejected(client.refreshHoldings(ac.signal)), 'other');
      f.reply(500, '');
      await expectCallError(await rejected(client.registerPush(hook, ac.signal)), 'other');

      expect(f.calls.length).toBe(7);
      classes.push(...f.calls.map((x) => x.callClass));
    }

    // 8. Every class used is counted by a declared window.
    expect(MONOBANK_LIMITS).toEqual({
      windows: [
        { callClass: 'client_info', calls: 1, windowMs: 60_000 },
        { callClass: 'statement', calls: 1, windowMs: 60_000 },
        { callClass: 'webhook', calls: 1, windowMs: 60_000 },
        { callClass: 'currency', calls: 1, windowMs: 60_000 },
      ],
      marginMs: 2_000,
      refusalCooldownMs: 60_000,
    });
    const declared = MONOBANK_LIMITS.windows.map((w: any) => w.callClass);
    for (const c of classes) expect(declared).toContain(c);
    expect(new Set(classes)).toEqual(new Set(['client_info', 'statement', 'webhook', 'currency']));

    // 9. No credential: refused before any call.
    {
      const f = fakeHttp();
      await expectCallError(await rejected((await open(f.http, null)).refreshHoldings(ac.signal)), 'other');
      expect(f.calls.length).toBe(0);
    }

    // 10. The definition.
    const def: any = source;
    expect(def.id).toBe('monobank');
    expect(def.capabilities).toEqual(['jars', 'rates']);
    expect(def.balanceConvention).toBe('includes_credit_limit');
    expect(def.maxWindowMs).toBe(MONOBANK_MAX_WINDOW_MS);
    expect(def.limits).toBe(MONOBANK_LIMITS);
    expect(def.push).toBe(monobankPush);
    expect((monobankPush as any).addressCheck).toEqual({ method: 'GET', status: 200 });
    expect(def.earliestAvailable).toBeUndefined();
  });
});
