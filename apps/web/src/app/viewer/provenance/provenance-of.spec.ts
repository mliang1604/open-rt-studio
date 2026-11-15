/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RegistrationObject, Roi, Series, StructureSet } from '@open-rt-studio/dicom';

import { derivationText } from '../derived-series/derived-export';
import { shift, testPlacement, testSeries } from '../derived-series/testing';
import { METHOD_TEXT, propagationText } from '../structure-propagation/propagation-export';
import { isDerivedSet, madeAt, provenanceOf, throughOf, type ProvenanceOf } from './provenance-of';

const roi = (number: number, name: string, way: keyof typeof METHOD_TEXT | null): Roi => ({
  number,
  name,
  color: null,
  interpretedType: null,
  contours: [],
  ...(way
    ? { generation: { algorithm: 'AUTOMATIC', description: METHOD_TEXT[way], resampled: true } }
    : {}),
});
const SOURCE_SET: StructureSet = {
  name: 'rt.dcm',
  label: 'Plan A',
  frameOfReferenceUid: '1.2.3.60',
  referencedSeriesUids: ['1.2.3.30'],
  sopInstanceUid: '1.2.3.80',
  rois: [roi(1, 'Heart', null), roi(2, 'Cord', null), roi(3, 'Lung', null)],
};
const PLACEMENT = testPlacement(shift(2, 0, 0), shift(-2, 0, 0));
const BASE = testSeries('1.2.3.20', { description: 'Planning CT' });
const MR = testSeries('1.2.3.30', { description: 'T2', modality: 'MR' });
const PROPAGATED: StructureSet = {
  name: 'propagated.dcm',
  label: 'PROPAGATED',
  frameOfReferenceUid: '1.2.3.50',
  referencedSeriesUids: ['1.2.3.20'],
  sopInstanceUid: '1.2.3.90',
  date: '20261114',
  time: '090507.25',
  predecessorSopInstanceUids: ['1.2.3.80'],
  description: propagationText({
    set: SOURCE_SET,
    source: MR,
    base: BASE,
    placement: PLACEMENT,
    results: [],
  }),
  rois: [roi(1, 'Heart', 'points'), roi(2, 'Cord', 'label-volume'), roi(3, 'Lung', 'label-volume')],
};
const names: Record<string, string> = { '1.2.3.20': 'CT Planning CT', '1.2.3.30': 'MR T2' };
const of = (more: Partial<ProvenanceOf> = {}): ProvenanceOf => ({
  structureSets: [],
  images: [],
  knownSets: [],
  knownRegistrations: [],
  seriesName: (uid) => names[uid] ?? null,
  ...more,
});

describe('the registration a description written here names', () => {
  it('is read from a propagated set’s words and from a resampled image’s', () => {
    expect(throughOf(PROPAGATED.description!)).toBe(
      'through registration "MR to CT" (1.2.3.70, inverted)',
    );
    const image = derivationText({
      source: MR,
      base: BASE,
      placement: PLACEMENT,
      outsideCount: 3,
      voxelCount: 100,
      outside: -1000,
      missingSlices: 0,
    });
    expect(throughOf(image)).toBe('through registration "MR to CT" (1.2.3.70, inverted)');
  });

  it('is that there was none, where the two share a frame', () => {
    const text = propagationText({
      set: SOURCE_SET,
      source: MR,
      base: BASE,
      placement: null,
      results: [],
    });
    expect(throughOf(text)).toBe('with no registration: the two series share a frame of reference');
  });

  it('is nothing for words that are not this application’s', () => {
    expect(throughOf('Deformed with Vendor 4.2 through the usual pipeline.')).toBeNull();
    expect(throughOf('')).toBeNull();
  });
});

describe('when something was made', () => {
  it('is its date and its time to the minute, or the date alone, or nothing', () => {
    expect(madeAt('20261114', '090507.25')).toBe('2026-11-14 09:05');
    expect(madeAt('20261114', null)).toBe('2026-11-14');
    expect(madeAt(null, '090507')).toBeNull();
    expect(madeAt('2026', '090507')).toBeNull();
  });
});

describe('what a propagated structure set was made from', () => {
  it('names the set it is from by its label and its image, the registration, and how each structure went', () => {
    const [item] = provenanceOf(of({ structureSets: [PROPAGATED], knownSets: [SOURCE_SET] }));
    expect(item.title).toBe('Structure set “PROPAGATED”');
    expect(item.rows).toEqual([
      { name: 'Made', value: '2026-11-14 09:05' },
      { name: 'From', value: 'Structure set “Plan A” on MR T2' },
      { name: 'Registration', value: 'through registration "MR to CT" (1.2.3.70, inverted)' },
      { name: '1 structure', value: METHOD_TEXT.points },
      { name: '2 structures', value: METHOD_TEXT['label-volume'] },
    ]);
    expect(item.says).toBe(PROPAGATED.description);
  });

  it('names what is not open here by its UID, and says so', () => {
    const [item] = provenanceOf(of({ structureSets: [PROPAGATED] }));
    expect(item.rows[1]).toEqual({
      name: 'From',
      value: 'Structure set 1.2.3.80, which is not open here',
    });
  });

  it('says nothing of a set that does not say it was made from another', () => {
    expect(isDerivedSet(SOURCE_SET)).toBe(false);
    expect(provenanceOf(of({ structureSets: [SOURCE_SET] }))).toEqual([]);
    // One that names no predecessor and has a structure that was resampled is derived all the same.
    const bare: StructureSet = { ...SOURCE_SET, rois: [roi(1, 'Heart', 'points')] };
    expect(isDerivedSet(bare)).toBe(true);
    const [item] = provenanceOf(of({ structureSets: [bare] }));
    expect(item.rows).toEqual([{ name: '1 structure', value: METHOD_TEXT.points }]);
    expect(item.says).toBeNull();
  });
});

describe('what a derived image was made from', () => {
  const derived = (more: object = {}): Series =>
    ({
      ...testSeries('1.2.3.40', { description: 'Resampled: T2 onto Planning CT' }),
      metadata: {
        curated: [],
        rawTags: [],
        derivation: {
          description: 'Resampled by another system.',
          date: '20261114',
          time: '0905',
          relatedSeriesUids: ['1.2.3.30', '9.9'],
          sourceInstanceUids: ['1.2.3.70', '8.8'],
          ...more,
        },
      },
    }) as Series;
  const registration = { sopInstanceUid: '1.2.3.70', label: 'MR to CT' } as RegistrationObject;

  it('names the series and the registrations it names, by what they are called when they are open', () => {
    const [item] = provenanceOf(
      of({ images: [BASE, derived()], knownRegistrations: [registration] }),
    );
    expect(item.title).toBe('Image “Resampled: T2 onto Planning CT”');
    expect(item.rows).toEqual([
      { name: 'Made', value: '2026-11-14 09:05' },
      { name: 'From', value: 'MR T2' },
      { name: 'From', value: 'Series 9.9, which is not open here' },
      { name: 'Registration', value: 'Registration “MR to CT”' },
      { name: 'Registration', value: 'Object 8.8, which is not open here' },
    ]);
    expect(item.says).toBe('Resampled by another system.');
  });

  it('reads a registration made by hand from the words, since it is in no object', () => {
    const text = derivationText({
      source: MR,
      base: BASE,
      placement: {
        ...PLACEMENT,
        steps: [{ ...PLACEMENT.steps[0], byHand: true }],
      },
      outsideCount: 0,
      voxelCount: 10,
      outside: 0,
      missingSlices: 0,
    });
    const [item] = provenanceOf(
      of({ images: [derived({ description: text, sourceInstanceUids: [] })] }),
    );
    expect(item.rows.at(-1)!.name).toBe('Registration');
    expect(item.rows.at(-1)!.value).toContain(
      'through a registration made by hand in the viewer that is in no object',
    );
  });

  it('lists images before structure sets, and nothing for what is not derived', () => {
    const items = provenanceOf(
      of({ images: [BASE, derived()], structureSets: [SOURCE_SET, PROPAGATED] }),
    );
    expect(items.map((item) => item.key)).toEqual(['image-1.2.3.40', 'set-1.2.3.90']);
  });
});
