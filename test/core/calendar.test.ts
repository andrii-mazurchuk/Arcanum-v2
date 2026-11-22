// Calendar (S-52): zone validation, local days, weeks, months and date-times drawn from instants
// through the zone database, and the named-period parser, from src/analytics/dates.
//
// The module is imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const dates = () => import('../../src/analytics/dates');
const primitives = () => import('../../src/core/primitives');

// Opens a calendar that must not be a refusal.
async function calendar(zone: string | undefined): Promise<any> {
  const { openCalendar } = await dates();
  const { isRefusal } = await primitives();
  const cal = openCalendar(zone);
  expect(isRefusal(cal)).toBe(false);
  return cal;
}

// 2026-11-21T12:00 Warsaw, a Saturday.
const NOW = Date.UTC(2026, 10, 21, 11, 0, 0);

describe('core/calendar', () => {
  test('named periods', async () => {
    const { isRefusal } = await primitives();
    const cal = await calendar(undefined);

    const table: [string, string, string][] = [
      ['today', '2026-11-21', '2026-11-21'],
      ['yesterday', '2026-11-20', '2026-11-20'],
      ['this-week', '2026-11-16', '2026-11-21'],
      ['last-week', '2026-11-09', '2026-11-15'],
      ['this-month', '2026-11-01', '2026-11-21'],
      ['last-month', '2026-10-01', '2026-10-31'],
      ['week:2026-11-19', '2026-11-16', '2026-11-22'],
      ['month:2026-02', '2026-02-01', '2026-02-28'],
      ['last-7-days', '2026-11-15', '2026-11-21'],
      ['last-1-days', '2026-11-21', '2026-11-21'],
      ['last-1-months', '2026-11-01', '2026-11-21'],
      ['last-3-months', '2026-09-01', '2026-11-21'],
      ['2026-11-01..', '2026-11-01', '2026-11-21'],
      ['2026-10-30..2026-11-02', '2026-10-30', '2026-11-02'],
      ['2026-11-21..2026-12-31', '2026-11-21', '2026-12-31'], // past today is not refused
      ['  last-week  ', '2026-11-09', '2026-11-15'],
    ];
    for (const [text, firstDay, lastDay] of table) {
      const p = cal.resolvePeriod(text, NOW);
      expect(isRefusal(p)).toBe(false);
      expect([text, p.firstDay, p.lastDay]).toEqual([text, firstDay, lastDay]);
      expect(p.text).toBe(text.trim());
      expect(p.from).toBe(cal.startOfDay(p.firstDay));
      expect(p.until).toBe(cal.startOfDay(cal.addDays(p.lastDay, 1)));
    }
    expect(cal.resolvePeriod('  last-week  ', NOW).text).toBe('last-week');

    // As instants: Warsaw is on +01:00 in November.
    const p = cal.resolvePeriod('last-7-days', NOW);
    expect(p.from).toBe(Date.UTC(2026, 10, 14, 23, 0, 0));
    expect(p.until).toBe(Date.UTC(2026, 10, 21, 23, 0, 0));
  });

  test('daylight saving and drawing', async () => {
    const cal = await calendar(undefined);

    // 2026-03-29: summer time from 01:00 UTC, a 23-hour day.
    expect(cal.startOfDay('2026-03-29')).toBe(Date.UTC(2026, 2, 28, 23, 0, 0));
    expect(cal.startOfDay('2026-03-30') - cal.startOfDay('2026-03-29')).toBe(82800000);

    // 2026-10-25: back to standard time at 01:00 UTC, a 25-hour day.
    expect(cal.startOfDay('2026-10-25')).toBe(Date.UTC(2026, 9, 24, 22, 0, 0));
    expect(cal.startOfDay('2026-10-26') - cal.startOfDay('2026-10-25')).toBe(90000000);

    expect(cal.localDay(Date.UTC(2026, 10, 20, 23, 30, 0))).toBe('2026-11-21');

    const july = Date.UTC(2026, 6, 1, 22, 30, 0);
    expect(cal.localDateTime(july)).toBe('2026-07-02T00:30:00+02:00');
    expect(cal.localDay(july)).toBe('2026-07-02');
    // 2026-07-02 is a Thursday.
    expect(cal.weekOf(july)).toEqual({ monday: '2026-06-29', sunday: '2026-07-05' });

    expect(cal.monthOf(Date.UTC(2026, 9, 31, 23, 30, 0))).toBe('2026-11');

    expect(cal.addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(cal.addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(cal.addDays('2026-03-28', 2)).toBe('2026-03-30');

    const utc = await calendar('UTC');
    expect(utc.localDay(Date.UTC(2026, 10, 20, 23, 30, 0))).toBe('2026-11-20');
  });

  test('zone validation', async () => {
    const { openCalendar, DEFAULT_TIME_ZONE } = await dates();
    const { isRefusal } = await primitives();

    expect((await calendar(undefined)).zone).toBe('Europe/Warsaw');
    expect(DEFAULT_TIME_ZONE).toBe('Europe/Warsaw');

    expect((await calendar('UTC')).zone).toBe('UTC');
    const ny = await calendar('America/New_York');
    expect(ny.localDateTime(Date.UTC(2026, 10, 21, 11, 0, 0))).toBe('2026-11-21T06:00:00-05:00');

    for (const v of ['+02:00', '', 'Europe/Wasaw', 'Mars/Base']) {
      let r: any;
      expect(() => {
        r = openCalendar(v);
      }).not.toThrow();
      expect(isRefusal(r)).toBe(true);
      expect(r.reason).toBe('unknown_time_zone');
      expect(r.subject).toBe('timeZone');
      expect(r.value).toBe(v);
      expect(r.message).toBe(
        'The time zone setting "timeZone" holds "' + v + '", which names no known time zone.',
      );
    }
  });

  test('period refusals', async () => {
    const { isRefusal } = await primitives();
    const cal = await calendar(undefined);

    const table: [string | undefined, string, string?][] = [
      [undefined, 'missing'],
      ['', 'missing'],
      ['Last-week', 'form', 'Last-week'],
      ['last-week-ish', 'form', 'last-week-ish'],
      ['month:2026-13', 'form', 'month:2026-13'],
      ['2026-02-30..', 'form', '2026-02-30..'],
      ['2026-02-29..', 'form', '2026-02-29..'], // 2026 is not a leap year
      ['0000-01-01..', 'form', '0000-01-01..'],
      ['last-0-days', 'n', '0'],
      ['last--3-days', 'n', '-3'],
      ['last-1.5-months', 'n', '1.5'],
      ['last-007-days', 'n', '007'],
      ['2026-11-22..', 'start_after_end'],
      ['2026-11-10..2026-11-09', 'start_after_end'],
    ];
    for (const [text, subject, value] of table) {
      let r: any;
      expect(() => {
        r = cal.resolvePeriod(text, NOW);
      }).not.toThrow();
      expect([text, isRefusal(r)]).toEqual([text, true]);
      expect(r.reason).toBe('bad_period');
      expect([text, r.subject]).toEqual([text, subject]);
      if (value !== undefined) expect(r.value).toBe(value);
    }
  });

  test('range floor', async () => {
    const { EARLIEST_DAY } = await dates();
    const { isRefusal } = await primitives();
    const cal = await calendar(undefined);

    // Whole days from 0001-01-01 to 2026-11-21, and whole months from 0001-01 to 2026-11.
    const D = (Date.parse('2026-11-21T00:00:00Z') - Date.parse('0001-01-01T00:00:00Z')) / 86400000;
    const M = (2026 - 1) * 12 + (11 - 1);
    expect(D).toBe(739940);
    expect(M).toBe(24310);

    expect(EARLIEST_DAY).toBe('0001-01-01');

    const refusedNamingN = (text: string, value: string) => {
      let r: any;
      expect(() => {
        r = cal.resolvePeriod(text, NOW);
      }).not.toThrow();
      expect(isRefusal(r)).toBe(true);
      expect(r.reason).toBe('bad_period');
      expect(r.subject).toBe('n');
      expect(r.value).toBe(value);
    };

    const p = cal.resolvePeriod('last-' + (D + 1) + '-days', NOW);
    expect(isRefusal(p)).toBe(false);
    expect(p.firstDay).toBe('0001-01-01');
    expect(p.lastDay).toBe('2026-11-21');
    expect(Number.isInteger(p.from)).toBe(true);

    refusedNamingN('last-' + (D + 2) + '-days', String(D + 2));

    const q = cal.resolvePeriod('last-' + (M + 1) + '-months', NOW);
    expect(isRefusal(q)).toBe(false);
    expect(q.firstDay).toBe('0001-01-01');

    refusedNamingN('last-' + (M + 2) + '-months', String(M + 2));

    refusedNamingN('last-1000000-days', '1000000');

    const big = '9'.repeat(400);
    refusedNamingN('last-' + big + '-days', big);
    refusedNamingN('last-' + big + '-months', big);
  });
});
