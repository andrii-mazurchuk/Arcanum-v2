// Second source (S-192): its declarations and translation from src/sources/second/source (no
// network), and its client, opened through the definition over a fake GatedHttp that records each
// call's class, URL, headers and signal. The bank's shape differs from Monobank's at every point:
// decimal-text amounts, letter currency codes, offset date-times, one account listing and
// per-account transaction pages joined by a cursor.
//
// The modules are imported inside each test, not at the top: a missing module then fails each test
// on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const second = () => import('../../src/sources/second/source');
const contract = () => import('../../src/sync/source-contract');
const register = () => import('../../src/core/register');
const settings = () => import('../../src/config/settings');

// The call's error, or undefined when it returned.
const thrown = (fn: () => unknown): any => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};
const rejected = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => undefined,
    (e) => e,
  );

const expectCallError = async (e: any, kind: string, label = ''): Promise<void> => {
  const { SourceCallError } = await contract();
  expect({ label, isCallError: e instanceof SourceCallError, kind: e?.kind }).toEqual({
    label,
    isCallError: true,
    kind,
  });
};

// --- translation fixtures ---------------------------------------------------------------------

const window = { startAt: Date.UTC(2026, 10, 20), endAt: Date.UTC(2026, 10, 22) };
const seenAt = Date.UTC(2026, 10, 22, 9);
const MOMENT = Date.UTC(2026, 10, 21, 10, 34, 56);

const rec = (id: string, amount: string, currency: string, extra: Record<string, unknown> = {}) => ({
  id,
  booked_at: '2026-11-21T12:34:56+02:00',
  amount,
  currency,
  merchant: 'Shop',
  description: 'd-' + id,
  status: 'booked',
  ...extra,
});

describe('sources/second/source', () => {
  test('worked translations', async () => {
    const { translatePage } = await second();
    const { narrowingName } = await register();
    const records = [
      rec('a', '-12.35', 'PLN'),
      rec('b', '-0.10', 'UAH'),
      rec('c', '5', 'JPY'),
      rec('d', '-1.235', 'PLN'),
      rec('e', '-2.77', 'EUR', { original_amount: '-3.01', original_currency: 'USD' }),
      rec('f', '-2.77', 'EUR', { original_amount: '3.01', original_currency: 'USD' }),
    ];
    const r = translatePage({ transactions: records, next_cursor: null }, 'sec-pln', window, seenAt);

    expect(r.nextCursor).toBeNull();
    expect(r.items.length).toBe(6);

    const held = (id: string, amount: any, originalAmount: any) => ({
      kind: 'held',
      sourceId: 'second',
      bankId: id,
      record: {
        sourceId: 'second',
        bankId: id,
        holdingId: narrowingName('second', 'account', 'sec-pln'),
        occurredAt: MOMENT,
        amount,
        originalAmount,
        cashback: null,
        settled: true,
        mcc: null,
        originalMcc: null,
        merchantText: 'Shop',
        description: 'd-' + id,
        comment: null,
        counterpart: null,
      },
    });

    // A translation scaling every currency by 100 gives c 500n; one reading the wall time as UTC
    // gives occurredAt two hours late.
    expect(r.items[0]).toEqual(held('a', { minor: -1235n, currency: 'PLN' }, null));
    expect(r.items[1]).toEqual(held('b', { minor: -10n, currency: 'UAH' }, null));
    expect(r.items[2]).toEqual(held('c', { minor: 5n, currency: 'JPY' }, null));

    // Excess precision is quarantined with its own moment, never rounded to -124n or -123n.
    const d: any = r.items[3];
    expect(d.kind).toBe('quarantined');
    expect({
      reason: d.entry.reason,
      bankId: d.entry.bankId,
      sourceId: d.entry.sourceId,
      raw: d.entry.raw,
      seenAt: d.entry.seenAt,
      occurredAt: d.entry.occurredAt,
    }).toEqual({
      reason: 'excess_precision',
      bankId: 'd',
      sourceId: 'second',
      raw: JSON.stringify(records[3]),
      seenAt,
      occurredAt: MOMENT,
    });

    expect(r.items[4]).toEqual(held('e', { minor: -277n, currency: 'EUR' }, { minor: -301n, currency: 'USD' }));

    // An original of the opposite sign is malformed, naming both figures.
    const f: any = r.items[5];
    expect(f.kind).toBe('quarantined');
    expect(f.entry.reason).toBe('malformed');
    expect(f.entry.bankId).toBe('f');
    expect(f.entry.detail).toContain('-2.77');
    expect(f.entry.detail).toContain('3.01');
  });

  test('readMoment', async () => {
    const { readMoment } = await second();
    expect(readMoment('2026-11-21T12:34:56+02:00')).toBe(MOMENT);
    expect(readMoment('2026-11-21T10:34:56Z')).toBe(MOMENT);
    expect(readMoment('2026-11-21T10:34:56.5Z')).toBe(Date.UTC(2026, 10, 21, 10, 34, 56, 500));
    expect(readMoment('2026-11-21T07:34:56.123-03:00')).toBe(Date.UTC(2026, 10, 21, 10, 34, 56, 123));

    // Date.parse alone accepts the first two (local time; a space in Bun).
    const refused: unknown[] = [
      '2026-11-21T10:34:56',
      '2026-11-21 10:34:56Z',
      '2026-11-21T10:34:56.1234Z',
      '2026-11-21T10:34:56+0200',
      '2026-13-01T00:00:00Z',
      '',
      1795689296000,
      null,
      undefined,
    ];
    for (const text of refused) expect({ text, got: readMoment(text) }).toEqual({ text, got: null });
  });

  test('page rules', async () => {
    const { translatePage } = await second();
    const { narrowingName } = await register();
    const page = (records: unknown[], next: unknown = null) => ({ transactions: records, next_cursor: next });
    const translate = (body: unknown, accountId = 'sec-pln') => translatePage(body, accountId, window, seenAt);

    // 1. The window is half-open: a record exactly at its end makes the reply unreadable; one exactly
    // at its start is held.
    const atEnd = page([rec('a', '-1.00', 'PLN'), rec('b', '-1.00', 'PLN', { booked_at: new Date(window.endAt).toISOString() })]);
    await expectCallError(thrown(() => translate(atEnd)), 'other', 'at window end');
    const atStart = translate(page([rec('a', '-1.00', 'PLN', { booked_at: new Date(window.startAt).toISOString() })]));
    expect(atStart.items.length).toBe(1);
    expect((atStart.items[0] as any).kind).toBe('held');
    expect((atStart.items[0] as any).record.occurredAt).toBe(window.startAt);

    // 2. Unreadable replies reject the whole page.
    await expectCallError(thrown(() => translate(page([rec('a', '-1.00', 'PLN', { status: 'settled' })]))), 'other', 'status');
    const noDescription: Record<string, unknown> = rec('a', '-1.00', 'PLN');
    delete noDescription.description;
    await expectCallError(thrown(() => translate(page([noDescription]))), 'other', 'no description');
    await expectCallError(thrown(() => translate({ transactions: 'x' })), 'other', 'transactions not a list');
    await expectCallError(
      thrown(() => translate(page([rec('a', '-1.00', 'PLN', { booked_at: '2026-11-21T10:34:56' })]))),
      'other',
      'no offset',
    );

    // 3. A repeated bank id keeps its first occurrence.
    const repeated = translate(page([rec('a', '-1.00', 'PLN', { status: 'pending' }), rec('a', '-2.00', 'PLN')]));
    expect(repeated.items.length).toBe(1);
    const first: any = repeated.items[0];
    expect({ amount: first.record.amount, settled: first.record.settled }).toEqual({
      amount: { minor: -100n, currency: 'PLN' },
      settled: false,
    });

    // 4. A different counterparty account is linked; the account's own is not.
    const linked: any = translate(page([rec('g', '-5.00', 'PLN', { counterparty_account: 'sec-eur' })])).items[0];
    expect(linked.record.counterpart).toEqual({
      holdingId: narrowingName('second', 'account', 'sec-eur'),
      bankId: null,
      via: 'link',
    });
    const own: any = translate(page([rec('g', '-5.00', 'PLN', { counterparty_account: 'sec-pln' })])).items[0];
    expect(own.record.counterpart).toBeNull();

    // 5. The cursor comes back as given.
    expect(translate(page([rec('a', '-1.00', 'PLN')], 'p2')).nextCursor).toBe('p2');
  });

  test('translateAccounts', async () => {
    const { translateAccounts } = await second();
    const { narrowingName } = await register();
    const accounts = () => [
      { id: 'sec-pln', name: 'Main', currency: 'PLN', balance: '2500.01' } as Record<string, unknown>,
      { id: 'sec-eur', name: 'Euro', currency: 'EUR', balance: '-100.03' } as Record<string, unknown>,
    ];
    const r: any = translateAccounts({ accounts: accounts() });

    expect(r.holdings.length).toBe(2);
    expect(r.holdings[0]).toEqual(
      expect.objectContaining({ kind: 'account', sourceId: 'second', bankId: 'sec-pln', currency: 'PLN' }),
    );
    expect(r.holdings[1]).toEqual(
      expect.objectContaining({ kind: 'account', sourceId: 'second', bankId: 'sec-eur', currency: 'EUR' }),
    );

    // The balance is own money: no credit limit (never Monobank's 0n), no goal, no order.
    const shape = (b: any) => ({
      holdingId: b.holdingId,
      balance: b.balance,
      creditLimit: b.creditLimit,
    });
    expect(r.balances.map(shape)).toEqual([
      {
        holdingId: narrowingName('second', 'account', 'sec-pln'),
        balance: { minor: 250001n, currency: 'PLN' },
        creditLimit: null,
      },
      {
        holdingId: narrowingName('second', 'account', 'sec-eur'),
        balance: { minor: -10003n, currency: 'EUR' },
        creditLimit: null,
      },
    ]);
    for (const b of r.balances) {
      expect('goal' in b).toBe(false);
      expect('order' in b).toBe(false);
    }
    expect(r.pushAddress).toBeUndefined();

    // A bad account refuses the whole listing; nothing is skipped or quarantined.
    const withSecond = (patch: Record<string, unknown>) => {
      const list = accounts();
      list[1] = { ...list[1], ...patch };
      return { accounts: list };
    };
    const withFirst = (patch: Record<string, unknown>) => {
      const list = accounts();
      list[0] = { ...list[0], ...patch };
      return { accounts: list };
    };
    await expectCallError(thrown(() => translateAccounts(withSecond({ id: 'sec-pln' }))), 'other', 'repeated id');
    await expectCallError(thrown(() => translateAccounts(withFirst({ balance: '2500.015' }))), 'other', 'excess precision');
    await expectCallError(thrown(() => translateAccounts(withFirst({ balance: 2500.01 }))), 'other', 'number balance');
    await expectCallError(thrown(() => translateAccounts(withFirst({ currency: 'XXX' }))), 'other', 'unknown currency');
    await expectCallError(thrown(() => translateAccounts({ accounts: null })), 'other', 'accounts null');
  });

  test('declarations', async () => {
    const { source, settingsGroup, SECOND_LIMITS, SECOND_PAGE_LIMIT } = await second();
    const { loadSettings, settingValue } = await settings();
    const s: any = source;

    expect(s.id).toBe('second');
    expect(s.capabilities).toEqual([]);
    expect(s.push).toBeUndefined();
    expect(s.balanceConvention).toBe('own_money_as_reported');
    expect(s.limits).toBe(SECOND_LIMITS);
    expect(SECOND_LIMITS).toEqual({
      windows: [{ callClass: null, calls: 5, windowMs: 10_000 }],
      marginMs: 500,
      refusalCooldownMs: 10_000,
    });
    expect(s.maxWindowMs).toBe(2_678_400_000);
    expect(s.earliestAvailable).toBeUndefined();
    expect(s.settingsGroup).toBe(settingsGroup);
    expect(settingsGroup).toEqual({ sourceId: 'second', enabledByDefault: false, needsCredential: true, extras: [] });
    expect('baseAddressDefault' in settingsGroup).toBe(false);
    expect(SECOND_PAGE_LIMIT).toBe(50);

    // Every call class the client uses (as the client tests below record) is counted by some window.
    for (const callClass of CLIENT_CALL_CLASSES) {
      const counted = SECOND_LIMITS.windows.some((w: any) => w.callClass === null || w.callClass === callClass);
      expect({ callClass, counted }).toEqual({ callClass, counted: true });
    }

    const off = loadSettings({}, [settingsGroup]);
    expect(off.sources.map((x) => x.sourceId)).toEqual(['second']);
    expect(settingValue(off.sources[0]!.enabled)).toBe(false);

    const on = loadSettings({ ARCANUM_SECOND_ENABLED: 'on' }, [settingsGroup]);
    expect(settingValue(on.sources[0]!.enabled)).toBe(true);
    expect(on.sources[0]!.baseAddress).toEqual({ state: 'missing', name: 'ARCANUM_SECOND_BASE_URL' });
    expect(on.sources[0]!.credential).toEqual({ state: 'missing', name: 'ARCANUM_SECOND_TOKEN' });
  });
});

// --- client fixtures --------------------------------------------------------------------------

// The call classes the client tests' fake records; the declarations test checks each is counted.
const CLIENT_CALL_CLASSES = ['accounts', 'transactions'];

const BASE = 'http://127.0.0.1:1';
const clientWindow = { startAt: Date.UTC(2026, 10, 15), endAt: Date.UTC(2026, 10, 22) };
const F = new Date(clientWindow.startAt).toISOString();
const T = new Date(clientWindow.endAt).toISOString();
const TX_URL = `${BASE}/v1/accounts/sec-pln/transactions?from=${F}&to=${T}`;

interface Recorded {
  callClass: string;
  url: string;
  authorization: string | null;
  signal: AbortSignal;
}
type Reply = (signal: AbortSignal) => Response | Promise<Response>;

const json = (body: unknown, status = 200): Reply => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (body: string | null, status: number): Reply => () => new Response(body, { status });

const records = (from: number, to: number) => {
  const out: Record<string, unknown>[] = [];
  for (let i = from; i < to; i++) {
    out.push({
      id: 'r' + String(i).padStart(3, '0'),
      booked_at: new Date(clientWindow.startAt + i * 60_000).toISOString(),
      amount: '-1.00',
      currency: 'PLN',
      merchant: 'Shop',
      description: 'd',
      status: 'booked',
    });
  }
  return out;
};
const txPage = (from: number, to: number, next: string | null): Reply =>
  json({ transactions: records(from, to), next_cursor: next });

// A GatedHttp answering by URL; a reply keyed by the cursor ('' for none) for transactions calls,
// 'accounts' for the listing. A URL the script does not know fails the test's call loudly.
const fakeHttp = (script: Record<string, Reply>) => {
  const calls: Recorded[] = [];
  const http = {
    async request(callClass: string, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
      calls.push({ callClass, url, authorization: new Headers(init?.headers).get('Authorization'), signal });
      const u = new URL(url);
      const key = u.pathname.endsWith('/transactions') ? (u.searchParams.get('cursor') ?? '') : 'accounts';
      const reply = script[key];
      if (reply === undefined) throw new Error(`unscripted call ${url}`);
      return reply(signal);
    },
  };
  return { http, calls };
};

const openClient = async (http: unknown) => {
  const { source } = await second();
  return (source as any).open({ baseAddress: BASE, credential: 'tok', extras: {}, http });
};

const holdingSecPln = async () => {
  const { narrowingName } = await register();
  return {
    id: narrowingName('second', 'account', 'sec-pln'),
    kind: 'account',
    sourceId: 'second',
    bankId: 'sec-pln',
    currency: 'PLN',
  };
};

describe('sources/second/client', () => {
  test(
    'paging across a window',
    async () => {
      const { http, calls } = fakeHttp({ '': txPage(0, 50, 'c1'), c1: txPage(50, 100, 'c2'), c2: txPage(100, 120, null) });
      const client = await openClient(http);
      const signal = new AbortController().signal;
      const w = await client.fetchWindow(await holdingSecPln(), clientWindow, signal);

      expect(calls.length).toBe(3);
      for (const c of calls) {
        expect({ callClass: c.callClass, authorization: c.authorization, sameSignal: c.signal === signal }).toEqual({
          callClass: 'transactions',
          authorization: 'Bearer tok',
          sameSignal: true,
        });
      }
      expect(calls.map((c) => decodeURIComponent(c.url))).toEqual([TX_URL, TX_URL + '&cursor=c1', TX_URL + '&cursor=c2']);
      expect(w.items.length).toBe(120);
      expect(w.items.map((i: any) => (i.kind === 'held' ? i.bankId : i.entry.bankId))).toEqual(
        records(0, 120).map((r) => r.id),
      );
      expect(w.next).toBeNull();
    },
    5000,
  );

  test(
    'a repeated cursor rejects other without a third call',
    async () => {
      const { http, calls } = fakeHttp({ '': txPage(0, 50, 'c1'), c1: txPage(50, 100, 'c1') });
      const client = await openClient(http);
      const e = await rejected(client.fetchWindow(await holdingSecPln(), clientWindow, new AbortController().signal));
      await expectCallError(e, 'other');
      expect(calls.length).toBe(2);
    },
    2000,
  );

  test('refreshHoldings is one accounts call', async () => {
    const { http, calls } = fakeHttp({
      accounts: json({ accounts: [{ id: 'sec-pln', name: 'Main', currency: 'PLN', balance: '2500.01' }] }),
    });
    const client = await openClient(http);
    const signal = new AbortController().signal;
    const r = await client.refreshHoldings(signal);
    expect(calls.map((c) => ({ callClass: c.callClass, url: c.url, sameSignal: c.signal === signal }))).toEqual([
      { callClass: 'accounts', url: `${BASE}/v1/accounts`, sameSignal: true },
    ]);
    expect(calls[0]!.authorization).toBe('Bearer tok');
    expect(r.balances.length).toBe(1);
  });

  test('reply classification', async () => {
    const holding = await holdingSecPln();
    const cases: { label: string; reply: Reply; kind: string }[] = [
      { label: '429', reply: text(null, 429), kind: 'rate_refused' },
      { label: '422 range_not_available', reply: json({ error: 'range_not_available' }, 422), kind: 'date_refused' },
      { label: '422 bad_request', reply: json({ error: 'bad_request' }, 422), kind: 'other' },
      { label: '500', reply: text(null, 500), kind: 'other' },
      { label: 'not json', reply: text('not json', 200), kind: 'other' },
      {
        label: 'transport',
        reply: () => {
          throw new TypeError('fetch failed');
        },
        kind: 'other',
      },
    ];
    for (const c of cases) {
      const { http, calls } = fakeHttp({ '': c.reply });
      const client = await openClient(http);
      const e = await rejected(client.fetchWindow(holding, clientWindow, new AbortController().signal));
      await expectCallError(e, c.kind, c.label);
      // No retry: each case makes exactly one call.
      expect({ label: c.label, calls: calls.length }).toEqual({ label: c.label, calls: 1 });
    }

    // An abort: the http rejects with the signal's AbortError.
    const ac = new AbortController();
    const aborted = fakeHttp({
      '': () => {
        ac.abort();
        throw ac.signal.reason;
      },
    });
    const abortedClient = await openClient(aborted.http);
    await expectCallError(await rejected(abortedClient.fetchWindow(holding, clientWindow, ac.signal)), 'other', 'abort');
    expect(aborted.calls.length).toBe(1);

    // A failure on a later page rejects the whole window: nothing resolves with the first 50.
    const later = fakeHttp({ '': txPage(0, 50, 'c1'), c1: text(null, 500) });
    const laterClient = await openClient(later.http);
    let resolved: unknown = undefined;
    const e = await laterClient.fetchWindow(holding, clientWindow, new AbortController().signal).then(
      (w: unknown) => {
        resolved = w;
        return undefined;
      },
      (err: unknown) => err,
    );
    expect(resolved).toBeUndefined();
    await expectCallError(e, 'other', 'later page 500');
    expect(later.calls.length).toBe(2);

    // The listing classifies the same way.
    const listing = fakeHttp({ accounts: text(null, 429) });
    const listingClient = await openClient(listing.http);
    await expectCallError(
      await rejected(listingClient.refreshHoldings(new AbortController().signal)),
      'rate_refused',
      'refreshHoldings 429',
    );
    expect(listing.calls.length).toBe(1);
  });
});
