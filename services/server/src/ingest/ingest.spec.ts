/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import {
  SYNTHETIC_RT_COURSE as COURSE,
  SYNTHETIC_STUDY,
  syntheticCtSeries,
  syntheticRtCourse,
  syntheticRtStruct,
  type SyntheticFile,
} from '@open-rt-studio/testdata';

import { readInstanceHeader } from '@open-rt-studio/dicom';
import { CoreStoppingError, createCore } from '../core/core.js';
import { createLogger } from '../logger.js';
import type { PacsIndex } from '../pacs-index/pacs-index.js';
import { openSqliteIndex } from '../pacs-index/sqlite-index.js';
import type { DicomStore } from '../store/dicom-store.js';
import { openFileStore } from '../store/file-store.js';
import { createMemoryStore } from '../store/memory-store.js';
import { sopInstanceUidOf } from '../store/testing.js';
import { createIngest, indexEntry, type Ingest, type ImportProgress } from './ingest.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function read(stream: Readable): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [];
  for await (const piece of stream) pieces.push(piece as Uint8Array);
  return new Uint8Array(Buffer.concat(pieces));
}

interface Pacs {
  readonly store: DicomStore;
  readonly index: PacsIndex;
  readonly ingest: Ingest;
  /** The log, one parsed line each. */
  readonly log: () => Record<string, unknown>[];
}

const indexes: PacsIndex[] = [];
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-ingest-'));
});
afterEach(async () => {
  await Promise.all(indexes.splice(0).map((index) => index.close()));
  await rm(scratch, { recursive: true, force: true });
});

/** A PACS in memory, with parts that a test may replace to make them fail. */
async function pacs(
  wrap: Partial<{ store: (s: DicomStore) => DicomStore; index: (i: PacsIndex) => PacsIndex }> = {},
): Promise<Pacs> {
  const index = await openSqliteIndex(':memory:');
  indexes.push(index);
  const store = createMemoryStore();
  const lines: string[] = [];
  const ingest = createIngest({
    store: wrap.store?.(store) ?? store,
    index: wrap.index?.(index) ?? index,
    logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
  });
  return {
    store,
    index,
    ingest,
    log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Everything a PACS holds, to compare one state with another. */
async function state({ store, index }: Pick<Pacs, 'store' | 'index'>) {
  const instances = await index.findInstances();
  return {
    counts: await index.counts(),
    instances,
    studies: await index.findStudies(),
    series: await index.findSeries(),
    stored: await Promise.all(instances.map((one) => store.stat(one.sopInstanceUid))),
  };
}

const COURSE_FILES = syntheticRtCourse();
const uidOf = (file: SyntheticFile): string => sopInstanceUidOf(file.bytes);

describe('ingest', () => {
  it('stores each file of the synthetic course and adds it to the index', async () => {
    const { store, index, ingest } = await pacs();
    for (const file of COURSE_FILES) {
      expect(await ingest.ingest(file.bytes)).toEqual({
        outcome: 'stored',
        sopInstanceUid: uidOf(file),
      });
    }
    expect(await index.counts()).toEqual({
      patients: 1,
      studies: 2,
      series: 7,
      instances: COURSE.instances,
    });
    for (const file of COURSE_FILES) {
      // The store has the file as it was given, and the index has the store's account of it.
      expect(await read(await store.get(uidOf(file)))).toEqual(file.bytes);
      expect(await index.getInstance(uidOf(file))).toMatchObject({
        size: file.bytes.byteLength,
        sha256: sha256(file.bytes),
      });
    }
  });

  it('files with each instance how many frames it has, and counts them as the images of its series', async () => {
    const { index, ingest } = await pacs();
    for (const file of COURSE_FILES) await ingest.ingest(file.bytes);

    const header = readInstanceHeader(
      COURSE_FILES.find((file) => uidOf(file) === COURSE.dose)!.bytes,
    );
    if (!header.ok) throw new Error('the dose has no header');
    // The dose is one file of several planes.
    expect(header.header.frames).toBeGreaterThan(1);
    expect((await index.getInstance(COURSE.dose))!.frames).toBe(header.header.frames);
    const [dose] = await index.findSeries({ modality: 'RTDOSE' });
    expect(dose).toMatchObject({ instances: 1, images: header.header.frames });
    // An image file says nothing of frames, and is one image.
    const ct = (await index.getSeries(COURSE.ct))!;
    expect(ct).toMatchObject({ instances: COURSE.ctSlices, images: COURSE.ctSlices });
  });

  it('learns the frames of an instance that was filed before they were kept, when the file comes again', async () => {
    const { store, index, ingest } = await pacs();
    const file = COURSE_FILES.find((one) => uidOf(one) === COURSE.dose)!;
    const header = readInstanceHeader(file.bytes);
    if (!header.ok) throw new Error('the dose has no header');
    // As an earlier version left it: the bytes stored, the entry without frames.
    await store.put(uidOf(file), file.bytes);
    const entry = indexEntry(header.header, {
      size: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    });
    await index.putInstance({ ...entry, instance: { ...entry.instance, frames: null } });
    expect((await index.findSeries({ modality: 'RTDOSE' }))[0].images).toBe(1);

    const put = vi.spyOn(store, 'put');
    expect(await ingest.ingest(file.bytes)).toEqual({
      outcome: 'unchanged',
      sopInstanceUid: uidOf(file),
    });
    expect(put).not.toHaveBeenCalled(); // nothing is written to the store
    expect((await index.getInstance(uidOf(file)))!.frames).toBe(header.header.frames);
    expect((await index.findSeries({ modality: 'RTDOSE' }))[0].images).toBe(header.header.frames);
  });

  // The issue's "done when": ingesting the synthetic dataset twice leaves one copy.
  it('leaves one copy when the dataset is ingested twice', async () => {
    const all = await pacs();
    for (const file of COURSE_FILES) await all.ingest.ingest(file.bytes);
    const once = await state(all);

    const put = vi.spyOn(all.store, 'put');
    for (const file of COURSE_FILES) {
      expect(await all.ingest.ingest(file.bytes)).toEqual({
        outcome: 'unchanged',
        sopInstanceUid: uidOf(file),
      });
    }
    expect(await state(all)).toEqual(once);
    expect(once.counts.instances).toBe(COURSE.instances);
    // Nothing was written the second time.
    expect(put).not.toHaveBeenCalled();
  });

  it('reads the relationships between the radiotherapy objects out of the files', async () => {
    const { index, ingest } = await pacs();
    // In an order a folder would not have: the dose first, its plan last.
    for (const file of [...COURSE_FILES].reverse()) await ingest.ingest(file.bytes);

    const related = (await index.relatedToSeries(COURSE.ct))!;
    expect(related.structureSets.map((one) => one.sopInstanceUid)).toEqual([COURSE.structureSet]);
    expect(related.plans.map((one) => one.sopInstanceUid)).toEqual([COURSE.plan]);
    expect(related.doses.map((one) => one.sopInstanceUid)).toEqual([COURSE.dose]);
    expect(related.registrations.map((one) => one.sopInstanceUid)).toEqual([COURSE.registration]);
    // Every series that says it is in the planning frame: the plan and the
    // registration say so too, and it is for the caller to pick by modality.
    expect(related.sameFrame.map((series) => series.modality)).toEqual([
      'MR',
      'RTPLAN',
      'RTDOSE',
      'REG',
    ]);
    expect(await index.referencesFrom(COURSE.dose)).toEqual([
      { relation: 'dose.plan', targetUid: COURSE.plan },
      { relation: 'dose.structure-set', targetUid: COURSE.structureSet },
    ]);
    const followUp = (await index.relatedToSeries(COURSE.followUpCt))!;
    expect(followUp.registrations.map((one) => one.sopInstanceUid)).toEqual([COURSE.registration]);
    expect(followUp.structureSets).toEqual([]);
  });

  it('files the instances under the patient and studies the files name', async () => {
    const { index, ingest } = await pacs();
    for (const file of COURSE_FILES) await ingest.ingest(file.bytes);
    expect(await index.findPatients()).toMatchObject([
      { patientId: SYNTHETIC_STUDY.patient.id, name: SYNTHETIC_STUDY.patient.name, studies: 2 },
    ]);
    expect(await index.getStudy(COURSE.planningStudy)).toMatchObject({
      date: SYNTHETIC_STUDY.date,
      description: SYNTHETIC_STUDY.description,
      modalities: ['CT', 'MR', 'RTDOSE', 'RTPLAN', 'RTSTRUCT'],
      instances: 8,
    });
    expect(
      (await index.findInstances({ seriesInstanceUid: COURSE.ct })).map((i) => i.number),
    ).toEqual([1, 2, 3]);
  });

  it('does not log who a file is about', async () => {
    const { ingest, log } = await pacs();
    for (const file of COURSE_FILES) await ingest.ingest(file.bytes);
    await ingest.ingest(new TextEncoder().encode('not a DICOM file'));
    const text = JSON.stringify(log());
    expect(log().length).toBeGreaterThan(COURSE.instances);
    expect(text).not.toContain(SYNTHETIC_STUDY.patient.id);
    expect(text).not.toContain('SYNTHETIC');
    expect(text).not.toContain('2.25.');
  });
});

describe('what is not taken', () => {
  it.each([
    ['not-dicom', new TextEncoder().encode('This is a text file. '.repeat(50))],
    ['not-dicom', new Uint8Array()],
  ] as const)('refuses bytes that are not a DICOM file (%s)', async (reason, bytes) => {
    const all = await pacs();
    expect(await all.ingest.ingest(bytes)).toEqual({ outcome: 'refused', reason });
    expect((await all.index.counts()).instances).toBe(0);
  });

  it('refuses a DICOM file that cannot be filed', async () => {
    const all = await pacs();
    // A slice cut off before its Study and Series UIDs: group 0008 only.
    const [slice] = syntheticCtSeries(1, 16);
    const view = new DataView(slice.bytes.buffer, slice.bytes.byteOffset);
    let at = 132;
    while (view.getUint16(at, true) < 0x0010) {
      const vr = String.fromCharCode(slice.bytes[at + 4], slice.bytes[at + 5]);
      const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
      at += long ? 12 + view.getUint32(at + 8, true) : 8 + view.getUint16(at + 6, true);
    }
    expect(await all.ingest.ingest(slice.bytes.slice(0, at))).toEqual({
      outcome: 'refused',
      reason: 'incomplete',
    });
    expect((await all.index.counts()).instances).toBe(0);
  });

  it('keeps what it has when other bytes arrive under the same UID', async () => {
    const all = await pacs();
    const first = syntheticRtStruct(3, 2);
    const other = syntheticRtStruct(3, 3); // one more ROI, the same SOP Instance UID
    expect(uidOf(other)).toBe(uidOf(first));
    expect(sha256(other.bytes)).not.toBe(sha256(first.bytes));
    await all.ingest.ingest(first.bytes);
    const before = await state(all);

    expect(await all.ingest.ingest(other.bytes)).toEqual({
      outcome: 'refused',
      reason: 'different-content',
    });
    expect(await state(all)).toEqual(before);
    expect(await read(await all.store.get(uidOf(first)))).toEqual(first.bytes);
  });

  it('replaces what it has when it is told to', async () => {
    const all = await pacs();
    const first = syntheticRtStruct(3, 2);
    const other = syntheticRtStruct(3, 3, { referencedSeriesUid: COURSE.ct });
    await all.ingest.ingest(first.bytes);
    expect(await all.index.referencesTo(COURSE.ct, 'structure-set.series')).toEqual([]);

    expect(await all.ingest.ingest(other.bytes, { onDifferent: 'replace' })).toEqual({
      outcome: 'replaced',
      sopInstanceUid: uidOf(first),
    });
    expect(await read(await all.store.get(uidOf(first)))).toEqual(other.bytes);
    expect(await all.index.getInstance(uidOf(first))).toMatchObject({
      size: other.bytes.byteLength,
      sha256: sha256(other.bytes),
    });
    // The index follows the new content: its references are the new file's.
    expect(await all.index.referencesTo(COURSE.ct, 'structure-set.series')).toHaveLength(1);
    expect((await all.index.counts()).instances).toBe(1);
  });

  it('refuses a file that places a known study under another patient, and stores nothing of it', async () => {
    const all = await pacs();
    for (const file of COURSE_FILES) await all.ingest.ingest(file.bytes);
    const before = await state(all);
    // The planning study's UIDs, with another patient's ID: a fourth CT slice.
    const [, , , stray] = syntheticCtSeries(4, 16, {
      study: { ...SYNTHETIC_STUDY, patient: { id: 'SYN-0002', name: 'OTHER^PERSON' } },
    });
    expect(await all.ingest.ingest(stray.bytes)).toEqual({
      outcome: 'refused',
      reason: 'study-of-another-patient',
    });
    expect(await state(all)).toEqual(before);
    expect(await all.store.exists(uidOf(stray))).toBe(false);
  });
});

// The issue's "done when": a failure mid-ingest leaves store and index consistent.
describe('a failure part-way', () => {
  const [SLICE] = syntheticCtSeries(1, 16);

  /** An index whose next `putInstance` fails as a database would. */
  function failingOnce(index: PacsIndex): PacsIndex {
    let failed = false;
    return new Proxy(index, {
      get(target, property, receiver) {
        if (property === 'putInstance' && !failed) {
          return async () => {
            failed = true;
            throw new Error('database is locked');
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  }

  it('leaves nothing in the store when the index fails, and can be tried again', async () => {
    const all = await pacs({ index: failingOnce });
    await expect(all.ingest.ingest(SLICE.bytes)).rejects.toThrow('database is locked');
    expect(await all.store.exists(uidOf(SLICE))).toBe(false);
    expect(await all.index.counts()).toEqual({ patients: 0, studies: 0, series: 0, instances: 0 });

    expect(await all.ingest.ingest(SLICE.bytes)).toMatchObject({ outcome: 'stored' });
    expect(await all.store.verify(uidOf(SLICE))).toBe(true);
    expect((await all.index.counts()).instances).toBe(1);
  });

  it('leaves nothing in the index when the store fails', async () => {
    const all = await pacs({
      store: (store) =>
        new Proxy(store, {
          get(target, property, receiver) {
            if (property === 'put') return () => Promise.reject(new Error('disk full'));
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
    });
    await expect(all.ingest.ingest(SLICE.bytes)).rejects.toThrow('disk full');
    expect(await all.index.counts()).toEqual({ patients: 0, studies: 0, series: 0, instances: 0 });
    expect(await all.store.exists(uidOf(SLICE))).toBe(false);
  });

  it('puts the old bytes back when the index fails during a replacement', async () => {
    const first = syntheticRtStruct(3, 2);
    const other = syntheticRtStruct(3, 3);
    const plain = await pacs();
    await plain.ingest.ingest(first.bytes);
    const before = await state(plain);
    // The same store and index, behind an ingest whose index fails once.
    const failing = createIngest({ store: plain.store, index: failingOnce(plain.index) });

    await expect(failing.ingest(other.bytes, { onDifferent: 'replace' })).rejects.toThrow(
      'database is locked',
    );
    expect(await state(plain)).toEqual(before);
    expect(await read(await plain.store.get(uidOf(first)))).toEqual(first.bytes);
    expect(await plain.store.verify(uidOf(first))).toBe(true);
  });

  it('finishes the job for bytes a crash left in the store without an index entry', async () => {
    const all = await pacs();
    // The state a process that died between the two writes leaves.
    await all.store.put(uidOf(SLICE), SLICE.bytes);
    expect(await all.index.getInstance(uidOf(SLICE))).toBeNull();

    const put = vi.spyOn(all.store, 'put');
    expect(await all.ingest.ingest(SLICE.bytes)).toEqual({
      outcome: 'stored',
      sopInstanceUid: uidOf(SLICE),
    });
    expect(put).not.toHaveBeenCalled(); // the bytes were there already
    expect(await all.index.getInstance(uidOf(SLICE))).toMatchObject({
      sha256: sha256(SLICE.bytes),
    });
    expect(await all.ingest.ingest(SLICE.bytes)).toMatchObject({ outcome: 'unchanged' });
  });

  it('stores an instance once when it arrives several times at once', async () => {
    const all = await pacs();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => all.ingest.ingest(SLICE.bytes)),
    );
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'stored',
      ...Array.from({ length: 5 }, () => 'unchanged'),
    ]);
    expect((await all.index.counts()).instances).toBe(1);
  });
});

describe('importing a folder', () => {
  /** The course as a folder a user might have: by study, with other files among it. */
  async function folder(): Promise<string> {
    const root = join(scratch, 'export');
    await mkdir(join(root, 'planning', 'images'), { recursive: true });
    await mkdir(join(root, 'follow-up'), { recursive: true });
    for (const file of COURSE_FILES) {
      const followUp = file.name.includes('-s2');
      const image = file.name.includes('ct') || file.name.includes('mr');
      const directory = followUp ? 'follow-up' : image ? join('planning', 'images') : 'planning';
      await writeFile(join(root, directory, file.name), file.bytes);
    }
    await writeFile(join(root, 'README.txt'), 'Exported for a test.');
    await writeFile(join(root, 'planning', '.DS_Store'), new Uint8Array(64));
    return root;
  }

  async function onDisk(): Promise<Pacs> {
    const index = await openSqliteIndex(join(scratch, 'index.sqlite'));
    indexes.push(index);
    const store = await openFileStore(join(scratch, 'store'));
    return { store, index, ingest: createIngest({ store, index }), log: () => [] };
  }

  it('ingests every file below the folder, and says what it did with each', async () => {
    const root = await folder();
    expect((await readdir(root, { recursive: true })).length).toBeGreaterThan(COURSE.instances);
    const all = await onDisk();
    const progress: ImportProgress[] = [];

    const summary = await all.ingest.importFolder(root, { onProgress: (p) => progress.push(p) });

    expect(summary).toEqual({
      total: COURSE.instances + 2,
      stored: COURSE.instances,
      unchanged: 0,
      replaced: 0,
      refused: [
        { path: 'README.txt', reason: 'not-dicom' },
        { path: join('planning', '.DS_Store'), reason: 'not-dicom' },
      ],
      failed: [],
      cancelled: false,
    });
    // Progress counts every file, one at a time, to the total.
    expect(progress.map((p) => p.done)).toEqual(
      Array.from({ length: COURSE.instances + 2 }, (_, i) => i + 1),
    );
    expect(new Set(progress.map((p) => p.total))).toEqual(new Set([COURSE.instances + 2]));
    expect(await all.index.counts()).toMatchObject({ studies: 2, instances: COURSE.instances });
    expect(await all.store.verify(COURSE.dose)).toBe(true);
  });

  it('changes nothing when the same folder is imported again', async () => {
    const root = await folder();
    const all = await onDisk();
    await all.ingest.importFolder(root);
    const once = await state(all);
    const again = await all.ingest.importFolder(root);
    expect(again).toMatchObject({ stored: 0, unchanged: COURSE.instances, replaced: 0 });
    expect(await state(all)).toEqual(once);
  });

  it('stops after the file in hand when it is cancelled, and picks up where it left off', async () => {
    const root = await folder();
    const all = await onDisk();
    const stop = new AbortController();
    const first = await all.ingest.importFolder(root, {
      signal: stop.signal,
      onProgress: ({ done }) => {
        if (done === 4) stop.abort();
      },
    });
    expect(first.cancelled).toBe(true);
    expect(first.stored + first.refused.length).toBe(4);
    const held = (await all.index.counts()).instances;
    expect(held).toBe(first.stored);

    const second = await all.ingest.importFolder(root);
    expect(second.cancelled).toBe(false);
    expect(second.unchanged).toBe(held);
    expect(second.stored).toBe(COURSE.instances - held);
    expect((await all.index.counts()).instances).toBe(COURSE.instances);
  });

  it('goes on past a file that fails, and names it by the kind of error', async () => {
    const root = await folder();
    const all = await onDisk();
    let calls = 0;
    const flaky = createIngest({
      store: all.store,
      index: new Proxy(all.index, {
        get(target, property, receiver) {
          if (property === 'putInstance') {
            return async (...args: Parameters<PacsIndex['putInstance']>) => {
              if (++calls === 2)
                throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' });
              return target.putInstance(...args);
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    });
    const summary = await flaky.importFolder(root);
    expect(summary.failed).toEqual([
      { path: expect.any(String) as string, error: 'ERR_SQLITE_ERROR' },
    ]);
    expect(summary.stored).toBe(COURSE.instances - 1);
    expect(summary.cancelled).toBe(false);
    // What failed left nothing behind, and the next import takes it.
    expect((await all.index.counts()).instances).toBe(COURSE.instances - 1);
    expect((await all.ingest.importFolder(root)).stored).toBe(1);
  });

  it('says so when the folder is not there', async () => {
    const all = await onDisk();
    await expect(all.ingest.importFolder(join(scratch, 'nowhere'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('a core with a PACS', () => {
  it('has none unless it is given a store and an index', () => {
    expect(createCore().pacs).toBeNull();
  });

  it('counts an ingest as work: a shutdown waits for it, then closes the index', async () => {
    const index = await openSqliteIndex(':memory:');
    const store = createMemoryStore();
    const close = vi.spyOn(index, 'close');
    // A store that takes its time, so that the ingest is still going when the core is disposed.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'put') {
          return async (...args: Parameters<DicomStore['put']>) => {
            await held;
            return target.put(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const core = createCore({ pacs: { store: slow, index } });
    const [slice] = syntheticCtSeries(1, 16);

    const ingesting = core.pacs!.ingest.ingest(slice.bytes);
    await vi.waitFor(() => expect(core.health().inFlight).toBe(1));
    let disposed = false;
    const disposal = core.dispose().then((result) => {
      disposed = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(disposed).toBe(false);
    expect(close).not.toHaveBeenCalled();

    release();
    expect(await ingesting).toMatchObject({ outcome: 'stored' });
    expect(await disposal).toEqual({ finished: true, abandoned: 0 });
    expect(close).toHaveBeenCalledTimes(1);
    // The instance made it into the store before the core stopped.
    expect(await store.exists(sopInstanceUidOf(slice.bytes))).toBe(true);
  });

  it('takes no ingest once it is stopping', async () => {
    const index = await openSqliteIndex(':memory:');
    const core = createCore({ pacs: { store: createMemoryStore(), index } });
    await core.dispose();
    const [slice] = syntheticCtSeries(1, 16);
    await expect(core.pacs!.ingest.ingest(slice.bytes)).rejects.toBeInstanceOf(CoreStoppingError);
    await expect(core.pacs!.ingest.importFolder(scratch)).rejects.toBeInstanceOf(CoreStoppingError);
  });
});
