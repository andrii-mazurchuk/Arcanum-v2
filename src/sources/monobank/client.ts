// Monobank client (S-219): the calls, made only through cfg.http, each once under the caller's
// signal and never retried. Every reply body is read with readJsonExact and handed to ./source's
// translation; a failed call is classed as rate_refused (429), date_refused (a statement's 400) or
// other (any other status, a transport error, an abort or an unreadable body).

import { type SourceClient, type SourceClientConfig, type WindowPage, SourceCallError } from '../../sync/source-contract';
import {
  type ExactJson,
  readJsonExact,
  secondsWindow,
  translateClientInfo,
  translateCurrency,
  translateStatement,
} from './source';

type CallClass = 'client_info' | 'statement' | 'webhook' | 'currency';

const failed = (callClass: CallClass, what: string): never => {
  throw new SourceCallError('other', `monobank: ${callClass} ${what}`);
};

export function openMonobankClient(cfg: SourceClientConfig): SourceClient {
  const base = cfg.baseAddress.endsWith('/') ? cfg.baseAddress.slice(0, -1) : cfg.baseAddress;

  // One call: on 200 the reply's text, else the call's failure class.
  async function call(
    callClass: CallClass,
    url: string,
    init: { method: 'GET' | 'POST'; body?: string; personal: boolean },
    signal: AbortSignal,
  ): Promise<string> {
    if (cfg.credential === null) return failed(callClass, 'has no credential');
    const headers: Record<string, string> = {};
    if (init.personal) headers['X-Token'] = cfg.credential;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    let text: string;
    try {
      res = await cfg.http.request(callClass, url, { method: init.method, headers, body: init.body }, signal);
      text = await res.text();
    } catch (e) {
      return failed(callClass, `call failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 429) throw new SourceCallError('rate_refused', `monobank: ${callClass} call refused for rate`);
    if (res.status === 400 && callClass === 'statement') {
      throw new SourceCallError('date_refused', `monobank: ${callClass} dates refused`);
    }
    if (res.status !== 200) return failed(callClass, `answered ${res.status}`);
    return text;
  }

  const read = (callClass: CallClass, text: string): ExactJson => {
    const body = readJsonExact(text);
    return body === undefined ? failed(callClass, 'body is not JSON') : body;
  };

  return {
    async refreshHoldings(signal) {
      const text = await call('client_info', `${base}/personal/client-info`, { method: 'GET', personal: true }, signal);
      return translateClientInfo(read('client_info', text));
    },
    async fetchWindow(holding, window, signal): Promise<WindowPage> {
      const sw = secondsWindow(window);
      if (sw === null) return { items: [], next: null };
      const url = `${base}/personal/statement/${encodeURIComponent(holding.bankId)}/${sw.from}/${sw.to}`;
      const text = await call('statement', url, { method: 'GET', personal: true }, signal);
      const seenAt = Date.now();
      return translateStatement(read('statement', text), holding, window, seenAt);
    },
    async registerPush(address, signal) {
      const body = JSON.stringify({ webHookUrl: address });
      await call('webhook', `${base}/personal/webhook`, { method: 'POST', body, personal: true }, signal);
    },
    async fetchRates(signal) {
      const text = await call('currency', `${base}/bank/currency`, { method: 'GET', personal: false }, signal);
      return translateCurrency(read('currency', text));
    },
  };
}
