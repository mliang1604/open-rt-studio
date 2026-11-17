/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The proof of concept of the DIMSE library spike (#40), between the
// library's own client and an SCP of ours on it. What it has to show is in
// docs/dimse-library.md; the same against DCMTK is in dcmtk.spec.ts.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syntheticCtSeries, syntheticRtCourse, type SyntheticFile } from '@open-rt-studio/testdata';

import { createIngest } from '../ingest/ingest.js';
import { openSqliteIndex } from '../pacs-index/sqlite-index.js';
import { createMemoryStore } from '../store/memory-store.js';
import { testCertificate } from '../tls-testing.js';
import {
  dataSetOf,
  echo,
  EXPLICIT_VR_LE,
  part10,
  startProofScp,
  store,
  SUCCESS,
  type ProofScp,
} from './testing/proof.js';

let directory = '';
const open: ProofScp[] = [];
const closing: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-dimse-'));
});
afterEach(async () => {
  for (const scp of open.splice(0)) scp.close();
  for (const close of closing.splice(0)) await close();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** The files on disk, which is where the library's client sends from. */
async function onDisk(files: readonly SyntheticFile[]): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    const path = join(directory, file.name);
    await writeFile(path, file.bytes);
    paths.push(path);
  }
  return paths;
}

async function scp(options: Parameters<typeof startProofScp>[0] = {}): Promise<ProofScp> {
  const started = await startProofScp(options);
  open.push(started);
  return started;
}

describe('C-ECHO', () => {
  it('is answered', async () => {
    const { port } = await scp();
    expect(await echo(port)).toEqual({ statuses: [SUCCESS], rejected: false });
  });

  it('is refused to a calling AE title that is not let in, and answered to one that is', async () => {
    const { port } = await scp({ callers: ['PLANNING'] });
    expect(await echo(port, { callingAeTitle: 'SOMEONE' })).toEqual({
      statuses: [],
      rejected: true,
    });
    expect(await echo(port, { callingAeTitle: 'PLANNING' })).toEqual({
      statuses: [SUCCESS],
      rejected: false,
    });
  });
});

describe('C-STORE', () => {
  it('gives the store hook the bytes of each data set as they are in the file sent', async () => {
    const files = syntheticCtSeries(3, 32);
    const listener = await scp();
    const result = await store(listener.port, await onDisk(files));

    expect(result.statuses).toEqual([SUCCESS, SUCCESS, SUCCESS]);
    expect(listener.received).toHaveLength(3);
    for (const [i, object] of listener.received.entries()) {
      expect(object.transferSyntax).toBe(EXPLICIT_VR_LE);
      expect(object.callingAeTitle).toBe('PROOF-SCU');
      expect(Buffer.from(object.dataSet).equals(Buffer.from(dataSetOf(files[i].bytes)))).toBe(true);
    }
  });

  it('feeds the ingest: what arrives is stored and indexed with what it refers to', async () => {
    const index = await openSqliteIndex(':memory:');
    closing.push(() => index.close());
    const ingest = createIngest({ store: createMemoryStore(), index });
    const outcomes: string[] = [];
    const listener = await scp({
      // Our Part 10 header in front of the bytes, then the one way in.
      onObject: async (object) => {
        outcomes.push((await ingest.ingest(part10(object))).outcome);
      },
    });

    // A CT, a structure set, a plan, a dose and a registration that name each other.
    const files = syntheticRtCourse();
    const result = await store(listener.port, await onDisk(files));

    expect(result.statuses).toEqual(files.map(() => SUCCESS));
    expect(outcomes).toEqual(files.map(() => 'stored'));
    const instances = await index.findInstances();
    expect(instances).toHaveLength(files.length);
    expect(new Set(instances.map((i) => i.sopInstanceUid))).toEqual(
      new Set(listener.received.map((o) => o.sopInstanceUid)),
    );

    // Every kind of object got through: the objects with sequences too, which
    // the library's client writes anew when it sends (their bytes are not the
    // file's; see docs/dimse-library.md).
    expect([...new Set(instances.map((i) => i.modality))].sort()).toEqual([
      'CT',
      'MR',
      'REG',
      'RTDOSE',
      'RTPLAN',
      'RTSTRUCT',
    ]);

    // Sent again, nothing is written: the bytes are the same bytes.
    outcomes.length = 0;
    await store(listener.port, await onDisk(files.slice(0, 2)));
    expect(outcomes).toEqual(['unchanged', 'unchanged']);
  });

  it('answers a failure when the object could not be taken', async () => {
    const listener = await scp({
      onObject: () => Promise.reject(new Error('refused')),
    });
    const result = await store(listener.port, await onDisk(syntheticCtSeries(1, 8)));
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0]).not.toBe(SUCCESS);
  });
});

describe('TLS', () => {
  it('echoes and stores over TLS with the certificate the server takes for HTTPS', async () => {
    const pair = testCertificate();
    const listener = await scp({ tls: pair });
    expect(await echo(listener.port, { trust: pair.cert })).toEqual({
      statuses: [SUCCESS],
      rejected: false,
    });
    const files = syntheticCtSeries(1, 16);
    const result = await store(listener.port, await onDisk(files), { trust: pair.cert });
    expect(result.statuses).toEqual([SUCCESS]);
    expect(
      Buffer.from(listener.received[0].dataSet).equals(Buffer.from(dataSetOf(files[0].bytes))),
    ).toBe(true);
  });

  it('a client that trusts another certificate does not get through', async () => {
    const listener = await scp({ tls: testCertificate() });
    await expect(echo(listener.port, { trust: testCertificate().cert })).rejects.toThrow();
    expect(listener.received).toHaveLength(0);
  });

  it('a client without TLS does not get through to a TLS listener', async () => {
    const listener = await scp({ tls: testCertificate() });
    const outcome = await echo(listener.port).then(
      (result) => result.statuses,
      () => 'failed',
    );
    expect(outcome).not.toEqual([SUCCESS]);
  });
});
