/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { ActiveDataSource } from './active-data-source';
import { DATA_SOURCE } from './data-source';
import { LocalFilesSource } from './local-files-source';
import { FakeDataSource, fakePatient } from './testing';

describe('ActiveDataSource', () => {
  let active: ActiveDataSource;
  beforeEach(() => {
    active = TestBed.inject(ActiveDataSource);
  });

  it('is what the viewer reads from, and is the opened files to begin with', () => {
    expect(TestBed.inject(DATA_SOURCE)).toBe(active);
    expect(active.source()).toBe(TestBed.inject(LocalFilesSource));
    expect(active.isFiles()).toBe(true);
    expect(active.label).toBe('Files on this computer');
    expect(active.currentPatient()).toBeNull();
  });

  it('passes everything on to the source in use, and follows it as it changes', async () => {
    const other = new FakeDataSource();
    active.use(other);
    expect(active.isFiles()).toBe(false);
    expect(active.label).toBe('A fake source');
    expect(active.currentPatient()).toBeNull();

    other.currentPatient.set(fakePatient());
    expect(active.currentPatient()?.key).toBe('k1');
    expect(active.patients().map((patient) => patient.key)).toEqual(['k1']);

    const abandoned = new AbortController();
    await active.fetchSeries('1.1.1', { signal: abandoned.signal });
    expect(other.fetches.map((fetch) => fetch.seriesUid)).toEqual(['1.1.1']);
    expect(other.fetches[0].options.signal).toBe(abandoned.signal);
    expect(active.thumbnail('1.1.1')).toMatchObject({ kind: 'image' });
    await active.save({
      bytes: new ArrayBuffer(1),
      filename: 'a.dcm',
      mediaType: 'application/dicom',
    });
    expect(other.saved.map((object) => object.filename)).toEqual(['a.dcm']);
  });

  it('goes back to the opened files, which were kept meanwhile', () => {
    const files = TestBed.inject(LocalFilesSource);
    active.use(new FakeDataSource());
    active.use(null);
    expect(active.source()).toBe(files);
    expect(active.isFiles()).toBe(true);
  });
});
