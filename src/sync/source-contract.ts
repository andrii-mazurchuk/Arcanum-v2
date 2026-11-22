// Source contract (S-217): what every built source declares — id, capabilities, balance convention,
// rate limits, longest window, optional earliest date, settings group, optional push — and the client
// it opens over a gated HTTP. Each source module exports one SourceDefinition as `source`; the
// composition root lists them in build order. Nothing in sync names a particular bank.

import type { HoldingId, Instant } from '../core/primitives';
import type { HoldingKind, HoldingRow, RegisterView } from '../core/register';
import type { SettingDecl, SourceSettings, SourceSettingsGroup } from '../config/settings';
import { settingValue } from '../config/settings';
import type { Interval } from '../local/covered';
import type { TranslatedTransaction } from '../local/translated';
import type { Translated } from '../money/quarantine';
import type { BuiltSource } from '../money/rate-view';
import type { StatedRate } from '../money/recorded-rates';
import type { ReportedBalance } from './balances';
import type { GatedHttp, RateLimitDecl } from './rate-gate';

// How the bank's reported account balance relates to the credit limit. The one declaration of the
// convention's members; the answering side imports it from here through the composition root.
export type BalanceConvention = 'includes_credit_limit' | 'own_money_as_reported';

export interface SourceDefinition extends BuiltSource {
  readonly settingsGroup: SourceSettingsGroup; // the same object the source exports as settingsGroup; settingsGroup.sourceId === id
  readonly balanceConvention: BalanceConvention; // declared once per source
  readonly limits: RateLimitDecl;
  readonly maxWindowMs: number; // longest window one statement call may cover; whole number >= 1
  readonly earliestAvailable?: (now: Instant) => Instant; // the earliest instant the source offers history from, when it declares one
  readonly push?: PushTranslator; // present iff the bank delivers push notifications
  open(cfg: SourceClientConfig): SourceClient;
}

export interface SourceClientConfig {
  readonly baseAddress: string; // settingValue of the group's baseAddress
  readonly credential: string | null; // settingValue of credential; null when the group needs none
  readonly extras: Readonly<Record<string, unknown>>; // settingValue of each extra, by key
  readonly http: GatedHttp; // the only route to the network
}

export interface HoldingsReport {
  readonly holdings: readonly Omit<HoldingRow, 'id'>[]; // every account and, with 'jars', every jar the bank lists
  readonly balances: readonly ReportedBalance[]; // one per holding listed
  readonly pushAddress?: string | null; // the push address the bank holds; absent when the source cannot read it
}

export interface WindowPage {
  readonly items: readonly Translated<TranslatedTransaction>[]; // this call's records, held or quarantined, each with sourceId = the source's id
  readonly next: Interval | null; // null: the window is whole up to here; else the part of the window still to fetch (row cap reached)
}

export interface SourceClient {
  refreshHoldings(signal: AbortSignal): Promise<HoldingsReport>;
  fetchWindow(holding: HoldingRow, window: Interval, signal: AbortSignal): Promise<WindowPage>;
  registerPush?(address: string, signal: AbortSignal): Promise<void>; // present iff the definition has push
  fetchRates?(signal: AbortSignal): Promise<StatedRate[]>; // present iff capabilities include 'rates'
}

export interface PushContext {
  readonly register: RegisterView; // the store's register as read by the receiver for this notification
  readonly now: Instant; // the receiver's clock; used only as seenAt of a quarantined entry
}

export type PushReading =
  | {
      kind: 'notification';
      holdingId: HoldingId;
      holdingKind: HoldingKind;
      item: Translated<TranslatedTransaction>;
      balance: ReportedBalance | null;
    }
  | { kind: 'unknown_holding'; holdingId: HoldingId }
  | { kind: 'not_well_formed'; reason: string };

export interface PushTranslator {
  read(body: string, contentType: string | null, ctx: PushContext): PushReading; // total, never throws, never calls the bank, writes nothing
  readonly addressCheck: { readonly method: 'GET' | 'HEAD' | null; readonly status: number }; // what the bank sends to the push address when registering, and the reply status it expects
}

export const PUSH_URL_KEY = 'PUSH_URL';
export const PUSH_SECRET_KEY = 'PUSH_SECRET';

// An http or https address, one trailing '/' removed.
function parsePushUrl(raw: string): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (!URL.canParse(raw)) return { ok: false, reason: 'not an address' };
  const protocol = new URL(raw).protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return { ok: false, reason: 'not an http or https address' };
  return { ok: true, value: raw.endsWith('/') ? raw.slice(0, -1) : raw };
}

function parsePushSecret(raw: string): { ok: true; value: string | null } | { ok: false; reason: string } {
  return /^[A-Za-z0-9_-]{16,128}$/.test(raw)
    ? { ok: true, value: raw }
    : { ok: false, reason: 'not 16 to 128 characters of A-Z, a-z, 0-9, _ and -' };
}

// Absent is defaulted to null, which satisfies the start gate: a missing pair only switches registration off.
export const PUSH_SETTING_DECLS: readonly SettingDecl<string | null>[] = Object.freeze([
  Object.freeze({ key: PUSH_URL_KEY, parse: parsePushUrl, default: null }),
  Object.freeze({ key: PUSH_SECRET_KEY, parse: parsePushSecret, default: null }),
]);

export interface PushSettings {
  readonly publicAddress: string | null;
  readonly secretPath: string | null;
}

function extraString(s: SourceSettings, key: string): string | null {
  const state = s.extras[key];
  if (state === undefined) return null;
  const value = settingValue(state);
  return typeof value === 'string' ? value : null;
}

export function pushSettingsOf(s: SourceSettings): PushSettings {
  return { publicAddress: extraString(s, PUSH_URL_KEY), secretPath: extraString(s, PUSH_SECRET_KEY) };
}

export function pushAddress(p: PushSettings): string | null {
  return p.publicAddress !== null && p.secretPath !== null ? `${p.publicAddress}/${p.secretPath}` : null;
}

export type SourceFailure = 'rate_refused' | 'date_refused' | 'other';

// Thrown by every client method on a failed call.
export class SourceCallError extends Error {
  readonly kind: SourceFailure;
  constructor(kind: SourceFailure, message?: string) {
    super(message ?? kind);
    this.name = 'SourceCallError';
    this.kind = kind;
  }
}
