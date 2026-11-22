// Second source (S-192): a bank whose shape is unlike Monobank's at every point of the source
// boundary — signed decimal-text amounts in major units, letter currency codes, date-times with an
// offset, one account listing, per-account transaction pages joined by a cursor, no merchant
// category code and a balance that is the holder's own money. Switched off by default; no push, no
// jars, no rates. Nothing outside this module knows the bank's shape: past translateAccounts and
// translatePage nothing distinguishes the source from Monobank except its declarations.
//
// The translation below calls nothing. The client at the end of the file makes every call through
// cfg.http alone.

import type { Instant, SourceId } from '../../core/primitives';
import { narrowingName } from '../../core/register';
import type { SourceSettingsGroup } from '../../config/settings';
import type { Interval } from '../../local/covered';
import type { TranslatedTransaction } from '../../local/translated';
import { type Money, parseMinorUnits } from '../../money/money';
import type { Translated } from '../../money/quarantine';
import type { ReportedBalance } from '../../sync/balances';
import type { RateLimitDecl } from '../../sync/rate-gate';
import {
  type HoldingsReport,
  type SourceClient,
  type SourceClientConfig,
  type SourceDefinition,
  type WindowPage,
  SourceCallError,
} from '../../sync/source-contract';

export const SECOND_ID: SourceId = 'second';
export const SECOND_PAGE_LIMIT = 50; // most records the bank returns per page
export const SECOND_MAX_WINDOW_MS = 2_678_400_000; // 31 days
export const SECOND_LIMITS: RateLimitDecl = {
  windows: [{ callClass: null, calls: 5, windowMs: 10_000 }],
  marginMs: 500,
  refusalCooldownMs: 10_000,
};

// No baseAddressDefault: switching the source on without ARCANUM_SECOND_BASE_URL is a start-gate fault.
export const settingsGroup: SourceSettingsGroup = {
  sourceId: 'second',
  enabledByDefault: false,
  needsCredential: true,
  extras: [],
};

const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export function readMoment(text: unknown): Instant | null {
  if (typeof text !== 'string' || !MOMENT.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

const unreadable = (what: string): never => {
  throw new SourceCallError('other', `second: unreadable reply: ${what}`);
};

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const isOptionalString = (x: unknown): boolean => x === undefined || typeof x === 'string';

export function translateAccounts(body: unknown): HoldingsReport {
  if (!isObject(body) || !Array.isArray(body.accounts)) return unreadable('no account list');
  const holdings: HoldingsReport['holdings'][number][] = [];
  const balances: ReportedBalance[] = [];
  const seen = new Set<string>();
  for (const account of body.accounts as unknown[]) {
    if (!isObject(account)) return unreadable('an account is not an object');
    const { id, name, currency, balance } = account;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof currency !== 'string' || typeof balance !== 'string') {
      return unreadable('an account field is missing or not text');
    }
    if (seen.has(id)) return unreadable(`account ${id} listed twice`);
    seen.add(id);
    const parsed = parseMinorUnits(balance, currency);
    if (!parsed.ok) return unreadable(`account ${id} balance: ${parsed.detail}`);
    holdings.push({ kind: 'account', sourceId: SECOND_ID, bankId: id, currency });
    balances.push({ holdingId: narrowingName(SECOND_ID, 'account', id), balance: parsed.money, creditLimit: null });
  }
  return { holdings, balances };
}

interface BankRecord {
  id: string;
  booked_at: string;
  amount: string;
  currency: string;
  original_amount?: string;
  original_currency?: string;
  merchant: string | null;
  description: string;
  status: 'booked' | 'pending';
  counterparty_account?: string;
}

function readRecord(x: unknown, window: Interval): { record: BankRecord; at: Instant } {
  if (!isObject(x)) return unreadable('a record is not an object');
  const ok =
    typeof x.id === 'string' &&
    typeof x.booked_at === 'string' &&
    typeof x.amount === 'string' &&
    typeof x.currency === 'string' &&
    isOptionalString(x.original_amount) &&
    isOptionalString(x.original_currency) &&
    (x.merchant === null || typeof x.merchant === 'string') &&
    typeof x.description === 'string' &&
    (x.status === 'booked' || x.status === 'pending') &&
    isOptionalString(x.counterparty_account);
  if (!ok) return unreadable('a record is not of the bank shape');
  const record = x as unknown as BankRecord;
  const at = readMoment(record.booked_at);
  if (at === null) return unreadable(`record ${record.id}: booked_at '${record.booked_at}' is not a moment`);
  if (at < window.startAt || at >= window.endAt) return unreadable(`record ${record.id} lies outside the window`);
  return { record, at };
}

function translateRecord(
  record: BankRecord,
  at: Instant,
  accountId: string,
  seenAt: Instant,
): Translated<TranslatedTransaction> {
  const quarantined = (reason: 'malformed' | 'excess_precision' | 'unknown_currency', detail: string) =>
    ({
      kind: 'quarantined',
      entry: { sourceId: SECOND_ID, bankId: record.id, raw: JSON.stringify(record), reason, detail, seenAt, occurredAt: at },
    }) as const;

  const a = parseMinorUnits(record.amount, record.currency);
  if (!a.ok) return quarantined(a.reason, a.detail);

  let original: Money | null = null;
  if (record.original_currency !== undefined && record.original_currency !== record.currency) {
    if (record.original_amount === undefined) {
      return quarantined('malformed', `${record.amount} ${record.currency}: original in ${record.original_currency} has no amount`);
    }
    const o = parseMinorUnits(record.original_amount, record.original_currency);
    if (!o.ok) return quarantined(o.reason, o.detail);
    const sa = a.money.minor < 0n ? -1 : a.money.minor > 0n ? 1 : 0;
    const so = o.money.minor < 0n ? -1 : o.money.minor > 0n ? 1 : 0;
    if (sa !== so) {
      return quarantined(
        'malformed',
        `${record.amount} ${record.currency} and original ${record.original_amount} ${record.original_currency}: signs differ`,
      );
    }
    original = o.money;
  }

  const counterparty = record.counterparty_account;
  return {
    kind: 'held',
    sourceId: SECOND_ID,
    bankId: record.id,
    record: {
      sourceId: SECOND_ID,
      bankId: record.id,
      holdingId: narrowingName(SECOND_ID, 'account', accountId),
      occurredAt: at,
      amount: a.money,
      originalAmount: original,
      cashback: null,
      settled: record.status === 'booked',
      mcc: null,
      originalMcc: null,
      merchantText: record.merchant,
      description: record.description,
      comment: null,
      counterpart:
        counterparty !== undefined && counterparty !== accountId
          ? { holdingId: narrowingName(SECOND_ID, 'account', counterparty), bankId: null, via: 'link' }
          : null,
    },
  };
}

// `seen` carries the bank ids already translated in the same window, across its pages.
function translatePageSeen(
  body: unknown,
  accountId: string,
  window: Interval,
  seenAt: Instant,
  seen: Set<string>,
): { items: Translated<TranslatedTransaction>[]; nextCursor: string | null } {
  if (!isObject(body) || !Array.isArray(body.transactions)) return unreadable('no transaction list');
  const next = body.next_cursor;
  if (next !== null && typeof next !== 'string') return unreadable('next_cursor is neither text nor null');
  // Every record is read before any is translated: one unreadable record rejects the whole page.
  const read = (body.transactions as unknown[]).map((x) => readRecord(x, window));
  const items: Translated<TranslatedTransaction>[] = [];
  for (const { record, at } of read) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    items.push(translateRecord(record, at, accountId, seenAt));
  }
  return { items, nextCursor: next };
}

export function translatePage(
  body: unknown,
  accountId: string,
  window: Interval,
  seenAt: Instant,
): { items: Translated<TranslatedTransaction>[]; nextCursor: string | null } {
  return translatePageSeen(body, accountId, window, seenAt, new Set());
}

// --- client ----------------------------------------------------------------------------------

// One call through cfg.http: the reply's parsed body, or the call's failure class. Never retries.
async function call(cfg: SourceClientConfig, callClass: string, url: string, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  let text: string;
  try {
    res = await cfg.http.request(
      callClass,
      url,
      { method: 'GET', headers: { Authorization: `Bearer ${cfg.credential ?? ''}` } },
      signal,
    );
    text = await res.text();
  } catch (e) {
    throw new SourceCallError('other', `second: ${callClass} call failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 429) throw new SourceCallError('rate_refused', `second: ${callClass} call refused for rate`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (res.status === 422 && isObject(body) && body.error === 'range_not_available') {
    throw new SourceCallError('date_refused', `second: ${callClass} range not available`);
  }
  if (res.status !== 200) throw new SourceCallError('other', `second: ${callClass} answered ${res.status}`);
  if (body === undefined) return unreadable('body is not JSON');
  return body;
}

function openClient(cfg: SourceClientConfig): SourceClient {
  const base = cfg.baseAddress.endsWith('/') ? cfg.baseAddress.slice(0, -1) : cfg.baseAddress;
  return {
    async refreshHoldings(signal) {
      return translateAccounts(await call(cfg, 'accounts', `${base}/v1/accounts`, signal));
    },
    async fetchWindow(holding, window, signal): Promise<WindowPage> {
      const from = encodeURIComponent(new Date(window.startAt).toISOString());
      const to = encodeURIComponent(new Date(window.endAt).toISOString());
      const first = `${base}/v1/accounts/${encodeURIComponent(holding.bankId)}/transactions?from=${from}&to=${to}`;
      const items: Translated<TranslatedTransaction>[] = [];
      const seen = new Set<string>();
      const followed = new Set<string>();
      let cursor: string | null = null;
      for (;;) {
        const url = cursor === null ? first : `${first}&cursor=${encodeURIComponent(cursor)}`;
        const body = await call(cfg, 'transactions', url, signal);
        const page = translatePageSeen(body, holding.bankId, window, Date.now(), seen);
        items.push(...page.items);
        if (page.nextCursor === null) return { items, next: null };
        if (followed.has(page.nextCursor)) {
          throw new SourceCallError('other', `second: cursor '${page.nextCursor}' repeated in one window`);
        }
        followed.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    },
  };
}

export const source: SourceDefinition = {
  id: SECOND_ID,
  capabilities: [],
  settingsGroup,
  balanceConvention: 'own_money_as_reported',
  limits: SECOND_LIMITS,
  maxWindowMs: SECOND_MAX_WINDOW_MS,
  open: openClient,
};
