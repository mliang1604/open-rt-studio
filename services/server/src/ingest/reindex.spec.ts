/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Making an index again from the store (#328), into an index in SQLite and,
// where there is a PostgreSQL to run against (`pacs-index/postgres-testing.ts`),
// into one there.

import {
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_PATIENT,
  SYNTHETIC_RT_COURSE,
  SYNTHETIC_STUDY,
  SYNTHETIC_UTF8_PATIENT,
  syntheticCharacterSetPatient,
  syntheticCtSeries,
  syntheticRtCourse,
  type SyntheticFile,
} from '@open-rt-studio/testdata';

import { createLogger } from '../logger.js';
import type { PacsIndex } from '../pacs-index/pacs-index.js';
import { openPostgresIndex } from '../pacs-index/postgres-index.js';
import { POSTGRES, testSchemas, type TestSchemas } from '../pacs-index/postgres-testing.js';
import { openSqliteIndex } from '../pacs-index/sqlite-index.js';
import type { DicomStore, StoredInstance } from '../store/dicom-store.js';
import { InstanceNotFoundError } from '../store/dicom-store.js';
import { createMemoryStore } from '../store/memory-store.js';
import { sopInstanceUidOf } from '../store/testing.js';
import { createIngest } from './ingest.js';
import { copyTimepoints, filledWhole, fillIndex } from './reindex.js';

const COURSE = SYNTHETIC_RT_COURSE;
const FILES = syntheticRtCourse();
/** Another patient, whose name is not in ASCII, with a study of their own. */
const OTHER = syntheticCharacterSetPatient(SYNTHETIC_UTF8_PATIENT);

const INDEXES = POSTGRES ? (['SQLite', 'PostgreSQL'] as const) : (['SQLite'] as const);
let schemas: TestSchemas | null = null;
const open: PacsIndex[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((index) => index.close()));
});
afterAll(async () => {
  await schemas?.drop();
});

async function emptyIndex(where: (typeof INDEXES)[number] = 'SQLite'): Promise<PacsIndex> {
  const index =
    where === 'SQLite'
      ? await openSqliteIndex(':memory:')
      : await openPostgresIndex(await (schemas ??= testSchemas()).fresh(), { connections: 4 });
  open.push(index);
  return index;
}

/** A store and the index that ingesting these files into it gave. */
async function ingested(files: readonly SyntheticFile[]) {
  const store = createMemoryStore();
  const index = await emptyIndex();
  const ingest = createIngest({ store, index });
  for (const file of files) {
    expect((await ingest.ingest(file.bytes)).outcome, file.name).toBe('stored');
  }
  return { store, index };
}

/** Everything an index can be asked, without the numbers it gives its patients. */
async function everything(index: PacsIndex) {
  const keyless = <T extends { patientKey: number }>({ patientKey: _, ...rest }: T) => {
    void _;
    return rest;
  };
  const series = await index.findSeries();
  const instances = await index.findInstances();
  return {
    counts: await index.counts(),
    patients: (await index.findPatients()).map(keyless),
    studies: (await index.findStudies({ order: 'patient' })).map(keyless),
    series,
    instances,
    related: await Promise.all(series.map((one) => index.relatedToSeries(one.seriesInstanceUid))),
    of: await Promise.all(
      instances.map(async ({ sopInstanceUid }) => ({
        references: await index.referencesFrom(sopInstanceUid),
        plan: await index.planOf(sopInstanceUid),
        dose: await index.doseOf(sopInstanceUid),
      })),
    ),
  };
}

describe.each(INDEXES)('filling an index in %s from the store', (where) => {
  it('gives the index that ingesting the same files gave', async () => {
    const { store, index } = await ingested([...FILES, ...OTHER]);
    const again = await emptyIndex(where);

    const summary = await fillIndex({ store, index: again });
    expect(summary).toEqual({
      instances: FILES.length + OTHER.length,
      added: FILES.length + OTHER.length,
      updated: 0,
      unreadable: 0,
      conflicts: 0,
      gone: 0,
    });
    expect(filledWhole(summary)).toBe(true);
    const expected = await everything(index);
    expect(expected.counts).toMatchObject({ patients: 2, studies: 3 });
    expect(expected.related.some((related) => related!.registrations.length > 0)).toBe(true);
    expect(expected.of.some((one) => one.plan !== null)).toBe(true);
    expect(expected.of.some((one) => one.dose !== null)).toBe(true);
    expect(await everything(again)).toEqual(expected);
  });

  it('can be done again, and brings an index that has a part up to date', async () => {
    const { store, index } = await ingested(FILES);
    const partial = await emptyIndex(where);
    const half = createMemoryStore();
    for (const file of FILES.slice(0, 4)) await half.put(sopInstanceUidOf(file.bytes), file.bytes);
    expect(await fillIndex({ store: half, index: partial })).toMatchObject({ added: 4 });

    expect(await fillIndex({ store, index: partial })).toMatchObject({
      instances: FILES.length,
      added: FILES.length - 4,
      updated: 4,
    });
    expect(await everything(partial)).toEqual(await everything(index));
    expect(await fillIndex({ store, index: partial })).toMatchObject({
      added: 0,
      updated: FILES.length,
    });
    expect(await everything(partial)).toEqual(await everything(index));
  });

  it('leaves out what cannot be filed, files the rest, and says how many of each', async () => {
    const { store } = await ingested(FILES);
    const [first, second] = syntheticCtSeries(2, 16, { study: { ...SYNTHETIC_STUDY, index: 7 } });
    // Bytes that are no DICOM object, and bytes that say they are another instance.
    await store.put('1.2.826.0.1.3680043.999.1', new TextEncoder().encode('not DICOM at all'));
    await store.put(sopInstanceUidOf(first.bytes), second.bytes);
    const index = await emptyIndex(where);
    // The index has one of the course's instances in another series already.
    const ct = (await store.stat(sopInstanceUidOf(FILES[0].bytes)))!;
    await index.putInstance({
      patient: { id: 'ELSEWHERE', name: null, birthDate: null, sex: null },
      study: {
        uid: '1.2.826.0.1.3680043.999.3',
        date: null,
        time: null,
        description: null,
        accessionNumber: null,
      },
      series: {
        uid: '1.2.826.0.1.3680043.999.3.1',
        modality: 'CT',
        number: null,
        description: null,
        frameOfReferenceUid: null,
      },
      instance: {
        uid: ct.sopInstanceUid,
        sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
        number: null,
        frames: null,
        size: ct.size,
        sha256: ct.sha256,
      },
      references: [],
    });

    const lines: string[] = [];
    const summary = await fillIndex({
      store,
      index,
      logger: createLogger({ level: 'info', write: (line) => lines.push(line) }),
    });
    expect(summary).toEqual({
      instances: FILES.length + 2,
      added: FILES.length - 1,
      updated: 0,
      unreadable: 2,
      conflicts: 1,
      gone: 0,
    });
    // What the index had is as it was.
    expect((await index.getInstance(ct.sopInstanceUid))?.seriesInstanceUid).toBe(
      '1.2.826.0.1.3680043.999.3.1',
    );
    expect(filledWhole(summary)).toBe(false);
    // The log has the counts, and nothing of what was filed.
    const said = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(said.at(-1)).toMatchObject({ event: 'index-filled', unreadable: 2, conflicts: 1 });
    expect(lines.join('\n')).not.toContain(SYNTHETIC_PATIENT.id);
    expect(lines.join('\n')).not.toContain(COURSE.planningStudy);
  });

  it('takes nothing out of the index, and passes over what leaves the store as it reads', async () => {
    const { store } = await ingested(FILES);
    const index = await emptyIndex(where);
    // Something the index lists that the store does not hold.
    const only = createMemoryStore();
    for (const file of OTHER) await only.put(sopInstanceUidOf(file.bytes), file.bytes);
    await fillIndex({ store: only, index });
    // And an instance that is listed, and gone when it is asked for.
    const ghost: StoredInstance = {
      sopInstanceUid: '1.2.826.0.1.3680043.999.2',
      size: 1,
      sha256: '0'.repeat(64),
    };
    const leaking: DicomStore = {
      ...store,
      async *list() {
        yield ghost;
        yield* store.list();
      },
      get: (uid, part) =>
        uid === ghost.sopInstanceUid
          ? Promise.reject(new InstanceNotFoundError())
          : store.get(uid, part),
    };
    const seen: number[] = [];
    const summary = await fillIndex({
      store: leaking,
      index,
      onProgress: (soFar) => seen.push(soFar.instances),
    });
    expect(summary).toMatchObject({ instances: FILES.length + 1, added: FILES.length, gone: 1 });
    expect(filledWhole(summary)).toBe(true);
    expect(seen).toEqual(Array.from({ length: FILES.length + 1 }, (_, n) => n + 1));
    expect((await index.counts()).instances).toBe(FILES.length + OTHER.length);
  });
});

describe.each(INDEXES)('bringing timepoints into an index in %s', (where) => {
  const BASELINE = { id: 't1', name: 'Baseline', studyUids: [COURSE.planningStudy] };
  const LATER = { id: 't2', name: 'After — 3 months', studyUids: [COURSE.followUpStudy] };
  const patientOf = async (index: PacsIndex, studyUid: string): Promise<number> =>
    (await index.getStudy(studyUid))!.patientKey;

  it('brings them to the same patient, whatever number each index gives them', async () => {
    const { store, index: old } = await ingested([...FILES, ...OTHER]);
    await old.putTimepoints(await patientOf(old, COURSE.planningStudy), [BASELINE, LATER]);
    // The other index met the patients in another order.
    const next = await emptyIndex(where);
    const others = createMemoryStore();
    for (const file of OTHER) await others.put(sopInstanceUidOf(file.bytes), file.bytes);
    await fillIndex({ store: others, index: next });
    await fillIndex({ store, index: next });
    const there = await patientOf(next, COURSE.planningStudy);
    expect(there).not.toBe(await patientOf(old, COURSE.planningStudy));

    expect(await copyTimepoints(old, next)).toEqual({
      patients: 1,
      copied: 1,
      alreadyThere: 0,
      withoutPatient: 0,
      studiesLeftOut: 0,
    });
    expect(await next.getTimepoints(there)).toEqual([BASELINE, LATER]);
    // The patient that had none has none.
    const other = (await next.findPatients({ patientId: SYNTHETIC_UTF8_PATIENT.id }))[0];
    expect(await next.getTimepoints(other.patientKey)).toEqual([]);
  });

  it('never replaces what was made in the index since, so it can be done again', async () => {
    const { store, index: old } = await ingested(FILES);
    await old.putTimepoints(await patientOf(old, COURSE.planningStudy), [BASELINE]);
    const next = await emptyIndex(where);
    await fillIndex({ store, index: next });
    const there = await patientOf(next, COURSE.planningStudy);
    await next.putTimepoints(there, [LATER]);

    expect(await copyTimepoints(old, next)).toMatchObject({ copied: 0, alreadyThere: 1 });
    expect(await next.getTimepoints(there)).toEqual([LATER]);
  });

  it('leaves out a study the index does not have, and a patient it does not have', async () => {
    const { index: old } = await ingested([...FILES, ...OTHER]);
    await old.putTimepoints(await patientOf(old, COURSE.planningStudy), [BASELINE, LATER]);
    const stranger = (await old.findPatients({ patientId: SYNTHETIC_UTF8_PATIENT.id }))[0];
    const theirs = (await old.findStudies({ patientKey: stranger.patientKey }))[0];
    await old.putTimepoints(stranger.patientKey, [
      { id: 't9', name: 'Only', studyUids: [theirs.studyInstanceUid] },
    ]);
    // The other index has the planning study alone.
    const next = await emptyIndex(where);
    const planning = createMemoryStore();
    for (const file of FILES) {
      const uid = sopInstanceUidOf(file.bytes);
      const study = (await old.getInstance(uid))!.studyInstanceUid;
      if (study === COURSE.planningStudy) await planning.put(uid, file.bytes);
    }
    await fillIndex({ store: planning, index: next });

    expect(await copyTimepoints(old, next)).toEqual({
      patients: 2,
      copied: 1,
      alreadyThere: 0,
      withoutPatient: 1,
      studiesLeftOut: 1,
    });
    expect(await next.getTimepoints(await patientOf(next, COURSE.planningStudy))).toEqual([
      BASELINE,
      { ...LATER, studyUids: [] },
    ]);
    expect(SYNTHETIC_FOLLOW_UP_STUDY.description).not.toBe('');
  });
});
