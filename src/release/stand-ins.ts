// Release stand-ins (S-236): a stand-in Monobank and a stand-in second source on loopback, each
// serving the run's dataset (S-233) in its own bank's shape from its own encoder. Neither imports a
// product source module's translator or client, so a translation fault is not mirrored; S-192 is
// cited only for the second bank's page size. Every call is recorded with its arrival moment, class
// and remote address, and a call over the limits written here (independently of the product's own
// declarations) is refused as the bank refuses it.

import type { Server } from 'bun';
import { type Dataset, type MonoTxn } from './dataset';
import { SECOND_PAGE_LIMIT } from '../sources/second/source';

export interface StandInLimit {
  readonly callClass: string | null; // null: every call
  readonly calls: number;
  readonly windowMs: number;
}

export const MONOBANK_STAND_IN_LIMITS: readonly StandInLimit[] = [
  { callClass: 'client-info', calls: 1, windowMs: 60_000 },
  { callClass: 'statement', calls: 1, windowMs: 60_000 },
];

export const SECOND_STAND_IN_LIMITS: readonly StandInLimit[] = [{ callClass: null, calls: 5, windowMs: 10_000 }];

export interface CallRecord {
  readonly seq: number;
  readonly at: number;
  readonly callClass: string;
  readonly path: string;
  readonly remote: string;
  readonly status: number;
  readonly refused: boolean;
}

// True iff the limit counts class c and, among the prior records it counts plus this arrival in seq
// order, this arrival has at least limit.calls records before it and the one limit.calls places
// before it arrived less than limit.windowMs earlier.
export function overLimit(prior: readonly CallRecord[], limit: StandInLimit, callClass: string, at: number): boolean {
  const counts = (c: string) => limit.callClass === null || limit.callClass === c;
  if (!counts(callClass)) return false;
  const counted = prior.filter((r) => counts(r.callClass)).sort((a, b) => a.seq - b.seq);
  if (counted.length < limit.calls) return false;
  return at - counted[counted.length - limit.calls].at < limit.windowMs;
}

export interface StandIn {
  readonly port: number;
  readonly baseAddress: string;
  close(): Promise<void>;
  reopen(): Promise<void>;
  calls(): readonly CallRecord[];
}

export interface MonobankStandIn extends StandIn {
  gain(t: MonoTxn, notify: 'send' | 'drop'): Promise<{ status: number | null }>; // stamps t.time, holds it, then sends or drops its notification
  webhookUrl(): string | null;
  freeze(): void; // from here gain() throws
}

// --- shared server and call recorder -----------------------------------------------------------

interface Answer {
  readonly status: number;
  readonly body?: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Route {
  readonly callClass: string;
  handle(req: Request, url: URL): Answer | Promise<Answer>;
}

interface Recorder {
  readonly records: Mutable<CallRecord>[];
}

const json = (status: number, value: unknown): Answer => ({ status, body: JSON.stringify(value) });

const respond = (a: Answer): Response =>
  new Response(a.body ?? '', {
    status: a.status,
    headers: a.body === undefined ? {} : { 'Content-Type': 'application/json' },
  });

interface ServeSpec {
  readonly now: () => number;
  readonly limits: readonly StandInLimit[];
  readonly route: (req: Request, url: URL) => Route;
  readonly authorized: (req: Request) => boolean;
  readonly unauthorized: Answer;
  readonly refusal: Answer;
}

class LoopbackStandIn implements StandIn {
  port = 0;
  baseAddress = '';
  private server: Server<undefined> | null = null;
  protected readonly recorder: Recorder = { records: [] };

  constructor(private readonly spec: ServeSpec) {}

  async start(): Promise<void> {
    this.listen(0);
    this.port = this.server!.port!;
    this.baseAddress = `http://127.0.0.1:${this.port}`;
  }

  private listen(port: number): void {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: (req, server) => this.serve(req, server.requestIP(req)?.address ?? ''),
    });
  }

  private async serve(req: Request, remote: string): Promise<Response> {
    const at = this.spec.now();
    const url = new URL(req.url);
    const route = this.spec.route(req, url);
    const records = this.recorder.records;
    const prior = records.slice();
    const record: Mutable<CallRecord> = {
      seq: records.length + 1,
      at,
      callClass: route.callClass,
      path: url.pathname + url.search,
      remote,
      status: 0,
      refused: false,
    };
    records.push(record);
    let answer: Answer;
    if (this.spec.limits.some((l) => overLimit(prior, l, route.callClass, at))) {
      record.refused = true;
      answer = this.spec.refusal;
    } else if (!this.spec.authorized(req)) {
      answer = this.spec.unauthorized;
    } else {
      answer = await route.handle(req, url);
    }
    record.status = answer.status;
    return respond(answer);
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await server.stop(true);
  }

  async reopen(): Promise<void> {
    if (this.server !== null) return;
    this.listen(this.port);
  }

  calls(): readonly CallRecord[] {
    return this.recorder.records.map((r) => ({ ...r }));
  }
}

const notFound: Route = { callClass: 'other', handle: () => ({ status: 404 }) };

// --- stand-in Monobank -------------------------------------------------------------------------

const MONO_MAX_RANGE_S = 2_682_000;
const MONO_STATEMENT_MAX = 500;

export async function startMonobankStandIn(ds: Dataset, token: string, now: () => number): Promise<MonobankStandIn> {
  const holdings = ds.monobank.holdings;
  const held = new Map<string, MonoTxn[]>(holdings.map((h) => [h.id, []]));
  for (const t of [...ds.monobank.initial, ...ds.monobank.older]) held.get(t.holding)?.push(t);
  let webhook: string | null = null;
  let frozen = false;

  const balanceOf = (holding: string) => holdings.find((h) => h.id === holding)?.balance ?? 0;
  const encodeItem = (t: MonoTxn) => ({
    id: t.id,
    time: Math.floor((t.time ?? 0) / 1000),
    description: t.description,
    mcc: t.mcc,
    originalMcc: t.mcc,
    hold: false,
    amount: t.amount,
    operationAmount: t.operationAmount,
    currencyCode: t.currencyCode,
    commissionRate: 0,
    cashbackAmount: 0,
    balance: balanceOf(t.holding),
  });

  const clientInfo: Route = {
    callClass: 'client-info',
    handle: () =>
      json(200, {
        clientId: `stand-in-${ds.runId}`,
        name: 'Stand-in holder',
        webHookUrl: webhook ?? '',
        permissions: 'psfj',
        accounts: holdings
          .filter((h) => h.kind === 'account')
          .map((h) => ({
            id: h.id,
            sendId: `send-${h.id}`,
            balance: h.balance,
            creditLimit: h.creditLimit,
            type: 'black',
            currencyCode: h.currencyCode,
            cashbackType: 'UAH',
            maskedPan: [],
            iban: `UA00STANDIN${h.id}`,
          })),
        jars: holdings
          .filter((h) => h.kind === 'jar')
          .map((h) => ({
            id: h.id,
            sendId: `send-${h.id}`,
            title: h.id,
            description: '',
            currencyCode: h.currencyCode,
            balance: h.balance,
            goal: h.goal,
          })),
      }),
  };

  const statement = (holding: string, fromText: string, toText: string | undefined): Route => ({
    callClass: 'statement',
    handle: () => {
      const seconds = /^\d+$/;
      if (!seconds.test(fromText) || (toText !== undefined && !seconds.test(toText))) return { status: 400 };
      const from = Number(fromText);
      const to = toText === undefined ? Math.floor(now() / 1000) : Number(toText);
      const txns = held.get(holding);
      if (to - from > MONO_MAX_RANGE_S || txns === undefined) return { status: 400 };
      const items = txns
        .filter((t) => t.time !== null && from <= t.time / 1000 && t.time / 1000 <= to)
        .sort((a, b) => b.time! - a.time!)
        .slice(0, MONO_STATEMENT_MAX)
        .map(encodeItem);
      return json(200, items);
    },
  });

  // The figures go out as the row's own text, so the JSON carries exactly the number text served.
  const currency: Route = {
    callClass: 'currency',
    handle: () => {
      const date = Math.floor(ds.monobank.rateStamp / 1000);
      const rows = ds.monobank.rates.map(
        (r) =>
          `{"currencyCodeA":${r.currencyCodeA},"currencyCodeB":${r.currencyCodeB},"date":${date},` +
          `"rateBuy":${r.rateBuy},"rateSell":${r.rateSell}}`,
      );
      return { status: 200, body: `[${rows.join(',')}]` };
    },
  };

  const registerWebhook: Route = {
    callClass: 'webhook',
    handle: async (req) => {
      let address: unknown;
      try {
        address = ((await req.json()) as { webHookUrl?: unknown }).webHookUrl;
      } catch {
        return { status: 400 };
      }
      if (typeof address !== 'string') return { status: 400 };
      try {
        const res = await fetch(address, { method: 'GET' });
        await res.arrayBuffer();
        if (res.status !== 200) return { status: 400 };
      } catch {
        return { status: 400 };
      }
      webhook = address;
      return json(200, { status: 'ok' });
    },
  };

  const route = (req: Request, url: URL): Route => {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/personal/client-info') return clientInfo;
    if (req.method === 'GET' && path === '/bank/currency') return currency;
    if (req.method === 'POST' && path === '/personal/webhook') return registerWebhook;
    const m = /^\/personal\/statement\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (req.method === 'GET' && m !== null) return statement(decodeURIComponent(m[1]), m[2], m[3]);
    return notFound;
  };

  const standIn = new LoopbackStandIn({
    now,
    limits: MONOBANK_STAND_IN_LIMITS,
    route,
    authorized: (req) => req.headers.get('X-Token') === token,
    unauthorized: json(403, { errorDescription: 'Unknown token' }),
    refusal: json(429, { errorDescription: 'Too many requests' }),
  });
  await standIn.start();

  return Object.assign(standIn, {
    async gain(t: MonoTxn, notify: 'send' | 'drop'): Promise<{ status: number | null }> {
      if (frozen) throw new Error('stand-in monobank: gain() after freeze()');
      const txns = held.get(t.holding);
      if (txns === undefined) throw new Error(`stand-in monobank: unknown holding '${t.holding}'`);
      t.time = Math.floor(now() / 1000) * 1000;
      txns.push(t);
      if (notify === 'drop' || webhook === null) return { status: null };
      try {
        const res = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'StatementItem', data: { account: t.holding, statementItem: encodeItem(t) } }),
        });
        await res.arrayBuffer();
        return { status: res.status };
      } catch {
        return { status: null };
      }
    },
    webhookUrl: () => webhook,
    freeze: () => {
      frozen = true;
    },
  });
}

// --- stand-in second source --------------------------------------------------------------------

const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const OFFSET_MS = 3 * 3_600_000;

const readMoment = (text: string | null): number | null => {
  if (text === null || !MOMENT.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
};

// Written with the offset +03:00, unlike the product's zone.
const bookedAtText = (at: number): string => new Date(at + OFFSET_MS).toISOString().slice(0, 23) + '+03:00';

export async function startSecondStandIn(ds: Dataset, token: string, now: () => number): Promise<StandIn> {
  const second = ds.second;
  const rangeRefused = json(422, { error: 'range_not_available' });

  const accounts: Route = {
    callClass: 'accounts',
    handle: () =>
      json(200, {
        accounts: second.accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency, balance: a.balance })),
      }),
  };

  const transactions = (accountId: string): Route => ({
    callClass: 'transactions',
    handle: (_req, url) => {
      const from = readMoment(url.searchParams.get('from'));
      const to = readMoment(url.searchParams.get('to'));
      if (from === null || to === null || from < second.historyFrom) return rangeRefused;
      if (!second.accounts.some((a) => a.id === accountId)) return json(404, { error: 'account_not_found' });
      const cursor = url.searchParams.get('cursor');
      let page = 0;
      if (cursor !== null) {
        const m = /^p([1-9]\d*)$/.exec(cursor);
        if (m === null) return json(400, { error: 'invalid_cursor' });
        page = Number(m[1]);
      }
      const records = second.initial
        .filter((r) => r.account === accountId && from <= r.bookedAt && r.bookedAt < to)
        .sort((a, b) => a.bookedAt - b.bookedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const start = page * SECOND_PAGE_LIMIT;
      const slice = records.slice(start, start + SECOND_PAGE_LIMIT).map((r) => ({
        id: r.id,
        booked_at: bookedAtText(r.bookedAt),
        amount: r.amount,
        currency: r.currency,
        ...(r.originalAmount !== undefined ? { original_amount: r.originalAmount } : {}),
        ...(r.originalCurrency !== undefined ? { original_currency: r.originalCurrency } : {}),
        merchant: r.merchant,
        description: r.description,
        status: 'booked',
      }));
      const next = start + SECOND_PAGE_LIMIT < records.length ? `p${page + 1}` : null;
      return json(200, { transactions: slice, next_cursor: next });
    },
  });

  const route = (req: Request, url: URL): Route => {
    if (req.method !== 'GET') return notFound;
    if (url.pathname === '/v1/accounts') return accounts;
    const m = /^\/v1\/accounts\/([^/]+)\/transactions$/.exec(url.pathname);
    if (m !== null) return transactions(decodeURIComponent(m[1]));
    return notFound;
  };

  const standIn = new LoopbackStandIn({
    now,
    limits: SECOND_STAND_IN_LIMITS,
    route,
    authorized: (req) => req.headers.get('Authorization') === `Bearer ${token}`,
    unauthorized: json(401, { error: 'unauthorized' }),
    refusal: { status: 429 },
  });
  await standIn.start();
  return standIn;
}
