// Push receiver (S-218): the product's only network listener. One exact secret path per push-capable
// source; the address check, POST only, the register read once and handed to the translator; an
// unknown account acknowledged and logged, a not-well-formed reading refused; otherwise the
// notification and its balance (stamped with the transaction's moment) go through ingest as one
// write, and the acknowledgment follows its commit. It never calls a bank and never starts a job.

import type { Instant, SourceId } from '../core/primitives';
import type { Store, WriteTx } from '../db/index';
import { ingest } from '../local/ingest';
import { recordBalances } from './balances';
import type { PushTranslator } from './source-contract';

export interface PushRoute {
  readonly sourceId: SourceId;
  readonly secretPath: string;
  readonly translator: PushTranslator;
}

export interface PushReceiverDeps {
  readonly port: number; // the push port setting; 0 takes any free port
  readonly routes: readonly PushRoute[]; // one per push-capable source with both push settings set; may be empty
  readonly store: Store;
  readonly now: () => Instant; // the service clock; read once per notification as PushContext.now; the balance stamp never reads it
  readonly log: (line: string) => void;
}

export interface PushReceiver {
  readonly port: number;
  stop(): Promise<void>;
}

export class PushRouteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushRouteConflictError';
  }
}

const reply = (status: number): Response => new Response(null, { status });

export async function handlePush(deps: PushReceiverDeps, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const route = deps.routes.find((r) => `/${r.secretPath}` === path);
  if (route === undefined) {
    deps.log('push refused: unknown path');
    return reply(404);
  }
  const { sourceId, translator } = route;
  if (translator.addressCheck.method !== null && request.method === translator.addressCheck.method) {
    return reply(translator.addressCheck.status);
  }
  if (request.method !== 'POST') return reply(405);

  const register = deps.store.readSnapshot((s) => s.register());
  const reading = translator.read(await request.text(), request.headers.get('content-type'), {
    register,
    now: deps.now(),
  });

  if (reading.kind === 'not_well_formed') {
    deps.log(`push rejected source=${sourceId}: ${reading.reason}`);
    return reply(400);
  }
  if (reading.kind === 'notification') {
    const item = reading.item;
    let reason: string | null = null;
    if (item.kind === 'held') {
      if (item.sourceId !== sourceId || item.record.sourceId !== sourceId) {
        reason = `the transaction names source ${item.record.sourceId}`;
      } else if (item.record.holdingId !== reading.holdingId) {
        reason = `the transaction is on holding ${item.record.holdingId}, not ${reading.holdingId}`;
      }
    } else if (item.entry.sourceId !== sourceId) {
      reason = `the quarantined entry names source ${item.entry.sourceId}`;
    }
    if (reason !== null) {
      deps.log(`push rejected source=${sourceId}: ${reason}`);
      return reply(400);
    }
  }
  if (reading.kind === 'unknown_holding' || !register.holdings.some((h) => h.id === reading.holdingId)) {
    deps.log(`push for unknown account source=${sourceId} holding=${reading.holdingId}; nothing stored`);
    return reply(200);
  }

  const item = reading.item;
  const stamp = item.kind === 'held' ? item.record.occurredAt : item.entry.occurredAt;
  const balance = reading.balance;
  const also =
    balance !== null && stamp !== null
      ? (tx: WriteTx) => {
          recordBalances(tx, sourceId, [balance], stamp, 'if_given');
        }
      : undefined;
  try {
    ingest(deps.store, { sourceId, items: [item], covered: null, also }, deps.log);
  } catch (e) {
    deps.log(`push failed source=${sourceId}: ${e instanceof Error ? e.message : String(e)}`);
    return reply(500);
  }
  return reply(200);
}

export function startPushReceiver(deps: PushReceiverDeps): PushReceiver {
  const seen = new Set<string>();
  for (const r of deps.routes) {
    if (seen.has(r.secretPath)) {
      throw new PushRouteConflictError(`two push routes share the secret path of source ${r.sourceId}`);
    }
    seen.add(r.secretPath);
  }

  const inFlight = new Set<Promise<Response>>();
  const server = Bun.serve({
    port: deps.port,
    fetch(request) {
      const handled = handlePush(deps, request);
      inFlight.add(handled);
      const done = () => {
        inFlight.delete(handled);
      };
      handled.then(done, done);
      return handled;
    },
  });

  return {
    port: server.port ?? deps.port,
    async stop() {
      void server.stop(false);
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
