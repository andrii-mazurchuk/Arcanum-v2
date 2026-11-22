// Service run (S-215): after the start gate passed, one rate gate, one client and one worker per
// switched-on source, registration switched off and logged where the push pair is incomplete, the
// receiver listening, and the stop sequence on the termination or interrupt signal — listener first,
// workers stopped, their in-flight work awaited, the store closed — resolving 0. It reads no
// environment, opens no store and is handed the runtime's network function.

import type { SettingsRecord } from '../config/settings';
import { settingValue } from '../config/settings';
import type { Instant, SourceId } from '../core/primitives';
import type { Store } from '../db/index';
import { type PushRoute, startPushReceiver } from './push-receiver';
import { type HttpFetch, type RateLimitDecl, createRateGate, gatedHttp } from './rate-gate';
import {
  PUSH_SECRET_KEY,
  PUSH_URL_KEY,
  type SourceDefinition,
  pushAddress,
  pushSettingsOf,
} from './source-contract';
import { type SyncWorker, type Timers, createSyncWorker } from './worker';

export interface ServiceParams {
  readonly record: SettingsRecord;
  readonly sources: readonly SourceId[]; // the gate's verdict: switched-on sources, record order
  readonly store: Store; // the composed store; also the answering side's
  readonly built: readonly SourceDefinition[]; // every built source, build order
  readonly now: () => Instant;
  readonly log: (line: string) => void;
  readonly fetchImpl: HttpFetch; // the runtime's network function, supplied by the composition root
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly timers: Timers;
  readonly onStopSignal: (handler: () => void) => void; // the starter attaches handler to the termination and interrupt signals
}

export class UnbuiltSourceError extends Error {
  constructor(sourceId: SourceId) {
    super(`Source "${sourceId}" is switched on but has no built definition.`);
    this.name = 'UnbuiltSourceError';
  }
}

export async function runService(p: ServiceParams): Promise<number> {
  const { record, store, now, log, timers } = p;
  const startedAt = now();
  const limits = new Map<SourceId, RateLimitDecl>(p.built.map((d) => [d.id, d.limits]));
  const gate = createRateGate({ store, limits, now, sleep: p.sleep });
  const firstFillDays = settingValue(record.shared.firstFillDays) as number;
  const pollMinutes = settingValue(record.shared.pollMinutes) as number;

  const routes: PushRoute[] = [];
  const workers: SyncWorker[] = [];
  for (const id of p.sources) {
    const def = p.built.find((d) => d.id === id);
    if (def === undefined) throw new UnbuiltSourceError(id);
    const s = record.sources.find((x) => x.sourceId === id);
    if (s === undefined) throw new UnbuiltSourceError(id);

    let address: string | null = null;
    if (def.push !== undefined) {
      const pushSettings = pushSettingsOf(s);
      address = pushAddress(pushSettings);
      if (address === null) {
        const missing: string[] = [];
        if (pushSettings.publicAddress === null) missing.push(s.extras[PUSH_URL_KEY]?.name ?? PUSH_URL_KEY);
        if (pushSettings.secretPath === null) missing.push(s.extras[PUSH_SECRET_KEY]?.name ?? PUSH_SECRET_KEY);
        log(`push registration off for source ${id}: ${missing.join(' and ')} not set`);
      } else {
        routes.push({ sourceId: id, secretPath: pushSettings.secretPath as string, translator: def.push });
      }
    }

    const extras: Record<string, unknown> = {};
    for (const [key, state] of Object.entries(s.extras)) extras[key] = settingValue(state);
    const client = def.open({
      baseAddress: settingValue(s.baseAddress) as string,
      credential: s.credential === null ? null : (settingValue(s.credential) ?? null),
      extras,
      http: gatedHttp(gate, id, p.fetchImpl, (w) => log(`rate wait source=${id} class=${w.callClass} ms=${w.waitMs}`)),
    });
    workers.push(
      createSyncWorker({
        job: { store, definition: def, client, gate, now, log },
        firstFillDays,
        pollMinutes,
        startedAt,
        pushAddress: address,
        timers,
      }),
    );
  }

  const receiver = startPushReceiver({
    port: settingValue(record.shared.pushPort) as number,
    routes,
    store,
    now,
    log,
  });
  for (const w of workers) w.start();
  log(`service started; push receiver on port ${receiver.port}; sources ${p.sources.join(', ')}`);

  return new Promise<number>((resolve, reject) => {
    let stopping = false;
    p.onStopSignal(() => {
      if (stopping) return;
      stopping = true;
      const pending: Promise<void>[] = [receiver.stop()];
      for (const w of workers) pending.push(w.stop());
      Promise.all(pending)
        .then(() => {
          store.close();
          log('service stopped');
          resolve(0);
        })
        .catch(reject);
    });
  });
}
