/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  createLabelVolume,
  labelIndex,
  paintLabels,
  parseStructureSet,
  rasterizeRoiContours,
  structureSetsForSeries,
  type LabelVolume,
  type Series,
  type Volume,
} from '@open-rt-studio/dicom';
import dicomParser from 'dicom-parser';

import { authoredSetRtStruct, EXPORT_DESCRIPTION } from './structure-set-export';

const DIMS = [24, 20, 8] as const;

function volume(): Volume {
  return {
    dims: DIMS,
    spacing: [1.5, 1.5, 3],
    data: new Float32Array(DIMS[0] * DIMS[1] * DIMS[2]),
    min: 0,
    max: 1,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry: {
      origin: [-10, 5, 40],
      iStep: [1.5, 0, 0],
      jStep: [0, 1.5, 0],
      kStep: [0, 0, 3],
    },
  };
}

const SERIES = {
  uid: '2.25.300',
  frameOfReferenceUid: '2.25.200',
  studyUid: '2.25.100',
  studyDate: '20260105',
  studyTime: '093000',
  studyDescription: 'Synthetic planning study',
  patientId: 'SYN-0001',
  patientName: 'SYNTHETIC^PHANTOM',
  modality: 'CT',
} as Series;

const NOW = new Date(2026, 10, 12, 21, 30, 5);

/** Paint a filled disc of the given radius (in voxels) on one slice. */
function paintDisc(
  label: LabelVolume,
  id: number,
  cx: number,
  cy: number,
  z: number,
  r: number,
): void {
  const voxels: number[] = [];
  for (let y = 0; y < DIMS[1]; y++) {
    for (let x = 0; x < DIMS[0]; x++) {
      if (Math.hypot(x - cx, y - cy) <= r) voxels.push(labelIndex(DIMS, x, y, z));
    }
  }
  paintLabels(label, id, voxels);
}

/** Two structures: a disc on three slices, and a ring (a disc with a hole) on one. */
function painted(): LabelVolume {
  const label = createLabelVolume(volume());
  for (const z of [2, 3, 4]) paintDisc(label, 1, 8, 9, z, 4);
  paintDisc(label, 2, 16, 10, 5, 5);
  paintDisc(label, 0, 16, 10, 5, 2); // erase the middle: id 0 is "no structure"
  return label;
}

const SET = {
  label: 'My contours',
  rois: [
    { id: 1, name: 'Target', color: [255, 0, 0] as const, interpretedType: 'GTV' },
    { id: 2, name: 'Ring', color: [0, 255, 0] as const, interpretedType: null },
  ],
};

describe('authoredSetRtStruct', () => {
  it('reimports with the same shape, voxel for voxel', () => {
    const label = painted();
    const { bytes, filename } = authoredSetRtStruct(label, SET, SERIES, NOW);
    const structureSet = parseStructureSet(filename, bytes)!;
    expect(structureSet.rois.map((r) => r.name)).toEqual(['Target', 'Ring']);

    // Fill the reimported contours into an empty grid of the same geometry.
    const reimported = createLabelVolume(volume());
    for (const roi of structureSet.rois) rasterizeRoiContours(reimported, roi, roi.number);

    expect(Array.from(reimported.data)).toEqual(Array.from(label.data));
    // Sanity: the grid is not trivially empty, and the ring kept its hole.
    expect(label.data.filter((v) => v === 1).length).toBeGreaterThan(100);
    expect(reimported.data[labelIndex(DIMS, 16, 10, 5)]).toBe(0);
    expect(reimported.data[labelIndex(DIMS, 20, 10, 5)]).toBe(2);
  });

  it('writes contours in patient millimetres on the slices that were painted', () => {
    const { bytes, filename } = authoredSetRtStruct(painted(), SET, SERIES, NOW);
    const target = parseStructureSet(filename, bytes)!.rois[0];
    // Slices 2, 3 and 4 of a grid that starts at z = 40 with 3 mm spacing.
    expect(target.contours.map((c) => c.points[0][2]).sort()).toEqual([46, 49, 52]);
    // The disc is centred on voxel (8, 9): x = -10 + 8 * 1.5, y = 5 + 9 * 1.5.
    const xs = target.contours[0].points.map((p) => p[0]);
    const ys = target.contours[0].points.map((p) => p[1]);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(2, 5);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(18.5, 5);
  });

  it('ties the object to the images it was drawn on', () => {
    const { bytes, filename } = authoredSetRtStruct(painted(), SET, SERIES, NOW);
    const structureSet = parseStructureSet(filename, bytes)!;
    expect(structureSet.frameOfReferenceUid).toBe(SERIES.frameOfReferenceUid);
    expect(structureSet.referencedSeriesUids).toEqual([SERIES.uid]);
    expect(structureSetsForSeries([structureSet], SERIES)).toHaveLength(1);

    const dataSet = dicomParser.parseDicom(new Uint8Array(bytes));
    expect(dataSet.string('x00100020')).toBe('SYN-0001');
    expect(dataSet.string('x00100010')).toBe('SYNTHETIC^PHANTOM');
    expect(dataSet.string('x0020000d')).toBe(SERIES.studyUid);
    expect(dataSet.string('x00080020')).toBe('20260105');
    expect(dataSet.string('x0008103e')).toBe('My contours');
  });

  it('marks the object as not for clinical use', () => {
    const { bytes } = authoredSetRtStruct(painted(), SET, SERIES, NOW);
    const dataSet = dicomParser.parseDicom(new Uint8Array(bytes));
    expect(dataSet.string('x30060006')).toBe(EXPORT_DESCRIPTION);
    expect(EXPORT_DESCRIPTION).toContain('Not for clinical use');
    expect(dataSet.string('x00080070')).toBe('Open RT Studio');
  });

  it('names the file after the set and the time, and keeps the label within 16 characters', () => {
    const long = { ...SET, label: 'Head and neck boost volumes v2' };
    const { bytes, filename } = authoredSetRtStruct(painted(), long, SERIES, NOW);
    expect(filename).toBe('rtstruct-head-and-neck-boost-volumes-v2-20261112-213005.dcm');
    expect(parseStructureSet(filename, bytes)!.label).toBe('Head and neck bo');
    expect(authoredSetRtStruct(painted(), { ...SET, label: '  ' }, SERIES, NOW).filename).toBe(
      'rtstruct-structures-20261112-213005.dcm',
    );
  });

  it('exports without references when nothing identifies the images', () => {
    const { bytes, filename } = authoredSetRtStruct(painted(), SET, null, NOW);
    const structureSet = parseStructureSet(filename, bytes)!;
    expect(structureSet.frameOfReferenceUid).toBeNull();
    expect(structureSet.referencedSeriesUids).toEqual([]);
    expect(structureSet.rois).toHaveLength(2);
    expect(dicomParser.parseDicom(new Uint8Array(bytes)).elements['x00100020']).toBeUndefined();
  });

  it('keeps a structure that has no voxels yet, with no contours', () => {
    const label = createLabelVolume(volume());
    const { bytes, filename } = authoredSetRtStruct(label, SET, SERIES, NOW);
    const structureSet = parseStructureSet(filename, bytes)!;
    expect(structureSet.rois.map((r) => r.contours.length)).toEqual([0, 0]);
  });
});
