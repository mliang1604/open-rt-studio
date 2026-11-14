/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PatientCatalog, mergeStructureSets } from './patient-catalog';
import { registrationObject } from './registration-testing';
import type { Slice, StructureSet, Series } from '@open-rt-studio/dicom';

/** A minimal structure set carrying just the fields the retention dedup reads. */
function structureSet(name: string, overrides: Partial<StructureSet> = {}): StructureSet {
  return {
    name,
    label: null,
    frameOfReferenceUid: 'for-1',
    referencedSeriesUids: [],
    rois: [],
    ...overrides,
  };
}

/** A minimal series carrying just the catalog-grouping fields under test. */
function series(uid: string, overrides: Partial<Series> = {}): Series {
  return {
    uid,
    seriesNumber: null,
    description: null,
    modality: null,
    studyUid: 'study',
    studyDate: null,
    studyTime: null,
    studyDescription: null,
    patientId: 'p1',
    patientName: null,
    frameOfReferenceUid: null,
    imageCount: 1,
    dims: [4, 4],
    metadata: null,
    slices: [{ marker: uid } as unknown as Slice],
    ...overrides,
  };
}

describe('PatientCatalog', () => {
  it('starts empty with no current patient', () => {
    const catalog = new PatientCatalog();
    expect(catalog.patients().size).toBe(0);
    expect(catalog.currentPatientId()).toBeNull();
    expect(catalog.currentPatient()).toBeNull();
  });

  it('accumulates series across imports into one merged hierarchy', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a')]);
    catalog.add([series('b')]);

    const patient = catalog.patients().get('p1');
    expect(catalog.patients().size).toBe(1);
    expect(patient?.studies.flatMap((s) => s.series).map((s) => s.uid)).toEqual(['a', 'b']);
  });

  it('dedups by SeriesInstanceUID, keeping the series already there', () => {
    const catalog = new PatientCatalog();
    const original = series('a', { slices: [{ marker: 'first' } as unknown as Slice] });
    catalog.add([original]);
    catalog.add([series('a', { slices: [{ marker: 'second' } as unknown as Slice] }), series('b')]);

    const kept =
      catalog
        .patients()
        .get('p1')
        ?.studies.flatMap((s) => s.series) ?? [];
    expect(kept.map((s) => s.uid)).toEqual(['a', 'b']);
    expect(kept.find((s) => s.uid === 'a')).toBe(original);
  });

  it('holds several patients while focusing the latest import', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a', { patientId: 'p1' })]);
    catalog.add([series('b', { patientId: 'p2' })]);

    expect([...catalog.patients().keys()]).toEqual(['p1', 'p2']);
    expect(catalog.currentPatientId()).toBe('p2');
    expect(catalog.currentPatient()?.patientId).toBe('p2');
  });

  it('stays with the patient on screen when an import brings their files among others', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a', { patientId: 'p1' })]);
    catalog.add([series('b', { patientId: 'p2' }), series('c', { patientId: 'p1' })]);

    expect([...catalog.patients().keys()]).toEqual(['p1', 'p2']);
    expect(catalog.currentPatientId()).toBe('p1');
  });

  it('turns to the first by Patient ID of a batch that holds two, whatever order they came in', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a', { patientId: 'p2' }), series('b', { patientId: 'p1' })]);
    // As the patients are listed.
    expect([...catalog.patients().keys()]).toEqual(['p1', 'p2']);
    expect(catalog.currentPatientId()).toBe('p1');

    // Likewise when the batch leaves the patient on screen for two others.
    catalog.add([series('c', { patientId: 'p4' }), series('d', { patientId: 'p3' })]);
    expect(catalog.currentPatientId()).toBe('p3');
  });

  it('turns to a patient it holds, and stays for one it does not', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a', { patientId: 'p1' })]);
    catalog.add([series('b', { patientId: 'p2' })]);

    expect(catalog.select('p1')).toBe(true);
    expect(catalog.currentPatient()?.patientId).toBe('p1');
    // The other patient is still held, to turn back to.
    expect(catalog.patients().has('p2')).toBe(true);
    expect(catalog.select('p9')).toBe(false);
    expect(catalog.currentPatientId()).toBe('p1');
  });

  it('builds no volumes, retaining each series slices', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a')]);

    const stored = catalog.patients().get('p1')?.studies[0].series[0];
    expect(stored?.slices).toHaveLength(1);
    expect('volume' in (stored ?? {})).toBe(false);
  });

  it('keys series with no PatientID under the empty string', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a', { patientId: null })]);

    expect(catalog.patients().has('')).toBe(true);
    expect(catalog.currentPatientId()).toBe('');
  });

  it('ignores an empty import', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a')]);
    catalog.add([]);

    expect(catalog.patients().size).toBe(1);
    expect(catalog.currentPatientId()).toBe('p1');
  });

  it('finds a retained series by UID across patients (for a chip drop)', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a', { patientId: 'p1' })]);
    catalog.add([series('b', { patientId: 'p2' })]);

    expect(catalog.seriesByUid('a')?.uid).toBe('a');
    expect(catalog.seriesByUid('b')?.uid).toBe('b');
    expect(catalog.seriesByUid('missing')).toBeUndefined();
  });

  it('clear() empties the catalog and current selection', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a')]);
    catalog.clear();

    expect(catalog.patients().size).toBe(0);
    expect(catalog.currentPatientId()).toBeNull();
    expect(catalog.currentPatient()).toBeNull();
  });

  describe('close()', () => {
    function threePatients(): PatientCatalog {
      const catalog = new PatientCatalog();
      catalog.add([
        series('a', { patientId: 'p1' }),
        series('b', { patientId: 'p2' }),
        series('c', { patientId: 'p3' }),
      ]);
      catalog.addStructureSets([
        structureSet('rs.dcm', { patientId: 'p1' }),
        structureSet('rs.dcm', { patientId: 'p2' }),
        structureSet('rs.dcm', { patientId: 'p3' }),
      ]);
      return catalog;
    }

    it('lets go of the patient, their series and their structure sets, and of no one else’s', () => {
      const catalog = threePatients();
      catalog.select('p2');
      expect(catalog.close('p3')).toBe(true);
      expect([...catalog.patients().keys()]).toEqual(['p1', 'p2']);
      expect(catalog.seriesByUid('c')).toBeUndefined();
      expect(catalog.structureSets().map((set) => set.patientId)).toEqual(['p1', 'p2']);
      // The patient it was on is still the one.
      expect(catalog.currentPatientId()).toBe('p2');
    });

    it('turns to the first patient left when the one it was on is closed, and to none after the last', () => {
      const catalog = threePatients();
      catalog.select('p2');
      catalog.close('p2');
      expect(catalog.currentPatientId()).toBe('p1');
      catalog.close('p1');
      expect(catalog.currentPatientId()).toBe('p3');
      catalog.close('p3');
      expect(catalog.currentPatientId()).toBeNull();
      expect(catalog.currentPatient()).toBeNull();
      expect(catalog.patients().size).toBe(0);
      expect(catalog.structureSets()).toEqual([]);
    });

    it('says false for a patient it does not hold, and changes nothing', () => {
      const catalog = threePatients();
      expect(catalog.close('p9')).toBe(false);
      expect(catalog.patients().size).toBe(3);
      expect(catalog.structureSets()).toHaveLength(3);
    });

    it('takes the sets that name no patient with the patient who has no ID', () => {
      const catalog = new PatientCatalog();
      catalog.add([series('a', { patientId: null }), series('b', { patientId: 'p1' })]);
      catalog.addStructureSets([
        structureSet('unnamed.dcm', { patientId: null }),
        structureSet('p1.dcm', { patientId: 'p1' }),
      ]);
      catalog.close('');
      expect(catalog.structureSets().map((set) => set.name)).toEqual(['p1.dcm']);
    });
  });

  it('retains structure sets across imports so a later pick can re-associate them (#241)', () => {
    const catalog = new PatientCatalog();
    catalog.addStructureSets([structureSet('rt-a')]);
    catalog.addStructureSets([structureSet('rt-b')]);
    expect(catalog.structureSets().map((s) => s.name)).toEqual(['rt-a', 'rt-b']);
  });

  it('dedups a re-imported structure set rather than stacking it', () => {
    const catalog = new PatientCatalog();
    catalog.addStructureSets([structureSet('rt-a')]);
    catalog.addStructureSets([structureSet('rt-a')]); // same file re-imported
    expect(catalog.structureSets()).toHaveLength(1);
  });

  it('ignores an empty structure-set batch', () => {
    const catalog = new PatientCatalog();
    catalog.addStructureSets([structureSet('rt-a')]);
    catalog.addStructureSets([]);
    expect(catalog.structureSets()).toHaveLength(1);
  });

  it('keeps registration objects, each once, and lets go of them with their patient', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a')]);
    const theirs = registrationObject('reg-1', 'f2', 'f1', undefined, { patientId: 'p1' });
    const anothers = registrationObject('reg-2', 'f4', 'f3', undefined, { patientId: 'P2' });
    catalog.addRegistrations([theirs, anothers]);
    // The same file opened again.
    catalog.addRegistrations([{ ...theirs }, { ...theirs }]);
    catalog.addRegistrations([]);
    expect(catalog.registrations()).toEqual([theirs, anothers]);

    catalog.add([series('b', { patientId: 'P2' })]);
    catalog.close('P2');
    expect(catalog.registrations()).toEqual([theirs]);

    catalog.clear();
    expect(catalog.registrations()).toEqual([]);
  });

  it('clear() drops retained structure sets too (patient switch)', () => {
    const catalog = new PatientCatalog();
    catalog.add([series('a')]);
    catalog.addStructureSets([structureSet('rt-a')]);
    catalog.clear();
    expect(catalog.structureSets()).toEqual([]);
  });
});

describe('mergeStructureSets', () => {
  it('appends new sets and skips duplicates by source/frame/referenced series', () => {
    const a = structureSet('a', { frameOfReferenceUid: 'for-1' });
    const b = structureSet('b', { frameOfReferenceUid: 'for-2' });
    const aAgain = structureSet('a', { frameOfReferenceUid: 'for-1' });
    const merged = mergeStructureSets([a], [aAgain, b]);
    expect(merged.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('keeps the sets of two patients apart, though name, frame and series are the same', () => {
    const one = structureSet('rs.dcm', { patientId: 'p1' });
    const other = structureSet('rs.dcm', { patientId: 'p2' });
    expect(mergeStructureSets([one], [other, structureSet('rs.dcm', { patientId: 'p1' })])).toEqual(
      [one, other],
    );
  });

  it('treats same-name sets with different frames of reference as distinct', () => {
    const a1 = structureSet('a', { frameOfReferenceUid: 'for-1' });
    const a2 = structureSet('a', { frameOfReferenceUid: 'for-2' });
    expect(mergeStructureSets([a1], [a2])).toHaveLength(2);
  });
});
