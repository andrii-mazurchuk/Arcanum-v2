// Analysis periods (S-152): month and week descriptors with their partial flag, the resolvers for
// named, current, last complete and N-before periods, the trends window and its count check, the
// report-period check and the per-day divisor, from src/analytics/periods. Edges are drawn by the
// Calendar (S-52) from src/analytics/dates.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const periods = () => import('../../src/analytics/periods');
const dates = () => import('../../src/analytics/dates');
const primitives = () => import('../../src/core/primitives');

// Opens the Europe/Warsaw calendar, which must not be a refusal.
async function warsaw(): Promise<any> {
  const { openCalendar } = await dates();
  const { isRefusal } = await primitives();
  const cal = openCalendar('Europe/Warsaw');
  expect(isRefusal(cal)).toBe(false);
  return cal;
}

const at = (text: string) => Date.parse(text);

// 2026-11-21T12:00 Warsaw, a Saturday.
const NOW = at('2026-11-21T12:00:00+01:00');

const HOUR = 3_600_000;

describe('analysis/periods', () => {
  test('periods: worked Warsaw descriptors', async () => {
    const {
      currentMonth,
      lastCompleteMonth,
      lastCompleteWeek,
      currentWeek,
      trendsWindow,
      monthsBefore,
      weeksBefore,
      monthPeriod,
      localDaysIn,
      spanUnion,
    } = await periods();
    const cal = await warsaw();

    const month = currentMonth(cal, NOW);
    expect(month.kind).toBe('month');
    expect(month.label).toBe('2026-11');
    expect(month.firstDay).toBe('2026-11-01');
    expect(month.lastDay).toBe('2026-11-30');
    expect(month.from).toBe(at('2026-11-01T00:00:00+01:00'));
    expect(month.until).toBe(NOW);
    expect(month.partial).toBe(true);
    // 20.5 days of instants so far; 21 local dates counted by stepping.
    expect(localDaysIn(cal, month, NOW)).toBe(21);

    const october = lastCompleteMonth(cal, NOW);
    expect(october.kind).toBe('month');
    expect(october.label).toBe('2026-10');
    expect(october.firstDay).toBe('2026-10-01');
    expect(october.lastDay).toBe('2026-10-31');
    expect(october.from).toBe(at('2026-10-01T00:00:00+02:00'));
    expect(october.until).toBe(at('2026-11-01T00:00:00+01:00'));
    // 2026-10-25 lasts 25 hours.
    expect(october.until - october.from).toBe(745 * HOUR);
    expect(october.partial).toBe(false);
    // 745 h is 31.04 days of instants; 31 local dates.
    expect(localDaysIn(cal, october, NOW)).toBe(31);

    const lastWeek = lastCompleteWeek(cal, NOW);
    expect(lastWeek.kind).toBe('week');
    expect(lastWeek.label).toBe('2026-11-09');
    expect(lastWeek.firstDay).toBe('2026-11-09');
    expect(lastWeek.lastDay).toBe('2026-11-15');
    expect(lastWeek.from).toBe(at('2026-11-09T00:00:00+01:00'));
    expect(lastWeek.until).toBe(at('2026-11-16T00:00:00+01:00'));
    expect(lastWeek.partial).toBe(false);
    expect(localDaysIn(cal, lastWeek, NOW)).toBe(7);

    const week = currentWeek(cal, NOW);
    expect(week.kind).toBe('week');
    expect(week.label).toBe('2026-11-16');
    expect(week.firstDay).toBe('2026-11-16');
    // The natural Sunday, not today, although the week is partial.
    expect(week.lastDay).toBe('2026-11-22');
    expect(week.from).toBe(at('2026-11-16T00:00:00+01:00'));
    expect(week.until).toBe(NOW);
    expect(week.partial).toBe(true);
    expect(localDaysIn(cal, week, NOW)).toBe(6);

    const window = trendsWindow(cal, NOW, 3);
    expect(window.complete.map((p: any) => p.label)).toEqual(['2026-08', '2026-09', '2026-10']);
    for (const p of window.complete) expect(p.partial).toBe(false);
    expect(window.inProgress.label).toBe('2026-11');
    expect(window.inProgress.partial).toBe(true);

    // Across a year boundary: the month before '2026-01' is '2025-12'.
    const before = monthsBefore(cal, monthPeriod(cal, '2026-01', NOW), 3, NOW);
    expect(before.map((p: any) => p.label)).toEqual(['2025-10', '2025-11', '2025-12']);
    for (const p of before) expect(p.partial).toBe(false);

    const weeks = weeksBefore(cal, lastCompleteWeek(cal, NOW), 4, NOW);
    expect(weeks.map((p: any) => p.label)).toEqual([
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
      '2026-11-02',
    ]);
    for (const p of weeks) expect(p.partial).toBe(false);

    // A month not yet begun is a programming error; at its own first instant it is empty.
    expect(() => monthPeriod(cal, '2026-12', NOW)).toThrow(RangeError);
    const december = monthPeriod(cal, '2026-12', at('2026-12-01T00:00:00+01:00'));
    expect(december.partial).toBe(true);
    expect(december.from).toBe(december.until);

    expect(
      spanUnion([
        { from: 5, until: 9 },
        { from: 2, until: 7 },
      ]),
    ).toEqual({ from: 2, until: 9 });
    expect(() => spanUnion([])).toThrow(RangeError);
  });

  test('periods: trendsMonths table', async () => {
    const {
      trendsMonths,
      TRENDS_MIN_MONTHS,
      TRENDS_MAX_MONTHS,
      TRENDS_DEFAULT_MONTHS,
      BASELINE_MONTHS,
      BASELINE_WEEKS,
    } = await periods();
    const { refuse, isRefusal } = await primitives();

    expect(TRENDS_MIN_MONTHS).toBe(1);
    expect(TRENDS_MAX_MONTHS).toBe(24);
    expect(TRENDS_DEFAULT_MONTHS).toBe(3);
    expect(BASELINE_MONTHS).toBe(3);
    expect(BASELINE_WEEKS).toBe(4);

    const accepted: [unknown, number][] = [
      [undefined, 3],
      [1, 1],
      [12, 12],
      [24, 24],
    ];
    for (const [raw, want] of accepted) {
      expect(trendsMonths(raw)).toBe(want);
    }

    for (const raw of [0, 25, -1, 2.5, '6', null]) {
      const got = trendsMonths(raw);
      expect(got).toEqual(
        refuse(
          'bad_option',
          'months',
          'The number of months must be a whole number from 1 to 24; "' + String(raw) + '" is not.',
          String(raw),
        ),
      );
      expect(isRefusal(got)).toBe(true);
    }
  });

  test('periods: reportPeriod forms and refusals', async () => {
    const { reportPeriod } = await periods();
    const { refuse, isRefusal } = await primitives();
    const cal = await warsaw();

    const rp = (text: string, firstDay: string, lastDay: string) => ({
      text,
      firstDay,
      lastDay,
      from: cal.startOfDay(firstDay),
      until: cal.startOfDay(cal.addDays(lastDay, 1)),
    });

    // Week.
    let got: any = reportPeriod(cal, rp('last-week', '2026-11-09', '2026-11-15'), 'week', NOW);
    expect(isRefusal(got)).toBe(false);
    expect(got.kind).toBe('week');
    expect(got.label).toBe('2026-11-09');
    expect(got.partial).toBe(false);

    got = reportPeriod(cal, rp('this-week', '2026-11-16', '2026-11-21'), 'week', NOW);
    expect(isRefusal(got)).toBe(false);
    expect(got.kind).toBe('week');
    expect(got.label).toBe('2026-11-16');
    expect(got.partial).toBe(true);
    expect(got.until).toBe(NOW);

    // A named week containing today: neither future nor complete.
    got = reportPeriod(cal, rp('week:2026-11-16', '2026-11-16', '2026-11-22'), 'week', NOW);
    expect(isRefusal(got)).toBe(false);
    expect(got.kind).toBe('week');
    expect(got.label).toBe('2026-11-16');
    expect(got.partial).toBe(true);
    expect(got.until).toBe(NOW);

    expect(reportPeriod(cal, rp('last-7-days', '2026-11-15', '2026-11-21'), 'week', NOW)).toEqual(
      refuse(
        'bad_period',
        'form',
        'A weekly report covers one Monday-to-Sunday week or this week so far; "last-7-days" is not one.',
        'last-7-days',
      ),
    );

    // Starts on a Monday but is neither a whole week nor this week so far.
    got = reportPeriod(cal, rp('mon-thu', '2026-11-09', '2026-11-12'), 'week', NOW);
    expect(got.reason).toBe('bad_period');
    expect(got.subject).toBe('form');

    expect(
      reportPeriod(cal, rp('week:2026-11-23', '2026-11-23', '2026-11-29'), 'week', NOW),
    ).toEqual(
      refuse(
        'bad_period',
        'future',
        'The period "week:2026-11-23" has not begun yet.',
        'week:2026-11-23',
      ),
    );

    // In the future and of the wrong form: 'form' is checked first.
    got = reportPeriod(cal, rp('next-mon-wed', '2026-11-23', '2026-11-25'), 'week', NOW);
    expect(got.reason).toBe('bad_period');
    expect(got.subject).toBe('form');

    // Month.
    got = reportPeriod(cal, rp('month:2026-10', '2026-10-01', '2026-10-31'), 'month', NOW);
    expect(isRefusal(got)).toBe(false);
    expect(got.kind).toBe('month');
    expect(got.label).toBe('2026-10');
    expect(got.partial).toBe(false);

    got = reportPeriod(cal, rp('this-month', '2026-11-01', '2026-11-21'), 'month', NOW);
    expect(isRefusal(got)).toBe(false);
    expect(got.kind).toBe('month');
    expect(got.label).toBe('2026-11');
    expect(got.partial).toBe(true);
    expect(got.until).toBe(NOW);

    got = reportPeriod(cal, rp('month:2026-11', '2026-11-01', '2026-11-30'), 'month', NOW);
    expect(isRefusal(got)).toBe(false);
    expect(got.kind).toBe('month');
    expect(got.label).toBe('2026-11');
    expect(got.partial).toBe(true);

    expect(reportPeriod(cal, rp('oct-1-30', '2026-10-01', '2026-10-30'), 'month', NOW)).toEqual(
      refuse(
        'bad_period',
        'form',
        'A monthly report covers one calendar month or this month so far; "oct-1-30" is not one.',
        'oct-1-30',
      ),
    );

    got = reportPeriod(cal, rp('month:2026-12', '2026-12-01', '2026-12-31'), 'month', NOW);
    expect(got.reason).toBe('bad_period');
    expect(got.subject).toBe('future');

    got = reportPeriod(cal, rp('last-week', '2026-11-09', '2026-11-15'), 'month', NOW);
    expect(got.reason).toBe('bad_period');
    expect(got.subject).toBe('form');
  });
});
