/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import dicomParser from 'dicom-parser';

import { parseStructureSet } from './structure-set.js';
import { writeStructureSet } from './structure-set-writer.js';
import type { StructureSet } from './types.js';

/** A structure set covering colour, interpreted type, multiple contours and references. */
function sampleStructureSet(): StructureSet {
  return {
    name: 'authored.dcm',
    label: 'Plan A',
    frameOfReferenceUid: '1.2.840.FOR',
    referencedSeriesUids: ['1.2.840.SERIES.A', '1.2.840.SERIES.B'],
    rois: [
      {
        number: 1,
        name: 'Heart',
        color: [255, 0, 0],
        interpretedType: 'ORGAN',
        contours: [
          {
            geometricType: 'CLOSED_PLANAR',
            points: [
              [0, 0, 5],
              [10, 0, 5],
              [10, 10, 5],
              [0, 10, 5],
            ],
          },
          {
            geometricType: 'CLOSED_PLANAR',
            points: [
              [0, 0, 7.5],
              [10, 0, 7.5],
              [10, 10, 7.5],
            ],
          },
        ],
      },
      {
        number: 2,
        name: 'PTV',
        color: [0, 255, 0],
        interpretedType: null,
        contours: [
          {
            geometricType: 'CLOSED_PLANAR',
            points: [
              [-1.25, 2.5, -3.5],
              [4.75, 2.5, -3.5],
              [4.75, 8.5, -3.5],
            ],
          },
        ],
      },
    ],
  };
}

describe('writeStructureSet', () => {
  it('round-trips through parseStructureSet', () => {
    const original = sampleStructureSet();
    const parsed = parseStructureSet('rt.dcm', writeStructureSet(original));

    expect(parsed).not.toBeNull();
    expect(parsed!.label).toBe('Plan A');
    expect(parsed!.frameOfReferenceUid).toBe('1.2.840.FOR');
    expect(parsed!.referencedSeriesUids).toEqual(['1.2.840.SERIES.A', '1.2.840.SERIES.B']);
    expect(parsed!.rois).toHaveLength(2);

    const [heart, ptv] = parsed!.rois;
    expect(heart.number).toBe(1);
    expect(heart.name).toBe('Heart');
    expect(heart.color).toEqual([255, 0, 0]);
    expect(heart.interpretedType).toBe('ORGAN');
    expect(heart.contours).toHaveLength(2);
    expect(heart.contours[0].geometricType).toBe('CLOSED_PLANAR');
    expect(heart.contours[0].points).toEqual(original.rois[0].contours[0].points);
    expect(heart.contours[1].points).toEqual(original.rois[0].contours[1].points);

    expect(ptv.number).toBe(2);
    expect(ptv.name).toBe('PTV');
    expect(ptv.color).toEqual([0, 255, 0]);
    expect(ptv.interpretedType).toBeNull();
    expect(ptv.contours[0].points).toEqual(original.rois[1].contours[0].points);
  });

  it('joins contour and observation sequences back to the right ROI by number', () => {
    const parsed = parseStructureSet('rt.dcm', writeStructureSet(sampleStructureSet()))!;
    expect(parsed.rois.map((r) => [r.name, r.color])).toEqual([
      ['Heart', [255, 0, 0]],
      ['PTV', [0, 255, 0]],
    ]);
  });

  it('preserves fractional millimetre coordinates', () => {
    const ss: StructureSet = {
      name: 'frac.dcm',
      label: null,
      frameOfReferenceUid: '1.2.3',
      referencedSeriesUids: [],
      rois: [
        {
          number: 1,
          name: 'R',
          color: [1, 2, 3],
          interpretedType: null,
          contours: [
            {
              geometricType: 'CLOSED_PLANAR',
              points: [
                [-12.34, 56.78, -9.5],
                [0.125, -0.25, 0.5],
              ],
            },
          ],
        },
      ],
    };
    const parsed = parseStructureSet('rt.dcm', writeStructureSet(ss))!;
    expect(parsed.rois[0].contours[0].points).toEqual([
      [-12.34, 56.78, -9.5],
      [0.125, -0.25, 0.5],
    ]);
  });

  it('emits a frame of reference even without a top-level reference sequence', () => {
    // No referenced series: the frame still round-trips via the ROI's 3006,0024.
    const ss: StructureSet = {
      name: 'foronly.dcm',
      label: null,
      frameOfReferenceUid: '9.9.9',
      referencedSeriesUids: [],
      rois: [{ number: 1, name: 'A', color: [9, 9, 9], interpretedType: null, contours: [] }],
    };
    const parsed = parseStructureSet('rt.dcm', writeStructureSet(ss))!;
    expect(parsed.frameOfReferenceUid).toBe('9.9.9');
  });

  it('writes a recognisable RTSTRUCT with no references at all', () => {
    const ss: StructureSet = {
      name: 'bare.dcm',
      label: null,
      frameOfReferenceUid: null,
      referencedSeriesUids: [],
      rois: [{ number: 1, name: 'A', color: [1, 1, 1], interpretedType: null, contours: [] }],
    };
    const parsed = parseStructureSet('rt.dcm', writeStructureSet(ss));
    expect(parsed).not.toBeNull();
    expect(parsed!.frameOfReferenceUid).toBeNull();
    expect(parsed!.rois.map((r) => r.name)).toEqual(['A']);
  });

  describe('identity of the new object', () => {
    const read = (buffer: ArrayBuffer) => dicomParser.parseDicom(new Uint8Array(buffer));

    it('writes the patient and study it is given', () => {
      const dataSet = read(
        writeStructureSet(sampleStructureSet(), {
          patientName: 'SYNTHETIC^PHANTOM',
          patientId: 'SYN-0001',
          studyInstanceUid: '2.25.1234',
          studyDate: '20260105',
          studyTime: '093000',
          studyDescription: 'Synthetic planning study',
          seriesDescription: 'Authored structures',
          description: 'Not for clinical use.',
          seriesInstanceUid: '2.25.5678',
          createdAt: new Date(2026, 10, 12, 21, 5, 9),
        }),
      );
      expect(dataSet.string('x00100010')).toBe('SYNTHETIC^PHANTOM');
      expect(dataSet.string('x00100020')).toBe('SYN-0001');
      expect(dataSet.string('x0020000d')).toBe('2.25.1234');
      expect(dataSet.string('x0020000e')).toBe('2.25.5678');
      expect(dataSet.string('x00080020')).toBe('20260105');
      expect(dataSet.string('x00080030')).toBe('093000');
      expect(dataSet.string('x00081030')).toBe('Synthetic planning study');
      expect(dataSet.string('x0008103e')).toBe('Authored structures');
      expect(dataSet.string('x30060006')).toBe('Not for clinical use.');
      expect(dataSet.string('x30060008')).toBe('20261112');
      expect(dataSet.string('x30060009')).toBe('210509');
      expect(dataSet.string('x00080070')).toBe('Open RT Studio');
    });

    it('leaves out what it is not given, and still gives the object its own series', () => {
      const dataSet = read(writeStructureSet(sampleStructureSet()));
      for (const tag of ['x00100010', 'x00100020', 'x0020000d', 'x00080020', 'x30060006']) {
        expect(dataSet.elements[tag], tag).toBeUndefined();
      }
      expect(dataSet.string('x0020000e')).toMatch(/^2\.25\.\d+$/);
      expect(dataSet.string('x30060008')).toMatch(/^\d{8}$/);
    });

    it('keeps the data set in ascending tag order', () => {
      const dataSet = read(
        writeStructureSet(sampleStructureSet(), {
          patientName: 'A^B',
          patientId: '1',
          studyInstanceUid: '2.25.1',
          studyDate: '20260105',
          description: 'x',
        }),
      );
      const offsets = Object.keys(dataSet.elements)
        .filter((tag) => !tag.startsWith('x0002'))
        .sort()
        .map((tag) => dataSet.elements[tag].dataOffset);
      expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    });

    it('still round-trips the structures when identity is added', () => {
      const original = sampleStructureSet();
      const parsed = parseStructureSet(
        'rt.dcm',
        writeStructureSet(original, { patientId: 'SYN-0001', studyInstanceUid: '2.25.1234' }),
      );
      expect(parsed!.rois.map((r) => r.name)).toEqual(original.rois.map((r) => r.name));
      expect(parsed!.rois[0].contours[0].points).toEqual(original.rois[0].contours[0].points);
      expect(parsed!.referencedSeriesUids).toEqual(original.referencedSeriesUids);
    });
  });
});
