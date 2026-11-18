/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The audit records of DICOM networking (#212): what the listener writes of
// what other systems do to it, by the library's own client.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SYNTHETIC_PATIENT,
  SYNTHETIC_RT_COURSE,
  syntheticCtSeries,
  syntheticRtCourse,
  type SyntheticFile,
} from '@open-rt-studio/testdata';

import { openSqliteAuditStore, type AuditRecord } from '../audit/audit-store.js';
import { createAuditLog, type AuditLog } from '../audit/audit.js';
import { createLogger } from '../logger.js';
import { askedOf, dicomAudit, NO_DICOM_AUDIT, type DicomAuditNote } from './dicom-audit.js';
import { dicomEcho } from './echo.js';
import { FIND_STATUS, STORE_STATUS, type DicomListenerOptions } from './listener.js';
import { RETRIEVE_STATUS } from './retrieve.js';
import {
  converse,
  findRequest,
  getRequest,
  LISTENER_AE,
  moveRequest,
  PEER_AE,
  sendFiles,
  startTestListener,
  type TestListener,
} from './testing/peer.js';

const COURSE = SYNTHETIC_RT_COURSE;
const STUDY_FIND = '1.2.840.10008.5.1.4.1.2.2.1';
const STUDY_MOVE = '1.2.840.10008.5.1.4.1.2.2.2';
const STUDY_GET = '1.2.840.10008.5.1.4.1.2.2.3';
const DESTINATION_AE = 'ARCHIVE';

const open: TestListener[] = [];
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ors-dicom-audit-'));
});
afterEach(async () => {
  for (const one of open.splice(0)) await one.close();
  await rm(directory, { recursive: true, force: true });
});

async function onDisk(files: readonly SyntheticFile[]): Promise<string[]> {
  const paths: string[] = [];
  for (const [index, file] of files.entries()) {
    const path = join(directory, `${index}.dcm`);
    await writeFile(path, file.bytes);
    paths.push(path);
  }
  return paths;
}

type Options = Partial<Omit<DicomListenerOptions, 'pacs'>>;

/** A listener with an audit log of its own, which PEER may store to and retrieve from. */
async function audited(options: Options = {}, holds: readonly SyntheticFile[] = []) {
  const audit = createAuditLog({ store: openSqliteAuditStore(':memory:') });
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  const server = await startTestListener({
    callers: [PEER_AE],
    retrievers: [PEER_AE],
    audit: dicomAudit(audit, logger),
    logger,
    ...options,
  });
  open.push(server);
  for (const file of holds) await server.core.pacs!.ingest.ingest(file.bytes);
  return {
    server,
    /** The records, the earliest first, as far as a test reads them. */
    records: (): AuditRecord[] => [...audit.all()],
    log: () => lines.join('\n'),
  };
}

/** What a test reads of a record. */
const read = (records: readonly AuditRecord[]) =>
  records.map(({ action, outcome, object, patientId, studyUid, seriesUid, detail, count }) => ({
    action,
    outcome,
    object,
    patientId,
    studyUid,
    seriesUid,
    detail,
    count,
  }));

describe('the audit records of DICOM networking', () => {
  it('are records of the audit log, from DICOM, of a system by its AE title', () => {
    const audit = createAuditLog({ store: openSqliteAuditStore(':memory:') });
    const write = dicomAudit(audit);
    expect(
      write({
        action: 'dicom-store',
        outcome: 'ok',
        aeTitle: 'PLANNING',
        patientId: 'SYN-0001',
        studyUid: '1.2.3',
        seriesUid: '1.2.3.4',
      }),
    ).toBe(true);
    expect(
      write({ action: 'dicom-sent', outcome: 'failed', aeTitle: 'ARCHIVE', actor: 'ada' }),
    ).toBe(true);
    expect([...audit.all()]).toMatchObject([
      {
        actor: null,
        origin: 'dicom',
        action: 'dicom-store',
        outcome: 'ok',
        object: 'PLANNING',
        patientId: 'SYN-0001',
        studyUid: '1.2.3',
        seriesUid: '1.2.3.4',
        detail: null,
      },
      { actor: 'ada', origin: 'dicom', action: 'dicom-sent', outcome: 'failed', object: 'ARCHIVE' },
    ]);
  });

  it('say when a record could not be written, and name nothing in the log', () => {
    const lines: string[] = [];
    const failing = {
      record: () => {
        throw new Error('disk full');
      },
    } as unknown as AuditLog;
    const write = dicomAudit(
      failing,
      createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    );
    const note: DicomAuditNote = {
      action: 'dicom-find',
      outcome: 'ok',
      aeTitle: 'PLANNING',
      patientId: 'SYN-0001',
      detail: 'study: 1 matches',
    };
    expect(write(note)).toBe(false);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'audit-failed', action: 'dicom-find' });
    expect(lines[0]).not.toContain('PLANNING');
    expect(lines[0]).not.toContain('SYN-0001');
    // A server that keeps no audit log holds nothing back for want of one.
    expect(dicomAudit(null)).toBe(NO_DICOM_AUDIT);
    expect(NO_DICOM_AUDIT(note)).toBe(true);
  });
});

describe('what an identifier asks for, for a record', () => {
  it('is the level, the patient and study when they are named whole, and the keys given', () => {
    expect(
      askedOf({
        QueryRetrieveLevel: 'STUDY',
        PatientID: 'SYN-0001',
        PatientName: [{ Alphabetic: 'SYNTH*' }],
        StudyInstanceUID: '',
        StudyDate: '20260101-20260131 ',
        ModalitiesInStudy: 'CT',
        NumberOfStudyRelatedInstances: '',
      }),
    ).toEqual({
      level: 'STUDY',
      patientId: 'SYN-0001',
      studyUid: null,
      seriesUid: null,
      keys: JSON.stringify({
        patientId: 'SYN-0001',
        patientName: 'SYNTH*',
        studyDate: '20260101-20260131',
        modality: 'CT',
      }),
    });
    expect(
      askedOf({
        QueryRetrieveLevel: 'SERIES',
        StudyInstanceUID: '1.2.3',
        SeriesInstanceUID: ['1.2.3.4'],
      }),
    ).toMatchObject({ level: 'SERIES', patientId: null, studyUid: '1.2.3', seriesUid: '1.2.3.4' });
  });

  it('names no patient for a wildcard, and no study for several or for what is no UID', () => {
    expect(askedOf({ PatientID: 'SYN-*' })).toMatchObject({ level: null, patientId: null });
    expect(askedOf({ PatientID: 'SYN-000?' }).patientId).toBeNull();
    expect(askedOf({ StudyInstanceUID: ['1.2.3', '1.2.4'] })).toMatchObject({
      studyUid: null,
      keys: JSON.stringify({ studyInstanceUid: '1.2.3\\1.2.4' }),
    });
    expect(askedOf({ StudyInstanceUID: '1.2.*' }).studyUid).toBeNull();
    expect(askedOf({})).toEqual({
      level: null,
      patientId: null,
      studyUid: null,
      seriesUid: null,
      keys: null,
    });
  });

  it('is cut to a length: an identifier is another system’s text', () => {
    const asked = askedOf({ QueryRetrieveLevel: 'X'.repeat(64), PatientName: 'A'.repeat(2000) });
    expect(asked.level).toHaveLength(16);
    expect(asked.keys!.length).toBe(300);
  });
});

describe('what the listener writes to the audit log', () => {
  // The issue's first "done when".
  it('of objects received: who sent them and whose they are, the instances of a series as one', async () => {
    const { server, records, log } = await audited();
    const { statuses } = await sendFiles(server.port, await onDisk(syntheticRtCourse()));
    expect(statuses.every((status) => status === STORE_STATUS.success)).toBe(true);
    const stores = read(records());
    expect(stores.every((one) => one.action === 'dicom-store' && one.outcome === 'ok')).toBe(true);
    expect(stores.every((one) => one.object === PEER_AE)).toBe(true);
    expect(stores.every((one) => one.patientId === SYNTHETIC_PATIENT.id)).toBe(true);
    // Eleven instances of seven series: a record for each series, counting its instances.
    expect(stores.reduce((sum, one) => sum + one.count, 0)).toBe(11);
    expect(stores.find((one) => one.seriesUid === COURSE.ct)).toMatchObject({
      studyUid: COURSE.planningStudy,
      count: COURSE.ctSlices,
      detail: null,
    });
    expect(records()[0]).toMatchObject({ actor: null, origin: 'dicom' });
    // Sent again, they are the same objects: said so, in records of their own.
    // (The course's files begin with its CT.)
    await sendFiles(server.port, await onDisk(syntheticRtCourse().slice(0, COURSE.ctSlices)));
    expect(read(records()).at(-1)).toMatchObject({
      action: 'dicom-store',
      outcome: 'ok',
      seriesUid: COURSE.ct,
      detail: 'unchanged',
      count: COURSE.ctSlices,
    });
    // The application log has what came of each object, and not who sent it or whose it is.
    expect(log()).toContain('"event":"object-received"');
    expect(log()).not.toContain(PEER_AE);
    expect(log()).not.toContain(SYNTHETIC_PATIENT.id);
    expect(log()).not.toContain(COURSE.planningStudy);
  });

  it('of an association it refused: who called', async () => {
    const { server, records, log } = await audited();
    const target = { host: '127.0.0.1', port: server.port, timeoutMs: 2_000 };
    expect(
      await dicomEcho({ ...target, callingAeTitle: 'SOMEONE', calledAeTitle: LISTENER_AE }),
    ).toMatchObject({ outcome: 'rejected' });
    expect(
      await dicomEcho({ ...target, callingAeTitle: PEER_AE, calledAeTitle: 'ELSEWHERE' }),
    ).toMatchObject({ outcome: 'rejected' });
    // An echo that is answered is nothing of anyone's, and leaves no record.
    expect(
      await dicomEcho({ ...target, callingAeTitle: PEER_AE, calledAeTitle: LISTENER_AE }),
    ).toEqual({ outcome: 'ok' });
    expect(read(records())).toMatchObject([
      {
        action: 'dicom-association',
        outcome: 'refused',
        object: 'SOMEONE',
        detail: 'not among the systems that are let in',
      },
      {
        action: 'dicom-association',
        outcome: 'refused',
        object: PEER_AE,
        detail: 'called by an AE title that is not this server’s',
      },
    ]);
    expect(log()).toContain('"event":"association-rejected"');
    expect(log()).not.toContain('SOMEONE');
    expect(log()).not.toContain(PEER_AE);
  });

  it('of a query: who asked, for whom, and how much was answered', async () => {
    const { server, records, log } = await audited({}, syntheticRtCourse());
    const { answers } = await converse(server.port, [
      findRequest(STUDY_FIND, {
        QueryRetrieveLevel: 'STUDY',
        PatientName: 'SYNTH*',
        StudyInstanceUID: '',
      }),
      findRequest(STUDY_FIND, {
        QueryRetrieveLevel: 'SERIES',
        PatientID: SYNTHETIC_PATIENT.id,
        StudyInstanceUID: COURSE.planningStudy,
        SeriesInstanceUID: '',
      }),
      // An identifier that cannot be answered is recorded all the same.
      findRequest(STUDY_FIND, { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: '1.2.*' }),
    ]);
    expect(answers.map((one) => one.at(-1)!.status)).toEqual([
      FIND_STATUS.success,
      FIND_STATUS.success,
      FIND_STATUS.identifierMismatch,
    ]);
    expect(read(records())).toEqual([
      {
        action: 'dicom-find',
        outcome: 'ok',
        object: PEER_AE,
        patientId: null,
        studyUid: null,
        seriesUid: null,
        detail: 'study: 2 matches, {"patientName":"SYNTH*"}',
        count: 1,
      },
      {
        action: 'dicom-find',
        outcome: 'ok',
        object: PEER_AE,
        patientId: SYNTHETIC_PATIENT.id,
        studyUid: COURSE.planningStudy,
        seriesUid: null,
        detail: `series: 5 matches, ${JSON.stringify({
          patientId: SYNTHETIC_PATIENT.id,
          studyInstanceUid: COURSE.planningStudy,
        })}`,
        count: 1,
      },
      {
        action: 'dicom-find',
        outcome: 'rejected',
        object: PEER_AE,
        patientId: null,
        studyUid: null,
        seriesUid: null,
        // (As the library's client wrote the key: it does not send the wildcard.)
        detail: expect.stringMatching(/^study: 0 matches, \{"studyInstanceUid":"1\.2\.\*?"\}$/),
        count: 1,
      },
    ]);
    expect(log()).toContain('"event":"query-answered"');
    for (const word of [PEER_AE, 'SYNTH', SYNTHETIC_PATIENT.id, COURSE.planningStudy]) {
      expect(log(), word).not.toContain(word);
    }
  });

  it('of a move: who asked, where to and whose, before anything leaves, and then how it ended', async () => {
    const there = await startTestListener({ aeTitle: DESTINATION_AE, callers: [LISTENER_AE] });
    open.push(there);
    const { server, records, log } = await audited(
      {
        destinationOf: (aeTitle) =>
          aeTitle === DESTINATION_AE ? { host: '127.0.0.1', port: there.port } : null,
        moveTimeoutMs: 2_000,
      },
      syntheticRtCourse(),
    );
    const study = { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: COURSE.planningStudy };
    const { answers } = await converse(server.port, [
      moveRequest(STUDY_MOVE, DESTINATION_AE, study),
      moveRequest(STUDY_MOVE, 'NOWHERE', study),
    ]);
    expect(answers.map((one) => one.at(-1)!.status)).toEqual([
      RETRIEVE_STATUS.success,
      RETRIEVE_STATUS.destinationUnknown,
    ]);
    const keys = JSON.stringify({ studyInstanceUid: COURSE.planningStudy });
    const whose = {
      patientId: SYNTHETIC_PATIENT.id,
      studyUid: COURSE.planningStudy,
      seriesUid: null,
      count: 1,
    };
    expect(read(records())).toEqual([
      {
        action: 'dicom-move',
        outcome: 'ok',
        object: PEER_AE,
        ...whose,
        detail: `to ${DESTINATION_AE}, 8 instances, ${keys}`,
      },
      // Where it went, and for whom.
      {
        action: 'dicom-sent',
        outcome: 'ok',
        object: DESTINATION_AE,
        ...whose,
        detail: `move for ${PEER_AE}, 8 of 8 sent`,
      },
      // Whose the study is was not looked up for a move that went nowhere.
      {
        action: 'dicom-move',
        outcome: 'refused',
        object: PEER_AE,
        ...whose,
        patientId: null,
        detail: `to NOWHERE, the server knows no such destination, ${keys}`,
      },
    ]);
    expect(log()).toContain('"event":"retrieve-answered"');
    for (const word of [PEER_AE, DESTINATION_AE, 'NOWHERE', COURSE.planningStudy]) {
      expect(log(), word).not.toContain(word);
    }
  });

  it('of a move that did not all arrive: that it failed, and how much was sent', async () => {
    const { server, records } = await audited(
      // Nothing is at the destination's address.
      { destinationOf: () => ({ host: '127.0.0.1', port: 9 }), moveTimeoutMs: 500 },
      syntheticRtCourse(),
    );
    await converse(server.port, [
      moveRequest(STUDY_MOVE, DESTINATION_AE, {
        QueryRetrieveLevel: 'SERIES',
        StudyInstanceUID: COURSE.planningStudy,
        SeriesInstanceUID: COURSE.ct,
      }),
    ]);
    expect(read(records())).toMatchObject([
      { action: 'dicom-move', outcome: 'ok', seriesUid: COURSE.ct },
      {
        action: 'dicom-sent',
        outcome: 'failed',
        object: DESTINATION_AE,
        seriesUid: COURSE.ct,
        detail: `move for ${PEER_AE}, 0 of ${COURSE.ctSlices} sent`,
      },
    ]);
  });

  it('of a get: who asked and whose, and that it was sent back to them', async () => {
    const { server, records } = await audited({}, syntheticRtCourse());
    const { received } = await converse(server.port, [
      getRequest(STUDY_GET, {
        QueryRetrieveLevel: 'SERIES',
        StudyInstanceUID: COURSE.planningStudy,
        SeriesInstanceUID: COURSE.ct,
      }),
    ]);
    expect(received).toHaveLength(COURSE.ctSlices);
    expect(read(records())).toMatchObject([
      {
        action: 'dicom-get',
        outcome: 'ok',
        object: PEER_AE,
        patientId: SYNTHETIC_PATIENT.id,
        studyUid: COURSE.planningStudy,
        seriesUid: COURSE.ct,
      },
      {
        action: 'dicom-sent',
        outcome: 'ok',
        object: PEER_AE,
        seriesUid: COURSE.ct,
        detail: `get, ${COURSE.ctSlices} of ${COURSE.ctSlices} sent`,
      },
    ]);
    expect(read(records())[0].detail).toMatch(/^3 instances, \{/);
  });

  it('lets nothing leave when the record of who asked cannot be written', async () => {
    const failing = {
      record: () => {
        throw new Error('disk full');
      },
    } as unknown as AuditLog;
    const there = await startTestListener({ aeTitle: DESTINATION_AE, callers: [LISTENER_AE] });
    open.push(there);
    const { server } = await audited(
      {
        audit: dicomAudit(failing),
        destinationOf: () => ({ host: '127.0.0.1', port: there.port }),
      },
      syntheticRtCourse(),
    );
    const study = { QueryRetrieveLevel: 'STUDY', StudyInstanceUID: COURSE.planningStudy };
    const { answers, received } = await converse(server.port, [
      findRequest(STUDY_FIND, { ...study, PatientID: '' }),
      getRequest(STUDY_GET, study),
      moveRequest(STUDY_MOVE, DESTINATION_AE, study),
    ]);
    // No match is told, and nothing is sent, back or onward.
    expect(answers[0].map((one) => one.status)).toEqual([FIND_STATUS.unableToProcess]);
    expect(answers[0][0].identifier ?? null).toBeNull();
    expect(answers[1].map((one) => one.status)).toEqual([RETRIEVE_STATUS.unableToProcess]);
    expect(answers[2].map((one) => one.status)).toEqual([RETRIEVE_STATUS.unableToProcess]);
    expect(received).toEqual([]);
    expect(await there.core.pacs!.index.counts()).toMatchObject({ instances: 0 });
  });

  it('tells a sender that an object failed when no record of it could be written', async () => {
    const failing = {
      record: () => {
        throw new Error('disk full');
      },
    } as unknown as AuditLog;
    const { server } = await audited({ audit: dicomAudit(failing) });
    const { statuses } = await sendFiles(server.port, await onDisk(syntheticCtSeries(2, 8)));
    expect(statuses).toEqual([STORE_STATUS.processingFailure, STORE_STATUS.processingFailure]);
  });
});
