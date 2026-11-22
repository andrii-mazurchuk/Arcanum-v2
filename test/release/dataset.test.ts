// Release dataset (S-233): the per-run stand-in data built from the start instant t0 and the
// runId, from src/release/dataset. Every guarantee G1..G10 must hold by construction for every
// draw, and the worked draw pins the exact content the stand-ins serve.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const dataset = () => import('../../src/release/dataset');

const DAY = 86_400_000;
const HOUR = 3_600_000;

// Exact decimal text to a scaled bigint: '36.61' at scale 4 -> 366100n.
function scaled(text: string, scale: number): bigint {
  const neg = text.startsWith('-');
  const body = neg ? text.slice(1) : text;
  const [whole, frac = ''] = body.split('.');
  const v = BigInt(whole + frac.padEnd(scale, '0').slice(0, scale));
  return neg ? -v : v;
}

// n / d rounded half away from zero, d > 0.
function roundHalfAway(n: bigint, d: bigint): bigint {
  const a = n < 0n ? -n : n;
  const q = (2n * a + d) / (2n * d);
  return n < 0n ? -q : q;
}

describe('release/dataset', () => {
  test(
    'guarantees hold for 10000 start instants',
    async () => {
      const { buildDataset, localDate, localDayStart, zoneName, RUN_LIMIT_MS, DAY_MS } =
        await dataset();
      expect(DAY_MS).toBe(DAY);
      expect(RUN_LIMIT_MS).toBe(39_600_000);

      const base = Date.UTC(2026, 0, 1);
      const runIds = ['abcdefgh', 'kfcqwert', 'silpoabc', 'zzzzzzzz'];
      const starts: number[] = [];
      for (let i = 0; i < 10_000; i++) {
        starts.push(base + Math.floor((i * 31_536_000) / 10_000) * 1000);
      }

      // Formatter: the zone database's fixed-offset names agree with t0 + o hours read in UTC.
      const pad = (n: number) => String(n).padStart(2, '0');
      for (let o = -12; o <= 14; o++) {
        const fmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: zoneName(o),
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        });
        for (let i = 0; i < 10_000; i += 200) {
          const t0 = starts[i];
          const parts: Record<string, string> = {};
          for (const p of fmt.formatToParts(t0)) parts[p.type] = p.value;
          const d = new Date(t0 + o * HOUR);
          expect({ o, t0, got: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` })
            .toEqual({
              o,
              t0,
              got: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
            });
        }
      }

      // G6: per-line rounding of the fixture, in exact integer arithmetic.
      expect(roundHalfAway(-100n * 36_555n, 10_000n)).toBe(-366n);
      expect(3n * roundHalfAway(-100n * 36_555n, 10_000n)).toBe(-1098n);
      expect(roundHalfAway(3n * 100n * 36_555n, 10_000n)).toBe(1097n);

      const markerRe = /^[a-z]{8}-\d{4}$/;
      const decRe = /^-?\d+\.\d{2}$/;
      const fail = (i: number, what: string) => `draw ${i}: ${what}`;

      for (let i = 0; i < 10_000; i++) {
        const t0 = starts[i];
        const runId = runIds[i % 4];
        const ds = buildDataset(t0, runId);
        const z = ds.zone;
        const b = ds.backfill;
        const mono = ds.monobank;
        const older = mono.older;
        const errs: string[] = [];
        const check = (ok: boolean, what: string) => {
          if (!ok) errs.push(fail(i, what));
        };

        // G1
        const tod = (((t0 + z.offsetHours * HOUR) % DAY) + DAY) % DAY;
        check(Math.abs(tod - 43_200_000) <= 1_800_000, `G1 time of day ${tod}`);
        check(localDate(t0, z) === localDate(t0 + RUN_LIMIT_MS, z), 'G1 day boundary in run');
        check(z.offsetHours >= -12 && z.offsetHours <= 14, 'G1 offset range');

        // G2
        const initialMoments: number[] = [];
        for (const t of mono.initial) initialMoments.push(t.time as number);
        for (const t of ds.second.initial) initialMoments.push(t.bookedAt);
        for (const m of initialMoments) {
          check(typeof m === 'number', 'G2 initial time is a number');
          check(t0 - 7 * DAY + 43_200_000 <= m && m <= t0, `G2 window ${m}`);
          check(m >= t0 + RUN_LIMIT_MS - 7 * DAY + HOUR, `G2 anchor ${m}`);
        }

        // G5
        const stampDay = localDate(mono.rateStamp, z);
        check(stampDay === localDate(t0 - 15 * DAY, z), 'G5 stamp day');
        for (const m of [...initialMoments, ...older.map((t) => t.time as number), t0]) {
          check(stampDay < localDate(m, z), `G5 stamp not before ${m}`);
        }

        // G10
        check(older.length === 7, 'G10 older size');
        const initialIds = new Set(mono.initial.map((t) => t.id));
        for (const t of older) {
          check(t.holding === 'acc-uah', 'G10 older holding');
          check(!initialIds.has(t.id), 'G10 older id among initial');
        }
        check(b.inRangeIds.length === 5 && b.outOfRangeIds.length === 2, 'G10 id counts');
        const rangeIds = new Set([...b.inRangeIds, ...b.outOfRangeIds]);
        const olderIds = new Set(older.map((t) => t.id));
        check(rangeIds.size === 7, 'G10 in/out disjoint');
        check(rangeIds.size === olderIds.size && [...olderIds].every((id) => rangeIds.has(id)), 'G10 in+out = older');
        check(b.fromDay === localDate(t0 - 13 * DAY, z), 'G10 fromDay');
        check(b.toDay === localDate(t0 - 9 * DAY, z), 'G10 toDay');
        check(b.arg === b.fromDay + '..' + b.toDay, 'G10 arg');
        check(b.startAt === localDayStart(b.fromDay, z), 'G10 startAt');
        check(b.endAt === localDayStart(localDate(t0 - 8 * DAY, z), z), 'G10 endAt');
        const inRange = new Set(b.inRangeIds);
        for (const t of older) {
          if (!inRange.has(t.id)) continue;
          const m = t.time as number;
          check(b.startAt <= m && m < b.endAt, `G10 in-range member outside stretch ${m}`);
          const d = localDate(m, z);
          check(b.fromDay <= d && d <= b.toDay, `G10 in-range member day ${d}`);
        }
        const first = older.find((t) => t.time === t0 - 14 * DAY);
        const last = older.find((t) => t.time === t0 - 8 * DAY);
        check(first !== undefined && (first.time as number) < b.startAt, 'G10 t0-14d member');
        check(
          last !== undefined && b.endAt <= (last.time as number) && (last.time as number) < t0 - 7 * DAY,
          'G10 t0-8d member',
        );
        check(b.endAt < t0 + RUN_LIMIT_MS - 7 * DAY - DAY, 'G10 endAt before first fill less a day');

        // Days
        for (const x of [...initialMoments, ...older.map((t) => t.time as number), mono.rateStamp, t0]) {
          const s = localDayStart(localDate(x, z), z);
          check(s <= x && x < s + DAY, `day bounds ${x}`);
        }
        const [apFrom, apTo] = ds.allPeriod.split('..');
        check(first !== undefined && apFrom === localDate(first.time as number, z), 'allPeriod first day');
        check(apTo === localDate(t0, z), 'allPeriod last day');

        // G3
        const monoAll = [...mono.initial, ...older, mono.pushed, mono.dropped, ...mono.whileStopped];
        const pairIds = new Set([ds.pair.initialId, ds.pair.pushedId]);
        const markers: string[] = [];
        for (const t of monoAll) if (!pairIds.has(t.id)) markers.push(t.description);
        for (const t of ds.second.initial) markers.push(t.merchant);
        for (const mk of markers) {
          check(mk.length === 13 && markerRe.test(mk), `G3 marker shape ${mk}`);
          check(mk.startsWith(runId + '-'), `G3 marker runId ${mk}`);
        }
        check(new Set(markers).size === markers.length, 'G3 markers distinct');
        for (let a = 0; a < markers.length; a++) {
          for (let c = 0; c < markers.length; c++) {
            if (a !== c) check(!markers[a].includes(markers[c]), `G3 ${markers[a]} contains ${markers[c]}`);
          }
        }
        const pt = ds.pair.text;
        check(pt.length === 13, 'G3 pair text length');
        for (const mk of markers) {
          check(!mk.includes(pt) && !pt.includes(mk), `G3 pair text vs ${mk}`);
        }
        const carriers = monoAll.filter((t) => t.description === pt);
        check(carriers.length === 2, 'G3 pair carriers count');
        check(carriers.every((t) => pairIds.has(t.id)), 'G3 pair carriers ids');
        check(initialIds.has(ds.pair.initialId), 'G3 pair initial member in initial');
        check(ds.pair.pushedId === mono.pushed.id, 'G3 pair pushed member');
        for (const t of ds.second.initial) {
          check(t.description === t.merchant, `G3 description ${t.description} != merchant ${t.merchant}`);
        }
        for (const t of monoAll) {
          const own = pairIds.has(t.id) ? pt : t.description;
          check(t.description.includes(own), 'G3 description carries marker');
        }

        // G4, G7
        for (const t of monoAll) {
          check(Number.isInteger(t.amount) && t.amount % 2 === 0, `G4 mono amount ${t.amount}`);
          check(Number.isInteger(t.operationAmount) && t.operationAmount % 2 === 0, `G4 mono op ${t.operationAmount}`);
        }
        for (const t of ds.second.initial) {
          const figs = [t.amount];
          if (t.originalAmount !== undefined) figs.push(t.originalAmount);
          for (const f of figs) {
            check(decRe.test(f), `G7 ${f}`);
            check(decRe.test(f) && BigInt(f.replace('.', '')) % 2n !== 0n, `G4 second figure ${f}`);
          }
        }
        for (const t of [...monoAll, ...ds.second.initial]) {
          check(!Object.keys(t).some((k) => /counter/i.test(k)), 'G4 counterpart field');
        }

        // G6: the fixture lines are each -100.
        const fixtureIds = new Set(ds.fixture.ids);
        const fixtureTxns = mono.initial.filter((t) => fixtureIds.has(t.id));
        check(ds.fixture.ids.length === 3 && fixtureTxns.length === 3, 'G6 fixture size');
        check(fixtureTxns.every((t) => t.amount === -100), 'G6 fixture amounts');

        if (errs.length > 0) expect(errs.slice(0, 10)).toEqual([]);
      }
    },
    300_000,
  );

  test('zone tie goes to the smaller offset', async () => {
    const { zoneFor, zoneName, localDate, RUN_LIMIT_MS } = await dataset();

    const t1 = Date.UTC(2026, 10, 22, 23, 30, 0);
    const t2 = Date.UTC(2026, 10, 22, 0, 0, 0);
    const t3 = Date.UTC(2026, 10, 22, 22, 0, 0);
    const t4 = Date.UTC(2026, 10, 22, 10, 0, 0);

    expect(zoneFor(t1)).toEqual({ name: 'Etc/GMT+12', offsetHours: -12 });
    expect(localDate(t1, zoneFor(t1))).toBe('2026-11-22');
    expect(localDate(t1 + RUN_LIMIT_MS, zoneFor(t1))).toBe('2026-11-22');

    expect(zoneFor(t2)).toEqual({ name: 'Etc/GMT+12', offsetHours: -12 });
    expect(localDate(t2, zoneFor(t2))).toBe('2026-11-21');

    expect(zoneFor(t3)).toEqual({ name: 'Etc/GMT+10', offsetHours: -10 });
    expect(localDate(t3, zoneFor(t3))).toBe('2026-11-22');

    expect(zoneFor(t4)).toEqual({ name: 'Etc/GMT-2', offsetHours: 2 });

    expect(zoneName(0)).toBe('Etc/GMT');
    expect(zoneName(14)).toBe('Etc/GMT-14');
    expect(zoneName(-12)).toBe('Etc/GMT+12');
    expect(zoneName(5)).toBe('Etc/GMT-5');
  });

  test('worked draw at 2026-11-22T10:07:37Z', async () => {
    const { buildDataset, localDate, localDayStart, RATE_STAMP_DAYS, DAY_MS } = await dataset();

    const t0 = Date.UTC(2026, 10, 22, 10, 7, 37);
    const runId = 'abcdefgh';
    const ds = buildDataset(t0, runId);
    const mono = ds.monobank;

    expect(ds.zone).toEqual({ name: 'Etc/GMT-2', offsetHours: 2 });
    expect(ds.allPeriod).toBe('2026-11-08..2026-11-22');
    expect(ds.fixture.day).toBe('2026-11-20');
    expect(ds.fixture.holding).toBe('acc-usd');

    expect(RATE_STAMP_DAYS).toBe(15);
    expect(mono.rateStamp).toBe(t0 - RATE_STAMP_DAYS * DAY_MS);
    expect(mono.rateStamp).toBe(Date.UTC(2026, 10, 7, 10, 7, 37));
    expect(localDate(mono.rateStamp, ds.zone)).toBe('2026-11-07');
    const rates = [...mono.rates].sort((a, b) => a.currencyCodeA - b.currencyCodeA);
    expect(rates).toEqual([
      { currencyCodeA: 840, currencyCodeB: 980, rateBuy: '36.5', rateSell: '36.61' },
      { currencyCodeA: 978, currencyCodeB: 980, rateBuy: '40', rateSell: '40.5' },
      { currencyCodeA: 985, currencyCodeB: 980, rateBuy: '9.95', rateSell: '10.05' },
    ]);

    // G6 read off the dataset's own table: USD -> PLN through the hryvnia midpoints.
    const usd = mono.rates.find((r) => r.currencyCodeA === 840)!;
    const pln = mono.rates.find((r) => r.currencyCodeA === 985)!;
    const num = scaled(usd.rateBuy, 4) + scaled(usd.rateSell, 4);
    const den = scaled(pln.rateBuy, 4) + scaled(pln.rateSell, 4);
    expect(roundHalfAway(-100n * num, den)).toBe(-366n);
    expect(roundHalfAway(-300n * num, den)).toBe(-1097n);

    expect(localDayStart('2026-11-09', ds.zone)).toBe(Date.UTC(2026, 10, 8, 22));
    expect(localDate(Date.UTC(2026, 10, 8, 21, 59, 59), ds.zone)).toBe('2026-11-08');
    expect(localDate(Date.UTC(2026, 10, 8, 22), ds.zone)).toBe('2026-11-09');

    const holding = (id: string) => mono.holdings.find((h) => h.id === id)!;
    const uah = holding('acc-uah');
    expect([uah.kind, uah.currencyCode, uah.balance, uah.creditLimit, uah.goal]).toEqual([
      'account', 980, 1_250_000, 500_000, null,
    ]);
    const usdAcc = holding('acc-usd');
    expect([usdAcc.kind, usdAcc.currencyCode, usdAcc.balance, usdAcc.creditLimit, usdAcc.goal]).toEqual([
      'account', 840, 10_000, 0, null,
    ]);
    const jar = holding('jar-1');
    expect([jar.kind, jar.currencyCode, jar.balance, jar.goal]).toEqual(['jar', 980, 300_000, 1_000_000]);

    expect(mono.initial.length).toBe(13);
    const uahTxns = mono.initial
      .filter((t) => t.holding === 'acc-uah')
      .sort((a, b) => (a.time as number) - (b.time as number));
    const mccs = [5411, 5812, 5814, 4111, 5912, 5651, 7832, 5541, 6011, 5999];
    const amounts = [-2000, -2274, -2548, -2822, -3096, -3370, -3644, -3918, -4192, -4466];
    expect(uahTxns.length).toBe(10);
    for (let k = 0; k < 10; k++) {
      const t = uahTxns[k];
      expect({
        time: t.time,
        amount: t.amount,
        operationAmount: t.operationAmount,
        currencyCode: t.currencyCode,
        mcc: t.mcc,
        description: t.description,
      }).toEqual({
        time: t0 - 7 * DAY + 43_200_000 + k * 56_160_000,
        amount: amounts[k],
        operationAmount: amounts[k],
        currencyCode: 980,
        mcc: mccs[k],
        description: k === 0 ? 'pair-abcdefgh' : `abcdefgh-${String(k + 1).padStart(4, '0')}`,
      });
    }
    const usdTxns = mono.initial
      .filter((t) => t.holding === 'acc-usd')
      .sort((a, b) => (a.time as number) - (b.time as number));
    expect(usdTxns.map((t) => [t.time, t.amount, t.operationAmount, t.currencyCode, t.mcc, t.description])).toEqual([
      [t0 - 2 * DAY, -100, -100, 840, 5999, 'abcdefgh-0011'],
      [t0 - 2 * DAY + 60_000, -100, -100, 840, 5999, 'abcdefgh-0012'],
      [t0 - 2 * DAY + 120_000, -100, -100, 840, 5999, 'abcdefgh-0013'],
    ]);
    expect(new Set(ds.fixture.ids)).toEqual(new Set(usdTxns.map((t) => t.id)));
    expect(ds.fixture.ids.length).toBe(3);

    expect(mono.older.length).toBe(7);
    const initialIds = new Set(mono.initial.map((t) => t.id));
    for (const t of mono.older) {
      expect([t.holding, t.currencyCode, t.mcc, t.operationAmount]).toEqual(['acc-uah', 980, 5812, t.amount]);
      expect(initialIds.has(t.id)).toBe(false);
    }
    const olderAt = (days: number) => mono.older.find((t) => t.time === t0 - days * DAY)!;
    const olderWant: [number, number, string][] = [
      [9, -1002, 'abcdefgh-0051'],
      [10, -1104, 'abcdefgh-0052'],
      [11, -1206, 'abcdefgh-0053'],
      [12, -1308, 'abcdefgh-0054'],
      [13, -1410, 'abcdefgh-0055'],
      [14, -1512, 'abcdefgh-0056'],
      [8, -1614, 'abcdefgh-0057'],
    ];
    for (const [days, amount, description] of olderWant) {
      const t = olderAt(days);
      expect(t).toBeDefined();
      expect([days, t.amount, t.description]).toEqual([days, amount, description]);
    }

    const b = ds.backfill;
    expect(b.fromDay).toBe('2026-11-09');
    expect(b.toDay).toBe('2026-11-13');
    expect(b.arg).toBe('2026-11-09..2026-11-13');
    expect(b.startAt).toBe(Date.UTC(2026, 10, 8, 22));
    expect(b.endAt).toBe(Date.UTC(2026, 10, 13, 22));
    expect(b.inRangeIds.length).toBe(5);
    expect(new Set(b.inRangeIds)).toEqual(new Set([9, 10, 11, 12, 13].map((d) => olderAt(d).id)));
    expect(new Set(b.outOfRangeIds)).toEqual(new Set([olderAt(14).id, olderAt(8).id]));

    expect(ds.pair).toEqual({ text: 'pair-abcdefgh', initialId: uahTxns[0].id, pushedId: mono.pushed.id });
    const pick = (t: (typeof mono.whileStopped)[number]) => ({
      holding: t.holding,
      amount: t.amount,
      mcc: t.mcc,
      description: t.description,
      time: t.time,
    });
    expect(pick(mono.pushed)).toEqual({
      holding: 'acc-uah', amount: -6912, mcc: 5411, description: 'pair-abcdefgh', time: null,
    });
    expect(mono.pushed.operationAmount).toBe(-6912);
    expect(pick(mono.dropped)).toEqual({
      holding: 'acc-uah', amount: -444, mcc: 5812, description: 'abcdefgh-0041', time: null,
    });
    expect(mono.whileStopped.map(pick)).toEqual([
      { holding: 'acc-uah', amount: -888, mcc: 5814, description: 'abcdefgh-0042', time: null },
      { holding: 'acc-uah', amount: -1776, mcc: 4111, description: 'abcdefgh-0043', time: null },
    ]);

    expect(ds.second.accounts.map((a) => ({ id: a.id, currency: a.currency, balance: a.balance }))).toEqual([
      { id: 'sec-pln', currency: 'PLN', balance: '2500.01' },
      { id: 'sec-eur', currency: 'EUR', balance: '100.03' },
    ]);
    const secOf = (acc: string) =>
      ds.second.initial.filter((t) => t.account === acc).sort((a, b) => a.bookedAt - b.bookedAt);
    const plnAmounts = ['-12.35', '-7.01', '-45.99', '-3.33', '-120.07', '-0.05'];
    expect(
      secOf('sec-pln').map((t) => [t.bookedAt, t.amount, t.currency, t.merchant, t.description]),
    ).toEqual(
      plnAmounts.map((a, j) => {
        const mk = `abcdefgh-00${21 + j}`;
        return [t0 - 6 * DAY + j * 64_800_000, a, 'PLN', mk, mk];
      }),
    );
    const eur = secOf('sec-eur');
    const eurAmounts = ['-2.77', '-15.03', '-9.99'];
    expect(eur.map((t) => [t.bookedAt, t.amount, t.currency, t.merchant, t.description])).toEqual(
      eurAmounts.map((a, j) => {
        const mk = `abcdefgh-00${31 + j}`;
        return [t0 - 5 * DAY + j * 72_000_000, a, 'EUR', mk, mk];
      }),
    );
    expect([eur[0].originalAmount, eur[0].originalCurrency]).toEqual(['-3.01', 'USD']);
    expect(ds.second.historyFrom).toBe(t0 - 30 * DAY);

    expect(buildDataset(t0, runId)).toEqual(ds);
  });
});
