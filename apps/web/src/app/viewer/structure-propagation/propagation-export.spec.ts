/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  parseStructureSet,
  type PropagatedRoi,
  type Roi,
  type StructureSet,
} from '@open-rt-studio/dicom';

import { DERIVED_NOTICE } from '../derived-series/derived-export';
import { shift, testPlacement, testSeries } from '../derived-series/testing';
import {
  METHOD_TEXT,
  PROPAGATED_LABEL,
  propagatedDescription,
  propagatedFile,
  propagatedSet,
  propagationSummary,
  propagationText,
  setName,
  type PropagationFacts,
} from './propagation-export';

const roi = (number: number, name: string, contours = 1): Roi => ({
  number,
  name,
  color: [255, 0, 0],
  interpretedType: 'ORGAN',
  contours: Array.from({ length: contours }, (_, at) => ({
    geometricType: 'CLOSED_PLANAR',
    points: [
      [0, 0, at],
      [10, 0, at],
      [10, 10, at],
    ],
  })),
});
const result = (
  one: Roi,
  method: PropagatedRoi['method'],
  more: Partial<PropagatedRoi> = {},
): PropagatedRoi => ({
  roi: one,
  method,
  sourceContours: one.contours.length,
  leftOut: 0,
  sourceVolumeMm3: null,
  volumeMm3: null,
  ...more,
});

const SET: StructureSet = {
  name: 'rt.dcm',
  label: 'Plan A',
  frameOfReferenceUid: '1.2.3.60',
  referencedSeriesUids: ['1.2.3.30'],
  patientId: 'SYN-0001',
  sopInstanceUid: '1.2.3.80',
  rois: [roi(1, 'Heart', 2), roi(2, 'Cord')],
};
const BASE = testSeries('1.2.3.20', { description: 'Planning CT' });
const SOURCE = testSeries('1.2.3.30', { description: 'T2', modality: 'MR' });
const FACTS: PropagationFacts = {
  set: SET,
  source: SOURCE,
  base: BASE,
  placement: testPlacement(shift(2, 0, 0), shift(-2, 0, 0)),
  results: [result(SET.rois[0], 'points'), result(SET.rois[1], 'label-volume')],
};
const NOW = new Date(2026, 10, 14, 9, 5, 7);

describe('what a propagated structure set is called', () => {
  it('says first that it is propagated, then what onto what', () => {
    expect(propagatedDescription(SET, BASE)).toBe('Propagated: Plan A onto Planning CT');
    expect(setName({ ...SET, label: '  ' })).toBe('unlabelled');
    expect(propagatedDescription({ ...SET, label: null }, BASE)).toBe(
      'Propagated: unlabelled onto Planning CT',
    );
  });
});

describe('how a structure set was propagated, in words', () => {
  it('names the set, the two series, the registration and how many went each way', () => {
    expect(propagationText(FACTS)).toBe(
      `${DERIVED_NOTICE} Structures of structure set "Plan A" (1.2.3.80) on series 1.2.3.30 ` +
        'taken to series 1.2.3.20 through registration "MR to CT" (1.2.3.70, inverted). ' +
        '1 by moving their points, 1 by a label volume resampled and outlined.',
    );
  });

  it('says so when no registration was needed, and names no object for a set that is in none', () => {
    const text = propagationText({
      ...FACTS,
      placement: null,
      set: { ...SET, sopInstanceUid: null },
    });
    expect(text).toContain('structure set "Plan A" on series 1.2.3.30');
    expect(text).toContain(
      'with no registration: the two series share a frame of reference. 1 by moving',
    );
  });
});

describe('propagated structures as a structure set on the base image', () => {
  it('is in the base’s frame, on its series, with each structure saying how it was taken', () => {
    const set = propagatedSet(FACTS, '1.2.3.50');
    expect(set.label).toBe(PROPAGATED_LABEL);
    expect(set.frameOfReferenceUid).toBe('1.2.3.50');
    expect(set.referencedSeriesUids).toEqual(['1.2.3.20']);
    expect(set.patientId).toBe('SYN-0001');
    expect(set.rois.map((one) => [one.number, one.name, one.generation])).toEqual([
      [1, 'Heart', { algorithm: 'AUTOMATIC', description: METHOD_TEXT.points, resampled: true }],
      [
        2,
        'Cord',
        { algorithm: 'AUTOMATIC', description: METHOD_TEXT['label-volume'], resampled: true },
      ],
    ]);
    // What a structure looks like and is goes with it.
    expect(set.rois[0]).toMatchObject({ color: [255, 0, 0], interpretedType: 'ORGAN' });
    // What is said of a way fits where it is written (64 characters).
    for (const text of Object.values(METHOD_TEXT)) expect(text.length).toBeLessThanOrEqual(64);
  });
});

describe('a propagated structure set as a file', () => {
  const filed = { frameOfReferenceUid: '1.2.3.50', studyInstanceUid: '1.2.3.10' };
  const file = propagatedFile(FACTS, filed, NOW);
  const read = parseStructureSet(file.filename, file.bytes)!;

  it('is named for what it is and when, and nothing of the patient', () => {
    expect(file.filename).toBe('propagated-structures-20261114-090507.dcm');
    expect(file.description).toBe('Propagated: Plan A onto Planning CT');
  });

  it('reads back as the structures on the base image, of its patient, each saying how it got there', () => {
    expect(read.label).toBe('PROPAGATED');
    expect(read.frameOfReferenceUid).toBe('1.2.3.50');
    expect(read.referencedSeriesUids).toEqual(['1.2.3.20']);
    expect(read.patientId).toBe('SYN-0001');
    expect(read.sopInstanceUid).not.toBe('1.2.3.80');
    expect(read.rois.map((one) => one.name)).toEqual(['Heart', 'Cord']);
    expect(read.rois[0].contours).toEqual(SET.rois[0].contours);
    expect(read.rois.map((one) => one.generation?.description)).toEqual([
      METHOD_TEXT.points,
      METHOD_TEXT['label-volume'],
    ]);
    expect(read.rois.every((one) => one.generation?.resampled)).toBe(true);
  });

  it('writes its own words in plain characters, however the set was labelled', () => {
    const odd = propagatedFile({ ...FACTS, set: { ...SET, label: 'Pläne → A' } }, filed, NOW);
    // Told as it is; written without what a file may not hold undeclared.
    expect(odd.description).toBe('Propagated: Pläne → A onto Planning CT');
    expect(parseStructureSet('x.dcm', odd.bytes)).not.toBeNull();
    const text = new TextDecoder('latin1').decode(odd.bytes);
    expect(text).toContain('Propagated: Pl?ne ? A onto Planning CT');
    expect(text).toContain('Structures of structure set "Pl?ne ? A"');
  });
});

describe('what was made, in words', () => {
  it('says how many structures went each way', () => {
    expect(propagationSummary(SET, FACTS.results)).toBe(
      'Propagated, not saved: 2 structures of “Plan A” onto the base image’s slices. 1 by moving its points, 1 by a label volume.',
    );
    expect(
      propagationSummary(SET, [result(SET.rois[0], 'points'), result(SET.rois[1], 'points')]),
    ).toBe(
      'Propagated, not saved: 2 structures of “Plan A” onto the base image’s slices. 2 by moving their points.',
    );
    expect(propagationSummary(SET, [result(SET.rois[1], 'label-volume')])).toBe(
      'Propagated, not saved: 1 structure of “Plan A” onto the base image’s slices. 1 by a label volume.',
    );
  });

  it('names a structure that has no contour on the base image, and counts contours left out', () => {
    const gone = result({ ...SET.rois[1], contours: [] }, 'label-volume', { sourceContours: 4 });
    const cut = result(SET.rois[0], 'points', { sourceContours: 5, leftOut: 3 });
    expect(propagationSummary(SET, [cut, gone])).toBe(
      'Propagated, not saved: 2 structures of “Plan A” onto the base image’s slices. 1 by moving its points, 1 by a label volume. ' +
        '“Cord” has no contour on this image. ' +
        '3 contours were left out: beyond the image’s slices, or open and so around nothing.',
    );
    // A structure that had no contour to begin with has lost none.
    const empty = result({ ...SET.rois[1], contours: [] }, 'points', { sourceContours: 0 });
    expect(propagationSummary(SET, [empty])).not.toContain('has no contour');
    expect(propagationSummary(SET, [{ ...cut, leftOut: 1 }])).toContain('1 contour was left out');
  });
});
