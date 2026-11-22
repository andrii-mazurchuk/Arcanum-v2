// Behaviour patterns (S-158): each spending line of the period ledger bucketed by the local hour and
// weekday the calendar draws from the line's own transaction instant (never a storage moment), in
// one pass; counts take every spending line, money figures only converted ones; habits per
// (category, weekday, hour) at count 3 or more; the per-day frequency over local days up to today;
// busiest hour and top weekday with ties going to the earliest. No recurring-payment or
// subscription detection exists here. The monthly report calls patternsOf over its own ledger.

import { fractionText } from '../answers/text';
import type { CurrencyCode, DisplayCurrency, Instant, LocalDate } from '../core/primitives';
import { refuse } from '../core/primitives';
import type { Family } from '../core/question';
import { CATEGORIES, type Category } from '../local/classifier';
import type { MoneyContext, MoneyPart } from '../money/context';
import { type Fraction, fraction } from '../money/exact';
import { type Money, money, sumMoney } from '../money/money';
import type { Calendar } from './dates';
import { type PeriodLedger, buildLedger } from './ledger';
import type { Span } from './periods';
import { averageMinor } from './savings';

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const HABIT_MIN_COUNT = 3;
export const PER_DAY_DECIMALS = 2;

export interface Bucket {
  readonly count: number;
  readonly total: Money;
  readonly average: Money | null;
}
export interface HourRow extends Bucket {
  readonly hour: number; // 0..23
}
export interface WeekdayRow extends Bucket {
  readonly weekday: Weekday;
}
export interface Habit {
  readonly category: Category;
  readonly weekday: Weekday;
  readonly hour: number;
  readonly count: number;
}
export interface PatternsBody {
  readonly byHour: readonly HourRow[]; // 24 rows, hour 0 first
  readonly byWeekday: readonly WeekdayRow[]; // 7 rows, Monday first
  readonly habits: readonly Habit[];
  readonly transactions: number; // spending lines in the span, converted or not
  readonly days: number; // the per-day divisor
  readonly perDay: { readonly exact: Fraction; readonly text: string } | null; // null when days is 0
  readonly total: Money;
  readonly averageTransaction: Money | null;
  readonly busiestHour: number | null;
  readonly topWeekday: Weekday | null;
  readonly notConverted: readonly {
    readonly original: Money;
    readonly pair: { readonly from: CurrencyCode; readonly to: DisplayCurrency };
  }[];
}

export function localHour(cal: Calendar, at: Instant): number {
  return Number(cal.localDateTime(at).slice(11, 13));
}

export function localWeekday(cal: Calendar, at: Instant): Weekday {
  const day = cal.localDay(at);
  const monday = cal.weekOf(at).monday;
  for (let k = 0; k < WEEKDAYS.length; k++) {
    if (cal.addDays(monday, k) === day) return WEEKDAYS[k]!;
  }
  throw new RangeError(`localWeekday: ${day} is not in the week of ${monday}`);
}

// Count of all lines plus the converted figures, so the average divides by converted lines only.
interface Acc {
  count: number;
  figures: Money[];
}

const newAcc = (): Acc => ({ count: 0, figures: [] });

function bucketOf(acc: Acc, display: DisplayCurrency): Bucket {
  const total = sumMoney(acc.figures, display);
  const c = acc.figures.length;
  return { count: acc.count, total, average: c === 0 ? null : money(averageMinor(total.minor, c), display) };
}

export function patternsOf(
  ledger: PeriodLedger,
  s: { from: number; until: number },
  days: number,
  cal: Calendar,
  mc: MoneyContext,
): PatternsBody {
  const display = ledger.display;
  const hours = Array.from({ length: 24 }, newAcc);
  const weekdays = WEEKDAYS.map(newAcc);
  const all = newAcc();
  // Keyed by CATEGORIES index, weekday index and hour, so the key orders as the tie rule does.
  const triples = new Map<string, { c: number; w: number; h: number; count: number }>();
  const notConverted: PatternsBody['notConverted'][number][] = [];

  const lines = ledger.lines(s as Span, 'spending');
  for (const l of lines) {
    const h = localHour(cal, l.at);
    const w = WEEKDAYS.indexOf(localWeekday(cal, l.at));
    for (const acc of [hours[h]!, weekdays[w]!, all]) {
      acc.count++;
      if (l.figure !== null) acc.figures.push(l.figure);
    }
    const c = CATEGORIES.indexOf(l.category);
    const key = `${c}/${w}/${h}`;
    const t = triples.get(key);
    if (t === undefined) triples.set(key, { c, w, h, count: 1 });
    else t.count++;
    if (l.figure === null && l.result.kind === 'unconverted') {
      notConverted.push({ original: l.original, pair: l.result.pair });
    }
  }
  mc.show(lines.map((l) => l.result));

  const byHour: HourRow[] = hours.map((acc, hour) => ({ hour, ...bucketOf(acc, display) }));
  const byWeekday: WeekdayRow[] = weekdays.map((acc, i) => ({ weekday: WEEKDAYS[i]!, ...bucketOf(acc, display) }));

  const habits: Habit[] = [...triples.values()]
    .filter((t) => t.count >= HABIT_MIN_COUNT)
    .sort((a, b) => b.count - a.count || a.w - b.w || a.h - b.h || a.c - b.c)
    .map((t) => ({ category: CATEGORIES[t.c]!, weekday: WEEKDAYS[t.w]!, hour: t.h, count: t.count }));

  // Earliest wins: a later row replaces the leader only when strictly larger.
  let busiestHour: number | null = null;
  for (const r of byHour) {
    if (r.count > 0 && (busiestHour === null || r.count > byHour[busiestHour]!.count)) busiestHour = r.hour;
  }
  let top: WeekdayRow | null = null;
  for (const r of byWeekday) {
    if (r.count > 0 && (top === null || r.total.minor > top.total.minor)) top = r;
  }

  const overall = bucketOf(all, display);
  let perDay: PatternsBody['perDay'] = null;
  if (days > 0) {
    const exact = fraction(BigInt(all.count), BigInt(days));
    perDay = { exact, text: fractionText(exact, PER_DAY_DECIMALS) };
  }

  return {
    byHour,
    byWeekday,
    habits,
    transactions: all.count,
    days,
    perDay,
    total: overall.total,
    averageTransaction: overall.average,
    busiestHour,
    topWeekday: top === null ? null : top.weekday,
    notConverted,
  };
}

export function patternDays(cal: Calendar, firstDay: LocalDate, lastDay: LocalDate, now: Instant): number {
  const today = cal.localDay(now);
  const end = lastDay < today ? lastDay : today;
  let n = 0;
  for (let d = firstDay; d <= end; d = cal.addDays(d, 1)) n++;
  return n;
}

export function createPatternsFamily(part: MoneyPart): Family<PatternsBody> {
  return {
    name: 'behaviour_patterns',
    period: 'optional',
    defaultPeriod: 'last-month',
    movesPoint: false,
    compute(ctx) {
      for (const key of Object.keys(ctx.options)) {
        return refuse('bad_option', key, `The behaviour patterns answer takes no option "${key}".`);
      }
      const period = ctx.period!;
      const mc = part.moneyFor(ctx);
      const s = { from: period.from, until: period.until };
      const ledger = buildLedger(ctx, mc, [s]);
      const days = patternDays(ctx.calendar, period.firstDay, period.lastDay, ctx.now);
      return { kind: 'body', body: patternsOf(ledger, s, days, ctx.calendar, mc) };
    },
  };
}
