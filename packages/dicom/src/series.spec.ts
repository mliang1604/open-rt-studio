/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DoseInfo } from './rt-dose.js';
import {
  doseObjectDescription,
  doseObjectSeriesKey,
  groupSeries,
  largestSeries,
  middleSlice,
  nameDoseObjects,
  seriesInstanceUidOf,
  seriesKeyParts,
} from './series.js';
import type { Slice } from './types.js';

/** A minimal slice carrying just the series-grouping fields under test. */
function slice(seriesUid: string | null, overrides: Partial<Slice> = {}): Slice {
  return {
    name: 'slice',
    columns: 4,
    rows: 4,
    pixelSpacing: [1, 1],
    position: null,
    orientation: null,
    instanceNumber: 0,
    seriesUid,
    seriesNumber: null,
    seriesDescription: null,
    frameOfReferenceUid: null,
    studyUid: null,
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    patientId: null,
    patientName: null,
    modality: null,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    windowCenter: null,
    windowWidth: null,
    pixels: new Float32Array(16),
    ...overrides,
  };
}

describe('groupSeries', () => {
  it('splits slices into one group per SeriesInstanceUID', () => {
    const series = groupSeries([slice('a'), slice('b'), slice('a')]);

    expect(series).toHaveLength(2);
    expect(series.map((s) => s.uid).sort()).toEqual(['a', 'b']);
    expect(series.find((s) => s.uid === 'a')?.imageCount).toBe(2);
    expect(series.find((s) => s.uid === 'b')?.imageCount).toBe(1);
  });

  it('takes the descriptor fields and dims from each series first slice', () => {
    const series = groupSeries([
      slice('a', {
        seriesNumber: 3,
        seriesDescription: 'Axial CT',
        modality: 'CT',
        columns: 512,
        rows: 256,
      }),
    ]);

    expect(series[0]).toMatchObject({
      uid: 'a',
      seriesNumber: 3,
      description: 'Axial CT',
      modality: 'CT',
      imageCount: 1,
      dims: [512, 256],
    });
  });

  it('orders series by SeriesNumber ascending, those without a number last', () => {
    const series = groupSeries([
      slice('c', { seriesNumber: null }),
      slice('a', { seriesNumber: 5 }),
      slice('b', { seriesNumber: 2 }),
    ]);

    expect(series.map((s) => s.uid)).toEqual(['b', 'a', 'c']);
  });

  it('groups slices that carry no UID into one unnamed series', () => {
    const series = groupSeries([slice(null), slice(null)]);

    expect(series).toHaveLength(1);
    expect(series[0].uid).toBe('');
    expect(series[0].imageCount).toBe(2);
  });

  it('keeps each series slices in encounter order', () => {
    const a1 = slice('a', { instanceNumber: 1 });
    const a2 = slice('a', { instanceNumber: 2 });
    const series = groupSeries([a2, slice('b'), a1]);

    expect(series.find((s) => s.uid === 'a')?.slices).toEqual([a2, a1]);
  });

  it('returns an empty list for no slices', () => {
    expect(groupSeries([])).toEqual([]);
  });
});

describe('largestSeries', () => {
  it('picks the series with the most images', () => {
    const series = groupSeries([slice('a'), slice('b'), slice('b'), slice('b'), slice('a')]);

    expect(largestSeries(series).uid).toBe('b');
  });

  it('breaks an image-count tie by picker order (lower SeriesNumber)', () => {
    const series = groupSeries([
      slice('hi', { seriesNumber: 9 }),
      slice('lo', { seriesNumber: 1 }),
    ]);

    expect(largestSeries(series).uid).toBe('lo');
  });
});

describe('middleSlice', () => {
  it('returns null for a series with no slices', () => {
    const series = groupSeries([slice('a')]);
    expect(middleSlice({ ...series[0], slices: [] })).toBeNull();
  });

  it('returns the central slice by InstanceNumber when there is no spatial metadata', () => {
    const [series] = groupSeries([
      slice('a', { instanceNumber: 3, name: 'three' }),
      slice('a', { instanceNumber: 1, name: 'one' }),
      slice('a', { instanceNumber: 2, name: 'two' }),
    ]);

    expect(middleSlice(series)?.name).toBe('two');
  });

  it('orders by ImagePositionPatient along the slice normal when present', () => {
    const orientation = [1, 0, 0, 0, 1, 0]; // normal is +z
    const at = (z: number, name: string) => slice('a', { orientation, position: [0, 0, z], name });
    // Encounter order is shuffled; the middle by z is the one at z=5.
    const [series] = groupSeries([at(9, 'top'), at(1, 'bottom'), at(5, 'middle')]);

    expect(middleSlice(series)?.name).toBe('middle');
  });

  it('does not reorder the series own slice array', () => {
    const [series] = groupSeries([
      slice('a', { instanceNumber: 3, name: 'three' }),
      slice('a', { instanceNumber: 1, name: 'one' }),
    ]);
    const before = series.slices.map((s) => s.name);

    middleSlice(series);

    expect(series.slices.map((s) => s.name)).toEqual(before);
  });
});

describe('a series that holds several dose objects (#257)', () => {
  const dose = (sopInstanceUid: string | null, more: Partial<DoseInfo> = {}): DoseInfo => ({
    units: 'GY',
    type: 'PHYSICAL',
    summationType: null,
    scaling: 1,
    sopInstanceUid,
    frameOffsets: 'relative',
    interpolatedPlanes: 0,
    ...more,
  });
  const planes = (of: DoseInfo, count = 2): Slice[] =>
    Array.from({ length: count }, () =>
      slice('1.2.3', { modality: 'RTDOSE', seriesDescription: 'Dose', dose: of }),
    );

  it('is one series to each object, the plan’s first and the rest by fraction group and beam', () => {
    const series = groupSeries([
      ...planes(dose('9.3', { summationType: 'BEAM', beams: [2], fractionGroup: 1 })),
      ...planes(dose('9.2', { summationType: 'BEAM', beams: [1], fractionGroup: 1 }), 3),
      ...planes(dose('9.4', { summationType: 'FRACTION', fractionGroup: 2 })),
      ...planes(dose('9.1', { summationType: 'PLAN' })),
    ]);
    expect(series.map((one) => [one.uid, one.description, one.imageCount])).toEqual([
      ['1.2.3@9.1', 'Dose (whole plan)', 2],
      ['1.2.3@9.2', 'Dose (beam 1)', 3],
      ['1.2.3@9.3', 'Dose (beam 2)', 2],
      ['1.2.3@9.4', 'Dose (fraction group 2)', 2],
    ]);
    // What each is the dose of is said by itself too, for where a line has no room for both.
    expect(series.map((one) => one.doseOf)).toEqual([
      'whole plan',
      'beam 1',
      'beam 2',
      'fraction group 2',
    ]);
    // Each holds its own object's planes and no other's.
    for (const one of series) {
      expect(new Set(one.slices.map((plane) => plane.dose?.sopInstanceUid)).size).toBe(1);
    }
  });

  it('tells doses that say the same of themselves, or nothing, apart by which of the series they are', () => {
    const series = groupSeries([
      ...planes(dose('9.2', { summationType: 'PLAN' })),
      ...planes(dose('9.1', { summationType: 'PLAN' })),
      ...planes(dose('9.3')),
    ]);
    expect(series.map((one) => one.description)).toEqual([
      'Dose (whole plan, dose 1 of 3)',
      'Dose (whole plan, dose 2 of 3)',
      'Dose (dose 3 of 3)',
    ]);
    expect(new Set(series.map((one) => one.uid)).size).toBe(3);
  });

  it('stays among the other series in the order of its series number', () => {
    const series = groupSeries([
      slice('7.7', { seriesNumber: 30 }),
      ...planes(dose('9.2', { summationType: 'BEAM', beams: [1] })).map((plane) => ({
        ...plane,
        seriesNumber: 20,
      })),
      ...planes(dose('9.1', { summationType: 'PLAN' })).map((plane) => ({
        ...plane,
        seriesNumber: 20,
      })),
      slice('1.1', { seriesNumber: 10 }),
    ]);
    expect(series.map((one) => one.uid)).toEqual(['1.1', '1.2.3@9.1', '1.2.3@9.2', '7.7']);
  });

  it('leaves whole a series of one dose object, and one whose objects cannot be told apart', () => {
    const one = dose('9.1');
    expect(groupSeries(planes(one)).map((series) => series.uid)).toEqual(['1.2.3']);
    expect(groupSeries(planes(one))[0]).not.toHaveProperty('doseOf');
    // Two objects with no UID, or with one UID: nothing to key them by.
    for (const pair of [
      [dose(null), dose(null)],
      [dose('9.1'), dose('9.1')],
    ]) {
      const series = groupSeries([...planes(pair[0]), ...planes(pair[1])]);
      expect(series.map((it) => [it.uid, it.description, it.imageCount])).toEqual([
        ['1.2.3', 'Dose', 4],
      ]);
    }
    // And a series that is not all dose.
    expect(
      groupSeries([...planes(dose('9.1')), ...planes(dose('9.2')), slice('1.2.3')]),
    ).toHaveLength(1);
  });

  it('orders and names dose objects the same way for a listing that has no slices', () => {
    const named = nameDoseObjects([
      { sopInstanceUid: '9.3', of: { summationType: 'BEAM', beams: [2], fractionGroup: 1 } },
      { sopInstanceUid: '9.4', of: null },
      { sopInstanceUid: '9.2', of: { summationType: 'BEAM', beams: [1], fractionGroup: 1 } },
      { sopInstanceUid: '9.1', of: { summationType: 'PLAN', beams: [], fractionGroup: null } },
    ]);
    expect(named.map((one) => [one.object.sopInstanceUid, one.said])).toEqual([
      ['9.1', 'whole plan'],
      ['9.4', 'dose 2 of 4'],
      ['9.2', 'beam 1'],
      ['9.3', 'beam 2'],
    ]);
    expect(doseObjectDescription('Plan A', 'beam 1')).toBe('Plan A (beam 1)');
    expect(doseObjectDescription(null, 'beam 1')).toBe('Dose (beam 1)');
  });

  it('keys a dose object by its series and itself, and gives the series back from the key', () => {
    const key = doseObjectSeriesKey('1.2.3', '9.1');
    expect(key).toBe('1.2.3@9.1');
    expect(seriesKeyParts(key)).toEqual({ seriesInstanceUid: '1.2.3', doseObjectUid: '9.1' });
    expect(seriesInstanceUidOf(key)).toBe('1.2.3');
    // Any other series' key is its UID.
    expect(seriesKeyParts('1.2.3')).toEqual({ seriesInstanceUid: '1.2.3', doseObjectUid: null });
    expect(seriesInstanceUidOf('')).toBe('');
  });
});
