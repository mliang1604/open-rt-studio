/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The listener asked what it holds, and to send it (#52), by the library's
// own client. DCMTK's findscu, movescu and getscu ask it in dcmtk.spec.ts.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SYNTHETIC_RT_COURSE, syntheticRtCourse } from '@open-rt-studio/testdata';

import type { Pacs } from '../core/core.js';
import { syntheticRtDataset } from '../pacs-index/testing.js';
import { FIND_STATUS, STORE_STATUS, type DicomListenerOptions } from './listener.js';
import { dataSetOf } from './part10.js';
import { RETRIEVE_STATUS } from './retrieve.js';
import {
  converse,
  findRequest,
  freePort,
  getRequest,
  LISTENER_AE,
  moveRequest,
  PEER_AE,
  startTestListener,
  storeRequest,
  type TestListener,
} from './testing/peer.js';

const COURSE = SYNTHETIC_RT_COURSE;
const PATIENT_FIND = '1.2.840.10008.5.1.4.1.2.1.1';
const PATIENT_MOVE = '1.2.840.10008.5.1.4.1.2.1.2';
const PATIENT_GET = '1.2.840.10008.5.1.4.1.2.1.3';
const STUDY_FIND = '1.2.840.10008.5.1.4.1.2.2.1';
const STUDY_MOVE = '1.2.840.10008.5.1.4.1.2.2.2';
const STUDY_GET = '1.2.840.10008.5.1.4.1.2.2.3';
/** A system that may store here and may not retrieve. */
const STORER_AE = 'STORER';
/** The third system, which a move sends to. */
const DESTINATION_AE = 'ARCHIVE';

const open: TestListener[] = [];
afterEach(async () => {
  for (const one of open.splice(0)) await one.close();
});

type Options = Partial<Omit<DicomListenerOptions, 'pacs'>>;

/** A listener that holds the synthetic course, which PEER may retrieve from and STORER store to. */
async function holding(options: Options = {}): Promise<TestListener> {
  const started = await startTestListener({
    callers: [STORER_AE],
    retrievers: [PEER_AE],
    ...options,
  });
  open.push(started);
  for (const file of syntheticRtCourse()) {
    expect((await started.core.pacs!.ingest.ingest(file.bytes)).outcome).toBe('stored');
  }
  return started;
}

/** The third system: it lets in the listener under test, and holds nothing. */
async function destination(options: Options = {}): Promise<TestListener> {
  const started = await startTestListener({
    aeTitle: DESTINATION_AE,
    callers: [LISTENER_AE],
    ...options,
  });
  open.push(started);
  return started;
}

async function kept(pacs: Pacs, sopInstanceUid: string): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for await (const piece of await pacs.store.get(sopInstanceUid)) pieces.push(piece as Buffer);
  return Buffer.concat(pieces);
}

const statuses = (answers: readonly { status: number }[]): number[] =>
  answers.map((answer) => answer.status);
const name = (value: unknown): unknown =>
  Array.isArray(value) ? (value[0] as { Alphabetic?: string }).Alphabetic : value;

describe('a C-FIND to the listener', () => {
  it('answers the studies that match, each as a pending answer, and then success', async () => {
    const server = await holding();
    const { answers, rejected } = await converse(server.port, [
      findRequest(STUDY_FIND, {
        QueryRetrieveLevel: 'STUDY',
        PatientName: 'SYNTH*',
        PatientID: '',
        StudyInstanceUID: '',
        StudyDate: '',
        ModalitiesInStudy: '',
        NumberOfStudyRelatedInstances: '',
      }),
    ]);
    expect(rejected).toBe(false);
    expect(statuses(answers[0])).toEqual([
      FIND_STATUS.pending,
      FIND_STATUS.pending,
      FIND_STATUS.success,
    ]);
    const [patient] = await server.core.pacs!.index.findPatients();
    const [followUp, planning] = answers[0].map((answer) => answer.identifier!);
    expect(followUp['StudyInstanceUID']).toBe(COURSE.followUpStudy);
    expect(planning['StudyInstanceUID']).toBe(COURSE.planningStudy);
    expect(name(planning['PatientName'])).toBe(patient.name);
    expect(planning['PatientID']).toBe(patient.patientId);
    expect(planning['RetrieveAETitle']).toBe(LISTENER_AE);
    expect(planning['QueryRetrieveLevel']).toBe('STUDY');
    expect(planning['NumberOfStudyRelatedInstances']).toBe(COURSE.ctSlices + COURSE.mrSlices + 3);
    expect([...(planning['ModalitiesInStudy'] as string[])].sort()).toEqual(
      ['CT', 'MR', 'RTDOSE', 'RTPLAN', 'RTSTRUCT'].sort(),
    );
    // The last answer carries no identifier.
    expect(answers[0][2].identifier).toBeNull();
  });

  it('answers each level of the patient root', async () => {
    const server = await holding();
    const [patient] = await server.core.pacs!.index.findPatients();
    const { answers } = await converse(server.port, [
      findRequest(PATIENT_FIND, { QueryRetrieveLevel: 'PATIENT', PatientID: '', PatientName: '' }),
      findRequest(PATIENT_FIND, {
        QueryRetrieveLevel: 'SERIES',
        StudyInstanceUID: COURSE.planningStudy,
        Modality: 'CT',
        NumberOfSeriesRelatedInstances: '',
      }),
      findRequest(PATIENT_FIND, {
        QueryRetrieveLevel: 'IMAGE',
        StudyInstanceUID: COURSE.planningStudy,
        SeriesInstanceUID: COURSE.ct,
        SOPInstanceUID: '',
      }),
    ]);
    expect(answers[0].map((answer) => answer.identifier?.['PatientID'])).toEqual([
      patient.patientId,
      undefined,
    ]);
    expect(answers[1][0].identifier).toMatchObject({
      SeriesInstanceUID: COURSE.ct,
      NumberOfSeriesRelatedInstances: COURSE.ctSlices,
    });
    expect(statuses(answers[2])).toEqual([
      ...Array.from({ length: COURSE.ctSlices }, () => FIND_STATUS.pending),
      FIND_STATUS.success,
    ]);
  });

  it('says of a match that a key was left out, of a question with a key it does not answer', async () => {
    const server = await holding();
    const { answers } = await converse(server.port, [
      findRequest(STUDY_FIND, {
        QueryRetrieveLevel: 'STUDY',
        StudyInstanceUID: COURSE.planningStudy,
        ReferringPhysicianName: '',
      }),
    ]);
    expect(statuses(answers[0])).toEqual([FIND_STATUS.pendingKeysLeftOut, FIND_STATUS.success]);
    expect('ReferringPhysicianName' in answers[0][0].identifier!).toBe(false);
  });

  it('answers no more matches than it may, and ends by saying there were more', async () => {
    const server = await holding({ findAtMost: 4 });
    const { answers } = await converse(server.port, [
      findRequest(STUDY_FIND, { QueryRetrieveLevel: 'IMAGE', SOPInstanceUID: '' }),
    ]);
    expect(statuses(answers[0])).toEqual([
      ...Array.from({ length: 4 }, () => FIND_STATUS.pending),
      FIND_STATUS.tooMany,
    ]);
  });

  it('refuses an identifier that cannot be one, and finds nothing where nothing matches', async () => {
    const server = await holding();
    const { answers } = await converse(server.port, [
      findRequest(STUDY_FIND, { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: '1.2.*' }),
      findRequest(STUDY_FIND, { QueryRetrieveLevel: 'PATIENT', PatientID: '' }),
      findRequest(STUDY_FIND, { QueryRetrieveLevel: 'STUDY', PatientName: 'NOBODY*' }),
    ]);
    expect(statuses(answers[0])).toEqual([FIND_STATUS.identifierMismatch]);
    expect(statuses(answers[1])).toEqual([FIND_STATUS.identifierMismatch]);
    expect(statuses(answers[2])).toEqual([FIND_STATUS.success]);
  });

  it('answers text that is not ASCII so that it is read as it is held', async () => {
    const server = await startTestListener({ callers: [], retrievers: [PEER_AE] });
    open.push(server);
    const [one] = syntheticRtDataset();
    await server.core.pacs!.index.putInstance({
      ...one,
      patient: { ...one.patient, name: 'MÜLLER^SYNTHETIC' },
    });
    const { answers } = await converse(server.port, [
      findRequest(STUDY_FIND, { QueryRetrieveLevel: 'STUDY', PatientID: '', PatientName: '' }),
    ]);
    expect(statuses(answers[0])).toEqual([FIND_STATUS.pending, FIND_STATUS.success]);
    expect(name(answers[0][0].identifier!['PatientName'])).toBe('MÜLLER^SYNTHETIC');
    expect(answers[0][0].identifier!['PatientID']).toBe(one.patient.id);
  });

  it('is not for a system that may only store, nor for one that is not known', async () => {
    const server = await holding();
    const question = () =>
      findRequest(STUDY_FIND, { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: '' });
    // Let in, and not for this: the request has no context to go on.
    const storer = await converse(server.port, [question()], { callingAeTitle: STORER_AE });
    expect(storer.rejected).toBe(false);
    expect(storer.answers[0]).toEqual([]);
    const stranger = await converse(server.port, [question()], { callingAeTitle: 'STRANGER' });
    expect(stranger.rejected).toBe(true);
    expect(stranger.answers[0]).toEqual([]);
  });
});

describe('a C-MOVE to the listener', () => {
  /** A listener that knows where the third system is. */
  const moving = async (there: TestListener | { port: number }, options: Options = {}) =>
    holding({
      destinationOf: (aeTitle) =>
        aeTitle === DESTINATION_AE ? { host: '127.0.0.1', port: there.port } : null,
      moveTimeoutMs: 3_000,
      ...options,
    });

  it('sends a study to the system that is named, each object as it is stored', async () => {
    const there = await destination();
    const server = await moving(there, { retrieveLimits: { instancesAtOnce: 3 } });
    const { answers } = await converse(server.port, [
      moveRequest(STUDY_MOVE, DESTINATION_AE, {
        QueryRetrieveLevel: 'STUDY',
        StudyInstanceUID: COURSE.planningStudy,
      }),
    ]);
    const sent = await server.core.pacs!.index.findInstances({
      studyInstanceUid: COURSE.planningStudy,
    });
    expect(sent).toHaveLength(COURSE.ctSlices + COURSE.mrSlices + 3);
    // Eight instances, three to a part: told how far it is after the first and the second.
    // (Of the last answer the library's client reads what remained from the
    // one before; the server sends none with it, which movescu shows.)
    expect(answers[0]).toMatchObject([
      { status: RETRIEVE_STATUS.pending, remaining: 5, completed: 3, failed: 0 },
      { status: RETRIEVE_STATUS.pending, remaining: 2, completed: 6, failed: 0 },
      { status: RETRIEVE_STATUS.success, completed: 8, failed: 0 },
    ]);
    expect(await there.core.pacs!.index.counts()).toMatchObject({ instances: sent.length });
    for (const { sopInstanceUid } of sent) {
      const [ours, theirs] = await Promise.all([
        kept(server.core.pacs!, sopInstanceUid),
        kept(there.core.pacs!, sopInstanceUid),
      ]);
      expect(Buffer.from(dataSetOf(theirs)!).equals(Buffer.from(dataSetOf(ours)!))).toBe(true);
    }
  });

  it('sends a patient, a series, or the instances that are named', async () => {
    const there = await destination();
    const server = await moving(there);
    const [patient] = await server.core.pacs!.index.findPatients();
    const { answers } = await converse(server.port, [
      moveRequest(STUDY_MOVE, DESTINATION_AE, {
        QueryRetrieveLevel: 'IMAGE',
        StudyInstanceUID: COURSE.planningStudy,
        SOPInstanceUID: [COURSE.structureSet, COURSE.dose],
      }),
      moveRequest(STUDY_MOVE, DESTINATION_AE, {
        QueryRetrieveLevel: 'SERIES',
        StudyInstanceUID: COURSE.planningStudy,
        SeriesInstanceUID: COURSE.mr,
      }),
      moveRequest(PATIENT_MOVE, DESTINATION_AE, {
        QueryRetrieveLevel: 'PATIENT',
        PatientID: patient.patientId,
      }),
    ]);
    expect(answers.map((of) => of.at(-1))).toMatchObject([
      { status: RETRIEVE_STATUS.success, completed: 2 },
      { status: RETRIEVE_STATUS.success, completed: COURSE.mrSlices },
      { status: RETRIEVE_STATUS.success, completed: COURSE.instances },
    ]);
    expect(await there.core.pacs!.index.counts()).toMatchObject({ instances: COURSE.instances });
  });

  it('does not know a destination that is not on its list', async () => {
    const there = await destination();
    const server = await moving(there);
    const { answers } = await converse(server.port, [
      moveRequest(STUDY_MOVE, 'ELSEWHERE', {
        QueryRetrieveLevel: 'STUDY',
        StudyInstanceUID: COURSE.planningStudy,
      }),
    ]);
    expect(statuses(answers[0])).toEqual([RETRIEVE_STATUS.destinationUnknown]);
    expect(await there.core.pacs!.index.counts()).toMatchObject({ instances: 0 });
  });

  it('says that nothing was sent, and names what was not, when the destination does not answer', async () => {
    const server = await moving(
      { port: await freePort() },
      {
        retrieveLimits: { instancesAtOnce: 1 },
      },
    );
    const { answers } = await converse(server.port, [
      moveRequest(STUDY_MOVE, DESTINATION_AE, {
        QueryRetrieveLevel: 'SERIES',
        StudyInstanceUID: COURSE.planningStudy,
        SeriesInstanceUID: COURSE.ct,
      }),
    ]);
    // The first part found nobody there, and the rest was not tried.
    expect(answers[0]).toHaveLength(1);
    expect(answers[0][0]).toMatchObject({
      status: RETRIEVE_STATUS.noneSent,
      completed: 0,
      failed: COURSE.ctSlices,
    });
    const held = await server.core.pacs!.index.findInstances({ seriesInstanceUid: COURSE.ct });
    expect([answers[0][0].identifier!['FailedSOPInstanceUIDList']].flat().sort()).toEqual(
      held.map((one) => one.sopInstanceUid).sort(),
    );
  });

  it('counts what the destination refused, and names it', async () => {
    const there = await destination();
    // The destination holds other bytes under one of the UIDs: it refuses that one.
    const other = syntheticRtCourse(8).find(
      (file) => !syntheticRtCourse().some((ours) => Buffer.from(ours.bytes).equals(file.bytes)),
    )!;
    const refused = await there.core.pacs!.ingest.ingest(other.bytes);
    expect(refused.outcome).toBe('stored');
    const uid = (await there.core.pacs!.index.findInstances())[0].sopInstanceUid;
    const { seriesInstanceUid, studyInstanceUid } =
      (await there.core.pacs!.index.getInstance(uid))!;

    const server = await moving(there);
    const { answers } = await converse(server.port, [
      moveRequest(STUDY_MOVE, DESTINATION_AE, {
        QueryRetrieveLevel: 'SERIES',
        StudyInstanceUID: studyInstanceUid,
        SeriesInstanceUID: seriesInstanceUid,
      }),
    ]);
    const last = answers[0].at(-1)!;
    const inSeries = (await server.core.pacs!.index.findInstances({ seriesInstanceUid })).length;
    expect(last).toMatchObject({
      status: RETRIEVE_STATUS.someFailed,
      completed: inSeries - 1,
      failed: 1,
    });
    expect([last.identifier!['FailedSOPInstanceUIDList']].flat()).toEqual([uid]);
  });

  it('sends nothing for more instances than one retrieve sends, or for an identifier without its key', async () => {
    const there = await destination();
    const server = await moving(there, { retrieveAtMost: 3 });
    const { answers } = await converse(server.port, [
      moveRequest(STUDY_MOVE, DESTINATION_AE, {
        QueryRetrieveLevel: 'STUDY',
        StudyInstanceUID: COURSE.planningStudy,
      }),
      moveRequest(STUDY_MOVE, DESTINATION_AE, { QueryRetrieveLevel: 'STUDY' }),
      moveRequest(STUDY_MOVE, DESTINATION_AE, {
        QueryRetrieveLevel: 'STUDY',
        StudyInstanceUID: '1.2.3.4',
      }),
    ]);
    expect(statuses(answers[0])).toEqual([RETRIEVE_STATUS.tooMany]);
    expect(statuses(answers[1])).toEqual([RETRIEVE_STATUS.identifierMismatch]);
    // A study the server does not hold: nothing to send, and that is no failure.
    expect(answers[2]).toMatchObject([
      { status: RETRIEVE_STATUS.success, completed: 0, failed: 0 },
    ]);
    expect(await there.core.pacs!.index.counts()).toMatchObject({ instances: 0 });
  });

  it('stops when it is cancelled, and says what was left', async () => {
    const there = await destination();
    const server = await moving(there, { retrieveLimits: { instancesAtOnce: 1 } });
    const { answers } = await converse(
      server.port,
      [
        moveRequest(STUDY_MOVE, DESTINATION_AE, {
          QueryRetrieveLevel: 'STUDY',
          StudyInstanceUID: COURSE.planningStudy,
        }),
      ],
      { cancelAfter: 1 },
    );
    const last = answers[0].at(-1)!;
    expect(last.status).toBe(RETRIEVE_STATUS.cancelled);
    expect(last.remaining).toBeGreaterThan(0);
    expect(last.completed! + last.remaining!).toBe(8);
    expect(await there.core.pacs!.index.counts()).toMatchObject({ instances: last.completed });
  });

  it('is not for a system that may only store', async () => {
    const there = await destination();
    const server = await moving(there);
    const { answers, rejected } = await converse(
      server.port,
      [
        moveRequest(STUDY_MOVE, DESTINATION_AE, {
          QueryRetrieveLevel: 'STUDY',
          StudyInstanceUID: COURSE.planningStudy,
        }),
      ],
      { callingAeTitle: STORER_AE },
    );
    expect(rejected).toBe(false);
    expect(answers[0]).toEqual([]);
    expect(await there.core.pacs!.index.counts()).toMatchObject({ instances: 0 });
  });
});

describe('a C-GET to the listener', () => {
  it('sends a series back on the association it was asked on', async () => {
    const server = await holding({ retrieveLimits: { instancesAtOnce: 2 } });
    const { answers, received } = await converse(server.port, [
      getRequest(STUDY_GET, {
        QueryRetrieveLevel: 'SERIES',
        StudyInstanceUID: COURSE.planningStudy,
        SeriesInstanceUID: COURSE.ct,
      }),
    ]);
    const held = await server.core.pacs!.index.findInstances({ seriesInstanceUid: COURSE.ct });
    expect(received.map((one) => one.sopInstanceUid).sort()).toEqual(
      held.map((one) => one.sopInstanceUid).sort(),
    );
    expect(new Set(received.map((one) => one.sopClassUid))).toEqual(
      new Set(['1.2.840.10008.5.1.4.1.1.2']),
    );
    expect(
      answers[0].map(({ status, remaining, completed }) => ({ status, remaining, completed })),
    ).toEqual([
      { status: RETRIEVE_STATUS.pending, remaining: 1, completed: 2 },
      { status: RETRIEVE_STATUS.success, remaining: undefined, completed: 3 },
    ]);
  });

  it('sends the images of a patient, and not a kind of object the caller did not say it takes', async () => {
    const server = await holding();
    const [patient] = await server.core.pacs!.index.findPatients();
    // The library's client offers to take images back, and nothing else.
    const { answers, received } = await converse(server.port, [
      getRequest(PATIENT_GET, { QueryRetrieveLevel: 'PATIENT', PatientID: patient.patientId }),
    ]);
    const images = COURSE.ctSlices + COURSE.mrSlices + COURSE.followUpCtSlices;
    const last = answers[0].at(-1)!;
    expect(last).toMatchObject({
      status: RETRIEVE_STATUS.someFailed,
      completed: images,
      failed: COURSE.instances - images,
    });
    expect(received).toHaveLength(images);
    expect([last.identifier!['FailedSOPInstanceUIDList']].flat().sort()).toEqual(
      [COURSE.structureSet, COURSE.plan, COURSE.dose, COURSE.registration].sort(),
    );
  });

  it('counts what the caller did not take', async () => {
    const server = await holding();
    const { answers, received } = await converse(
      server.port,
      [
        getRequest(STUDY_GET, {
          QueryRetrieveLevel: 'SERIES',
          StudyInstanceUID: COURSE.planningStudy,
          SeriesInstanceUID: COURSE.ct,
        }),
      ],
      // The second is refused, the third taken with a warning.
      { storeStatus: (nth) => [0, STORE_STATUS.outOfResources, 0xb000][nth - 1] },
    );
    const last = answers[0].at(-1)!;
    expect(last).toMatchObject({
      status: RETRIEVE_STATUS.someFailed,
      completed: 1,
      failed: 1,
      warning: 1,
    });
    expect([last.identifier!['FailedSOPInstanceUIDList']].flat()).toEqual([
      received[1].sopInstanceUid,
    ]);
  });

  it('stops when it is cancelled', async () => {
    const server = await holding({ retrieveLimits: { instancesAtOnce: 1 } });
    const { answers, received } = await converse(
      server.port,
      [
        getRequest(STUDY_GET, {
          QueryRetrieveLevel: 'STUDY',
          StudyInstanceUID: COURSE.planningStudy,
        }),
      ],
      { cancelAfter: 1 },
    );
    const last = answers[0].at(-1)!;
    expect(last.status).toBe(RETRIEVE_STATUS.cancelled);
    expect(last.remaining).toBeGreaterThan(0);
    expect(received).toHaveLength(last.completed!);
  });

  describe('and storing', () => {
    let folder: string;
    beforeEach(async () => {
      folder = await mkdtemp(join(tmpdir(), 'ors-get-'));
    });
    afterEach(async () => {
      await rm(folder, { recursive: true, force: true });
    });

    it('a system that may retrieve and not store is refused what it sends', async () => {
      const server = await holding();
      // An object the server does not hold, of a kind the caller says it takes back.
      const [file] = syntheticRtCourse(8);
      const before = await server.core.pacs!.index.counts();
      const path = join(folder, 'one.dcm');
      await writeFile(path, file.bytes);
      const { answers } = await converse(server.port, [
        getRequest(STUDY_GET, { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: '1.2.3.4' }),
        storeRequest(path),
      ]);
      expect(statuses(answers[0])).toEqual([RETRIEVE_STATUS.success]);
      expect(statuses(answers[1])).toEqual([STORE_STATUS.notAuthorized]);
      expect(await server.core.pacs!.index.counts()).toEqual(before);
    });
  });
});
