/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import type { Series, Slice, StructureSet } from '@open-rt-studio/dicom';

import { DATA_SOURCE, listedSeries } from './data-source';
import { LocalFilesSource } from './local-files-source';

/** A parsed series with one small slice, enough to draw a preview from. */
function series(uid: string, overrides: Partial<Series> = {}): Series {
  const slice = {
    columns: 2,
    rows: 2,
    pixels: new Float32Array([0, 100, 200, 300]),
    windowCenter: null,
    windowWidth: null,
  } as unknown as Slice;
  return {
    uid,
    seriesNumber: 1,
    description: 'Planning CT',
    modality: 'CT',
    studyUid: '1.1',
    studyDate: '20260105',
    studyTime: null,
    studyDescription: 'Planning',
    patientId: 'SYN-0001',
    patientName: 'SYNTHETIC^PHANTOM',
    frameOfReferenceUid: '1.9',
    imageCount: 1,
    dims: [2, 2],
    metadata: null,
    slices: [slice],
    ...overrides,
  };
}

const structures = (name: string): StructureSet =>
  ({ name, frameOfReferenceUid: '1.9', referencedSeriesUids: [] }) as unknown as StructureSet;

describe('LocalFilesSource', () => {
  let source: LocalFilesSource;
  beforeEach(() => {
    source = TestBed.inject(LocalFilesSource);
  });

  it('is what the viewer reads from until another source is put in use', () => {
    source.add([series('1.1.1')]);
    expect(TestBed.inject(DATA_SOURCE).currentPatient()?.key).toBe('SYN-0001');
  });

  it('lists nothing before anything was opened', () => {
    expect(source.patients()).toEqual([]);
    expect(source.currentPatient()).toBeNull();
    expect(listedSeries(source)).toEqual([]);
  });

  it('lists what was imported: the patient, their studies in date order, and each study’s series', () => {
    source.add([
      series('1.2.1', {
        studyUid: '1.2',
        studyDate: '20260302',
        modality: 'MR',
        description: 'T1',
      }),
      series('1.1.1'),
      series('1.1.2', { modality: 'RTDOSE', description: null, seriesNumber: 20 }),
    ]);
    expect(source.patients()).toEqual([
      { key: 'SYN-0001', patientId: 'SYN-0001', name: 'SYNTHETIC^PHANTOM' },
    ]);
    const patient = source.currentPatient()!;
    expect(patient).toMatchObject({ key: 'SYN-0001', patientId: 'SYN-0001' });
    expect(patient.studies.map((study) => [study.studyUid, study.date, study.modalities])).toEqual([
      ['1.1', '20260105', ['CT', 'RTDOSE']],
      ['1.2', '20260302', ['MR']],
    ]);
    expect(listedSeries(source).map((one) => one.uid)).toEqual(['1.1.1', '1.1.2', '1.2.1']);
  });

  it('turns to the patient imported last, and forgets everything when cleared', () => {
    source.add([series('1.1.1')]);
    source.add([series('2.1.1', { patientId: 'SYN-0002', patientName: null, studyUid: '2.1' })]);
    expect(source.currentPatientId()).toBe('SYN-0002');
    expect(source.currentPatient()!.key).toBe('SYN-0002');
    expect(source.patients().map((patient) => patient.key)).toEqual(['SYN-0001', 'SYN-0002']);

    source.clear();
    expect(source.patients()).toEqual([]);
    expect(source.currentPatient()).toBeNull();
  });

  it('gives a series as it was parsed, with every structure set that was imported', async () => {
    const ct = series('1.1.1');
    const sets = [structures('a'), structures('b')];
    source.add([ct]);
    source.addStructureSets(sets);
    const fetched = await source.fetchSeries('1.1.1');
    expect(fetched.series).toBe(ct);
    expect(fetched.structureSets).toEqual(sets);
  });

  it('answers at once, without reporting progress', async () => {
    source.add([series('1.1.1')]);
    const onProgress = vi.fn();
    await source.fetchSeries('1.1.1', { onProgress });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('rejects for a series that was not opened, and for a fetch that was abandoned', async () => {
    source.add([series('1.1.1')]);
    await expect(source.fetchSeries('9.9.9')).rejects.toThrow(
      'That series is not among the opened files.',
    );
    const abandoned = new AbortController();
    abandoned.abort();
    await expect(source.fetchSeries('1.1.1', { signal: abandoned.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('draws a preview from the pixels it holds, at once, and once', () => {
    source.add([series('1.1.1'), series('1.1.2', { modality: 'RTDOSE' })]);
    const preview = source.thumbnail('1.1.1');
    expect(preview).toMatchObject({ kind: 'image', pixels: { width: 64, height: 64 } });
    expect(source.thumbnail('1.1.1')).toBe(preview);
    // A dose has no picture worth showing; the chip draws the modality's icon.
    expect(source.thumbnail('1.1.2')).toEqual({ kind: 'icon', modality: 'RTDOSE' });
    expect(source.thumbnail('9.9.9')).toEqual({ kind: 'icon', modality: null });
  });

  it('saves an object as a download, in the turn it was asked', async () => {
    const clicked: { download: string; href: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href });
    });
    const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.type}:${blob.size}`);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    try {
      const saving = source.save({
        bytes: new Uint8Array([1, 2, 3]).buffer,
        filename: 'rtstruct-test.dcm',
        mediaType: 'application/dicom',
      });
      // Before anything is awaited: a browser allows a download only then.
      expect(clicked).toEqual([
        { download: 'rtstruct-test.dcm', href: 'blob:application/dicom:3' },
      ]);
      expect(await saving).toEqual({ kind: 'downloaded' });
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
