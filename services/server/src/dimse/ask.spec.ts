/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server asking another system (#51). The other system is a listener of
// our own that holds the synthetic course; DCMTK's dcmqrscp is asked in
// dcmtk.spec.ts.

import { createServer, type Server } from 'node:net';

import {
  SYNTHETIC_LATIN1_PATIENT,
  SYNTHETIC_RT_COURSE,
  SYNTHETIC_UTF8_PATIENT,
  syntheticCharacterSetPatient,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';

import type { Pacs } from '../core/core.js';
import {
  AskError,
  askIdentifier,
  checkedKeys,
  findAt,
  matchOf,
  moveFrom,
  type MoveCounts,
} from './ask.js';
import { dataSetOf } from './part10.js';
import type { SendTarget } from './send.js';
import { freePort, startTestListener, type TestListener } from './testing/peer.js';

const COURSE = SYNTHETIC_RT_COURSE;
/** This server, and the system it asks. */
const OURS = 'OURS';
const THEIRS = 'THEIR-PACS';

const open: TestListener[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const one of open.splice(0)) await one.close();
  for (const server of servers.splice(0)) server.close();
});

type Options = Parameters<typeof startTestListener>[0];

/** This server's listener, which the other system may store to. */
async function ours(options: Options = {}): Promise<TestListener> {
  const started = await startTestListener({ aeTitle: OURS, callers: [THEIRS], ...options });
  open.push(started);
  return started;
}

/** The other system: it holds the course, and lets this server ask and retrieve. */
async function theirs(here: { port: number } | null, options: Options = {}): Promise<TestListener> {
  const started = await startTestListener({
    aeTitle: THEIRS,
    callers: [],
    retrievers: [OURS],
    destinationOf: (aeTitle) =>
      here && aeTitle === OURS ? { host: '127.0.0.1', port: here.port } : null,
    moveTimeoutMs: 3_000,
    ...options,
  });
  open.push(started);
  for (const file of syntheticRtCourse()) {
    expect((await started.core.pacs!.ingest.ingest(file.bytes)).outcome).toBe('stored');
  }
  return started;
}

const to = (port: number, more: Partial<SendTarget> = {}): SendTarget => ({
  host: '127.0.0.1',
  port,
  calledAeTitle: THEIRS,
  callingAeTitle: OURS,
  timeoutMs: 3_000,
  ...more,
});

async function kept(pacs: Pacs, sopInstanceUid: string): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for await (const piece of await pacs.store.get(sopInstanceUid)) pieces.push(piece as Buffer);
  return Buffer.concat(pieces);
}

describe('the keys of a question', () => {
  it('are those of its level, without what is empty', () => {
    expect(
      checkedKeys('study', { patientName: 'SYN*', studyDate: '20260101-', modality: ' ' }),
    ).toEqual({ patientName: 'SYN*', studyDate: '20260101-' });
    expect(checkedKeys('patient', {})).toEqual({});
    expect(checkedKeys('series', { studyInstanceUid: COURSE.planningStudy })).toEqual({
      studyInstanceUid: COURSE.planningStudy,
    });
  });

  it('are refused when they are not what they must be', () => {
    const refused = (level: 'patient' | 'study' | 'series', keys: unknown): string => {
      try {
        checkedKeys(level, keys);
      } catch (error) {
        expect(error).toBeInstanceOf(AskError);
        return (error as Error).message;
      }
      return 'taken';
    };
    expect(refused('study', [])).toBe('The keys are an object.');
    expect(refused('patient', { studyDate: '20260101' })).toBe(
      'A question at the patient level has patientId, patientName.',
    );
    expect(refused('study', { host: 'elsewhere' })).toContain('A question at the study level has');
    expect(refused('study', { patientName: 7 })).toContain('patientName is one line');
    expect(refused('study', { patientName: 'A\\B' })).toContain('patientName is one line');
    expect(refused('study', { patientName: 'two\nlines' })).toContain('patientName is one line');
    expect(refused('study', { patientName: 'x'.repeat(65) })).toContain('patientName is one line');
    expect(refused('study', { studyDate: 'yesterday' })).toContain('studyDate is YYYYMMDD');
    expect(refused('study', { studyInstanceUid: '1.2.*' })).toBe('studyInstanceUid is a UID.');
    expect(refused('series', { modality: 'CT' })).toBe(
      'A question at the series level names the study.',
    );
  });

  it('make an identifier that asks for what a list of matches shows', () => {
    expect(askIdentifier('series', { studyInstanceUid: '1.2.3', modality: 'CT' })).toEqual({
      QueryRetrieveLevel: 'SERIES',
      StudyInstanceUID: '1.2.3',
      SeriesInstanceUID: '',
      Modality: 'CT',
      SeriesNumber: '',
      SeriesDescription: '',
      NumberOfSeriesRelatedInstances: '',
    });
    expect(askIdentifier('study', { patientName: 'SYN*' })).toMatchObject({
      QueryRetrieveLevel: 'STUDY',
      PatientName: 'SYN*',
      StudyInstanceUID: '',
      ModalitiesInStudy: '',
    });
  });

  it('say that they are in UTF-8 when one is outside ASCII, and nothing of it otherwise', () => {
    expect(askIdentifier('study', { patientName: 'SYN*' })).not.toHaveProperty(
      'SpecificCharacterSet',
    );
    expect(askIdentifier('patient', { patientName: 'Ødeg*' })).toMatchObject({
      SpecificCharacterSet: 'ISO_IR 192',
      PatientName: 'Ødeg*',
    });
    expect(askIdentifier('study', { studyDescription: '計画*' })).toMatchObject({
      SpecificCharacterSet: 'ISO_IR 192',
    });
  });
});

describe('what another system answers', () => {
  it('is taken as text: a line of a length, a UID that is one, a number that is one', () => {
    expect(
      matchOf('study', {
        StudyInstanceUID: '1.2.3',
        PatientName: [{ Alphabetic: 'SYNTHETIC^PHANTOM ' }],
        PatientID: 'two\nlines',
        StudyDate: '2026-01-05',
        StudyTime: '101500',
        StudyDescription: 'x'.repeat(1000),
        ModalitiesInStudy: ['CT', 'RTDOSE'],
        NumberOfStudyRelatedInstances: '8 ',
        NumberOfStudyRelatedSeries: 'many',
      }),
    ).toEqual({
      patientId: 'two lines',
      patientName: 'SYNTHETIC^PHANTOM',
      patientBirthDate: null,
      patientSex: null,
      studyInstanceUid: '1.2.3',
      date: null,
      time: '101500',
      description: 'x'.repeat(256),
      accessionNumber: null,
      modalities: ['CT', 'RTDOSE'],
      series: null,
      instances: 8,
    });
    expect(
      matchOf('study', { ModalitiesInStudy: 'CT\\MR', StudyInstanceUID: '1.2' }),
    ).toMatchObject({ modalities: ['CT', 'MR'] });
  });

  it('is no match without the key that names it', () => {
    expect(matchOf('study', { PatientID: 'SYN' })).toBeNull();
    expect(matchOf('study', { StudyInstanceUID: 'not a uid' })).toBeNull();
    expect(matchOf('series', { StudyInstanceUID: '1.2.3' })).toBeNull();
    expect(matchOf('patient', { PatientName: 'SYNTHETIC' })).toBeNull();
    expect(matchOf('patient', { PatientID: 'SYN-1', NumberOfPatientRelatedStudies: 2 })).toEqual({
      patientId: 'SYN-1',
      patientName: null,
      birthDate: null,
      sex: null,
      studies: 2,
    });
  });
});

describe('asking another system what it holds', () => {
  it('finds the studies of a patient by a part of the name', async () => {
    const peer = await theirs(null);
    const [patient] = await peer.core.pacs!.index.findPatients();
    const answer = await findAt(to(peer.port), 'study', { patientName: 'synth*' });
    expect(answer).toMatchObject({ outcome: 'answered', status: 0, complete: true });
    if (answer.outcome !== 'answered') return;
    const held = await peer.core.pacs!.index.findStudies({ order: 'newest' });
    expect(answer.matches).toEqual(
      held.map((study) => ({
        patientId: patient.patientId,
        patientName: patient.name,
        patientBirthDate: study.patientBirthDate,
        patientSex: study.patientSex,
        studyInstanceUid: study.studyInstanceUid,
        date: study.date,
        time: study.time === null ? null : expect.stringContaining(study.time.slice(0, 6)),
        description: study.description,
        accessionNumber: study.accessionNumber,
        modalities: expect.arrayContaining([...study.modalities]),
        series: study.series,
        instances: study.instances,
      })),
    );
    expect(answer.matches.map((match) => match.studyInstanceUid)).toEqual([
      COURSE.followUpStudy,
      COURSE.planningStudy,
    ]);
  });

  it('finds patients, and the series of a study', async () => {
    const peer = await theirs(null);
    const [patient] = await peer.core.pacs!.index.findPatients();
    const patients = await findAt(to(peer.port), 'patient', { patientId: patient.patientId });
    expect(patients).toMatchObject({
      outcome: 'answered',
      complete: true,
      matches: [{ patientId: patient.patientId, patientName: patient.name, studies: 2 }],
    });
    const series = await findAt(to(peer.port), 'series', {
      studyInstanceUid: COURSE.planningStudy,
      modality: 'CT',
    });
    expect(series).toMatchObject({
      outcome: 'answered',
      complete: true,
      matches: [
        {
          studyInstanceUid: COURSE.planningStudy,
          seriesInstanceUid: COURSE.ct,
          modality: 'CT',
          instances: COURSE.ctSlices,
        },
      ],
    });
    expect(await findAt(to(peer.port), 'study', { patientName: 'NOBODY*' })).toEqual({
      outcome: 'answered',
      status: 0,
      matches: [],
      complete: true,
    });
  });

  // Found while the conformance statement was written (#60): a key outside
  // ASCII went out with nothing said of how it was written, and matched nothing.
  it('finds by a name and a description outside ASCII, whatever the file was written in', async () => {
    const there = await theirs(null);
    for (const patient of [SYNTHETIC_UTF8_PATIENT, SYNTHETIC_LATIN1_PATIENT]) {
      for (const file of syntheticCharacterSetPatient(patient)) {
        expect((await there.core.pacs!.ingest.ingest(file.bytes)).outcome).toBe('stored');
      }
    }
    const named = async (keys: Parameters<typeof findAt>[2]) => {
      const found = await findAt(to(there.port), 'study', keys);
      return found.outcome === 'answered' ? found.matches.map((one) => one.patientName) : found;
    };
    expect(await named({ patientName: 'Łukasiewicz*' })).toEqual([SYNTHETIC_UTF8_PATIENT.name]);
    expect(await named({ patientName: 'Ødeg*' })).toEqual([SYNTHETIC_LATIN1_PATIENT.name]);
    expect(await named({ studyDescription: 'Étude 計画*' })).toEqual([SYNTHETIC_UTF8_PATIENT.name]);
    const patients = await findAt(to(there.port), 'patient', { patientName: '*山田' });
    expect(patients.outcome === 'answered' && patients.matches).toMatchObject([
      { patientId: SYNTHETIC_UTF8_PATIENT.id, patientName: SYNTHETIC_UTF8_PATIENT.name },
    ]);
  });

  it('says that a list is not all there was', async () => {
    const peer = await theirs(null, { findAtMost: 1 });
    // The other system cut its answer.
    const cut = await findAt(to(peer.port), 'study', {});
    expect(cut).toMatchObject({ outcome: 'answered', status: 0xa700, complete: false });
    expect(cut.outcome === 'answered' && cut.matches).toHaveLength(1);
    // This server took as many as it takes, and told it to stop.
    const full = await theirs(null);
    const taken = await findAt(to(full.port), 'study', {}, 1);
    expect(taken).toMatchObject({ outcome: 'answered', complete: false });
    expect(taken.outcome === 'answered' && taken.matches).toHaveLength(1);
  });

  it('says why there was no answer', async () => {
    const peer = await theirs(null);
    expect(await findAt(to(peer.port, { callingAeTitle: 'STRANGER' }), 'study', {})).toEqual({
      outcome: 'rejected',
    });
    expect(await findAt(to(peer.port, { calledAeTitle: 'WRONG' }), 'study', {})).toEqual({
      outcome: 'rejected',
    });
    expect(await findAt(to(await freePort()), 'study', {})).toEqual({ outcome: 'unreachable' });
    // A system that lets this server store, and answers no questions.
    const storesOnly = await startTestListener({ aeTitle: THEIRS, callers: [OURS] });
    open.push(storesOnly);
    expect(await findAt(to(storesOnly.port), 'study', {})).toEqual({ outcome: 'not-taken' });
    // Something that takes the connection and says nothing.
    const silent = createServer((socket) => socket.on('data', () => socket.destroy()));
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as { port: number };
    expect(await findAt(to(port), 'study', {})).toEqual({ outcome: 'broken' });
  });
});

describe('having another system send here', () => {
  // The issue's "done when": a study on a test peer is found and retrieved into our PACS.
  it('retrieves a study that was found, each object as the other system holds it', async () => {
    const here = await ours();
    const peer = await theirs(here, { retrieveLimits: { instancesAtOnce: 3 } });
    const found = await findAt(to(peer.port), 'study', { modality: 'RTDOSE' });
    expect(found.outcome === 'answered' && found.matches).toHaveLength(1);
    if (found.outcome !== 'answered') return;
    const { studyInstanceUid, instances } = found.matches[0];
    expect(studyInstanceUid).toBe(COURSE.planningStudy);

    const told: MoveCounts[] = [];
    const answer = await moveFrom(to(peer.port), OURS, { studyInstanceUid }, (counts) =>
      told.push(counts),
    );
    expect(answer).toEqual({
      outcome: 'answered',
      status: 0,
      counts: { remaining: 0, completed: instances, failed: 0, warning: 0 },
    });
    expect(told).toEqual([
      { remaining: 5, completed: 3, failed: 0, warning: 0 },
      { remaining: 2, completed: 6, failed: 0, warning: 0 },
    ]);
    const arrived = await here.core.pacs!.index.findInstances({ studyInstanceUid });
    expect(arrived).toHaveLength(instances!);
    for (const { sopInstanceUid } of arrived) {
      const [mine, original] = await Promise.all([
        kept(here.core.pacs!, sopInstanceUid),
        kept(peer.core.pacs!, sopInstanceUid),
      ]);
      expect(Buffer.from(dataSetOf(mine)!).equals(Buffer.from(dataSetOf(original)!))).toBe(true);
    }
    // And the index knows what the objects are to each other, as for any that came in.
    expect(
      (await here.core.pacs!.index.relatedToSeries(COURSE.ct))?.structureSets.map(
        (one) => one.sopInstanceUid,
      ),
    ).toEqual([COURSE.structureSet]);
  });

  it('retrieves one series', async () => {
    const here = await ours();
    const peer = await theirs(here);
    const answer = await moveFrom(to(peer.port), OURS, {
      studyInstanceUid: COURSE.planningStudy,
      seriesInstanceUid: COURSE.mr,
    });
    expect(answer).toMatchObject({ outcome: 'answered', status: 0 });
    expect(await here.core.pacs!.index.counts()).toMatchObject({ instances: COURSE.mrSlices });
  });

  it('says how a move ended that did not go well', async () => {
    const here = await ours();
    // The other system does not know where this server is.
    const unknowing = await theirs(null);
    expect(
      await moveFrom(to(unknowing.port), OURS, { studyInstanceUid: COURSE.planningStudy }),
    ).toEqual({ outcome: 'answered', status: 0xa801, counts: null });
    // It knows, and this server does not let it store.
    const closed = await ours({ callers: [] });
    const refusedThere = await theirs(closed);
    expect(
      await moveFrom(to(refusedThere.port), OURS, { studyInstanceUid: COURSE.followUpStudy }),
    ).toMatchObject({
      outcome: 'answered',
      status: 0xa702,
      counts: { completed: 0, failed: 3 },
    });
    expect(await closed.core.pacs!.index.counts()).toMatchObject({ instances: 0 });
    // And why there was no answer at all.
    const peer = await theirs(here);
    const what = { studyInstanceUid: COURSE.planningStudy };
    expect(await moveFrom(to(peer.port, { callingAeTitle: 'STRANGER' }), OURS, what)).toEqual({
      outcome: 'rejected',
    });
    expect(await moveFrom(to(await freePort()), OURS, what)).toEqual({ outcome: 'unreachable' });
    const storesOnly = await startTestListener({ aeTitle: THEIRS, callers: [OURS] });
    open.push(storesOnly);
    expect(await moveFrom(to(storesOnly.port), OURS, what)).toEqual({ outcome: 'not-taken' });
    expect(await here.core.pacs!.index.counts()).toMatchObject({ instances: 0 });
  });
});
