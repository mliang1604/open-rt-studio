/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import type { RtObjectFacts, Series, Slice, StructureSet } from '@open-rt-studio/dicom';

import { DATA_SOURCE, listedSeries } from './data-source';
import { LocalFilesSource } from './local-files-source';
import { TimepointStore } from './timepoint-store';
import { registrationObject } from '../registration-testing';

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

  it('gives with a series the registrations that were opened, but not another patient’s', async () => {
    source.add([series('1.1.1')]);
    const theirs = registrationObject('reg-1', '1.8', '1.9', undefined, { patientId: 'SYN-0001' });
    const unnamed = registrationObject('reg-2', '1.7', '1.9');
    const anothers = registrationObject('reg-3', '1.6', '1.9', undefined, {
      patientId: 'SYN-0002',
    });
    source.addRegistrations([theirs, unnamed, anothers]);
    expect((await source.fetchSeries('1.1.1')).registrations).toEqual([theirs, unnamed]);
    expect(source.registrations()).toEqual([theirs, unnamed]);
    source.clear();
    expect(source.registrations()).toEqual([]);
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

  describe('with files of two patients', () => {
    const other = { patientId: 'SYN-0002', patientName: 'SYNTHETIC^OTHER', studyUid: '2.1' };
    beforeEach(() => {
      source.add([series('1.1.1'), series('2.1.1', other)]);
    });

    it('lists both, and shows the timeline of the first', () => {
      expect(source.patients()).toEqual([
        { key: 'SYN-0001', patientId: 'SYN-0001', name: 'SYNTHETIC^PHANTOM' },
        { key: 'SYN-0002', patientId: 'SYN-0002', name: 'SYNTHETIC^OTHER' },
      ]);
      expect(source.currentPatient()?.key).toBe('SYN-0001');
      expect(listedSeries(source).map((one) => one.uid)).toEqual(['1.1.1']);
    });

    it('turns to the other, whose timeline has only what is theirs', () => {
      source.selectPatient('SYN-0002');
      expect(source.currentPatient()?.key).toBe('SYN-0002');
      expect(listedSeries(source).map((one) => one.uid)).toEqual(['2.1.1']);
      // Both are still open.
      expect(source.patients()).toHaveLength(2);
    });

    it('gives a series only of the patient it is on', async () => {
      expect((await source.fetchSeries('1.1.1')).series.uid).toBe('1.1.1');
      await expect(source.fetchSeries('2.1.1')).rejects.toThrow(
        'That series belongs to another of the opened patients.',
      );
      source.selectPatient('SYN-0002');
      expect((await source.fetchSeries('2.1.1')).series.uid).toBe('2.1.1');
      await expect(source.fetchSeries('1.1.1')).rejects.toThrow('another of the opened patients');
    });

    it('stays with its patient when more of their files come, with or without another patient', () => {
      source.selectPatient('SYN-0002');
      source.add([
        series('2.1.2', other),
        series('3.1.1', { patientId: 'SYN-0003', studyUid: '3.1' }),
      ]);
      expect(source.currentPatient()?.key).toBe('SYN-0002');
      expect(source.patients().map((patient) => patient.key)).toEqual([
        'SYN-0001',
        'SYN-0002',
        'SYN-0003',
      ]);
    });

    // The helper gives every series the frame of reference 1.9: the two
    // patients share it, as one study exported under two names would.
    describe('whose structure sets share a frame of reference', () => {
      const of = (patientId: string | null, name: string): StructureSet => ({
        ...structures(name),
        patientId,
      });
      const count = (uid: string): number =>
        listedSeries(source).find((one) => one.uid === uid)!.structureSets;

      beforeEach(() => {
        source.addStructureSets([of('SYN-0001', 'first'), of('SYN-0002', 'second')]);
      });

      it('counts on a chip only the sets of that patient', () => {
        expect(count('1.1.1')).toBe(1);
        source.selectPatient('SYN-0002');
        expect(count('2.1.1')).toBe(1);
      });

      it('gives with a series only the sets of its patient', async () => {
        const names = async (uid: string): Promise<string[]> =>
          (await source.fetchSeries(uid)).structureSets.map((set) => set.name);
        expect(await names('1.1.1')).toEqual(['first']);
        source.selectPatient('SYN-0002');
        expect(await names('2.1.1')).toEqual(['second']);
      });

      it('gives a set that names no patient to whoever its UIDs say', async () => {
        source.addStructureSets([of(null, 'unnamed')]);
        expect(count('1.1.1')).toBe(2);
        expect((await source.fetchSeries('1.1.1')).structureSets.map((set) => set.name)).toEqual([
          'first',
          'unnamed',
        ]);
      });
    });

    describe('closing one', () => {
      it('lets go of their series, structure sets and previews, and stays where it was', async () => {
        source.addStructureSets([
          { ...structures('first'), patientId: 'SYN-0001' },
          { ...structures('second'), patientId: 'SYN-0002' },
        ]);
        expect(source.thumbnail('2.1.1').kind).toBe('image');
        source.closePatient('SYN-0002');
        expect(source.patients().map((patient) => patient.key)).toEqual(['SYN-0001']);
        expect(source.currentPatient()?.key).toBe('SYN-0001');
        await expect(source.fetchSeries('2.1.1')).rejects.toThrow(
          'That series is not among the opened files.',
        );
        // Not a picture kept from before: there is no such series any more.
        expect(source.thumbnail('2.1.1')).toEqual({ kind: 'icon', modality: null });
        expect((await source.fetchSeries('1.1.1')).structureSets.map((set) => set.name)).toEqual([
          'first',
        ]);
      });

      it('turns to the patient that is left when the one it is on is closed, and to none after the last', () => {
        source.closePatient('SYN-0001');
        expect(source.currentPatient()?.key).toBe('SYN-0002');
        expect(listedSeries(source).map((one) => one.uid)).toEqual(['2.1.1']);
        source.closePatient('SYN-0002');
        expect(source.patients()).toEqual([]);
        expect(source.currentPatient()).toBeNull();
      });

      it('opens them again from their files, as if for the first time', () => {
        source.closePatient('SYN-0002');
        source.add([series('2.1.1', other)]);
        expect(source.patients().map((patient) => patient.key)).toEqual(['SYN-0001', 'SYN-0002']);
        // It was on the first, and the files hold nothing of theirs.
        expect(source.currentPatient()?.key).toBe('SYN-0002');
      });

      it('refuses a patient that is not open', () => {
        expect(() => source.closePatient('SYN-0009')).toThrow(
          'That patient is not among the opened files.',
        );
        expect(source.patients()).toHaveLength(2);
      });
    });

    it('refuses to turn to a patient that is not open', () => {
      expect(() => source.selectPatient('SYN-0009')).toThrow(
        'That patient is not among the opened files.',
      );
      expect(source.currentPatient()?.key).toBe('SYN-0001');
    });
  });

  it('says with each series how many of the opened structure sets belong to it', () => {
    const count = (uid: string): number =>
      listedSeries(source).find((one) => one.uid === uid)!.structureSets;
    source.add([
      series('1.1.1'),
      series('1.2.1', { studyUid: '1.2', modality: 'MR', frameOfReferenceUid: '2.9' }),
    ]);
    expect([count('1.1.1'), count('1.2.1')]).toEqual([0, 0]);

    // One in the CT's frame of reference.
    source.addStructureSets([structures('in the frame')]);
    expect([count('1.1.1'), count('1.2.1')]).toEqual([1, 0]);

    // One that names the MR, and no frame.
    source.addStructureSets([
      {
        name: 'by series',
        frameOfReferenceUid: null,
        referencedSeriesUids: ['1.2.1'],
      } as unknown as StructureSet,
    ]);
    expect([count('1.1.1'), count('1.2.1')]).toEqual([1, 1]);
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

  it('saves a series as one download, an archive of its files in a folder, in the turn it was asked', async () => {
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => `blob:${blobs.push(blob)}`);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    try {
      const told: [number, number][] = [];
      const saving = source.saveSeries(
        {
          name: 'resampled-series-20261114-090507',
          made: new Date(2026, 10, 14, 9, 5, 7),
          objects: ['first', 'second'].map((text, at) => ({
            bytes: new TextEncoder().encode(text).buffer as ArrayBuffer,
            filename: `IM000${at + 1}.dcm`,
            mediaType: 'application/dicom',
          })),
        },
        (kept, of) => told.push([kept, of]),
      );
      // Before anything is awaited: a browser allows a download only then.
      expect(clicked).toEqual(['resampled-series-20261114-090507.zip']);
      expect(await saving).toEqual({ kind: 'downloaded' });
      expect(told).toEqual([[2, 2]]);
      expect(blobs).toHaveLength(1);
      expect(blobs[0].type).toBe('application/zip');
      // Not compressed: the names and the files can be read in it as they are.
      const archive = new TextDecoder('latin1').decode(await blobs[0].arrayBuffer());
      expect(archive.startsWith('PK\u0003\u0004')).toBe(true);
      for (const part of [
        'resampled-series-20261114-090507/IM0001.dcm',
        'resampled-series-20261114-090507/IM0002.dcm',
        'first',
        'second',
      ]) {
        expect(archive, part).toContain(part);
      }
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('what belongs to what among opened files (#38)', () => {
  let source: LocalFilesSource;
  beforeEach(() => {
    source = TestBed.inject(LocalFilesSource);
    source.clear();
  });

  const object = (
    kind: RtObjectFacts['kind'],
    uid: string,
    references: [RtObjectFacts['references'][number]['relation'], string][],
    more: Partial<RtObjectFacts> = {},
  ): RtObjectFacts => ({
    kind,
    sopInstanceUid: uid,
    sopClassUid: '1.2.840.10008.5.1.4.1.1.66.1',
    seriesUid: `${uid}.1`,
    studyUid: '1.1',
    patientId: 'SYN-0001',
    description: uid,
    frameOfReferenceUid: null,
    references: references.map(([relation, targetUid]) => ({ relation, targetUid })),
    ...more,
  });

  it('says with a plan its fractions and prescription, to a structure by its name once its structure set is read (#97)', () => {
    source.add([series('1.1.1')]);
    source.addRtObjects([
      object('structure-set', '5.1', [['structure-set.series', '1.1.1']]),
      object('plan', '5.2', [['plan.structure-set', '5.1']], {
        plan: {
          label: 'Plan A',
          planName: null,
          date: null,
          intent: null,
          approvalStatus: null,
          fractionGroups: [{ number: 1, fractionsPlanned: 30, beams: 1, beamDoseGy: 2 }],
          doseReferences: [
            {
              number: 1,
              structureType: 'VOLUME',
              type: 'TARGET',
              description: null,
              roiNumber: 2,
              prescriptionGy: 60,
            },
          ],
        },
      }),
    ]);
    const plan = () => listedSeries(source)[0].attached!.find((one) => one.kind === 'plan')!.plan!;
    expect(plan()).toMatchObject({ label: 'Plan A', fractions: [30], fractionGroups: 1 });
    expect(plan().prescriptions).toEqual([{ gy: 60, type: 'TARGET', to: 'ROI 2' }]);

    // A structure set the plan does not name says nothing of the plan's structures.
    const set = (sopInstanceUid: string, name: string): StructureSet =>
      ({
        name: sopInstanceUid,
        sopInstanceUid,
        frameOfReferenceUid: '1.9',
        referencedSeriesUids: [],
        rois: [{ number: 2, name }],
      }) as unknown as StructureSet;
    source.addStructureSets([set('5.9', 'Bladder')]);
    expect(plan().prescriptions[0].to).toBe('ROI 2');
    source.addStructureSets([set('5.1', 'PTV 60')]);
    expect(plan().prescriptions[0].to).toBe('PTV 60');
  });

  it('shows with each series what belongs to it, and the registrations as links', () => {
    source.add([
      series('1.1.1'),
      series('1.1.2', { modality: 'RTDOSE', description: 'Dose' }),
      series('1.2.1', { studyUid: '1.2', studyDate: '20260316', frameOfReferenceUid: '2.9' }),
    ]);
    // Before anything is known of them, nothing is said.
    expect(listedSeries(source).some((one) => one.attached)).toBe(false);
    expect(source.currentPatient()!.links).toEqual([]);

    source.addRtObjects([
      object('structure-set', '5.1', [['structure-set.series', '1.1.1']]),
      object('plan', '5.2', [['plan.structure-set', '5.1']]),
      object('dose', '5.3', [['dose.plan', '5.2']], { seriesUid: '1.1.2' }),
      object('registration', '5.4', [
        ['registration.frame', '1.9'],
        ['registration.frame', '2.9'],
      ]),
      object('plan', '5.5', []),
    ]);
    const listed = listedSeries(source);
    const of = (uid: string) => listed.find((one) => one.uid === uid)!;
    expect(of('1.1.1').attached!.map((one) => `${one.kind} by ${one.by}`)).toEqual([
      'structure-set by series',
      'plan by structure-set',
      'dose by plan',
    ]);
    // The dose is a series to show, and no image for anything to belong to.
    expect(of('1.1.2').attached).toBeUndefined();
    expect(of('1.2.1').attached).toBeUndefined();
    const history = source.currentPatient()!;
    expect(history.links).toEqual([
      {
        sopInstanceUid: '5.4',
        description: '5.4',
        deformable: false,
        ends: [['1.1.1'], ['1.2.1']],
      },
    ]);
    expect(history.studies[0].loose!.map((one) => one.sopInstanceUid)).toEqual(['5.5']);
  });

  it('marks a series and an object that say they are derived, and no other, whatever they are called (#254)', () => {
    const derivation = {
      description: 'Resampled by another system',
      date: null,
      time: null,
      relatedSeriesUids: [],
      sourceInstanceUids: [],
    };
    source.add([
      series('1.1.1', { description: 'Resampled: only called so' }),
      series('1.1.3', {
        description: 'CT on MR',
        metadata: { curated: [], rawTags: [], derivation },
      }),
      // An image that says nothing of the kind has no derivation.
      series('1.1.4', { metadata: { curated: [], rawTags: [], derivation: null } }),
    ]);
    source.addRtObjects([
      object('structure-set', '5.1', [['structure-set.series', '1.1.1']], {
        description: 'Propagated: only called so',
      }),
      object('structure-set', '5.2', [['structure-set.series', '1.1.1']], { derived: true }),
      object('dose', '5.3', [], { studyUid: '1.1', derived: true }),
    ]);
    const listed = listedSeries(source);
    const of = (uid: string) => listed.find((one) => one.uid === uid)!;
    expect(of('1.1.3').derived).toBe(true);
    expect(of('1.1.1')).not.toHaveProperty('derived');
    expect(of('1.1.4')).not.toHaveProperty('derived');
    expect(of('1.1.1').attached!.map((one) => [one.sopInstanceUid, one.derived])).toEqual([
      ['5.1', undefined],
      ['5.2', true],
    ]);
    // One that belongs to no series says so too, where it is listed.
    const everything = JSON.stringify(source.currentPatient());
    expect(everything).toContain('"sopInstanceUid":"5.3"');
    const loose = [
      ...source.currentPatient()!.studies.flatMap((study) => study.loose ?? []),
      ...listed.flatMap((one) => one.attached ?? []),
    ].find((one) => one.sopInstanceUid === '5.3')!;
    expect(loose.derived).toBe(true);
  });

  it('takes an object once, shows only the patient’s own, and lets go of them with the patient', () => {
    source.add([series('1.1.1')]);
    const set = object('structure-set', '5.1', [['structure-set.series', '1.1.1']]);
    source.addRtObjects([set]);
    source.addRtObjects([
      set,
      object('plan', '5.2', [['plan.structure-set', '5.1']], { patientId: 'SYN-0002' }),
    ]);
    // Another patient's plan names this patient's structure set: it is not this patient's to show.
    expect(listedSeries(source)[0].attached!.map((one) => one.sopInstanceUid)).toEqual(['5.1']);

    source.closePatient('SYN-0001');
    source.add([series('1.1.1')]);
    expect(listedSeries(source)[0].attached).toBeUndefined();
  });
});

describe('timepoints of a patient whose files were opened (#39)', () => {
  const MADE = [{ id: 'a', name: 'Planning', studyUids: ['1.2.840.1'] }];
  let source: LocalFilesSource;
  /** Let what is read from the browser arrive: an effect, a digest and a read. */
  const settled = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
      TestBed.tick();
      await new Promise((done) => setTimeout(done));
    }
  };
  beforeEach(() => {
    localStorage.clear();
    source = TestBed.inject(LocalFilesSource);
  });
  afterEach(() => localStorage.clear());

  it('are none until some are made, and are kept in this browser for the next time', async () => {
    source.add([series('1.1.1')]);
    await settled();
    expect(source.timepoints()).toEqual([]);
    await source.saveTimepoints(MADE);
    expect(source.timepoints()).toEqual(MADE);
    expect(await TestBed.inject(TimepointStore).read('SYN-0001')).toEqual(MADE);

    // Everything is closed and the page loaded again: the same patient is grouped as before.
    TestBed.resetTestingModule();
    const again = TestBed.inject(LocalFilesSource);
    again.add([series('1.1.1')]);
    expect(again.timepoints()).toEqual([]);
    await settled();
    expect(again.timepoints()).toEqual(MADE);
  });

  it('are the current patient’s only', async () => {
    source.add([series('1.1.1')]);
    await settled();
    await source.saveTimepoints(MADE);
    source.add([series('2.1.1', { patientId: 'SYN-0002' })]);
    expect(source.timepoints()).toEqual([]);
    await settled();
    expect(source.timepoints()).toEqual([]);
    source.selectPatient('SYN-0001');
    await settled();
    expect(source.timepoints()).toEqual(MADE);
  });

  it('hold while the files are open for a patient without an ID, and say that they are not kept', async () => {
    source.add([series('3.1.1', { patientId: '' })]);
    await settled();
    await expect(source.saveTimepoints(MADE)).rejects.toThrow(
      'Grouped until the files are closed. It is not kept: the files give no Patient ID to know the patient by again.',
    );
    expect(source.timepoints()).toEqual(MADE);
    expect(localStorage.length).toBe(0);
  });

  it('hold while the files are open when the browser stores nothing, and say so', async () => {
    source.add([series('1.1.1')]);
    await settled();
    const refused = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    await expect(source.saveTimepoints(MADE)).rejects.toThrow(
      'Grouped until the files are closed. It is not kept: this browser stores nothing for the page.',
    );
    refused.mockRestore();
    expect(source.timepoints()).toEqual(MADE);
  });

  it('are not to be kept with no patient open', async () => {
    await expect(source.saveTimepoints(MADE)).rejects.toThrow('No patient is open.');
  });
});
