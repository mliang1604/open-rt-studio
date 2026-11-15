/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DoseInfo, Layer, Volume } from '@open-rt-studio/dicom';
import type { VoxelProbe } from '@open-rt-studio/render';

import {
  doseLabel,
  dosePart,
  doseSaid,
  formatDose,
  formatFieldReading,
  formatProbe,
} from './viewer-format';

function volume(overrides: Partial<Volume> = {}): Volume {
  return {
    dims: [4, 4, 4],
    spacing: [1, 1, 1],
    data: new Float32Array(64),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: -1024,
    modality: 'CT',
    geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1], origin: [0, 0, 0] },
    ...overrides,
  };
}

const PROBE: VoxelProbe = {
  voxel: [33, 58, 32],
  value: -784,
  rawValue: 240,
  patient: [-91.52, 17.96, -0.04],
};

const DOSE: DoseInfo = {
  units: 'GY',
  type: 'PHYSICAL',
  summationType: 'PLAN',
  scaling: 0.1,
  sopInstanceUid: '1.2.3',
  frameOffsets: 'relative',
  interpolatedPlanes: 0,
};

describe('formatProbe', () => {
  it('gives the pane, the voxel, the patient position in mm, the value and the stored value', () => {
    expect(formatProbe('Axial', PROBE, volume())).toBe(
      'Axial · voxel (33, 58, 32) · LPS (-91.5, 18.0, 0.0) mm · value -784 HU · stored 240',
    );
  });

  it('writes a position that rounds to zero without a minus sign', () => {
    const text = formatProbe('Axial', { ...PROBE, patient: [-0.04, 0.04, -0.049] }, volume());
    expect(text).toContain('LPS (0.0, 0.0, 0.0) mm');
  });

  it('leaves the position out when the volume has no recorded geometry', () => {
    expect(formatProbe('Coronal', PROBE, volume({ geometry: undefined }))).toBe(
      'Coronal · voxel (33, 58, 32) · value -784 HU · stored 240',
    );
  });

  it('leaves the stored value out when it equals the value', () => {
    const text = formatProbe('Axial', PROBE, volume({ rescaleIntercept: 0 }));
    expect(text).toBe('Axial · voxel (33, 58, 32) · LPS (-91.5, 18.0, 0.0) mm · value -784 HU');
  });

  it('adds the other layers read at the same point, after the value', () => {
    const doseOf = (units: DoseInfo['units']): Layer =>
      ({ modality: 'RTDOSE', volume: { modality: 'RTDOSE', dose: { ...DOSE, units } } }) as Layer;
    const sample: VoxelProbe = {
      voxel: [1, 2, 3],
      value: 35.72,
      rawValue: 0,
      patient: PROBE.patient,
    };
    expect(formatProbe('Axial', PROBE, volume(), [{ layer: doseOf('GY'), sample }])).toBe(
      'Axial · voxel (33, 58, 32) · LPS (-91.5, 18.0, 0.0) mm · value -784 HU · stored 240 · Dose 35.72 Gy',
    );
    // A relative dose is a share of something the file does not name: it has no unit (#93).
    expect(formatProbe('Axial', PROBE, volume(), [{ layer: doseOf('RELATIVE'), sample }])).toBe(
      'Axial · voxel (33, 58, 32) · LPS (-91.5, 18.0, 0.0) mm · value -784 HU · stored 240 · Dose, relative 35.72',
    );
  });

  it('reads another image beside it by its modality, to a tenth', () => {
    const mr = { modality: 'MR', volume: { modality: 'MR' } } as Layer;
    const sample: VoxelProbe = {
      voxel: [1, 2, 3],
      value: 35.72,
      rawValue: 0,
      patient: PROBE.patient,
    };
    expect(formatProbe('Axial', PROBE, volume(), [{ layer: mr, sample }])).toMatch(/ · MR 35\.7$/);
  });

  it('shows a dose that is the image as a dose: by its type, to a hundredth of a gray, with no stored value', () => {
    const read = { ...PROBE, value: 2.4567 };
    // Its scaling is not 1, and yet no stored value is shown: between voxels there is none.
    const dose = volume({ modality: 'RTDOSE', rescaleSlope: 0.1, rescaleIntercept: 0, dose: DOSE });
    expect(formatProbe('Axial', read, dose)).toBe(
      'Axial · voxel (33, 58, 32) · LPS (-91.5, 18.0, 0.0) mm · Dose 2.46 Gy',
    );
    const relative = volume({
      modality: 'RTDOSE',
      rescaleSlope: 0.1,
      rescaleIntercept: 0,
      dose: { ...DOSE, units: 'RELATIVE', type: 'EFFECTIVE' },
    });
    expect(formatProbe('Axial', read, relative)).toMatch(/ · Effective dose, relative 2\.457$/);
  });
});

describe('a dose beside its value (#95)', () => {
  it('is called by its type, and relative when it is', () => {
    expect(doseLabel({ type: 'PHYSICAL', units: 'GY' })).toBe('Dose');
    expect(doseLabel({ type: 'EFFECTIVE', units: 'GY' })).toBe('Effective dose');
    expect(doseLabel({ type: 'ERROR', units: 'GY' })).toBe('Dose error');
    expect(doseLabel({ type: 'PHYSICAL', units: 'RELATIVE' })).toBe('Dose, relative');
    // One that is less than a whole plan's says what it is the dose of (#257).
    const beam = { type: 'PHYSICAL', units: 'GY', summationType: 'BEAM', beams: [2] } as const;
    expect(doseLabel({ ...beam, fractionGroup: 1 })).toBe('Dose (beam 2)');
    expect(doseLabel({ ...beam, units: 'RELATIVE' })).toBe('Dose (beam 2), relative');
    expect(doseLabel({ type: 'EFFECTIVE', units: 'GY', summationType: 'FRACTION' })).toBe(
      'Effective dose (one fraction group)',
    );
    // A whole plan's dose, and one that does not say, go by their type alone.
    expect(doseLabel({ type: 'PHYSICAL', units: 'GY', summationType: 'PLAN' })).toBe('Dose');
    expect(doseLabel({ type: 'PHYSICAL', units: 'GY', summationType: null })).toBe('Dose');
    expect(dosePart({ summationType: 'BEAM', beams: [] })).toBe('one or more beams');
    expect(dosePart({ summationType: 'PLAN' })).toBeNull();
    expect(
      dosePart({ summationType: 'BEAM', beams: [1], sum: { doses: 2, model: 'physical' } }),
    ).toBeNull();
  });

  it('is called by what it is a sum of, when it was made by summing (#98, #99)', () => {
    const made = { type: 'EFFECTIVE', units: 'GY' } as const;
    expect(
      doseLabel({ ...made, sum: { doses: 2, model: 'eqd', fractionGy: 2, alphaBetaGy: 3 } }),
    ).toBe('EQD2 (α/β 3 Gy)');
    expect(doseLabel({ ...made, sum: { doses: 3, model: 'bed', alphaBetaGy: null } })).toBe(
      'BED (α/β by voxel)',
    );
    expect(doseLabel({ type: 'PHYSICAL', units: 'GY', sum: { doses: 2, model: 'physical' } })).toBe(
      'Summed dose',
    );
  });

  it('is shown to a hundredth of a gray, or to four figures when it is relative', () => {
    expect(formatDose(35.7249, { units: 'GY' })).toBe('35.72 Gy');
    expect(formatDose(0, { units: 'GY' })).toBe('0.00 Gy');
    expect(formatDose(-0.126, { units: 'GY' })).toBe('-0.13 Gy');
    expect(formatDose(0.456789, { units: 'RELATIVE' })).toBe('0.4568');
    expect(formatDose(98.76543, { units: 'RELATIVE' })).toBe('98.77');
    expect(formatDose(100, { units: 'RELATIVE' })).toBe('100');
    // A sum that is not known at the place has no number there.
    expect(formatDose(Number.NaN, { units: 'GY' })).toBe('not known here');
  });
});

describe('what a dose says of itself, in a line (#93)', () => {
  it('names its units, its type and what it is summed over', () => {
    expect(doseSaid(DOSE)).toBe('RT Dose: in Gy, physical, summation type PLAN');
    expect(doseSaid({ ...DOSE, units: 'RELATIVE', type: 'EFFECTIVE', summationType: null })).toBe(
      'RT Dose: relative, with no unit, effective, of no summation type',
    );
  });

  it('says first that it was made here, and of what, when it was (#98, #99)', () => {
    const made = { ...DOSE, summationType: null, sopInstanceUid: null };
    expect(
      doseSaid({
        ...made,
        type: 'EFFECTIVE',
        sum: { doses: 2, model: 'eqd', fractionGy: 2, alphaBetaGy: 3 },
      }),
    ).toBe(
      'Dose made here by summing, not read from a file: EQD2 (α/β 3 Gy), sum of 2 doses, each converted before it was added. In Gy, effective.',
    );
    expect(doseSaid({ ...made, sum: { doses: 3, model: 'physical' } })).toBe(
      'Dose made here by summing, not read from a file: Physical dose, sum of 3 doses. In Gy, physical.',
    );
  });

  it('says so when planes were laid between its frames', () => {
    expect(doseSaid({ ...DOSE, interpolatedPlanes: 1 })).toBe(
      'RT Dose: in Gy, physical, summation type PLAN. Its frames are spaced unevenly: 1 plane was laid between them by interpolation.',
    );
    expect(doseSaid({ ...DOSE, interpolatedPlanes: 3 })).toContain(
      '3 planes were laid between them',
    );
  });
});

describe('what a field’s wash stands for under the cursor', () => {
  it('is how far the field moves the place, in mm', () => {
    expect(formatFieldReading({ kind: 'displacement', mm: 5.0990195 })).toBe('field moves 5.10 mm');
    expect(formatFieldReading({ kind: 'displacement', mm: 0 })).toBe('field moves 0.00 mm');
  });

  it('is the Jacobian determinant, and says in words that the field folds', () => {
    expect(formatFieldReading({ kind: 'jacobian', determinant: 0.874 })).toBe(
      'Jacobian determinant 0.87',
    );
    expect(formatFieldReading({ kind: 'jacobian', determinant: -0.2 })).toBe(
      'Jacobian determinant -0.20 (the field folds here)',
    );
    expect(formatFieldReading({ kind: 'jacobian', determinant: 0 })).toBe(
      'Jacobian determinant 0.00 (the field folds here)',
    );
  });

  it('comes last in the probe’s line, and is left out without one', () => {
    const with_ = formatProbe('Axial', PROBE, volume(), [], { kind: 'displacement', mm: 2.5 });
    expect(with_).toBe(`${formatProbe('Axial', PROBE, volume())} · field moves 2.50 mm`);
    expect(formatProbe('Axial', PROBE, volume(), [], null)).toBe(
      formatProbe('Axial', PROBE, volume()),
    );
  });
});
