/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The DICOM listener and the echo client against DCMTK's command-line tools:
// a peer that is not the library talking to itself. DCMTK is a test peer
// only: it is not a dependency and is never bundled.
//
// These run where DCMTK is installed, which in CI is the "DIMSE interop" job
// (REQUIRE_DCMTK=1 there makes a missing DCMTK a failure, not a skip).
// Elsewhere they are skipped.

import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { readInstanceHeader, SUM_RECORD_CREATOR } from '@open-rt-studio/dicom';
import {
  SYNTHETIC_RT_COURSE,
  syntheticCtSeries,
  syntheticRtCourse,
  type SyntheticFile,
} from '@open-rt-studio/testdata';

import { sopInstanceUidOf } from '../store/testing.js';
import { testCertificate, type TestCertificate } from '../tls-testing.js';
import { dicomEcho } from './echo.js';
import { dataSetOf, outgoingFrom } from './part10.js';
import { findAt, moveFrom } from './ask.js';
import { sendObjects } from './send.js';
import { IMPLICIT_VR_LE } from './sop-classes.js';
import {
  freePort,
  LISTENER_AE,
  PEER_AE,
  startTestListener,
  type TestListener,
} from './testing/peer.js';
import { syntheticSummedDose } from './testing/summed-dose.js';
import type { ClientTls } from './tls.js';

const run = promisify(execFile);
const installed = (tool: string): boolean =>
  spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0;
const required = process.env['REQUIRE_DCMTK'] === '1';
const TOOLS = [
  ...['echoscu', 'storescu', 'storescp', 'dcmdump'],
  ...['findscu', 'movescu', 'getscu', 'dcmqrscp'],
];
const dcmtk = required || TOOLS.every(installed);

let directory = '';
const open: TestListener[] = [];
const children: ChildProcess[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-dcmtk-'));
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const one of open.splice(0)) await one.close();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function onDisk(files: readonly SyntheticFile[]): Promise<string[]> {
  const to = await mkdtemp(join(directory, 'send-'));
  const paths: string[] = [];
  for (const file of files) {
    const path = join(to, file.name);
    await writeFile(path, file.bytes);
    paths.push(path);
  }
  return paths;
}

async function listening(): Promise<TestListener> {
  const started = await startTestListener();
  open.push(started);
  return started;
}

/** Whether a DCMTK tool ended well. Its output is kept out of the test log. */
async function tool(name: string, args: readonly string[]): Promise<boolean> {
  return run(name, [...args], { timeout: 30_000 }).then(
    () => true,
    () => false,
  );
}

/** What a DCMTK tool said, and whether it ended well. Kept out of the test log. */
async function said(name: string, args: readonly string[]): Promise<{ ok: boolean; text: string }> {
  return run(name, [...args], { timeout: 30_000 }).then(
    ({ stdout, stderr }) => ({ ok: true, text: `${stdout}\n${stderr}` }),
    (error: { stdout?: string; stderr?: string }) => ({
      ok: false,
      text: `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
    }),
  );
}

const echo = (port: number, called: string, tls?: ClientTls) =>
  dicomEcho({
    host: '127.0.0.1',
    port,
    callingAeTitle: LISTENER_AE,
    calledAeTitle: called,
    timeoutMs: 2_000,
    ...(tls ? { tls } : {}),
  });

/** Start DCMTK's storescp writing into a folder, and wait until it answers. */
async function storescp(
  more: readonly string[] = [],
  /** What to call it with, when it was started with TLS. */
  tls?: ClientTls,
): Promise<{ port: number; folder: string }> {
  const port = await freePort();
  const folder = await mkdtemp(join(directory, 'storescp-'));
  const child = spawn(
    'storescp',
    ['--aetitle', 'DCMTK', '--output-directory', folder, ...more, String(port)],
    { stdio: 'ignore' },
  );
  children.push(child);
  for (let tries = 0; tries < 50; tries++) {
    if ((await echo(port, 'DCMTK', tls)).outcome === 'ok') return { port, folder };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('storescp did not start listening');
}

describe.skipIf(!dcmtk)('against DCMTK', () => {
  it('echoscu is answered, and refused under an AE title that is not on the list', async () => {
    const { port } = await listening();
    const address = ['--call', LISTENER_AE, '127.0.0.1', String(port)];
    expect(await tool('echoscu', ['--aetitle', PEER_AE, ...address])).toBe(true);
    expect(await tool('echoscu', ['--aetitle', 'SOMEONE', ...address])).toBe(false);
    expect(
      await tool('echoscu', ['--aetitle', PEER_AE, '--call', 'OTHER', '127.0.0.1', String(port)]),
    ).toBe(false);
  });

  it('what storescu sends is stored and indexed, each data set byte for byte', async () => {
    const { port, core } = await listening();
    // A CT, an MR, a structure set, a plan, a dose and a registration.
    const files = syntheticRtCourse();
    const sent = await tool('storescu', [
      ...['--aetitle', PEER_AE, '--call', LISTENER_AE],
      ...['127.0.0.1', String(port), ...(await onDisk(files))],
    ]);

    expect(sent).toBe(true);
    expect(await core.pacs!.index.findInstances()).toHaveLength(files.length);
    const identical: Record<string, boolean> = {};
    for (const file of files) {
      const pieces: Buffer[] = [];
      const stream = await core.pacs!.store.get(sopInstanceUidOf(file.bytes));
      for await (const piece of stream) pieces.push(piece as Buffer);
      identical[file.name] = Buffer.from(dataSetOf(Buffer.concat(pieces))!).equals(
        Buffer.from(dataSetOf(file.bytes)!),
      );
    }
    expect(identical).toEqual(Object.fromEntries(files.map((f) => [f.name, true])));
  });

  it('storescu is told when an object is refused', async () => {
    const { port, core } = await listening();
    const [first] = syntheticCtSeries(1, 16);
    const [other] = syntheticCtSeries(1, 24); // the same UID, another image
    const address = ['--aetitle', PEER_AE, '--call', LISTENER_AE, '127.0.0.1', String(port)];
    expect(await tool('storescu', [...address, ...(await onDisk([first]))])).toBe(true);
    // storescu goes on after a failed store unless told to stop.
    expect(await tool('storescu', ['--halt', ...address, ...(await onDisk([other]))])).toBe(false);
    expect(await core.pacs!.index.findInstances()).toHaveLength(1);
  });

  it('storescp answers our C-ECHO', async () => {
    const { port } = await storescp();
    expect(await echo(port, 'DCMTK')).toEqual({ outcome: 'ok' });
  });

  /** What storescp wrote: each object as a Part 10 file of its own making. */
  const written = async (folder: string): Promise<Buffer[]> =>
    Promise.all((await readdir(folder)).map((name) => readFile(join(folder, name))));

  const target = (port: number) => ({
    host: '127.0.0.1',
    port,
    calledAeTitle: 'DCMTK',
    callingAeTitle: PEER_AE,
    timeoutMs: 10_000,
  });

  // The first "done when" of #50: a series and a structure set arrive intact.
  it('storescp takes what the server sends, each data set byte for byte', async () => {
    // Bit-preserving: it writes what it received, and not its own writing of it.
    const { port, folder } = await storescp(['--bit-preserving']);
    // A CT, an MR, a structure set, a plan, a dose and a registration.
    const files = syntheticRtCourse();
    const objects = files.map((file) => outgoingFrom(file.bytes)!);
    expect(await sendObjects(target(port), objects)).toEqual(
      objects.map(() => ({ outcome: 'stored', status: 0, rewritten: false })),
    );

    const theirs = (await written(folder)).map((file) => Buffer.from(dataSetOf(file)!));
    expect(theirs).toHaveLength(files.length);
    for (const [i, object] of objects.entries()) {
      const ours = Buffer.from(object.dataSet);
      expect(
        theirs.some((one) => one.equals(ours)),
        files[i].name,
      ).toBe(true);
    }
  });

  // #101: a summed dose as the viewer saves it can be sent to a test peer.
  it('storescp takes a summed dose as it was saved, the private block with it', async () => {
    const { port, folder } = await storescp(['--bit-preserving']);
    const object = outgoingFrom(syntheticSummedDose())!;
    expect(await sendObjects(target(port), [object])).toEqual([
      { outcome: 'stored', status: 0, rewritten: false },
    ]);
    const theirs = await written(folder);
    expect(theirs).toHaveLength(1);
    expect(Buffer.from(dataSetOf(theirs[0])!).equals(Buffer.from(object.dataSet))).toBe(true);
    // And DCMTK's own reader reads it: a dose, with the private block's creator.
    const { stdout } = await run('dcmdump', [join(folder, (await readdir(folder))[0])]);
    expect(stdout).toContain('RTDOSE');
    expect(stdout).toContain(SUM_RECORD_CREATOR);
  });

  it('storescp that takes only Implicit VR has each object written anew, and reads it', async () => {
    const { port, folder } = await storescp(['--implicit']);
    const files = syntheticRtCourse();
    const objects = files.map((file) => outgoingFrom(file.bytes)!);
    expect(await sendObjects(target(port), objects)).toEqual(
      objects.map(() => ({ outcome: 'stored', status: 0, rewritten: true })),
    );
    // The same objects, as the server's own reader finds them in what DCMTK wrote.
    const there = (await written(folder)).map((file) => {
      const read = readInstanceHeader(file);
      if (!read.ok) throw new Error('the server cannot read what DCMTK wrote');
      return read.header;
    });
    expect(there.map((header) => header.transferSyntaxUid)).toEqual(
      objects.map(() => IMPLICIT_VR_LE),
    );
    expect(there.map((header) => header.sopInstanceUid).sort()).toEqual(
      objects.map((object) => object.sopInstanceUid).sort(),
    );
  });

  it('storescp is not sent compressed pixel data it does not take', async () => {
    // Uncompressed only, which is how storescp starts.
    const { port, folder } = await storescp();
    const compressed = syntheticCtSeries(2, 16, { encoding: { jpegLossless: 1 } });
    const objects = compressed.map((file) => outgoingFrom(file.bytes)!);
    expect(await sendObjects(target(port), objects)).toEqual(
      objects.map(() => ({ outcome: 'not-taken', why: 'transfer-syntax' })),
    );
    expect(await readdir(folder)).toEqual([]);
  });

  // ---- #52: asked what it holds, and to send it, by findscu, movescu and getscu.

  /** A listener that holds the synthetic course, which PEER may query and retrieve from. */
  async function holding(
    options: Parameters<typeof startTestListener>[0] = {},
  ): Promise<TestListener> {
    const started = await startTestListener({ callers: [], retrievers: [PEER_AE], ...options });
    open.push(started);
    for (const file of syntheticRtCourse()) {
      expect((await started.core.pacs!.ingest.ingest(file.bytes)).outcome).toBe('stored');
    }
    return started;
  }
  /**
   * A value as a DCMTK tool prints one: in brackets, with the NUL a UID of
   * odd length is padded with, or the space of other text.
   */
  const shown = (value: string): RegExp =>
    new RegExp(`\\[${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\0 ]?\\]`);
  const asking = (port: number, calling = PEER_AE): string[] => [
    ...['--verbose', '--aetitle', calling, '--call', LISTENER_AE],
    ...['127.0.0.1', String(port)],
  ];
  const kept = async (core: TestListener['core'], sopInstanceUid: string): Promise<Buffer> => {
    const pieces: Buffer[] = [];
    for await (const piece of await core.pacs!.store.get(sopInstanceUid)) {
      pieces.push(piece as Buffer);
    }
    return Buffer.concat(pieces);
  };
  /** That each file a DCMTK tool wrote holds the data set the server has under its UID. */
  async function expectAsHeld(core: TestListener['core'], files: readonly Buffer[]): Promise<void> {
    for (const file of files) {
      const read = readInstanceHeader(file);
      if (!read.ok) throw new Error('the server cannot read what DCMTK wrote');
      const ours = dataSetOf(await kept(core, read.header.sopInstanceUid))!;
      expect(
        Buffer.from(dataSetOf(file)!).equals(Buffer.from(ours)),
        read.header.sopInstanceUid,
      ).toBe(true);
    }
  }

  it('findscu finds the studies of a patient by a part of the name, and the series of one', async () => {
    const { port, core } = await holding();
    const [patient] = await core.pacs!.index.findPatients();
    const studies = await said('findscu', [
      ...['--study', '-k', 'QueryRetrieveLevel=STUDY'],
      ...['-k', `PatientName=${patient.name!.slice(0, 4)}*`],
      ...['-k', 'PatientID', '-k', 'StudyInstanceUID', '-k', 'StudyDate'],
      ...['-k', 'NumberOfStudyRelatedInstances'],
      ...asking(port),
    ]);
    expect(studies.ok, studies.text).toBe(true);
    expect(studies.text).toMatch(shown(SYNTHETIC_RT_COURSE.planningStudy));
    expect(studies.text).toMatch(shown(SYNTHETIC_RT_COURSE.followUpStudy));
    expect(studies.text).toMatch(shown(patient.patientId));
    expect(studies.text.match(/Find Response: \d+ \(Pending\)/g)).toHaveLength(2);

    const series = await said('findscu', [
      ...['--patient', '-k', 'QueryRetrieveLevel=SERIES'],
      ...['-k', `StudyInstanceUID=${SYNTHETIC_RT_COURSE.planningStudy}`],
      ...['-k', 'Modality=CT', '-k', 'SeriesInstanceUID'],
      ...asking(port),
    ]);
    expect(series.ok, series.text).toBe(true);
    expect(series.text).toMatch(shown(SYNTHETIC_RT_COURSE.ct));
    expect(series.text).not.toMatch(shown(SYNTHETIC_RT_COURSE.mr));
  });

  it('movescu has a study sent to storescp, each data set byte for byte', async () => {
    const archive = await storescp(['--bit-preserving']);
    const { port, core } = await holding({
      destinationOf: (aeTitle) =>
        aeTitle === 'DCMTK' ? { host: '127.0.0.1', port: archive.port } : null,
      moveTimeoutMs: 10_000,
      retrieveLimits: { instancesAtOnce: 3 },
    });
    const moved = await said('movescu', [
      ...['--study', '--move', 'DCMTK', '-k', 'QueryRetrieveLevel=STUDY'],
      ...['-k', `StudyInstanceUID=${SYNTHETIC_RT_COURSE.planningStudy}`],
      ...asking(port),
    ]);
    expect(moved.ok, moved.text).toBe(true);
    const held = await core.pacs!.index.findInstances({
      studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy,
    });
    const theirs = await written(archive.folder);
    expect(theirs).toHaveLength(held.length);
    await expectAsHeld(core, theirs);

    // A destination the server does not know is refused, and nothing is sent.
    const elsewhere = await said('movescu', [
      ...['--study', '--move', 'ELSEWHERE', '-k', 'QueryRetrieveLevel=STUDY'],
      ...['-k', `StudyInstanceUID=${SYNTHETIC_RT_COURSE.followUpStudy}`],
      ...asking(port),
    ]);
    expect(elsewhere.text).toMatch(/Move ?Destination ?unknown/i);
    expect(await written(archive.folder)).toHaveLength(held.length);
  });

  it('getscu gets everything of a patient back: images, structure set, plan, dose and registration', async () => {
    const { port, core } = await holding({ retrieveLimits: { instancesAtOnce: 4 } });
    const [patient] = await core.pacs!.index.findPatients();
    const folder = await mkdtemp(join(directory, 'getscu-'));
    const got = await said('getscu', [
      ...['--patient', '--bit-preserving', '--output-directory', folder],
      ...['-k', 'QueryRetrieveLevel=PATIENT', '-k', `PatientID=${patient.patientId}`],
      ...asking(port),
    ]);
    expect(got.ok, got.text).toBe(true);
    const theirs = await written(folder);
    expect(theirs).toHaveLength(SYNTHETIC_RT_COURSE.instances);
    await expectAsHeld(core, theirs);
    const uids = theirs.map((file) => {
      const read = readInstanceHeader(file);
      return read.ok ? read.header.sopInstanceUid : '';
    });
    expect(uids).toEqual(
      expect.arrayContaining([
        SYNTHETIC_RT_COURSE.structureSet,
        SYNTHETIC_RT_COURSE.plan,
        SYNTHETIC_RT_COURSE.dose,
        SYNTHETIC_RT_COURSE.registration,
      ]),
    );
  });

  // The second "done when" of #52.
  it('an AE title that is not on the list is refused by all three, and one that may only store is answered nothing', async () => {
    const { port } = await holding({ callers: ['STORER'] });
    const study = ['-k', `StudyInstanceUID=${SYNTHETIC_RT_COURSE.planningStudy}`];
    const level = ['-k', 'QueryRetrieveLevel=STUDY'];
    const folder = await mkdtemp(join(directory, 'getscu-'));
    for (const calling of ['SOMEONE', 'STORER']) {
      const found = await said('findscu', [
        '--study',
        ...level,
        ...study,
        ...asking(port, calling),
      ]);
      expect(found.text, calling).not.toMatch(shown(SYNTHETIC_RT_COURSE.planningStudy));
      expect(found.text, calling).not.toMatch(/Find Response: \d+ \(Pending\)/);
      const moved = await said('movescu', [
        ...['--study', '--move', 'DCMTK', ...level, ...study],
        ...asking(port, calling),
      ]);
      expect(moved.ok, calling).toBe(false);
      const got = await said('getscu', [
        ...['--study', '--output-directory', folder, ...level, ...study],
        ...asking(port, calling),
      ]);
      expect(got.ok, calling).toBe(false);
      expect(await readdir(folder), calling).toEqual([]);
    }
    // The one that is not on the list is told so when it asks for an association.
    const stranger = await said('findscu', [
      '--study',
      ...level,
      ...study,
      ...asking(port, 'SOMEONE'),
    ]);
    expect(stranger.ok).toBe(false);
    expect(stranger.text).toMatch(/Association Rejected|Calling AE Title Not Recognized/i);
  });

  // ---- #51: the server asks DCMTK's archive what it holds, and has it sent here.

  /**
   * DCMTK's dcmqrscp, holding the synthetic course, which knows the server
   * under test as a place to send to.
   */
  async function dcmqrscp(ourPort: number): Promise<number> {
    const port = await freePort();
    const storage = await mkdtemp(join(directory, 'dcmqrscp-'));
    const config = join(storage, 'dcmqrscp.cfg');
    await writeFile(
      config,
      [
        `NetworkTCPPort  = ${port}`,
        'MaxPDUSize      = 16384',
        'MaxAssociations = 16',
        'HostTable BEGIN',
        `ours = (${LISTENER_AE}, 127.0.0.1, ${ourPort})`,
        'HostTable END',
        'VendorTable BEGIN',
        'VendorTable END',
        'AETable BEGIN',
        `DCMQRSCP ${storage} RW (200, 1024mb) ANY`,
        'AETable END',
        '',
      ].join('\n'),
    );
    const child = spawn('dcmqrscp', ['--config', config, String(port)], { stdio: 'ignore' });
    children.push(child);
    let there = false;
    for (let tries = 0; tries < 50 && !there; tries++) {
      there = (await echo(port, 'DCMQRSCP')).outcome === 'ok';
      if (!there) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!there) throw new Error('dcmqrscp did not start listening');
    const sent = await said('storescu', [
      ...['--aetitle', LISTENER_AE, '--call', 'DCMQRSCP'],
      ...['127.0.0.1', String(port), ...(await onDisk(syntheticRtCourse()))],
    ]);
    if (!sent.ok) throw new Error(`dcmqrscp did not take the course: ${sent.text}`);
    return port;
  }

  // The "done when" of #51, against a system that is not ours.
  it('finds a study on dcmqrscp and retrieves it into the PACS', async () => {
    const here = await startTestListener({ callers: ['DCMQRSCP'] });
    open.push(here);
    const port = await dcmqrscp(here.port);
    const archive = {
      host: '127.0.0.1',
      port,
      calledAeTitle: 'DCMQRSCP',
      callingAeTitle: LISTENER_AE,
      timeoutMs: 20_000,
    };

    const studies = await findAt(archive, 'study', { patientName: 'SYNTH*' });
    expect(studies).toMatchObject({ outcome: 'answered', status: 0, complete: true });
    if (studies.outcome !== 'answered') return;
    expect(studies.matches.map((match) => match.studyInstanceUid).sort()).toEqual(
      [SYNTHETIC_RT_COURSE.planningStudy, SYNTHETIC_RT_COURSE.followUpStudy].sort(),
    );
    expect(studies.matches.every((match) => match.patientName?.startsWith('SYNTH'))).toBe(true);
    const series = await findAt(archive, 'series', {
      studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy,
    });
    expect(
      series.outcome === 'answered' && series.matches.map((one) => one.modality).sort(),
    ).toEqual(['CT', 'MR', 'RTDOSE', 'RTPLAN', 'RTSTRUCT'].sort());
    expect(await findAt(archive, 'study', { patientName: 'NOBODY*' })).toMatchObject({
      outcome: 'answered',
      matches: [],
    });

    const told: number[] = [];
    const moved = await moveFrom(
      archive,
      LISTENER_AE,
      { studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy },
      (counts) => told.push(counts.completed),
    );
    expect(moved).toMatchObject({
      outcome: 'answered',
      status: 0,
      counts: { remaining: 0, completed: 8, failed: 0 },
    });
    // It told how far it was on the way, and never went back.
    expect(told.length).toBeGreaterThan(0);
    expect([...told].sort((a, b) => a - b)).toEqual(told);
    const arrived = await here.core.pacs!.index.findInstances({
      studyInstanceUid: SYNTHETIC_RT_COURSE.planningStudy,
    });
    expect(arrived).toHaveLength(8);
    // What came is read as what it is: the structure set is the CT's.
    expect(
      (await here.core.pacs!.index.relatedToSeries(SYNTHETIC_RT_COURSE.ct))?.structureSets.map(
        (one) => one.sopInstanceUid,
      ),
    ).toEqual([SYNTHETIC_RT_COURSE.structureSet]);

    // To a place dcmqrscp does not know, nothing is sent; and one series alone can be.
    expect(
      await moveFrom(archive, 'ELSEWHERE', { studyInstanceUid: SYNTHETIC_RT_COURSE.followUpStudy }),
    ).toMatchObject({ outcome: 'answered', status: 0xa801 });
    expect(
      await moveFrom(archive, LISTENER_AE, {
        studyInstanceUid: SYNTHETIC_RT_COURSE.followUpStudy,
        seriesInstanceUid: SYNTHETIC_RT_COURSE.followUpCt,
      }),
    ).toMatchObject({ outcome: 'answered', status: 0 });
    expect(await here.core.pacs!.index.counts()).toMatchObject({
      instances: 8 + SYNTHETIC_RT_COURSE.followUpCtSlices,
    });
  });
});

// #57, the issue's second "done when": a TLS association with a test peer
// that speaks TLS. The certificates are made here, with RSA keys: the
// ciphersuites of DCMTK's default profile for TLS 1.2 are for those.
describe.skipIf(!dcmtk)('against DCMTK, over TLS', () => {
  let authority: TestCertificate;
  let ours: TestCertificate;
  let theirs: TestCertificate;
  /** The same as files, for DCMTK's tools. */
  let ca = '';
  let theirCert = '';
  let theirKey = '';

  beforeAll(async () => {
    authority = testCertificate({ authority: true, rsa: true });
    ours = testCertificate({ signedBy: authority, rsa: true });
    theirs = testCertificate({ signedBy: authority, rsa: true });
    const folder = await mkdtemp(join(directory, 'tls-'));
    [ca, theirCert, theirKey] = ['ca.pem', 'cert.pem', 'key.pem'].map((name) => join(folder, name));
    await writeFile(ca, authority.cert);
    await writeFile(theirCert, theirs.cert);
    await writeFile(theirKey, theirs.key, { mode: 0o600 });
  });

  async function secure(askWhoCalls: boolean): Promise<TestListener> {
    const started = await startTestListener({
      tls: { ...ours, ca: askWhoCalls ? authority.cert : null },
    });
    open.push(started);
    return started;
  }

  it('echoscu is answered over TLS when it trusts the certificate, and not without TLS', async () => {
    const { port } = await secure(false);
    const address = ['--aetitle', PEER_AE, '--call', LISTENER_AE, '127.0.0.1', String(port)];
    expect(await tool('echoscu', ['--anonymous-tls', '--add-cert-file', ca, ...address])).toBe(
      true,
    );
    // Without TLS, and with it but with no authority to trust the listener by.
    expect(await tool('echoscu', address)).toBe(false);
    expect(await tool('echoscu', ['--anonymous-tls', ...address])).toBe(false);
  });

  it('storescu shows a certificate to a listener that asks who calls, and what it sends is stored', async () => {
    const { port, core } = await secure(true);
    const files = syntheticCtSeries(3, 16);
    const address = [
      ...['--aetitle', PEER_AE, '--call', LISTENER_AE],
      ...['127.0.0.1', String(port), ...(await onDisk(files))],
    ];
    // With no certificate to show, it is not heard.
    expect(await tool('storescu', ['--anonymous-tls', '--add-cert-file', ca, ...address])).toBe(
      false,
    );
    expect(await core.pacs!.index.findInstances()).toHaveLength(0);
    const sent = await tool('storescu', [
      ...['--enable-tls', theirKey, theirCert, '--null-passwd', '--add-cert-file', ca],
      ...address,
    ]);
    expect(sent).toBe(true);
    expect(await core.pacs!.index.findInstances()).toHaveLength(files.length);
    for (const file of files) {
      const pieces: Buffer[] = [];
      const stream = await core.pacs!.store.get(sopInstanceUidOf(file.bytes));
      for await (const piece of stream) pieces.push(piece as Buffer);
      expect(
        Buffer.from(dataSetOf(Buffer.concat(pieces))!).equals(Buffer.from(dataSetOf(file.bytes)!)),
        file.name,
      ).toBe(true);
    }
  });

  it('storescp with TLS answers our echo and takes what the server sends, each data set byte for byte', async () => {
    // It asks who calls, as it does unless told not to: the server shows its certificate.
    const shown: ClientTls = { ca: authority.cert, cert: ours.cert, key: ours.key };
    const { port, folder } = await storescp(
      [
        ...['--enable-tls', theirKey, theirCert, '--null-passwd', '--add-cert-file', ca],
        '--bit-preserving',
      ],
      shown,
    );
    expect(await echo(port, 'DCMTK', shown)).toEqual({ outcome: 'ok' });
    // Not trusted by the authorities the machine knows; and it does not take a caller without TLS.
    expect(await echo(port, 'DCMTK', {})).toEqual({ outcome: 'tls-untrusted' });
    expect((await echo(port, 'DCMTK')).outcome).not.toBe('ok');

    const files = syntheticRtCourse();
    const objects = files.map((file) => outgoingFrom(file.bytes)!);
    const target = {
      host: '127.0.0.1',
      port,
      calledAeTitle: 'DCMTK',
      callingAeTitle: PEER_AE,
      timeoutMs: 10_000,
      tls: shown,
    };
    expect(await sendObjects(target, objects)).toEqual(
      objects.map(() => ({ outcome: 'stored', status: 0, rewritten: false })),
    );
    const written = await Promise.all(
      (await readdir(folder)).map((name) => readFile(join(folder, name))),
    );
    const there = written.map((file) => Buffer.from(dataSetOf(file)!));
    expect(there).toHaveLength(files.length);
    for (const [i, object] of objects.entries()) {
      const sent = Buffer.from(object.dataSet);
      expect(
        there.some((one) => one.equals(sent)),
        files[i].name,
      ).toBe(true);
    }
  });

  it('storescp that asks who calls is told apart from one that is not trusted', async () => {
    const shown: ClientTls = { ca: authority.cert, cert: ours.cert, key: ours.key };
    const { port } = await storescp(
      ['--enable-tls', theirKey, theirCert, '--null-passwd', '--add-cert-file', ca],
      shown,
    );
    // With no certificate to show it, the server is refused; why is said as a refusal.
    expect(await echo(port, 'DCMTK', { ca: authority.cert })).toEqual({ outcome: 'tls-refused' });
  });
});

describe.skipIf(!required)('where DCMTK is required', () => {
  it('is installed', () => {
    expect(TOOLS.filter((name) => !installed(name))).toEqual([]);
  });
});
