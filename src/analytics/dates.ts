// Calendar (S-52): the only place a local date, week, month or wall time is computed. Zone
// validation, instants drawn into local days through the zone database, and the named-period
// parser. Families, envelope statements and rate-day lookup ask this; none computes local time.

import type { Instant, LocalDate, LocalDateTime, Refusal } from '../core/primitives';
import { refuse } from '../core/primitives';

export const DEFAULT_TIME_ZONE = 'Europe/Warsaw';
export const EARLIEST_DAY: LocalDate = '0001-01-01'; // no resolved period starts before it

export interface Calendar {
  readonly zone: string;
  localDay(i: Instant): LocalDate;
  localDateTime(i: Instant): LocalDateTime;
  weekOf(i: Instant): { monday: LocalDate; sunday: LocalDate };
  monthOf(i: Instant): string; // 'YYYY-MM'
  startOfDay(d: LocalDate): Instant; // first instant whose localDay is d
  addDays(d: LocalDate, n: number): LocalDate; // calendar arithmetic on dates, zone-free
  resolvePeriod(text: string | undefined, now: Instant): ResolvedPeriod | Refusal; // never throws
}

export interface ResolvedPeriod {
  text: string; // the period text as given, trimmed
  firstDay: LocalDate;
  lastDay: LocalDate;
  from: Instant; // startOfDay(firstDay)
  until: Instant; // startOfDay(addDays(lastDay, 1)); the span is from <= t < until
}

const DAY_MS = 86400000;

export function openCalendar(timeZoneSetting: string | undefined): Calendar | Refusal {
  const zone = timeZoneSetting === undefined ? DEFAULT_TIME_ZONE : timeZoneSetting;
  const refused = () =>
    refuse(
      'unknown_time_zone',
      'timeZone',
      'The time zone setting "timeZone" holds "' + zone + '", which names no known time zone.',
      zone,
    );
  // Explicit offsets are refused whatever the runtime would accept.
  if (zone === '' || zone.startsWith('+') || zone.startsWith('-') || zone.startsWith('−')) {
    return refused();
  }
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return refused();
  }
  return makeCalendar(zone, format);
}

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

// Builds the instant for a wall time read as UTC, setting the full year so years below 100 stay.
function utcOf(y: number, m: number, d: number, h = 0, mi = 0, s = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  date.setUTCHours(h, mi, s, 0);
  return date.getTime();
}

function pad(n: number, width: number): string {
  return String(Math.abs(n)).padStart(width, '0');
}

function dateText(y: number, m: number, d: number): LocalDate {
  return pad(y, 4) + '-' + pad(m, 2) + '-' + pad(d, 2);
}

function parseDate(text: string): { y: number; m: number; d: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1 || m < 1 || m > 12 || d < 1) return undefined;
  if (d > new Date(utcOf(y, m + 1, 0)).getUTCDate()) return undefined;
  return { y, m, d };
}

function addDays(d: LocalDate, n: number): LocalDate {
  const p = parseDate(d);
  const base = p === undefined ? Date.parse(d + 'T00:00:00Z') : utcOf(p.y, p.m, p.d);
  const date = new Date(base + n * DAY_MS);
  return dateText(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

// Whole days from a to b, both real dates.
function daysBetween(a: LocalDate, b: LocalDate): number {
  return (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS;
}

function dayOfWeekFromMonday(d: LocalDate): number {
  return (new Date(Date.parse(d + 'T00:00:00Z')).getUTCDay() + 6) % 7;
}

function makeCalendar(zone: string, format: Intl.DateTimeFormat): Calendar {
  const wall = (i: Instant): Wall => {
    const parts: Record<string, string> = {};
    for (const part of format.formatToParts(i)) parts[part.type] = part.value;
    let y = Number(parts.year);
    if (parts.era === 'BC' || parts.era === 'B') y = 1 - y;
    return {
      y,
      m: Number(parts.month),
      d: Number(parts.day),
      h: Number(parts.hour),
      mi: Number(parts.minute),
      s: Number(parts.second),
    };
  };

  // The zone's offset at i, in milliseconds east of UTC.
  const offset = (i: Instant): number => {
    const w = wall(i);
    const whole = i - (((i % 1000) + 1000) % 1000);
    return utcOf(w.y, w.m, w.d, w.h, w.mi, w.s) - whole;
  };

  const localDay = (i: Instant): LocalDate => {
    const w = wall(i);
    return dateText(w.y, w.m, w.d);
  };

  const startOfDay = (d: LocalDate): Instant => {
    const p = parseDate(d);
    const midnight = p === undefined ? Date.parse(d + 'T00:00:00Z') : utcOf(p.y, p.m, p.d);
    let t = midnight - offset(midnight);
    t = midnight - offset(t);
    if (localDay(t) === d && localDay(t - 1) < d) return t;
    // Midnight falls in a gap or an overlap: search for the first instant of the day.
    let lo = midnight - 2 * DAY_MS; // localDay(lo) < d
    let hi = midnight + DAY_MS; // localDay(hi) >= d
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (localDay(mid) < d) lo = mid;
      else hi = mid;
    }
    return hi;
  };

  const calendar: Calendar = {
    zone,
    localDay,
    localDateTime(i) {
      const w = wall(i);
      const off = Math.round(offset(i) / 60000);
      const sign = off < 0 ? '-' : '+';
      return (
        dateText(w.y, w.m, w.d) +
        'T' +
        pad(w.h, 2) +
        ':' +
        pad(w.mi, 2) +
        ':' +
        pad(w.s, 2) +
        sign +
        pad(Math.floor(Math.abs(off) / 60), 2) +
        ':' +
        pad(Math.abs(off) % 60, 2)
      );
    },
    weekOf(i) {
      const day = localDay(i);
      const monday = addDays(day, -dayOfWeekFromMonday(day));
      return { monday, sunday: addDays(monday, 6) };
    },
    monthOf(i) {
      return localDay(i).slice(0, 7);
    },
    startOfDay,
    addDays,
    resolvePeriod(text, now) {
      try {
        return resolve(calendar, text, now);
      } catch {
        return refuse(
          'bad_period',
          'form',
          'The period "' + String(text) + '" could not be resolved.',
          text === undefined ? undefined : text.trim(),
        );
      }
    },
  };
  return calendar;
}

function resolve(
  cal: Calendar,
  given: string | undefined,
  now: Instant,
): ResolvedPeriod | Refusal {
  const text = given === undefined ? '' : given.trim();
  if (text === '') {
    return refuse('bad_period', 'missing', 'A period is required but none was given.');
  }
  const badForm = () =>
    refuse(
      'bad_period',
      'form',
      'The period "' + text + '" is not one of the named period forms.',
      text,
    );
  const badN = (n: string, why: string) =>
    refuse('bad_period', 'n', 'The period "' + text + '" has N "' + n + '", ' + why, n);
  const span = (firstDay: LocalDate, lastDay: LocalDate): ResolvedPeriod | Refusal => {
    if (firstDay > lastDay) {
      return refuse(
        'bad_period',
        'start_after_end',
        'The period "' + text + '" starts on ' + firstDay + ', after its end on ' + lastDay + '.',
        text,
      );
    }
    if (firstDay < EARLIEST_DAY) return badForm();
    return {
      text,
      firstDay,
      lastDay,
      from: cal.startOfDay(firstDay),
      until: cal.startOfDay(cal.addDays(lastDay, 1)),
    };
  };

  const today = cal.localDay(now);
  const t = parseDate(today);
  if (t === undefined) return badForm();
  const monday = cal.addDays(today, -dayOfWeekFromMonday(today));
  const monthStart = (y: number, m: number) => dateText(y, m, 1);
  const monthEnd = lastOfMonth;

  switch (text) {
    case 'today':
      return span(today, today);
    case 'yesterday': {
      const y = cal.addDays(today, -1);
      return span(y, y);
    }
    case 'this-week':
      return span(monday, today);
    case 'last-week':
      return span(cal.addDays(monday, -7), cal.addDays(monday, -1));
    case 'this-month':
      return span(monthStart(t.y, t.m), today);
    case 'last-month': {
      const y = t.m === 1 ? t.y - 1 : t.y;
      const m = t.m === 1 ? 12 : t.m - 1;
      if (y < 1) return badForm();
      return span(monthStart(y, m), monthEnd(y, m));
    }
  }

  let match = /^week:(.*)$/.exec(text);
  if (match !== null) {
    const d = parseDate(match[1]);
    if (d === undefined) return badForm();
    const day = dateText(d.y, d.m, d.d);
    const back = dayOfWeekFromMonday(day);
    if (daysBetween(EARLIEST_DAY, day) < back) return badForm();
    const mon = cal.addDays(day, -back);
    return span(mon, cal.addDays(mon, 6));
  }

  match = /^month:(\d{4})-(\d{2})$/.exec(text);
  if (match !== null) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    if (y < 1 || m < 1 || m > 12) return badForm();
    return span(monthStart(y, m), monthEnd(y, m));
  }

  match = /^last-(.*)-(days|months)$/.exec(text);
  if (match !== null) {
    const nText = match[1];
    if (!/^[1-9][0-9]*$/.test(nText)) {
      return badN(nText, 'which is not a positive whole number.');
    }
    // Decided on the N text before any date arithmetic, so N of any length is safe.
    const n = BigInt(nText);
    const tooFar = 'which reaches before the earliest date ' + EARLIEST_DAY + '.';
    if (match[2] === 'days') {
      if (n - 1n > BigInt(daysBetween(EARLIEST_DAY, today))) return badN(nText, tooFar);
      return span(cal.addDays(today, -(Number(n) - 1)), today);
    }
    const current = (t.y - 1) * 12 + (t.m - 1);
    if (n - 1n > BigInt(current)) return badN(nText, tooFar);
    const index = current - (Number(n) - 1);
    return span(monthStart(Math.floor(index / 12) + 1, (index % 12) + 1), today);
  }

  match = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})?$/.exec(text);
  if (match !== null) {
    const start = parseDate(match[1]);
    const end = match[2] === undefined ? t : parseDate(match[2]);
    if (start === undefined || end === undefined) return badForm();
    return span(dateText(start.y, start.m, start.d), dateText(end.y, end.m, end.d));
  }

  return badForm();
}

function lastOfMonth(y: number, m: number): LocalDate {
  return dateText(y, m, new Date(utcOf(y, m + 1, 0)).getUTCDate());
}
