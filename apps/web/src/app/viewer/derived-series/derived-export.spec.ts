/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  CT_IMAGE_SOP_CLASS,
  MR_IMAGE_SOP_CLASS,
  buildVolume,
  parseFile,
  type DicomMetadata,
} from '@open-rt-studio/dicom';

import {
  DERIVED_NOTICE,
  derivationText,
  derivedFiles,
  resampledDescription,
  sourceOf,
  type DerivationFacts,
} from './derived-export';
import { shift, testPlacement, testSeries, testVolume } from './testing';

const tags = (pairs: Record<string, string>): DicomMetadata => ({
  curated: [],
  rawTags: Object.entries(pairs).map(([tag, value]) => ({ tag, name: null, vr: null, value })),
});

const BASE = testSeries('1.2.3.20', { description: 'Planning CT' });
const SOURCE = testSeries('1.2.3.30', {
  description: 'T2 axial',
  modality: 'MR',
  studyUid: '1.2.3.11',
  frameOfReferenceUid: '1.2.3.60',
});
const PLACEMENT = testPlacement(shift(2, 0, 0), shift(-2, 0, 0));
const FACTS: DerivationFacts = {
  source: SOURCE,
  base: BASE,
  placement: PLACEMENT,
  outsideCount: 40,
  voxelCount: 120,
  outside: 0,
  missingSlices: 0,
};
const NOW = new Date(2026, 10, 14, 9, 5, 7);

describe('what a resampled series is called', () => {
  it('says first that it is resampled, then what onto what', () => {
    expect(resampledDescription(SOURCE, BASE)).toBe('Resampled: T2 axial onto Planning CT');
  });

  it('goes by the modality, or as an image, where a series has no description', () => {
    expect(
      resampledDescription(
        testSeries('1', { description: '  ', modality: 'MR' }),
        testSeries('2', { description: null, modality: null }),
      ),
    ).toBe('Resampled: MR onto image');
  });
});

describe('what a source says of itself', () => {
  it('is its first image’s elements by tag, and its kind of object', () => {
    const series = testSeries('1.2.3.30', {
      studyUid: '1.2.3.11',
      metadata: tags({
        '(0008,0016)': MR_IMAGE_SOP_CLASS,
        '(0018,0020)': 'SE',
        '(0018,5100)': 'HFS',
      }),
    });
    expect(sourceOf(series)).toEqual({
      studyInstanceUid: '1.2.3.11',
      seriesInstanceUid: '1.2.3.30',
      sopClassUid: MR_IMAGE_SOP_CLASS,
      attributes: {
        '(0008,0016)': MR_IMAGE_SOP_CLASS,
        '(0018,0020)': 'SE',
        '(0018,5100)': 'HFS',
      },
    });
  });

  it('has no kind when the image names none, or names what is no UID', () => {
    expect(sourceOf(testSeries('1')).sopClassUid).toBeNull();
    expect(sourceOf(testSeries('1')).attributes).toEqual({});
    const odd = testSeries('1', { metadata: tags({ '(0008,0016)': '<binary: 26 bytes>' }) });
    expect(sourceOf(odd).sopClassUid).toBeNull();
  });
});

describe('how a resampled image was derived, in words', () => {
  it('names the two series, the registration and which way it was taken, and what is outside', () => {
    expect(derivationText(FACTS)).toBe(
      `${DERIVED_NOTICE} Series 1.2.3.30 resampled onto the grid of series 1.2.3.20 by linear interpolation, ` +
        'through registration "MR to CT" (1.2.3.70, inverted). ' +
        '40 of 120 voxels lie outside the source and were given 0.',
    );
    expect(DERIVED_NOTICE).toContain('Not for clinical use');
  });

  it('says of each registration in a row whether it is by a deformation field', () => {
    const [step] = PLACEMENT.steps;
    const two = {
      ...PLACEMENT,
      steps: [
        { ...step, inverted: false },
        { ...step, sopInstanceUid: '1.2.3.71', description: null, label: 'DEF', deformable: true },
      ],
    };
    expect(derivationText({ ...FACTS, placement: two })).toContain(
      'through registration "MR to CT" (1.2.3.70, as written), then registration "DEF" (1.2.3.71, inverted, by its deformation field).',
    );
  });

  it('gives the matrix of a registration by hand, which is in no object to name', () => {
    const [step] = PLACEMENT.steps;
    const byHand = {
      ...PLACEMENT,
      steps: [{ ...step, sopInstanceUid: '', label: null, description: null, byHand: true }],
      baseToLayer: shift(2.5, -1.2345678, 0),
    };
    expect(derivationText({ ...FACTS, placement: byHand })).toContain(
      'through a registration made by hand in the viewer that is in no object ' +
        '(base to source, row by row: 1 0 0 2.5 0 1 0 -1.234568 0 0 1 0 0 0 0 1).',
    );
  });

  it('says so when no registration was needed, and when the source had slices missing', () => {
    const text = derivationText({ ...FACTS, placement: null, missingSlices: 2 });
    expect(text).toContain(
      'by linear interpolation, with no registration: the two series share a frame of reference.',
    );
    expect(text).toContain(
      ' The source lacks 2 slices, filled in by interpolation before it was resampled.',
    );
    expect(derivationText({ ...FACTS, missingSlices: 1 })).toContain('lacks 1 slice,');
  });
});

describe('a resampled image as the files of a new series', () => {
  const resampled = testVolume('MR', [6, 5, 4], [0, 0, 0], (i, j, k) => i + 10 * j + 100 * k);
  const filed = { frameOfReferenceUid: '1.2.3.50', studyInstanceUid: '1.2.3.10' };
  const made = derivedFiles(resampled, FACTS, filed, NOW);
  const slices = made.series.objects.flatMap((object) => parseFile(object.filename, object.bytes));

  it('is a file to a slice, named in order, in a folder named for what it is and when', () => {
    expect(made.series.name).toBe('resampled-series-20261114-090507');
    expect(made.series.made).toBe(NOW);
    expect(made.series.objects.map((object) => object.filename)).toEqual([
      'IM0001.dcm',
      'IM0002.dcm',
      'IM0003.dcm',
      'IM0004.dcm',
    ]);
    expect(new Set(made.series.objects.map((object) => object.mediaType))).toEqual(
      new Set(['application/dicom']),
    );
    expect(made.description).toBe('Resampled: T2 axial onto Planning CT');
    expect(made.clampedCount).toBe(0);
  });

  it('is of the base image’s patient, in its study and its frame of reference', () => {
    expect(slices).toHaveLength(4);
    for (const slice of slices) {
      expect(slice.patientId).toBe('SYN-0001');
      expect(slice.patientName).toBe('SYNTHETIC^PHANTOM');
      // The base's study and frame, not the source's.
      expect(slice.studyUid).toBe('1.2.3.10');
      expect(slice.frameOfReferenceUid).toBe('1.2.3.50');
      expect(slice.studyDate).toBe('20260105');
      expect(slice.seriesDescription).toBe('Resampled: T2 axial onto Planning CT');
      expect(slice.seriesUid).toBe(made.seriesInstanceUid);
      expect(slice.modality).toBe('MR');
    }
    expect(made.seriesInstanceUid).not.toBe('1.2.3.30');
  });

  it('opens again as the image that was resampled', () => {
    const back = buildVolume(slices);
    expect(back.dims).toEqual([6, 5, 4]);
    expect([...back.data]).toEqual([...resampled.data]);
  });

  it('says what kind of object its slices are', () => {
    // An MR that does not say how it was scanned cannot be written as an MR image.
    expect(made.kind).toBe('Secondary Capture images');
    const ct = derivedFiles(
      { ...resampled, modality: 'CT' },
      {
        ...FACTS,
        source: testSeries('1.2.3.31', {
          metadata: tags({ '(0008,0016)': CT_IMAGE_SOP_CLASS }),
        }),
      },
      filed,
      NOW,
    );
    expect(ct.kind).toBe('CT images');
    const mr = derivedFiles(
      resampled,
      {
        ...FACTS,
        source: testSeries('1.2.3.32', {
          modality: 'MR',
          metadata: tags({
            '(0008,0016)': MR_IMAGE_SOP_CLASS,
            '(0018,0020)': 'SE',
            '(0018,0021)': 'NONE',
          }),
        }),
      },
      filed,
      NOW,
    );
    expect(mr.kind).toBe('MR images');
  });

  it('counts the values 16 bits could not hold', () => {
    const wide = testVolume('MR', [2, 2, 1], [0, 0, 0], (i) => (i === 0 ? 1e6 : 5));
    expect(derivedFiles(wide, FACTS, filed, NOW).clampedCount).toBe(2);
  });
});
