// Release dataset (S-233): the per-run stand-in data, built from the run's start instant t0 and
// its runId. It is the only source of what the stand-ins serve and of every expected value. Pure:
// it writes nothing and reads no clock. Every guarantee G1..G10 holds by construction, so nothing
// here is random and no draw is ever rejected.

export const RUN_LIMIT_MS = 39_600_000; // 11 hours
export const FIRST_FILL_DAYS = 7;
export const DAY_MS = 86_400_000;
export const RATE_STAMP_DAYS = 15; // the rate table's bank timestamp is t0 - 15 days

const HOUR_MS = 3_600_000;
const NOON_MS = 12 * HOUR_MS;

export interface FixedZone {
  readonly name: string;
  readonly offsetHours: number; // -12..14
}

// The zone database's fixed-offset zones invert the sign: 'Etc/GMT-14' is 14 hours ahead of UTC.
export function zoneName(offsetHours: number): string {
  if (offsetHours === 0) return 'Etc/GMT';
  return offsetHours > 0 ? `Etc/GMT-${offsetHours}` : `Etc/GMT+${-offsetHours}`;
}

function timeOfDay(at: number): number {
  return ((at % DAY_MS) + DAY_MS) % DAY_MS;
}

// G1: the offset whose local time of day at t0 is nearest 12:00, the smaller offset on a tie.
export function zoneFor(t0: number): FixedZone {
  let best = -12;
  let bestDist = Infinity;
  for (let o = -12; o <= 14; o++) {
    const dist = Math.abs(timeOfDay(t0 + o * HOUR_MS) - NOON_MS);
    if (dist < bestDist) {
      best = o;
      bestDist = dist;
    }
  }
  return { name: zoneName(best), offsetHours: best };
}

export function localDate(at: number, zone: FixedZone): string {
  return new Date(at + zone.offsetHours * HOUR_MS).toISOString().slice(0, 10);
}

// The instant the local day begins.
export function localDayStart(date: string, zone: FixedZone): number {
  return Date.parse(date + 'T00:00:00Z') - zone.offsetHours * HOUR_MS;
}

// Minor units throughout.
export interface MonoHolding {
  readonly id: string;
  readonly kind: 'account' | 'jar';
  readonly currencyCode: 980 | 840;
  readonly balance: number;
  readonly creditLimit: number;
  readonly goal: number | null;
}

// time in ms, whole seconds; null until the stand-in gains it.
export interface MonoTxn {
  readonly id: string;
  readonly holding: string;
  time: number | null;
  readonly amount: number;
  readonly operationAmount: number;
  readonly currencyCode: 980 | 840;
  readonly mcc: number;
  readonly description: string;
}

export interface SecondAccount {
  readonly id: string;
  readonly name: string;
  readonly currency: 'PLN' | 'EUR';
  readonly balance: string;
}

export interface SecondTxn {
  readonly id: string;
  readonly account: string;
  readonly bookedAt: number;
  readonly amount: string;
  readonly currency: 'PLN' | 'EUR';
  readonly originalAmount?: string;
  readonly originalCurrency?: 'USD';
  readonly merchant: string;
  readonly description: string;
}

// Figures as JSON number text.
export interface RateRow {
  readonly currencyCodeA: 840 | 985 | 978;
  readonly currencyCodeB: 980;
  readonly rateBuy: string;
  readonly rateSell: string;
}

export interface BackfillRange {
  readonly fromDay: string; // local days, inclusive
  readonly toDay: string;
  readonly arg: string; // `${fromDay}..${toDay}`, the backfill command's range argument
  readonly startAt: number; // localDayStart(fromDay)
  readonly endAt: number; // localDayStart of the day after toDay: the requested half-open stretch
  readonly inRangeIds: readonly string[];
  readonly outOfRangeIds: readonly string[];
}

export interface Dataset {
  readonly t0: number;
  readonly runId: string;
  readonly zone: FixedZone;
  readonly monobank: {
    readonly holdings: readonly MonoHolding[];
    readonly initial: readonly MonoTxn[];
    readonly older: readonly MonoTxn[];
    readonly pushed: MonoTxn;
    readonly dropped: MonoTxn;
    readonly whileStopped: readonly MonoTxn[];
    readonly rates: readonly RateRow[];
    readonly rateStamp: number;
  };
  readonly second: {
    readonly accounts: readonly SecondAccount[];
    readonly initial: readonly SecondTxn[];
    readonly historyFrom: number;
  };
  readonly fixture: { readonly holding: string; readonly ids: readonly string[]; readonly day: string };
  readonly pair: { readonly text: string; readonly initialId: string; readonly pushedId: string };
  readonly backfill: BackfillRange;
  readonly allPeriod: string; // every transaction the dataset holds, the older set included
}

// G3: 13 characters (8 + 1 + 4); two different texts of equal length never contain one another.
export function marker(runId: string, seq: number): string {
  return `${runId}-${String(seq).padStart(4, '0')}`;
}

const UAH_MCCS = [5411, 5812, 5814, 4111, 5912, 5651, 7832, 5541, 6011, 5999];
const PLN_AMOUNTS = ['-12.35', '-7.01', '-45.99', '-3.33', '-120.07', '-0.05'];
const EUR_AMOUNTS = ['-2.77', '-15.03', '-9.99'];

export function buildDataset(t0: number, runId: string): Dataset {
  if (!/^[a-z]{8}$/.test(runId)) throw new RangeError(`buildDataset: runId must be 8 lower-case ASCII letters, got '${runId}'`);
  if (!Number.isInteger(t0) || t0 % 1000 !== 0) throw new RangeError(`buildDataset: t0 must be whole seconds in ms, got ${t0}`);

  const zone = zoneFor(t0);
  const pairText = `pair-${runId}`;
  const monoId = (tag: string | number) => `mono-${runId}-${tag}`;
  const mono = (
    id: string,
    holding: string,
    time: number | null,
    amount: number,
    currencyCode: 980 | 840,
    mcc: number,
    description: string,
  ): MonoTxn => ({ id, holding, time, amount, operationAmount: amount, currencyCode, mcc, description });
  const wholeSecond = (at: number) => Math.floor(at / 1000) * 1000;

  const holdings: MonoHolding[] = [
    { id: 'acc-uah', kind: 'account', currencyCode: 980, balance: 1_250_000, creditLimit: 500_000, goal: null },
    { id: 'acc-usd', kind: 'account', currencyCode: 840, balance: 10_000, creditLimit: 0, goal: null },
    { id: 'jar-1', kind: 'jar', currencyCode: 980, balance: 300_000, creditLimit: 0, goal: 1_000_000 },
  ];

  // G2: acc-uah's ten from t0 - 7 days + 12 hours, 15.6 hours apart; k = 0 is the pair's initial member.
  const initial: MonoTxn[] = [];
  const windowStart = t0 - FIRST_FILL_DAYS * DAY_MS + NOON_MS;
  for (let k = 0; k < 10; k++) {
    const time = wholeSecond(windowStart + k * 56_160_000);
    const description = k === 0 ? pairText : marker(runId, k + 1);
    initial.push(mono(monoId(k + 1), 'acc-uah', time, -2 * (1000 + 137 * k), 980, UAH_MCCS[k], description));
  }
  // G6: three purchases of 1.00 USD on one local day.
  const fixtureIds: string[] = [];
  for (let j = 0; j < 3; j++) {
    const seq = 11 + j;
    fixtureIds.push(monoId(seq));
    initial.push(mono(monoId(seq), 'acc-usd', t0 - 2 * DAY_MS + j * 60_000, -100, 840, 5999, marker(runId, seq)));
  }

  // G8, G9: stamped when the stand-in gains them.
  const pushed = mono(monoId('pushed'), 'acc-uah', null, -6912, 980, 5411, pairText);
  const dropped = mono(monoId(41), 'acc-uah', null, -444, 980, 5812, marker(runId, 41));
  const whileStopped = [
    mono(monoId(42), 'acc-uah', null, -888, 980, 5814, marker(runId, 42)),
    mono(monoId(43), 'acc-uah', null, -1776, 980, 4111, marker(runId, 43)),
  ];

  // G10: five in range at t0 - 9..13 days, two out of range at t0 - 14 and t0 - 8 days.
  const olderSpec: [days: number, amount: number, seq: number][] = [
    [9, -1002, 51],
    [10, -1104, 52],
    [11, -1206, 53],
    [12, -1308, 54],
    [13, -1410, 55],
    [14, -1512, 56],
    [8, -1614, 57],
  ];
  const older = olderSpec.map(([days, amount, seq]) =>
    mono(monoId(seq), 'acc-uah', t0 - days * DAY_MS, amount, 980, 5812, marker(runId, seq)),
  );
  const fromDay = localDate(t0 - 13 * DAY_MS, zone);
  const toDay = localDate(t0 - 9 * DAY_MS, zone);
  const backfill: BackfillRange = {
    fromDay,
    toDay,
    arg: `${fromDay}..${toDay}`,
    startAt: localDayStart(fromDay, zone),
    endAt: localDayStart(localDate(t0 - 8 * DAY_MS, zone), zone),
    inRangeIds: older.slice(0, 5).map((t) => t.id),
    outOfRangeIds: older.slice(5).map((t) => t.id),
  };

  // G5: one table, pairs against the hryvnia only.
  const rates: RateRow[] = [
    { currencyCodeA: 840, currencyCodeB: 980, rateBuy: '36.5', rateSell: '36.61' },
    { currencyCodeA: 985, currencyCodeB: 980, rateBuy: '9.95', rateSell: '10.05' },
    { currencyCodeA: 978, currencyCodeB: 980, rateBuy: '40', rateSell: '40.5' },
  ];

  // G3, G4, G7: merchant text is the marker and the description repeats it; every figure is odd.
  const accounts: SecondAccount[] = [
    { id: 'sec-pln', name: 'PLN account', currency: 'PLN', balance: '2500.01' },
    { id: 'sec-eur', name: 'EUR account', currency: 'EUR', balance: '100.03' },
  ];
  const secondInitial: SecondTxn[] = [];
  PLN_AMOUNTS.forEach((amount, j) => {
    const mk = marker(runId, 21 + j);
    secondInitial.push({
      id: `sec-${runId}-${21 + j}`,
      account: 'sec-pln',
      bookedAt: t0 - 6 * DAY_MS + j * 18 * HOUR_MS,
      amount,
      currency: 'PLN',
      merchant: mk,
      description: mk,
    });
  });
  EUR_AMOUNTS.forEach((amount, j) => {
    const mk = marker(runId, 31 + j);
    secondInitial.push({
      id: `sec-${runId}-${31 + j}`,
      account: 'sec-eur',
      bookedAt: t0 - 5 * DAY_MS + j * 20 * HOUR_MS,
      amount,
      currency: 'EUR',
      ...(j === 0 ? { originalAmount: '-3.01', originalCurrency: 'USD' as const } : {}),
      merchant: mk,
      description: mk,
    });
  });

  return {
    t0,
    runId,
    zone,
    monobank: {
      holdings,
      initial,
      older,
      pushed,
      dropped,
      whileStopped,
      rates,
      rateStamp: t0 - RATE_STAMP_DAYS * DAY_MS,
    },
    second: { accounts, initial: secondInitial, historyFrom: t0 - 30 * DAY_MS },
    fixture: { holding: 'acc-usd', ids: fixtureIds, day: localDate(t0 - 2 * DAY_MS, zone) },
    pair: { text: pairText, initialId: initial[0].id, pushedId: pushed.id },
    backfill,
    allPeriod: `${localDate(t0 - 14 * DAY_MS, zone)}..${localDate(t0, zone)}`,
  };
}
