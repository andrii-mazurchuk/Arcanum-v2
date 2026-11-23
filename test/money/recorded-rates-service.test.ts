// Recorded rates in a running service (S-112, S-145, S-84, S-86): the service started by the real
// process entry against the Monobank stand-in (src/release/stand-ins) serving the release dataset
// (src/release/dataset) records the stand-in's currency rows in its start refresh, and the
// answering core composed over the same storage (src/core/compose with the lists of
// src/app/starters) converts every own-money balance line to PLN with them, listing each rate leg.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawn = () => import('../../src/release/spawn');
const standIns = () => import('../../src/release/stand-ins');
const dataset = () => import('../../src/release/dataset');
const starters = () => import('../../src/app/starters');
const compose = () => import('../../src/core/compose');

const RUN_ID = 'ratesvcx';
const TOKEN = 'stand-in-ratesvcx';
const READY_DEADLINE_MS = 60_000;
const POLL_MS = 250;
const STOP_BOUND_MS = 10_000;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('money/recorded-rates in a running service', () => {
  test(
    "a running service's recorded Monobank rates convert a PLN balance",
    async () => {
      const { spawnProduct } = await spawn();
      const { startMonobankStandIn } = await standIns();
      const { buildDataset, localDate, FIRST_FILL_DAYS } = await dataset();
      const { STORE_SCHEMAS, ANSWER_FAMILIES, ANSWER_CONTRIBUTORS } = await starters();
      const { composeAnswering } = await compose();

      const t0 = Math.floor(Date.now() / 1000) * 1000;
      const ds = buildDataset(t0, RUN_ID);
      const folder = mkdtempSync(join(tmpdir(), 'arcanum-recorded-rates-'));
      const location = join(folder, 'arcanum.db');
      const mono = await startMonobankStandIn(ds, TOKEN, () => Date.now());
      const service = spawnProduct(
        ['service'],
        {
          ARCANUM_STORAGE: location,
          ARCANUM_FIRST_FILL_DAYS: String(FIRST_FILL_DAYS),
          ARCANUM_TIME_ZONE: ds.zone.name,
          ARCANUM_MONOBANK_ENABLED: 'on',
          ARCANUM_MONOBANK_BASE_URL: mono.baseAddress,
          ARCANUM_MONOBANK_TOKEN: TOKEN,
        },
        process.env,
      );
      // The service's standard error, as far as it has come, for the failure message.
      let stderr = '';
      void (async () => {
        const decoder = new TextDecoder();
        try {
          for await (const chunk of service.stderr) stderr += decoder.decode(chunk, { stream: true });
        } catch {
          // a stream that errors ends where it is
        }
      })();
      void new Response(service.stdout).text();
      let exitCode: number | null = null;
      void service.exited.then((code) => {
        exitCode = code;
      });

      const monobankRows = (c: ReturnType<typeof composeAnswering>) =>
        c.store.readSnapshot(
          (snap) =>
            snap.db
              .query("SELECT base, quote, held_from FROM rate_snapshot WHERE source_id = 'monobank' ORDER BY base")
              .all() as { base: string; quote: string; held_from: number }[],
        );

      let composed: ReturnType<typeof composeAnswering> | null = null;
      try {
        // Wait until the start refresh has recorded rates: the rate table holds a 'monobank' row. The
        // rates step runs before any statement is fetched, so coverage is not waited on.
        const deadline = Date.now() + READY_DEADLINE_MS;
        let ready = false;
        let lastFault = '';
        while (!ready && Date.now() < deadline && exitCode === null) {
          try {
            // Opened only once the service has created the file, so this process never creates it; a
            // running service's file may still read as empty (its writes held in the journal), which an
            // existing-only open refuses.
            if (composed === null && existsSync(location)) {
              composed = composeAnswering({
                location,
                schemas: STORE_SCHEMAS,
                now: Date.now,
                settings: () => ({ timeZone: ds.zone.name, sources: ['monobank'] }),
                families: ANSWER_FAMILIES,
                contributors: ANSWER_CONTRIBUTORS,
              });
            }
            ready = composed !== null && monobankRows(composed).length > 0;
          } catch (e) {
            lastFault = e instanceof Error ? e.message : String(e);
          }
          if (!ready) await pause(POLL_MS);
        }
        if (!ready) {
          const how = exitCode !== null ? `service exited ${exitCode}` : `last fault: ${lastFault}`;
          throw new Error(`no 'monobank' rate recorded after ${READY_DEADLINE_MS} ms (${how}; service stderr: ${stderr})`);
        }
        const { core } = composed!;

        // The rate table: one row per stand-in currency row, each keyed by the bank's own stamp.
        const stampMs = Math.floor(ds.monobank.rateStamp / 1000) * 1000;
        const rows = monobankRows(composed!);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows).toEqual([
          { base: 'EUR', quote: 'UAH', held_from: stampMs },
          { base: 'PLN', quote: 'UAH', held_from: stampMs },
          { base: 'USD', quote: 'UAH', held_from: stampMs },
        ]);
        expect(rows.length).toBe(ds.monobank.rates.length);

        // The balance question in PLN through the answering core.
        let written = '';
        const result = await core.serve(
          { asker: 'command_line', family: 'balance', displayCurrency: 'PLN', options: {} },
          (a) => JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
          {
            write: async (text) => {
              written = text;
            },
            closed: new Promise<void>(() => {}),
          },
        );
        expect(written).not.toBe('');
        const answer: any = result.answer;
        expect(answer.kind).toBe('envelope');
        expect(answer.displayCurrency).toBe('PLN');
        expect(answer.outcome.kind).toBe('answered');
        const body = answer.outcome.body;

        // Every own-money line of acc-uah, acc-usd and jar-1 is shown in PLN.
        const lines: any[] = [...body.accounts, ...body.jars];
        const byId = new Map(lines.map((l) => [l.holdingId, l] as const));
        for (const id of ['acc-uah', 'acc-usd', 'jar-1']) {
          const line = byId.get(id);
          expect(line).toBeDefined();
          expect(line.ownMoney.notConverted).toBeNull();
          expect(line.ownMoney.shown).not.toBeNull();
          expect(line.ownMoney.shown.currency).toBe('PLN');
        }
        for (const line of lines) expect(line.ownMoney.shown).not.toBeNull();

        // The net position is the sum of the shown lines, and not 0.00.
        const sum = lines.reduce((acc: bigint, l) => acc + (l.ownMoney.shown.minor as bigint), 0n);
        expect(body.netPosition.currency).toBe('PLN');
        expect(body.netPosition.minor).toBe(sum);
        expect(body.netPosition.minor).not.toBe(0n);

        // Rates used: UAH to PLN, and for acc-usd both legs USD to UAH and UAH to PLN, each dated.
        const stampDate = localDate(stampMs, ds.zone);
        const items: any[] = answer.statements.ratesUsed;
        expect(Array.isArray(items)).toBe(true);
        expect(items.filter((i) => i.kind === 'not_converted')).toEqual([]);
        const applied = items.filter((i) => i.kind === 'applied');
        const leg = (from: string, to: string) => applied.find((i) => i.from === from && i.to === to);
        for (const [from, to] of [
          ['UAH', 'PLN'],
          ['USD', 'UAH'],
        ]) {
          const item = leg(from!, to!);
          expect(item).toBeDefined();
          expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(item.date).toBe(stampDate);
        }
      } finally {
        composed?.store.close();
        try {
          service.signal('SIGTERM');
        } catch {
          // already gone
        }
        const stoppedInTime = await Promise.race([service.exited.then(() => true), pause(STOP_BOUND_MS).then(() => false)]);
        if (!stoppedInTime) {
          service.signal('SIGKILL');
          await service.exited;
        }
        try {
          await mono.close();
        } catch {
          // already closed
        }
        rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      }
    },
    READY_DEADLINE_MS + 3 * STOP_BOUND_MS,
  );
});
