/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  buildVolume,
  parseFile,
  summedDoseVolume,
  type DoseSum,
  type LayerPlacement,
  type WrittenDose,
} from '@open-rt-studio/dicom';

import { shift, testPlacement } from '../derived-series/testing';
import {
  sourceOf,
  sumDerivationText,
  summedDoseFile,
  transformOf,
  writtenNotes,
  type SummedOf,
} from './dose-export';
import type { SumMade } from './dose-sum-model';
import { CT, DIMS, FIRST, PLACEMENT, SECOND, SERIES, VOXELS, doseVolume } from './testing';

const FIRST_OF: SummedOf = {
  volume: doseVolume([0, 0, 0], (i) => 10 + i, { sopInstanceUid: '1.2.3.101' }),
  placement: undefined,
  planUids: ['1.2.3.201'],
};
const SECOND_OF: SummedOf = {
  volume: doseVolume([100, 200, 300], (_i, _j, k) => 4 + k, { sopInstanceUid: '1.2.3.102' }),
  placement: PLACEMENT,
  planUids: ['1.2.3.202'],
};

const dose = (more: Partial<SumMade['doses'][number]> = {}): SumMade['doses'][number] => ({
  name: 'A dose',
  placedBy: '',
  weight: 1,
  fractions: null,
  beyond: 'unknown',
  unknown: 0,
  nothing: 0,
  ...more,
});

const PHYSICAL: SumMade = {
  made: { doses: 2, model: 'physical' },
  name: 'Summed dose',
  alphaBeta: null,
  doses: [dose(), dose()],
  voxels: VOXELS,
  known: VOXELS,
  withoutAlphaBeta: 0,
};

/** A sum of the value 7 Gy at every voxel of the image. */
function sumVolume(made: DoseSum['made']) {
  const sum: DoseSum = {
    data: new Float32Array(VOXELS).fill(7),
    known: new Uint8Array(VOXELS).fill(1),
    knownCount: VOXELS,
    terms: [],
    made,
    withoutAlphaBeta: 0,
  };
  return summedDoseVolume(sum, CT);
}

describe('transformOf', () => {
  const placed = (more: Partial<LayerPlacement>): LayerPlacement => ({ ...PLACEMENT, ...more });

  it('is none for a dose in the image’s own frame of reference', () => {
    expect(transformOf(undefined)).toBe('none');
  });

  it('is rigid for a matrix that only moves and turns', () => {
    expect(transformOf(PLACEMENT)).toBe('rigid');
  });

  it('is not rigid for a matrix that scales, or anything with a deformation field', () => {
    const scaled = [...shift(1, 2, 3)];
    scaled[0] = 1.1;
    expect(transformOf(placed({ baseToLayer: scaled as LayerPlacement['baseToLayer'] }))).toBe(
      'non-rigid',
    );
    expect(transformOf(placed({ field: {} as LayerPlacement['field'] }))).toBe('non-rigid');
    expect(transformOf(placed({ steps: [{ ...PLACEMENT.steps[0], deformable: true }] }))).toBe(
      'non-rigid',
    );
  });
});

describe('sourceOf', () => {
  it('names the dose, its plans and the registration objects it was taken through', () => {
    expect(sourceOf(FIRST_OF)).toEqual({
      sopInstanceUid: '1.2.3.101',
      planUids: ['1.2.3.201'],
      registrations: [],
      transform: 'none',
    });
    expect(sourceOf(SECOND_OF)).toEqual({
      sopInstanceUid: '1.2.3.102',
      planUids: ['1.2.3.202'],
      registrations: [{ sopClassUid: '1.2.840.10008.5.1.4.1.1.66.1', sopInstanceUid: '1.2.3.70' }],
      transform: 'rigid',
    });
  });

  it('names no object for a registration made by hand, and a deformable one by its class', () => {
    const [step] = PLACEMENT.steps;
    const byHand = { ...PLACEMENT, steps: [{ ...step, sopInstanceUid: '', byHand: true }] };
    expect(sourceOf({ ...SECOND_OF, placement: byHand })).toMatchObject({
      registrations: [],
      transform: 'rigid',
    });
    const bent = { ...PLACEMENT, steps: [{ ...step, deformable: true }] };
    expect(sourceOf({ ...SECOND_OF, placement: bent })).toMatchObject({
      registrations: [{ sopClassUid: '1.2.840.10008.5.1.4.1.1.66.3', sopInstanceUid: '1.2.3.70' }],
      transform: 'non-rigid',
    });
    // A dose that was itself made here has no object to name.
    expect(sourceOf({ ...FIRST_OF, volume: FIRST }).sopInstanceUid).toBeNull();
  });
});

describe('sumDerivationText', () => {
  it('says first that it is not for clinical use, then what the sum is, then each dose', () => {
    const text = sumDerivationText(PHYSICAL, [FIRST_OF, SECOND_OF], SERIES['ct']);
    expect(text).toBe(
      'Made with Open RT Studio, which is not a medical device. Not for clinical use. ' +
        'Sum of 2 physical doses, each as it is, on the grid of series ct. ' +
        'The sum is known at every voxel of that grid. ' +
        'Dose 1: object 1.2.3.101, weight 1, with no registration: the two series share a frame of reference. ' +
        'Dose 2: object 1.2.3.102, weight 1, through registration "MR to CT" (1.2.3.70, inverted).',
    );
  });

  it('says a converted sum’s model, α/β, fractions, and what was taken for no dose, in plain ASCII', () => {
    const said: SumMade = {
      made: { doses: 2, model: 'eqd', fractionGy: 2, alphaBetaGy: null },
      name: 'EQD2 (α/β by voxel)',
      alphaBeta: {
        defaults: [],
        structures: [
          { number: 1, name: 'PTV', alphaBetaGy: 10 },
          { number: 2, name: 'Cord', alphaBetaGy: 2 },
          { number: 3, name: 'Couch', alphaBetaGy: null },
        ],
        outsideGy: 3,
      },
      doses: [dose({ fractions: 30 }), dose({ fractions: 1, weight: 0.5, beyond: 'nothing' })],
      voxels: VOXELS,
      known: 80,
      withoutAlphaBeta: 0,
    };
    const text = sumDerivationText(said, [FIRST_OF, SECOND_OF], SERIES['ct']);
    expect(text).toMatch(/^[\x20-\x7e]+$/);
    expect(text).toContain(
      'EQD2 (alpha/beta by voxel): sum of 2 doses, each converted voxel by voxel by the linear-quadratic model, taken to be given in equal fractions, before it was added, on the grid of series ct.',
    );
    expect(text).toContain(
      'alpha/beta by structure, the first having a voxel two are in: PTV 10 Gy, Cord 2 Gy, 3 Gy outside them.',
    );
    expect(text).toContain(
      `The sum is known at 80 of the ${VOXELS} voxels of that grid; 0 is stored where it is not known, which is not a dose of zero.`,
    );
    expect(text).toContain('Dose 1: object 1.2.3.101, 30 fractions, weight 1,');
    expect(text).toContain('Dose 2: object 1.2.3.102, 1 fraction, weight 0.5,');
    expect(text.endsWith('taken for no dose beyond its grid.')).toBe(true);
    // No value outside the structures is said as none.
    expect(
      sumDerivationText(
        { ...said, alphaBeta: { ...said.alphaBeta!, outsideGy: null } },
        [FIRST_OF, SECOND_OF],
        SERIES['ct'],
      ),
    ).toContain('Cord 2 Gy, none outside them.');
  });
});

describe('summedDoseFile', () => {
  const FILED = { frameOfReferenceUid: '1.2.3.50', studyInstanceUid: '1.2.3.10' };
  const AT = new Date(2026, 10, 15, 9, 30, 5);

  it('writes the sum as a file named for what it is and when, filed under the image', () => {
    const { object, written } = summedDoseFile(
      sumVolume(PHYSICAL.made),
      PHYSICAL,
      [FIRST_OF, SECOND_OF],
      SERIES['ct'],
      FILED,
      AT,
    );
    expect(object.filename).toBe('summed-dose-20261115-093005.dcm');
    expect(object.mediaType).toBe('application/dicom');
    expect(object.bytes).toBe(written.bytes);
    expect(written).toMatchObject({
      dims: DIMS,
      summationType: 'MULTI_PLAN',
      plansNotNamed: 0,
      unknownCount: 0,
      seriesDescription: 'Summed dose: physical, 2 doses',
    });
    const slices = parseFile(object.filename, object.bytes);
    expect(slices[0]).toMatchObject({
      patientId: 'SYN-0001',
      patientName: 'SYNTHETIC^PHANTOM',
      studyUid: '1.2.3.10',
      studyDate: '20260105',
      frameOfReferenceUid: '1.2.3.50',
    });
    const read = buildVolume(slices);
    expect(read.dims).toEqual(DIMS);
    expect(read.min).toBeCloseTo(7, 5);
    expect(read.max).toBeCloseTo(7, 5);
  });

  it('refers to no dose that had no weight: it added nothing', () => {
    const said = { ...PHYSICAL, doses: [dose(), dose({ weight: 0 })] };
    const { written } = summedDoseFile(
      sumVolume({ doses: 1, model: 'physical' }),
      said,
      [FIRST_OF, { ...SECOND_OF, volume: SECOND }],
      SERIES['ct'],
      FILED,
      AT,
    );
    // One dose of one plan is a plan's dose.
    expect(written.summationType).toBe('PLAN');
  });
});

describe('writtenNotes', () => {
  const written = (more: Partial<WrittenDose>): WrittenDose =>
    ({ unknownCount: 0, plansNotNamed: 0, ...more }) as WrittenDose;

  it('has nothing to tell of a sum known throughout whose doses all name plans', () => {
    expect(writtenNotes(written({}))).toEqual([]);
  });

  it('tells that what is not known is written as 0, and of doses that name no plan', () => {
    expect(writtenNotes(written({ unknownCount: 3, plansNotNamed: 1 }))).toEqual([
      'Where the sum is not known the file holds 0, as an RT Dose must. Open RT Studio reads back which voxels those are; another program will read a dose of 0 there.',
      '1 dose names no plan, so the file lacks a reference to a plan that the standard asks for.',
    ]);
    expect(writtenNotes(written({ plansNotNamed: 2 }))[0]).toBe(
      '2 doses name no plan, so the file lacks a reference to a plan that the standard asks for.',
    );
  });
});

// The fixture's own claim, so that the tests above test what they say.
it('uses a placement that only moves', () => {
  expect(testPlacement(shift(1, 2, 3), shift(-1, -2, -3)).baseToLayer).toEqual(shift(1, 2, 3));
});
