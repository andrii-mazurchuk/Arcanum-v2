// Covered-range statement (S-77): drawInward rounds a held interval inward to the minute and draws
// it in the question's zone; coveredRangesContributor states one entry per scope source, in scope
// order, read from the question's snapshot. From src/local/covered-ranges.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load. The type imports are erased at run
// time.

import { describe, expect, test } from 'bun:test';
import type { Calendar } from '../../src/analytics/dates';
import type { QuestionContext } from '../../src/core/question';
import type { Snapshot } from '../../src/db/index';

const coveredRanges = () => import('../../src/local/covered-ranges');
const covered = () => import('../../src/local/covered');
const storeModule = () => import('../../src/db/index');
const dates = () => import('../../src/analytics/dates');

const calendarFor = async (zone: string | undefined): Promise<Calendar> => {
  const { openCalendar } = await dates();
  return openCalendar(zone) as Calendar;
};

// Every QuestionContext field but snapshot, calendar and scope throws when read.
const OTHER_FIELDS = [
  'now',
  'settings',
  'displayCurrency',
  'position',
  'register',
  'period',
  'asker',
  'options',
] as const;

const ctxFor = (snap: Snapshot, cal: Calendar, sources: readonly string[]): QuestionContext => {
  const ctx: Record<string, unknown> = {
    snapshot: snap,
    calendar: cal,
    scope: { narrowing: { kind: 'all' }, sources, holdings: new Set() },
  };
  for (const name of OTHER_FIELDS) {
    Object.defineProperty(ctx, name, {
      enumerable: true,
      get() {
        throw new Error('read ' + name);
      },
    });
  }
  return ctx as unknown as QuestionContext;
};

describe('local/covered-ranges', () => {
  test('drawInward', async () => {
    const { drawInward } = await coveredRanges();
    const cal = await calendarFor(undefined);
    const at = (s: string): number => Date.parse(s);
    const iv = (from: string, to: string) => ({ startAt: at(from), endAt: at(to) });

    // Europe/Warsaw in November (+01:00): the start is rounded up, the end is already whole.
    expect(drawInward(iv('2026-11-21T13:00:30Z', '2026-11-21T15:00:00Z'), cal)).toEqual({
      startAt: at('2026-11-21T13:01:00Z'),
      endAt: at('2026-11-21T15:00:00Z'),
      start: '2026-11-21T14:01:00+01:00',
      end: '2026-11-21T16:00:00+01:00',
    });

    // In July the zone's own offset is +02:00; the end is rounded down.
    expect(drawInward(iv('2026-07-02T08:00:30Z', '2026-07-02T09:30:59Z'), cal)).toEqual({
      startAt: at('2026-07-02T08:01:00Z'),
      endAt: at('2026-07-02T09:30:00Z'),
      start: '2026-07-02T10:01:00+02:00',
      end: '2026-07-02T11:30:00+02:00',
    });

    // Exactly one minute left after rounding is kept.
    const oneMinute = drawInward(iv('2026-11-21T10:00:30Z', '2026-11-21T10:02:10Z'), cal);
    expect(oneMinute?.startAt).toBe(at('2026-11-21T10:01:00Z'));
    expect(oneMinute?.endAt).toBe(at('2026-11-21T10:02:00Z'));

    // Nothing whole left after rounding, and an interval shorter than a minute on a whole start.
    expect(drawInward(iv('2026-11-21T10:00:30Z', '2026-11-21T10:01:20Z'), cal)).toBeNull();
    expect(
      drawInward(
        { startAt: at('2026-11-21T10:00:00Z'), endAt: at('2026-11-21T10:00:00Z') + 59_999 },
        cal,
      ),
    ).toBeNull();
  });

  test('coveredRangesContributor states scope sources in scope order', async () => {
    const { coveredRangesContributor, COVERED_RANGES_KEY } = await coveredRanges();
    const { ensureCoverageSchema, mergeCovered } = await covered();
    const { openStore, MEMORY_LOCATION } = await storeModule();
    const cal = await calendarFor('UTC');
    const at = (s: string): number => Date.parse(`2026-11-21T${s}Z`);
    const iv = (from: string, to: string) => ({ startAt: at(from), endAt: at(to) });

    expect(coveredRangesContributor.key).toBe(COVERED_RANGES_KEY);
    expect(COVERED_RANGES_KEY).toBe('coveredRanges');

    const store = openStore(MEMORY_LOCATION, [ensureCoverageSchema]);
    try {
      store.write((tx) => {
        mergeCovered(tx, 'monobank', [
          iv('10:00:00', '11:17:00'),
          iv('11:18:00', '12:00:00'),
          iv('13:00:10', '13:00:50'),
        ]);
        mergeCovered(tx, 'other', [iv('08:00:00', '09:00:00')]);
      });

      store.readSnapshot((snap) => {
        const result = coveredRangesContributor.contribute(
          ctxFor(snap, cal, ['zeta', 'monobank']),
        ) as readonly {
          sourceId: string;
          ranges: readonly { startAt: number; endAt: number; start: string; end: string }[];
        }[];

        expect(result.length).toBe(2);
        expect(result[0]).toEqual({ sourceId: 'zeta', ranges: [] });
        expect(result[1]?.sourceId).toBe('monobank');
        // Two held intervals that do not touch are shown apart; the sub-minute one is dropped.
        expect(result[1]?.ranges.map((r) => [r.startAt, r.endAt])).toEqual([
          [at('10:00:00'), at('11:17:00')],
          [at('11:18:00'), at('12:00:00')],
        ]);
        expect(result[1]?.ranges[0]?.end).toBe(cal.localDateTime(at('11:17:00')));
        expect(result.some((e) => e.sourceId === 'other')).toBe(false);

        expect(coveredRangesContributor.contribute(ctxFor(snap, cal, []))).toEqual([]);
      });
    } finally {
      store.close();
    }
  });
});
