// Covered intervals (S-71): per-source sets of half-open instant intervals. normaliseIntervals and
// minuteOf, the covered part of a completed step (coveredPart), and the merge and read over the
// store (mergeCovered, readCovered), from src/local/covered.
//
// The modules are imported inside each test, not at the top: a missing module then fails each
// test on its own instead of failing the whole file at load.

import { describe, expect, test } from 'bun:test';

const covered = () => import('../../src/local/covered');
const storeModule = () => import('../../src/db/index');

const at = (s: string): number => Date.parse(`2026-11-21T${s}Z`);
const iv = (from: string, to: string) => ({ startAt: at(from), endAt: at(to) });

describe('local/covered', () => {
  test('normaliseIntervals and coveredPart', async () => {
    const { normaliseIntervals, minuteOf, coveredPart } = await covered();

    // [10:00, 11:00) and [11:00, 11:10) touch at 11:00 and must merge; [09:00, 09:00) is empty and
    // [13:00, 12:30) is reversed, both dropped; [11:05, 11:08) lies inside the merged stretch.
    expect(
      normaliseIntervals([
        iv('11:30:00', '12:00:00'),
        iv('10:00:00', '11:00:00'),
        iv('11:00:00', '11:10:00'),
        iv('09:00:00', '09:00:00'),
        iv('13:00:00', '12:30:00'),
        iv('11:05:00', '11:08:00'),
      ]),
    ).toEqual([iv('10:00:00', '11:10:00'), iv('11:30:00', '12:00:00')]);

    expect(minuteOf(at('11:17:42'))).toEqual(iv('11:17:00', '11:18:00'));

    const window = iv('10:00:00', '12:00:00');
    const carved = [iv('10:00:00', '11:17:00'), iv('11:18:00', '12:00:00')];

    expect(coveredPart(window, [])).toEqual([window]);
    expect(coveredPart(window, [at('11:17:42')])).toEqual(carved);
    // 11:17:05 is in the same minute; 09:30:00 is before the window and 12:00:00 is its open end.
    expect(
      coveredPart(window, [at('11:17:42'), at('11:17:05'), at('09:30:00'), at('12:00:00')]),
    ).toEqual(carved);
    // A moment on the window start carves the whole first minute.
    expect(coveredPart(window, [at('10:00:00')])).toEqual([iv('10:01:00', '12:00:00')]);
    // An unreadable moment: the step passes no covered part at all.
    expect(coveredPart(window, [at('11:17:42'), null])).toBeNull();
    expect(coveredPart(iv('12:00:00', '12:00:00'), [])).toEqual([]);
  });

  test('mergeCovered widens only', async () => {
    const { ensureCoverageSchema, mergeCovered, readCovered, CoveredPartError } = await covered();
    const { openStore, MEMORY_LOCATION } = await storeModule();

    const store = openStore(MEMORY_LOCATION, [ensureCoverageSchema]);
    try {
      const read = (id: string) => store.readSnapshot((s) => readCovered(s, id));
      const rowCount = (id: string) =>
        store.readSnapshot(
          (s) =>
            s.db.query('SELECT COUNT(*) FROM covered_interval WHERE source_id = ?').values(id)[0]?.[0],
        );
      const step3 = [iv('10:00:00', '12:00:00'), iv('13:00:00', '14:00:00')];

      // 1. A first part on an empty source.
      store.write((tx) => mergeCovered(tx, 'monobank', [iv('10:00:00', '11:00:00')]));
      expect(read('monobank')).toEqual([iv('10:00:00', '11:00:00')]);

      // 2. A touching part merges into one stored row.
      store.write((tx) => mergeCovered(tx, 'monobank', [iv('11:00:00', '12:00:00')]));
      expect(read('monobank')).toEqual([iv('10:00:00', '12:00:00')]);
      expect(rowCount('monobank')).toBe(1);

      // 3. A part inside the held set and a separate one: the held set is kept, not replaced.
      store.write((tx) =>
        mergeCovered(tx, 'monobank', [iv('13:00:00', '14:00:00'), iv('10:30:00', '10:40:00')]),
      );
      expect(read('monobank')).toEqual(step3);

      // 4. An empty part changes nothing.
      store.write((tx) => mergeCovered(tx, 'monobank', []));
      expect(read('monobank')).toEqual(step3);

      // 5. Sources are kept apart.
      store.write((tx) => mergeCovered(tx, 'second', [iv('09:00:00', '10:00:00')]));
      expect(read('second')).toEqual([iv('09:00:00', '10:00:00')]);
      expect(read('monobank')).toEqual(step3);
      expect(read('none')).toEqual([]);

      // 6. An empty interval in a later merge rolls back the whole write, earlier merge included.
      expect(() =>
        store.write((tx) => {
          mergeCovered(tx, 'monobank', [iv('15:00:00', '16:00:00')]);
          mergeCovered(tx, 'monobank', [iv('17:00:00', '17:00:00')]);
        }),
      ).toThrow(CoveredPartError);
      expect(read('monobank')).toEqual(step3);

      // 7. A non-whole instant is refused.
      expect(() =>
        store.write((tx) =>
          mergeCovered(tx, 'monobank', [{ startAt: at('15:00:00') + 0.5, endAt: at('16:00:00') }]),
        ),
      ).toThrow(CoveredPartError);
      expect(read('monobank')).toEqual(step3);
    } finally {
      store.close();
    }
  });
});
