// Analysis periods (S-152): the only place an analysis family obtains month and week edges. Every
// edge is drawn by the question's one Calendar and every 'now' is the frame's moment of asking; a
// period in progress ends at now and is tagged partial. Also the trends window and its count
// check, the report-period check, and the per-day divisor.

import type { Instant, LocalDate, Refusal } from '../core/primitives';
import { refuse } from '../core/primitives';
import type { Calendar, ResolvedPeriod } from './dates';

export type PeriodKind = 'month' | 'week';
export interface Span {
  readonly from: Instant;
  readonly until: Instant;
} // half-open: from <= t < until
export interface AnalysisPeriod extends Span {
  readonly kind: PeriodKind;
  readonly label: string; // month: 'YYYY-MM'; week: its Monday 'YYYY-MM-DD'
  readonly firstDay: LocalDate; // the 1st, or the Monday
  readonly lastDay: LocalDate; // the natural last day (month's last day, or the Sunday), also when partial
  readonly partial: boolean; // true exactly when now < calendar.startOfDay(calendar.addDays(lastDay, 1))
}

export const TRENDS_MIN_MONTHS = 1;
export const TRENDS_MAX_MONTHS = 24;
export const TRENDS_DEFAULT_MONTHS = 3;
export const BASELINE_MONTHS = 3; // months before a month that a tier is judged against
export const BASELINE_WEEKS = 4; // weeks before a week that a weekly tier is judged against

function monthLabel(y: number, m: number): string {
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0');
}

function splitLabel(label: string): { y: number; m: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (match === null) throw new RangeError('Not a month label: "' + label + '".');
  const y = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) throw new RangeError('Not a month label: "' + label + '".');
  return { y, m };
}

function previousMonth(label: string): string {
  const { y, m } = splitLabel(label);
  return m === 1 ? monthLabel(y - 1, 12) : monthLabel(y, m - 1);
}

function nextMonth(label: string): string {
  const { y, m } = splitLabel(label);
  return m === 12 ? monthLabel(y + 1, 1) : monthLabel(y, m + 1);
}

function lastDayOfMonth(cal: Calendar, label: string): LocalDate {
  return cal.addDays(nextMonth(label) + '-01', -1);
}

function describe(
  cal: Calendar,
  kind: PeriodKind,
  label: string,
  firstDay: LocalDate,
  lastDay: LocalDate,
  now: Instant,
): AnalysisPeriod {
  const from = cal.startOfDay(firstDay);
  if (from > now) {
    throw new RangeError('The ' + kind + ' ' + label + ' starts after now.');
  }
  const end = cal.startOfDay(cal.addDays(lastDay, 1));
  const partial = now < end;
  return Object.freeze({
    kind,
    label,
    firstDay,
    lastDay,
    from,
    until: partial ? now : end,
    partial,
  });
}

function checkCount(n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError('A period count must be a whole number >= 1; got ' + String(n) + '.');
  }
}

export function monthPeriod(cal: Calendar, label: string, now: Instant): AnalysisPeriod {
  splitLabel(label);
  return describe(cal, 'month', label, label + '-01', lastDayOfMonth(cal, label), now);
}

export function weekPeriod(cal: Calendar, monday: LocalDate, now: Instant): AnalysisPeriod {
  return describe(cal, 'week', monday, monday, cal.addDays(monday, 6), now);
}

export function currentMonth(cal: Calendar, now: Instant): AnalysisPeriod {
  return monthPeriod(cal, cal.monthOf(now), now);
}

export function currentWeek(cal: Calendar, now: Instant): AnalysisPeriod {
  return weekPeriod(cal, cal.weekOf(now).monday, now);
}

export function lastCompleteMonth(cal: Calendar, now: Instant): AnalysisPeriod {
  return monthPeriod(cal, previousMonth(cal.monthOf(now)), now);
}

export function lastCompleteWeek(cal: Calendar, now: Instant): AnalysisPeriod {
  return weekPeriod(cal, cal.addDays(cal.weekOf(now).monday, -7), now);
}

// The n months immediately before p, oldest first; each is complete, since it ends where p starts.
export function monthsBefore(
  cal: Calendar,
  p: AnalysisPeriod,
  n: number,
  now: Instant,
): AnalysisPeriod[] {
  checkCount(n);
  const out: AnalysisPeriod[] = [];
  let label = p.firstDay.slice(0, 7);
  for (let i = 0; i < n; i++) {
    label = previousMonth(label);
    out.push(monthPeriod(cal, label, now));
  }
  return out.reverse();
}

// The n weeks immediately before p, oldest first.
export function weeksBefore(
  cal: Calendar,
  p: AnalysisPeriod,
  n: number,
  now: Instant,
): AnalysisPeriod[] {
  checkCount(n);
  const out: AnalysisPeriod[] = [];
  let monday = p.firstDay;
  for (let i = 0; i < n; i++) {
    monday = cal.addDays(monday, -7);
    out.push(weekPeriod(cal, monday, now));
  }
  return out.reverse();
}

export function trendsMonths(raw: unknown): number | Refusal {
  if (raw === undefined) return TRENDS_DEFAULT_MONTHS;
  if (
    typeof raw === 'number' &&
    Number.isSafeInteger(raw) &&
    raw >= TRENDS_MIN_MONTHS &&
    raw <= TRENDS_MAX_MONTHS
  ) {
    return raw;
  }
  return refuse(
    'bad_option',
    'months',
    'The number of months must be a whole number from 1 to 24; "' + String(raw) + '" is not.',
    String(raw),
  );
}

// complete: the n months ending with lastCompleteMonth, oldest first; inProgress: this month so far.
export function trendsWindow(
  cal: Calendar,
  now: Instant,
  n: number,
): { complete: AnalysisPeriod[]; inProgress: AnalysisPeriod } {
  const inProgress = currentMonth(cal, now);
  return { complete: monthsBefore(cal, inProgress, n, now), inProgress };
}

export function reportPeriod(
  cal: Calendar,
  rp: ResolvedPeriod,
  kind: PeriodKind,
  now: Instant,
): AnalysisPeriod | Refusal {
  const today = cal.localDay(now);
  let accepted: boolean;
  let resolveIt: () => AnalysisPeriod;
  if (kind === 'week') {
    const monday = cal.weekOf(rp.from).monday;
    const sunday = cal.addDays(monday, 6);
    accepted =
      rp.firstDay === monday &&
      (rp.lastDay === sunday || (rp.lastDay === today && monday <= today && today <= sunday));
    resolveIt = () => weekPeriod(cal, monday, now);
  } else {
    const first = rp.firstDay.slice(0, 8) + '01';
    const label = first.slice(0, 7);
    accepted =
      rp.firstDay === first &&
      (rp.lastDay === lastDayOfMonth(cal, label) ||
        (rp.lastDay === today && today.slice(0, 7) === label));
    resolveIt = () => monthPeriod(cal, label, now);
  }
  if (!accepted) {
    const covers =
      kind === 'week'
        ? 'A weekly report covers one Monday-to-Sunday week or this week so far; "'
        : 'A monthly report covers one calendar month or this month so far; "';
    return refuse('bad_period', 'form', covers + rp.text + '" is not one.', rp.text);
  }
  if (rp.firstDay > today) {
    return refuse(
      'bad_period',
      'future',
      'The period "' + rp.text + '" has not begun yet.',
      rp.text,
    );
  }
  return resolveIt();
}

// Local dates from firstDay to lastDay (or to today when partial), inclusive, counted by stepping.
export function localDaysIn(cal: Calendar, p: AnalysisPeriod, now: Instant): number {
  const end = p.partial ? cal.localDay(now) : p.lastDay;
  let count = 1;
  for (let d = p.firstDay; d < end; d = cal.addDays(d, 1)) count++;
  return count;
}

export function spanUnion(spans: readonly Span[]): Span {
  if (spans.length === 0) throw new RangeError('spanUnion needs at least one span.');
  let from = spans[0].from;
  let until = spans[0].until;
  for (const s of spans) {
    if (s.from < from) from = s.from;
    if (s.until > until) until = s.until;
  }
  return { from, until };
}
