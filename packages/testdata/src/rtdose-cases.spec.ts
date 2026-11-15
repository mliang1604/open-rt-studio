/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  buildVolume,
  groupSeries,
  parseFile,
  UnsupportedDicomError,
  valueUnit,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';
import { describe, expect, it } from 'vitest';

import { SYNTHETIC_STUDY } from './identity.js';
import {
  SYNTHETIC_DOSE_GRID_SCALING,
  syntheticDoseCases,
  syntheticDoseGy,
  writeRtDose,
  type SyntheticDoseCase,
} from './rtdose.js';

// Each way a dose may be written reads to the values of its formula at the
// places its formula puts them (#93). The place is asked of the volume's
// own geometry, so that a dose read onto the wrong grid is found out.

const read = (one: SyntheticDoseCase): Volume =>
  buildVolume(parseFile(one.file.name, one.file.bytes.slice().buffer));

/** The voxel of a volume a patient point lies at, as fractions of its steps. */
function indexOf(volume: Volume, point: Vec3): Vec3 {
  const { origin, iStep, jStep, kStep } = volume.geometry!;
  const from = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
  const along = (step: Vec3): number =>
    (from[0] * step[0] + from[1] * step[1] + from[2] * step[2]) /
    (step[0] ** 2 + step[1] ** 2 + step[2] ** 2);
  return [along(iStep), along(jStep), along(kStep)];
}

describe('synthetic doses, each written another way', () => {
  const cases = syntheticDoseCases();

  it('are of every way the reader takes', () => {
    expect(cases.map((one) => one.name)).toEqual([
      'evenly spaced',
      'going down',
      'positions along z',
      'unevenly spaced',
      'coronal',
      'relative',
      'of a beam',
      'of one frame',
    ]);
  });

  for (const one of cases) {
    it(`${one.name}: reads to its formula's values at its formula's places`, () => {
      const volume = read(one);
      expect(volume.modality).toBe('RTDOSE');
      expect(volume.dims).toEqual([one.columns, one.rows, one.planes]);
      expect(volume.spacing).toEqual([2, 2, one.planeSpacing]);
      expect(volume.missingSlices).toBeUndefined();
      expect(volume.dose).toMatchObject({
        units: one.units,
        type: 'PHYSICAL',
        summationType: one.summationType,
        scaling: SYNTHETIC_DOSE_GRID_SCALING,
        interpolatedPlanes: one.planes - one.frames,
      });
      expect(valueUnit(volume)).toBe(one.units === 'GY' ? 'Gy' : null);
      const [columns, rows] = volume.dims;
      let checked = 0;
      for (let frame = 0; frame < one.frames; frame++) {
        for (let row = 0; row < one.rows; row++) {
          for (let column = 0; column < one.columns; column++) {
            const [i, j, k] = indexOf(volume, one.pointOf(column, row, frame));
            // Every stored voxel lies on a voxel of the grid it was read onto.
            for (const part of [i, j, k])
              expect(Math.abs(part - Math.round(part))).toBeLessThan(1e-6);
            const at = (Math.round(k) * rows + Math.round(j)) * columns + Math.round(i);
            expect(volume.data[at]).toBeCloseTo(syntheticDoseGy(column, row, frame), 5);
            checked += 1;
          }
        }
      }
      expect(checked).toBe(one.frames * one.rows * one.columns);
    });
  }

  it('unevenly spaced: what is between two frames is the straight line between them', () => {
    const one = cases.find((each) => each.name === 'unevenly spaced')!;
    const volume = read(one);
    const [columns, rows] = volume.dims;
    // Frames 1 and 2 lie 5 mm apart on a grid of 2.5 mm: one plane lies halfway.
    const [i, j, k] = indexOf(volume, one.pointOf(3, 2, 1)).map(Math.round);
    const between = volume.data[((k + 1) * rows + j) * columns + i];
    expect(between).toBeCloseTo((syntheticDoseGy(3, 2, 1) + syntheticDoseGy(3, 2, 2)) / 2, 5);
    // Frames 3 and 4 lie 7.5 mm apart: two planes, a third and two thirds of the way.
    const [, , k3] = indexOf(volume, one.pointOf(3, 2, 3)).map(Math.round);
    const third = volume.data[((k3 + 1) * rows + j) * columns + i];
    expect(third).toBeCloseTo(
      syntheticDoseGy(3, 2, 3) + (syntheticDoseGy(3, 2, 4) - syntheticDoseGy(3, 2, 3)) / 3,
      5,
    );
  });

  it('going down: the lowest plane of the grid is the last frame', () => {
    const one = cases.find((each) => each.name === 'going down')!;
    const volume = read(one);
    expect(volume.geometry!.origin).toEqual([4, 4, -27.5]);
    expect(volume.data[0]).toBeCloseTo(syntheticDoseGy(0, 0, one.frames - 1), 5);
  });
});

describe('synthetic doses that are not to be read', () => {
  const written = (more: Partial<Parameters<typeof writeRtDose>[0]>) =>
    writeRtDose({
      study: SYNTHETIC_STUDY,
      fileName: 'refused.dcm',
      rows: 4,
      columns: 4,
      frames: 3,
      origin: [0, 0, 0],
      pixelSpacing: 2,
      frameSpacing: 2.5,
      scaling: SYNTHETIC_DOSE_GRID_SCALING,
      stored: (column, row, frame) => column + row + frame,
      ...more,
    });
  const reasonOf = (file: { name: string; bytes: Uint8Array }): string => {
    try {
      parseFile(file.name, file.bytes.slice().buffer);
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedDicomError);
      return (error as UnsupportedDicomError).reason;
    }
    return 'read';
  };

  it('say what is wrong: frames on no even grid, no offsets, offsets from somewhere else', () => {
    expect(reasonOf(written({ frameOffsets: [0, 2, 5] }))).toBe(
      'RT Dose not read. Its frames are spaced unevenly, and not by multiples of their closest spacing, so they lie on no even grid',
    );
    expect(reasonOf(written({ frameOffsets: null }))).toBe(
      'RT Dose not read. It has 3 frames and no Grid Frame Offset Vector to say where they lie',
    );
    expect(reasonOf(written({ frameOffsets: [50, 52.5, 55] }))).toBe(
      'RT Dose not read. Its Grid Frame Offset Vector begins neither at zero nor at the z of Image Position (Patient), so its frames cannot be placed',
    );
    expect(reasonOf(written({}))).toBe('read');
  });

  it('are several objects in one series, which are not shown as one grid', () => {
    const beams = [1, 2, 3].map((instance) =>
      written({ instance, summationType: 'BEAM', fileName: `beam-${instance}.dcm` }),
    );
    const slices = beams.flatMap((file) => parseFile(file.name, file.bytes.slice().buffer));
    expect(new Set(slices.map((slice) => slice.seriesUid)).size).toBe(1);
    expect(() => buildVolume(slices)).toThrow('The series holds 3 dose grids');
    // One of them alone is read.
    expect(buildVolume(slices.slice(0, 3)).dims).toEqual([4, 4, 3]);
    // And so each is given as a dose of its own (#257). They name no beam, so
    // they are told apart by which of the series they are.
    const series = groupSeries(slices);
    expect(series.map((one) => one.description)).toEqual([
      'Synthetic dose (one or more beams, dose 1 of 3)',
      'Synthetic dose (one or more beams, dose 2 of 3)',
      'Synthetic dose (one or more beams, dose 3 of 3)',
    ]);
    for (const one of series) expect(buildVolume(one.slices).dims).toEqual([4, 4, 3]);
  });
});
