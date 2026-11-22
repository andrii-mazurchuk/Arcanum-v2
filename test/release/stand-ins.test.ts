// Release stand-ins (S-236): the stand-in Monobank and the stand-in second source from
// src/release/stand-ins, served on loopback from the release dataset (S-233). Each is driven over
// real HTTP with a test-set clock, so every recorded arrival moment is exact; the receiver for the
// Monobank webhook is a Bun.serve on loopback of the test's own.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const standIns = () => import('../../src/release/stand-ins');
const dataset = () => import('../../src/release/dataset');

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 22, 10, 7, 37);
const RUN_ID = 'abcdefgh';

const workedDraw = async () => (await dataset()).buildDataset(T0, RUN_ID);

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers });

// close() may already have run when a test fails midway; a second close must not mask the failure.
const closeQuietly = async (s: { close(): Promise<void> } | undefined) => {
  try {
    await s?.close();
  } catch {
    // already closed
  }
};

describe('release/stand-ins', () => {
  test('stand-in monobank', async () => {
    const { startMonobankStandIn } = await standIns();
    const ds = await workedDraw();
    let t = ds.t0;
    const m = await startMonobankStandIn(ds, 'tok', () => t);
    const F = Math.floor(ds.t0 / 1000);
    const tok = { 'X-Token': 'tok' };
    const sent: { callClass: string; status: number; at: number }[] = [];
    const call = async (path: string, callClass: string, headers: Record<string, string> = tok) => {
      const res = await get(m.baseAddress + path, headers);
      sent.push({ callClass, status: res.status, at: t });
      return res;
    };
    try {
      // 1. client-info
      t += 61_000;
      const info = await call('/personal/client-info', 'client-info');
      expect(info.status).toBe(200);
      const body: any = await info.json();
      expect(body.accounts.map((a: any) => a.id)).toEqual(['acc-uah', 'acc-usd']);
      expect(body.accounts.map((a: any) => a.balance)).toEqual([1_250_000, 10_000]);
      expect(body.accounts.map((a: any) => a.creditLimit)).toEqual([500_000, 0]);
      expect(body.accounts.map((a: any) => a.currencyCode)).toEqual([980, 840]);
      expect(body.jars.length).toBe(1);
      expect(body.jars[0]).toMatchObject({ id: 'jar-1', balance: 300_000, goal: 1_000_000 });
      expect(body.webHookUrl).toBe('');

      // 2. the recent statement (the older set's member at exactly F - 8 days is outside it)
      t += 61_000;
      const recentPath = `/personal/statement/acc-uah/${F - 8 * 86_400 + 1}/${F}`;
      const st = await call(recentPath, 'statement');
      expect(st.status).toBe(200);
      const items: any[] = await st.json();
      expect(items.length).toBe(10);
      for (let i = 1; i < items.length; i++) expect(items[i].time).toBeLessThan(items[i - 1].time);
      expect(items[0].amount).toBe(-4466);
      for (const it of items) {
        expect(typeof it.id).toBe('string');
        expect(Number.isInteger(it.time)).toBe(true);
        expect(it.time).toBeLessThanOrEqual(F); // seconds, not milliseconds
        expect(typeof it.mcc).toBe('number');
        expect(it.originalMcc).toBe(it.mcc);
        expect(it.hold).toBe(false);
        expect(it.amount).toBe(it.operationAmount);
        expect(it.currencyCode).toBe(980);
        expect(it.balance).toBe(1_250_000);
      }

      // 3. the same request inside 60 s
      t += 1_000;
      const again = await call(recentPath, 'statement');
      expect(again.status).toBe(429);
      expect(await again.json()).toEqual({ errorDescription: 'Too many requests' });

      // 4. range and holding refusals, and the widest range accepted
      t += 61_000;
      expect((await call(`/personal/statement/acc-uah/${F - 2_682_001}/${F}`, 'statement')).status).toBe(400);
      t += 61_000;
      expect((await call(`/personal/statement/nope/${F - 100}/${F}`, 'statement')).status).toBe(400);
      t += 61_000;
      expect((await call(`/personal/statement/acc-uah/${F - 2_682_000}/${F}`, 'statement')).status).toBe(200);

      // 5. a wrong token
      t += 61_000;
      expect((await call('/personal/client-info', 'client-info', { 'X-Token': 'bad' })).status).toBe(403);

      // 6. the rate table, figures as JSON number text
      t += 61_000;
      const cur = await call('/bank/currency', 'currency');
      expect(cur.status).toBe(200);
      const raw = await cur.text();
      const rows: any[] = JSON.parse(raw);
      expect(rows.length).toBe(3);
      const usd = rows.find((r) => r.currencyCodeA === 840);
      expect(usd.date).toBe(Math.floor(ds.monobank.rateStamp / 1000));
      expect(usd.rateBuy).toBe(36.5);
      expect(usd.rateSell).toBe(36.61);
      expect(raw).toContain('"rateSell":36.61');

      const calls = m.calls();
      expect(calls.map((c) => ({ callClass: c.callClass, status: c.status, at: c.at }))).toEqual(sent);
      for (let i = 1; i < calls.length; i++) expect(calls[i].seq).toBeGreaterThan(calls[i - 1].seq);
      expect(calls[2].refused).toBe(true);
    } finally {
      await closeQuietly(m);
    }
  });

  test('reopen and gain', async () => {
    const { startMonobankStandIn } = await standIns();
    const ds = await workedDraw();
    let t = ds.t0;
    const m = await startMonobankStandIn(ds, 'tok', () => t);
    const tok = { 'X-Token': 'tok' };

    let receiverGets = 0;
    const posts: any[] = [];
    const receiver = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        if (req.method === 'GET') receiverGets++;
        else posts.push(await req.json());
        return new Response('ok', { status: 200 });
      },
    });
    const missing = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('no', { status: 404 }) });
    const hook = `http://127.0.0.1:${receiver.port}/hook`;
    const register = (webHookUrl: string) =>
      fetch(m.baseAddress + '/personal/webhook', {
        method: 'POST',
        headers: { ...tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ webHookUrl }),
      });

    try {
      // 1. registration, kept only when the address answers 200
      t = ds.t0;
      expect((await register(hook)).status).toBe(200);
      expect(receiverGets).toBe(1);
      expect(m.webhookUrl()).toBe(hook);
      expect((await register(`http://127.0.0.1:${missing.port}/hook`)).status).toBe(400);
      expect(m.webhookUrl()).toBe(hook);

      // 2. a gained 'send' transaction, stamped to the whole second, posted once
      t = ds.t0 + 1_234;
      const pushed = ds.monobank.pushed;
      const r = await m.gain(pushed, 'send');
      expect(r.status).toBe(200);
      expect(pushed.time).toBe(ds.t0 + 1_000);
      expect(posts.length).toBe(1);
      expect(posts[0]).toMatchObject({
        type: 'StatementItem',
        data: {
          account: 'acc-uah',
          statementItem: {
            id: pushed.id,
            time: (ds.t0 + 1_000) / 1000,
            amount: -6912,
            operationAmount: -6912,
            mcc: 5411,
            description: 'pair-abcdefgh',
          },
        },
      });

      // 3. a gained 'drop' transaction sends nothing
      const dropped = ds.monobank.dropped;
      const r2 = await m.gain(dropped, 'drop');
      expect(r2.status).toBeNull();
      expect(posts.length).toBe(1);
      expect(dropped.time).toBe(ds.t0 + 1_000);

      // 4. both appear in the next statement, newest first
      t = ds.t0 + 2_500;
      const st = await get(
        `${m.baseAddress}/personal/statement/acc-uah/${(ds.t0 - 86_400_000) / 1000}/${(ds.t0 + 2_000) / 1000}`,
        tok,
      );
      expect(st.status).toBe(200);
      const items: any[] = await st.json();
      expect(items.length).toBeGreaterThan(2);
      expect(new Set([items[0].id, items[1].id])).toEqual(new Set([pushed.id, dropped.id]));
      for (const it of items.slice(2)) expect(it.time).toBeLessThan((ds.t0 + 1_000) / 1000);

      // 5. frozen: gain throws
      m.freeze();
      let threw = false;
      try {
        await m.gain(ds.monobank.whileStopped[0], 'drop');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      // 6. close and reopen on the same port, keeping the record
      const port = m.port;
      t = ds.t0 + 70_000;
      expect((await get(m.baseAddress + '/personal/client-info', tok)).status).toBe(200);
      await m.close();
      const failed = await get(m.baseAddress + '/personal/client-info', tok).then(
        () => false,
        () => true,
      );
      expect(failed).toBe(true);
      await m.reopen();
      expect(m.port).toBe(port);
      t = ds.t0 + 140_000;
      expect((await get(m.baseAddress + '/personal/client-info', tok)).status).toBe(200);

      const calls = m.calls();
      expect(calls.map((c) => c.callClass)).toEqual(['webhook', 'webhook', 'statement', 'client-info', 'client-info']);
      for (let i = 1; i < calls.length; i++) expect(calls[i].seq).toBe(calls[i - 1].seq + 1);
      expect(calls.map((c) => c.at)).toEqual([ds.t0, ds.t0, ds.t0 + 2_500, ds.t0 + 70_000, ds.t0 + 140_000]);
    } finally {
      await closeQuietly(m);
      receiver.stop(true);
      missing.stop(true);
    }
  });

  test('stand-in second source pages', async () => {
    const { startSecondStandIn } = await standIns();
    const { buildDataset, marker, DAY_MS } = await dataset();
    const base = buildDataset(T0, RUN_ID);
    const initial = [];
    for (let i = 0; i < 120; i++) {
      const mk = marker(RUN_ID, 100 + i);
      initial.push({
        id: 'r' + String(119 - i).padStart(3, '0'),
        account: 'sec-pln',
        bookedAt: base.t0 - 3 * DAY_MS + i * 60_000,
        amount: i % 2 === 0 ? '-0.01' : '-12.35',
        currency: 'PLN' as const,
        merchant: mk,
        description: mk,
      });
    }
    const last = marker(RUN_ID, 220);
    initial.push({
      id: 'aaaa',
      account: 'sec-pln',
      bookedAt: base.t0,
      amount: '-1.01',
      currency: 'PLN' as const,
      merchant: last,
      description: last,
    });
    const ds = { ...base, second: { ...base.second, initial } };
    const bookedAt = new Map(initial.map((r) => [r.id, r.bookedAt]));
    const amountOf = new Map(initial.map((r) => [r.id, r.amount]));

    let t = ds.t0;
    const s = await startSecondStandIn(ds, 'tok', () => t);
    const auth = { Authorization: 'Bearer tok' };
    const F = new Date(ds.t0 - 4 * DAY_MS).toISOString();
    const T = new Date(ds.t0).toISOString();
    expect(Date.parse(T)).toBe(ds.t0);
    const txUrl = (from: string) => `${s.baseAddress}/v1/accounts/sec-pln/transactions?from=${from}&to=${T}`;

    try {
      const pages: any[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < 5; n++) {
        t += 3_000;
        const res = await get(cursor === null ? txUrl(F) : `${txUrl(F)}&cursor=${encodeURIComponent(cursor)}`, auth);
        expect(res.status).toBe(200);
        const page: any = await res.json();
        pages.push(page);
        cursor = page.next_cursor;
        if (cursor === null) break;
      }
      expect(pages.map((p) => p.transactions.length)).toEqual([50, 50, 20]);
      expect(pages[0].next_cursor).not.toBeNull();
      expect(pages[1].next_cursor).not.toBeNull();
      expect(pages[2].next_cursor).toBeNull();
      expect(s.calls()[1].path).toContain(`cursor=${encodeURIComponent(pages[0].next_cursor)}`);

      const records: any[] = pages.flatMap((p) => p.transactions);
      const expectedIds = Array.from({ length: 120 }, (_, i) => 'r' + String(119 - i).padStart(3, '0'));
      expect(records.map((r) => r.id)).toEqual(expectedIds);
      for (const r of records) {
        expect(r.booked_at).toMatch(/\+03:00$/);
        expect(Date.parse(r.booked_at)).toBe(bookedAt.get(r.id)!);
        expect(typeof r.amount).toBe('string');
        expect(r.amount).toBe(amountOf.get(r.id)!);
        expect('mcc' in r).toBe(false);
      }

      t += 3_000;
      const early = await get(txUrl(new Date(ds.second.historyFrom - 1000).toISOString()), auth);
      expect(early.status).toBe(422);
      expect(await early.json()).toEqual({ error: 'range_not_available' });
      t += 3_000;
      expect((await get(txUrl('yesterday'), auth)).status).toBe(422);

      t += 3_000;
      const acc = await get(`${s.baseAddress}/v1/accounts`, auth);
      expect(acc.status).toBe(200);
      const listing: any = await acc.json();
      const pln = listing.accounts.find((a: any) => a.id === 'sec-pln');
      expect(pln.balance).toBe('2500.01');
      expect(pln.currency).toBe('PLN');

      expect(new Set(s.calls().map((c) => c.callClass))).toEqual(new Set(['transactions', 'accounts']));
    } finally {
      await closeQuietly(s);
    }
  });

  test('limits and refusal', async () => {
    const { overLimit, startSecondStandIn } = await standIns();
    const L = { callClass: 'statement', calls: 1, windowMs: 60_000 };
    const rec = (seq: number, at: number, callClass: string) => ({
      seq,
      at,
      callClass,
      path: '/',
      remote: '127.0.0.1',
      status: 200,
      refused: false,
    });
    expect(overLimit([rec(1, 0, 'statement')], L, 'statement', 59_999)).toBe(true);
    expect(overLimit([rec(1, 0, 'statement')], L, 'statement', 60_000)).toBe(false);
    expect(overLimit([rec(1, 0, 'client-info')], L, 'statement', 1)).toBe(false);
    expect(overLimit([rec(1, 0, 'statement')], L, 'client-info', 1)).toBe(false);
    const N = { callClass: null, calls: 5, windowMs: 10_000 };
    const prior = [
      rec(1, 0, 'accounts'),
      rec(2, 2000, 'transactions'),
      rec(3, 4000, 'accounts'),
      rec(4, 6000, 'transactions'),
      rec(5, 8000, 'accounts'),
    ];
    expect(overLimit(prior, N, 'accounts', 9_999)).toBe(true);
    expect(overLimit(prior, N, 'accounts', 10_000)).toBe(false);

    const ds = await workedDraw();
    let t = ds.t0;
    const s = await startSecondStandIn(ds, 'stand-in-abcdefgh', () => t);
    const accounts = (bearer: string) => get(`${s.baseAddress}/v1/accounts`, { Authorization: `Bearer ${bearer}` });
    const arrivals: number[] = [];
    try {
      // 1. six inside 9 995 ms: the sixth refused
      const statuses: number[] = [];
      for (const off of [0, 1_999, 3_998, 5_997, 7_996, 9_995]) {
        t = ds.t0 + off;
        arrivals.push(t);
        statuses.push((await accounts('stand-in-abcdefgh')).status);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);

      // 2. the refused sixth counts against the seventh
      t = ds.t0 + 11_000;
      arrivals.push(t);
      expect((await accounts('stand-in-abcdefgh')).status).toBe(429);

      // 3. a wrong token once the window is clear
      t = ds.t0 + 30_000;
      arrivals.push(t);
      expect((await accounts('wrong')).status).toBe(401);

      const calls = s.calls();
      expect(calls.length).toBe(8);
      expect(calls.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(calls.map((c) => c.at)).toEqual(arrivals);
      expect([calls[5].refused, calls[5].status, calls[6].refused, calls[6].status]).toEqual([true, 429, true, 429]);
      expect(calls[7].status).toBe(401);
      for (const c of calls) expect(['127.0.0.1', '::1', '::ffff:127.0.0.1']).toContain(c.remote);
    } finally {
      await closeQuietly(s);
    }
  });
});
