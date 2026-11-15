/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only: two small doses over a small image, each a formula, and a
// patient's history that says what plan each dose names.

import {
  baseImageLayer,
  overlayImageLayer,
  type DoseInfo,
  type Layer,
  type PlanSummary,
  type Series,
  type Volume,
} from '@open-rt-studio/dicom';

import type { PatientHistory } from '../../data-source/data-source';
import { shift, testPlacement, testSeries, testVolume } from '../derived-series/testing';

export const DIMS: [number, number, number] = [6, 5, 4];
export const VOXELS = DIMS[0] * DIMS[1] * DIMS[2];

/** What a dose says of itself, unless a spec says otherwise. */
export function doseInfo(more: Partial<DoseInfo> = {}): DoseInfo {
  return {
    units: 'GY',
    type: 'PHYSICAL',
    summationType: 'PLAN',
    scaling: 1,
    sopInstanceUid: null,
    frameOffsets: 'relative',
    interpolatedPlanes: 0,
    ...more,
  };
}

/** A dose of `value` at each voxel, on a grid of {@link DIMS} voxels of 1 mm at `origin`. */
export function doseVolume(
  origin: [number, number, number],
  value: (i: number, j: number, k: number) => number,
  more: Partial<DoseInfo> = {},
): Volume {
  return { ...testVolume('RTDOSE', DIMS, origin, value), dose: doseInfo(more) };
}

/** The image: a CT of {@link DIMS} voxels of 1 mm at the origin. */
export const CT = testVolume('CT', DIMS, [0, 0, 0], () => -1000);

/** The first dose, on the image's own grid: 10 Gy and 1 Gy more with each column. */
export const firstGy = (i: number): number => 10 + i;
export const FIRST = doseVolume([0, 0, 0], (i) => firstGy(i));

/**
 * The second dose, in another frame of reference: 4 Gy and 1 Gy more with
 * each slice. Its registration puts its voxel (i, j, k) at the image's voxel
 * (i + 2, j, k), so it is known over the image from the third column on.
 */
export const secondGy = (k: number): number => 4 + k;
export const SECOND = doseVolume([100, 200, 300], (_i, _j, k) => secondGy(k));
export const PLACEMENT = testPlacement(shift(98, 200, 300), shift(-98, -200, -300));
/** The image's columns where the second dose is known. */
export const SECOND_FROM_COLUMN = 2;

export const baseCt = (): Layer => baseImageLayer('ct', CT);
export const firstLayer = (): Layer => overlayImageLayer('dose-1', FIRST);
export const secondLayer = (): Layer => overlayImageLayer('dose-2', SECOND, PLACEMENT);

export const SERIES: Record<string, Series> = {
  ct: testSeries('ct', { description: 'Planning CT' }),
  'dose-1': testSeries('dose-1', { description: 'First course', modality: 'RTDOSE' }),
  'dose-2': testSeries('dose-2', {
    description: 'Second course',
    modality: 'RTDOSE',
    studyUid: '1.2.3.11',
    studyDate: '20260316',
    frameOfReferenceUid: '1.2.3.60',
  }),
};

const plan = (label: string, fractions: number[]): PlanSummary => ({
  label,
  planName: null,
  date: null,
  intent: null,
  approvalStatus: null,
  fractions,
  fractionGroups: fractions.length,
  prescriptions: [],
});

/**
 * The patient as a timeline has them: the first dose with the CT by its
 * plan of 30 fractions; the second with its own CT, naming a plan of 5
 * fractions that belongs to no series and is listed with its study.
 */
export function history(): PatientHistory {
  return {
    key: 'p',
    patientId: 'SYN-0001',
    name: 'SYNTHETIC^PHANTOM',
    studies: [
      {
        studyUid: '1.2.3.10',
        date: '20260105',
        description: 'Planning',
        modalities: ['CT', 'RTDOSE'],
        series: [
          {
            uid: 'ct',
            seriesNumber: 1,
            description: 'Planning CT',
            modality: 'CT',
            frameOfReferenceUid: '1.2.3.50',
            imageCount: 4,
            structureSets: 0,
            attached: [
              {
                kind: 'plan',
                sopInstanceUid: 'plan-1',
                seriesUid: 'plan-series-1',
                description: 'Plan series',
                by: 'structure-set',
                plan: plan('First plan', [30]),
              },
              {
                kind: 'dose',
                sopInstanceUid: 'dose-object-1',
                seriesUid: 'dose-1',
                description: 'First course',
                by: 'plan',
                plans: ['plan-1'],
              },
            ],
          },
        ],
      },
      {
        studyUid: '1.2.3.11',
        date: '20260316',
        description: 'Second course',
        modalities: ['CT', 'RTDOSE'],
        series: [
          {
            uid: 'ct-2',
            seriesNumber: 1,
            description: 'Second CT',
            modality: 'CT',
            frameOfReferenceUid: '1.2.3.60',
            imageCount: 4,
            structureSets: 0,
            attached: [
              {
                kind: 'dose',
                sopInstanceUid: 'dose-object-2',
                seriesUid: 'dose-2',
                description: 'Second course',
                by: 'own-frame',
                plans: ['plan-2'],
              },
            ],
          },
        ],
        loose: [
          {
            kind: 'plan',
            sopInstanceUid: 'plan-2',
            seriesUid: 'plan-series-2',
            description: null,
            plan: plan('Second plan', [5]),
          },
        ],
      },
    ],
  };
}
