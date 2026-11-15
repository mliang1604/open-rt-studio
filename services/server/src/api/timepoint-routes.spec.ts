/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { syntheticRtCourse } from '@open-rt-studio/testdata';

import { DEFAULT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import { startServer, type RunningServer } from '../server.js';
import { API_PREFIX } from './api-routes.js';
import { SCHEMAS } from './schemas.js';
import { violations } from './testing.js';
import {
  MAX_TIMEPOINT_NAME,
  MAX_TIMEPOINT_STUDIES,
  MAX_TIMEPOINTS,
  timepointsOf,
} from './timepoint-routes.js';

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

/** A server that holds the synthetic course: one patient, two studies. */
async function served() {
  const server = await startServer(
    { ...DEFAULT_CONFIG, auth: 'none', port: 0, shutdownTimeoutMs: 5_000 },
    createLogger({ level: 'error', write: () => undefined }),
  );
  running.push(server);
  const url = `http://127.0.0.1:${server.address.port}${API_PREFIX}`;
  const files = syntheticRtCourse();
  for (const file of files) {
    const stored = await fetch(`${url}/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/dicom' },
      body: file.bytes,
    });
    expect(stored.status).toBe(201);
  }
  const patients = (await (await fetch(`${url}/patients`)).json()) as {
    items: { patientKey: number }[];
  };
  expect(patients.items).toHaveLength(1);
  const path = `${url}/patients/${patients.items[0].patientKey}/timepoints`;
  const studies = (await (await fetch(`${url}/studies?order=oldest`)).json()) as {
    items: { studyInstanceUid: string }[];
  };
  expect(studies.items).toHaveLength(2);
  const [planning, followUp] = studies.items.map((study) => study.studyInstanceUid);
  const list = {
    timepoints: [
      { id: 'b', name: 'Re-plan', studyUids: [followUp] },
      { id: 'a', name: 'Planning', studyUids: [planning] },
      { id: 'c', name: 'Fraction 10', studyUids: [] },
    ],
  };
  const put = (body: unknown, type = 'application/json', at = path) =>
    fetch(at, {
      method: 'PUT',
      headers: { 'Content-Type': type },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const kept = async (): Promise<unknown> => (await (await fetch(path)).json()) as unknown;
  const remove = (sopInstanceUid: string) => server.core.pacs!.index.removeInstance(sopInstanceUid);
  return { url, path, put, kept, files, remove, server, list, planning, followUp };
}

describe('a patient’s timepoints', () => {
  it('are none until some are kept, and then are what was kept, in its order', async () => {
    const { put, kept, list, planning, followUp } = await served();
    expect(await kept()).toEqual({ timepoints: [] });
    const answer = await put(list);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as unknown;
    expect(body).toEqual(list);
    expect(violations(body, SCHEMAS['Timepoints'], SCHEMAS)).toEqual([]);
    expect(await kept()).toEqual(list);
    // A list takes the place of the one before, whole; an empty one keeps none.
    const one = {
      timepoints: [{ id: 'a', name: 'Planning CT', studyUids: [planning, followUp] }],
    };
    expect((await put(one)).status).toBe(200);
    expect(await kept()).toEqual(one);
    expect((await put({ timepoints: [] })).status).toBe(200);
    expect(await kept()).toEqual({ timepoints: [] });
  });

  it('are refused whole when a study is not the patient’s, and what was kept stays', async () => {
    const { put, kept, list, planning } = await served();
    await put(list);
    const answer = await put({
      timepoints: [{ id: 'a', name: 'Planning', studyUids: [planning, '1.2.3.4'] }],
    });
    expect(answer.status).toBe(400);
    const error = (await answer.json()) as { error: string; message: string };
    expect(error.error).toBe('invalid-request');
    // What is wrong is said without repeating any of it.
    expect(error.message).toBe('A timepoint names a study that is not this patient’s.');
    expect(await kept()).toEqual(list);
  });

  it('are of a patient the server has, asked for by the key the patient list gives', async () => {
    const { url, put, list } = await served();
    expect((await fetch(`${url}/patients/987654/timepoints`)).status).toBe(404);
    expect((await put(list, 'application/json', `${url}/patients/987654/timepoints`)).status).toBe(
      404,
    );
    for (const key of ['0', '-1', 'abc', '1.5', '12345678901234567']) {
      expect((await fetch(`${url}/patients/${key}/timepoints`)).status, key).toBe(400);
    }
    expect((await fetch(`${url}/patients/1/timepoints?name=x`)).status).toBe(400);
  });

  it('are sent as JSON', async () => {
    const { put, list } = await served();
    expect((await put(JSON.stringify(list), 'text/plain')).status).toBe(415);
    expect((await put('{"timepoints": [', 'application/json')).status).toBe(400);
  });

  it('go when the patient’s last study does', async () => {
    const { put, files, remove, server, list } = await served();
    await put(list);
    const index = server.core.pacs!.index;
    const [patient] = await index.findPatients();
    expect(await index.getTimepoints(patient.patientKey)).toHaveLength(3);
    for (const instance of await index.findInstances({ limit: files.length + 1 })) {
      await remove(instance.sopInstanceUid);
    }
    expect(await index.findPatients()).toEqual([]);
    expect(await index.getTimepoints(patient.patientKey)).toBeNull();
    expect(await index.putTimepoints(patient.patientKey, [])).toBe(false);
  });
});

describe('a list of timepoints, as a body', () => {
  const one = (more: object = {}) => ({ id: 'a', name: 'Planning', studyUids: ['1.2.3'], ...more });
  const refused = (body: unknown): string => {
    try {
      timepointsOf(body);
    } catch (error) {
      return (error as Error).message;
    }
    return 'taken';
  };

  it('is taken when every timepoint is well formed', () => {
    expect(
      timepointsOf({ timepoints: [one(), one({ id: 'b-2', name: '', studyUids: [] })] }),
    ).toEqual([one(), { id: 'b-2', name: '', studyUids: [] }]);
    const longest = 'é'.repeat(MAX_TIMEPOINT_NAME);
    expect(timepointsOf({ timepoints: [one({ name: longest })] })[0].name).toBe(longest);
  });

  it('is refused for what it is, and for anything else it holds', () => {
    for (const body of [null, 'x', [], { timepoints: {} }, { timepoints: [], more: 1 }, {}]) {
      expect(refused(body)).not.toBe('taken');
    }
    expect(refused({ timepoints: ['x'] })).toBe('A timepoint is an object.');
    expect(refused({ timepoints: [one({ colour: 'red' })] })).toBe(
      'A timepoint holds id, name and studyUids, and nothing else.',
    );
    const many = Array.from({ length: MAX_TIMEPOINTS + 1 }, (_, at) =>
      one({ id: `t${at}`, studyUids: [] }),
    );
    expect(refused({ timepoints: many })).toBe(
      `A patient has at most ${MAX_TIMEPOINTS} timepoints.`,
    );
  });

  it('is refused for an id that is not one, or that two have', () => {
    for (const id of ['', 'a b', 'a/b', 'x'.repeat(65), 7, null]) {
      expect(refused({ timepoints: [one({ id })] })).toContain('an id of its own');
    }
    expect(refused({ timepoints: [one(), one({ studyUids: [] })] })).toContain('an id of its own');
  });

  it('is refused for a name that is not one line of text of a name’s length', () => {
    for (const name of [' Planning', 'Planning ', 'Plan\nning', 'Plan\tning', 'x'.repeat(65), 7]) {
      expect(refused({ timepoints: [one({ name })] })).toContain('a name of one line');
    }
  });

  it('is refused for studies that are no UIDs, that are in two timepoints, or that are too many', () => {
    for (const studyUids of ['1.2.3', ['x'], ['1.2.3', '1.2.3'], [7], ['1.2.'.repeat(20)]]) {
      expect(refused({ timepoints: [one({ studyUids })] })).not.toBe('taken');
    }
    expect(refused({ timepoints: [one(), one({ id: 'b' })] })).toBe(
      'studyUids are Study Instance UIDs, each in one timepoint at most.',
    );
    const studyUids = Array.from({ length: MAX_TIMEPOINT_STUDIES + 1 }, (_, at) => `1.2.${at}`);
    expect(refused({ timepoints: [one({ studyUids })] })).toBe(
      `A patient's timepoints hold at most ${MAX_TIMEPOINT_STUDIES} studies.`,
    );
  });
});
