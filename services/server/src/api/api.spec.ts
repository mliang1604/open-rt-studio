/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';

import {
  SYNTHETIC_RT_COURSE as COURSE,
  SYNTHETIC_STUDY,
  syntheticCtSeries,
  syntheticRtCourse,
  syntheticRtStruct,
  type SyntheticFile,
} from '@open-rt-studio/testdata';

import { DEFAULT_CONFIG, type ServerConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { startServer, type RunningServer } from '../server.js';
import { sopInstanceUidOf } from '../store/testing.js';
import { API_PREFIX, DEFAULT_LIMIT, MAX_LIMIT, parseRange } from './api-routes.js';
import { openApiPath } from './openapi.js';
import { SCHEMAS } from './schemas.js';
import { violations } from './testing.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const COURSE_FILES = syntheticRtCourse();
const uidOf = (file: SyntheticFile): string => sopInstanceUidOf(file.bytes);

interface Api {
  readonly server: RunningServer;
  readonly url: string;
  readonly log: () => Record<string, unknown>[];
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  /** GET and parse, having checked the status. */
  json<T = Record<string, unknown>>(path: string, status?: number): Promise<T>;
  upload(bytes: Uint8Array, query?: string, type?: string): Promise<Response>;
}

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

async function api(
  config: Partial<ServerConfig> = {},
  files: readonly SyntheticFile[] = [],
): Promise<Api> {
  const lines: string[] = [];
  const server = await startServer(
    { ...DEFAULT_CONFIG, port: 0, shutdownTimeoutMs: 2_000, ...config },
    createLogger({ level: 'info', write: (line) => lines.push(line) }),
  );
  running.push(server);
  const url = `http://127.0.0.1:${server.address.port}${API_PREFIX}`;
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { headers });
  const made: Api = {
    server,
    url,
    log: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    get,
    async json<T>(path: string, status = 200) {
      const response = await get(path);
      expect(response.status, path).toBe(status);
      return (await response.json()) as T;
    },
    upload: (bytes, query = '', type = 'application/dicom') =>
      fetch(`${url}/instances${query}`, {
        method: 'POST',
        headers: { 'Content-Type': type },
        body: bytes,
      }),
  };
  for (const file of files) expect((await made.upload(file.bytes)).status).toBe(201);
  return made;
}

interface PageOf<T> {
  items: T[];
  limit: number;
  offset: number;
  more: boolean;
}

/** Hold an answer against the schema the description gives for it. */
function expectSchema(value: unknown, schema: string): void {
  expect(violations(value, SCHEMAS[schema], SCHEMAS), schema).toEqual([]);
}

describe('upload', () => {
  it('stores an instance, and says where it is', async () => {
    const { upload, json } = await api();
    const [slice] = COURSE_FILES;
    const response = await upload(slice.bytes);
    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe(`${API_PREFIX}/instances/${uidOf(slice)}`);
    const body = (await response.json()) as unknown;
    expect(body).toEqual({ outcome: 'stored', sopInstanceUid: uidOf(slice) });
    expectSchema(body, 'Upload');
    expect(await json('/counts')).toEqual({ patients: 1, studies: 1, series: 1, instances: 1 });
  });

  it('changes nothing when the same file is uploaded again', async () => {
    const { upload, json } = await api({}, COURSE_FILES);
    const before = await json('/counts');
    for (const file of COURSE_FILES) {
      const response = await upload(file.bytes);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: 'unchanged', sopInstanceUid: uidOf(file) });
    }
    expect(await json('/counts')).toEqual(before);
    expect(before).toEqual({ patients: 1, studies: 2, series: 7, instances: COURSE.instances });
  });

  it('refuses other bytes under a UID it has (409), unless told to replace them', async () => {
    const first = syntheticRtStruct(3, 2);
    const other = syntheticRtStruct(3, 3);
    const { upload, get } = await api({}, [first]);

    const refused = await upload(other.bytes);
    expect(refused.status).toBe(409);
    const error = (await refused.json()) as unknown;
    expect(error).toMatchObject({ error: 'different-content' });
    expectSchema(error, 'Error');
    expect(
      sha256(new Uint8Array(await (await get(`/instances/${uidOf(first)}/file`)).arrayBuffer())),
    ).toBe(sha256(first.bytes));

    const replaced = await upload(other.bytes, '?onDifferent=replace');
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({ outcome: 'replaced', sopInstanceUid: uidOf(first) });
    expect(
      sha256(new Uint8Array(await (await get(`/instances/${uidOf(first)}/file`)).arrayBuffer())),
    ).toBe(sha256(other.bytes));
  });

  it('refuses a file that puts a known study under another patient (409)', async () => {
    const { upload, json } = await api({}, COURSE_FILES);
    const [, , , stray] = syntheticCtSeries(4, 16, {
      study: { ...SYNTHETIC_STUDY, patient: { id: 'SYN-0002', name: 'OTHER^PERSON' } },
    });
    const response = await upload(stray.bytes);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('study-of-another-patient');
    // The answer says nothing of either patient.
    expect(JSON.stringify(body)).not.toMatch(/SYN-|OTHER|PHANTOM/);
    expect((await json<{ instances: number }>('/counts')).instances).toBe(COURSE.instances);
  });

  it.each([
    ['text', new TextEncoder().encode('not a DICOM file'), 422, 'not-dicom'],
    ['nothing', new Uint8Array(), 422, 'not-dicom'],
  ] as const)('refuses %s (%i %s)', async (_what, bytes, status, error) => {
    const { upload, json } = await api();
    const response = await upload(bytes);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect((await json<{ instances: number }>('/counts')).instances).toBe(0);
  });

  it('wants the body sent as application/dicom (415)', async () => {
    const { upload } = await api();
    const [slice] = COURSE_FILES;
    for (const type of ['application/octet-stream', 'text/plain', 'multipart/form-data']) {
      const response = await upload(slice.bytes, '', type);
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({ error: 'unsupported-media-type' });
    }
    expect((await upload(slice.bytes, '', 'Application/DICOM; charset=binary')).status).toBe(201);
  });

  it('refuses a file larger than it is set to take (413), and takes one that fits', async () => {
    const [slice] = COURSE_FILES;
    const { upload, json } = await api({ maxUploadBytes: slice.bytes.byteLength });
    expect((await upload(slice.bytes)).status).toBe(201);
    const larger = new Uint8Array(slice.bytes.byteLength + 1);
    const response = await upload(larger);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'too-large' });
    expect((await json<{ instances: number }>('/counts')).instances).toBe(1);
  });

  it('refuses a parameter it does not know, or a value onDifferent does not have (400)', async () => {
    const { upload } = await api();
    const [slice] = COURSE_FILES;
    expect((await upload(slice.bytes, '?overwrite=1')).status).toBe(400);
    const response = await upload(slice.bytes, '?onDifferent=maybe');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid-parameter' });
  });
});

describe('browse', () => {
  let made: Api;
  beforeEach(async () => {
    made = await api({}, COURSE_FILES);
  });

  it('lists patients', async () => {
    const page =
      await made.json<PageOf<{ patientId: string; name: string; studies: number }>>('/patients');
    expectSchema(page, 'PatientPage');
    expect(page).toMatchObject({ limit: DEFAULT_LIMIT, offset: 0, more: false });
    expect(page.items).toMatchObject([
      { patientId: SYNTHETIC_STUDY.patient.id, name: SYNTHETIC_STUDY.patient.name, studies: 2 },
    ]);
    expect((await made.json<PageOf<unknown>>('/patients?name=synthetic*')).items).toHaveLength(1);
    expect((await made.json<PageOf<unknown>>('/patients?name=nobody*')).items).toEqual([]);
    expect((await made.json<PageOf<unknown>>('/patients?patientId=SYN-000?')).items).toHaveLength(
      1,
    );
  });

  it('lists studies, the latest first, and finds them by date, patient and modality', async () => {
    const all = await made.json<PageOf<{ studyInstanceUid: string }>>('/studies');
    expectSchema(all, 'StudyPage');
    expect(all.items.map((study) => study.studyInstanceUid)).toEqual([
      COURSE.followUpStudy,
      COURSE.planningStudy,
    ]);
    const uids = async (query: string) =>
      (await made.json<PageOf<{ studyInstanceUid: string }>>(`/studies?${query}`)).items.map(
        (study) => study.studyInstanceUid,
      );
    expect(await uids(`date=${SYNTHETIC_STUDY.date}`)).toEqual([COURSE.planningStudy]);
    expect(await uids('date=20260201-')).toEqual([COURSE.followUpStudy]);
    expect(await uids('modality=RTDOSE')).toEqual([COURSE.planningStudy]);
    expect(await uids('modality=REG&patientName=synthetic^*')).toEqual([COURSE.followUpStudy]);
    expect(await uids('patientId=SYN-0002')).toEqual([]);
    const [patient] = (await made.json<PageOf<{ patientKey: number }>>('/patients')).items;
    expect(await uids(`patientKey=${patient.patientKey}`)).toHaveLength(2);
  });

  it('gives one study, its series, one series and its instances', async () => {
    const study = await made.json(`/studies/${COURSE.planningStudy}`);
    expectSchema(study, 'Study');
    expect(study).toMatchObject({
      description: SYNTHETIC_STUDY.description,
      modalities: ['CT', 'MR', 'RTDOSE', 'RTPLAN', 'RTSTRUCT'],
      series: 5,
      instances: 8,
    });

    const series = await made.json<PageOf<{ modality: string; number: number }>>(
      `/studies/${COURSE.planningStudy}/series`,
    );
    expectSchema(series, 'SeriesPage');
    expect(series.items.map((one) => [one.number, one.modality])).toEqual([
      [1, 'CT'],
      [2, 'MR'],
      [10, 'RTSTRUCT'],
      [15, 'RTPLAN'],
      [20, 'RTDOSE'],
    ]);
    expect(
      (await made.json<PageOf<unknown>>(`/studies/${COURSE.planningStudy}/series?modality=RT*`))
        .items,
    ).toHaveLength(3);

    const ct = await made.json(`/series/${COURSE.ct}`);
    expectSchema(ct, 'Series');
    expect(ct).toMatchObject({
      modality: 'CT',
      instances: 3,
      frameOfReferenceUid: COURSE.planningFrame,
      // The course's one structure set was drawn on it.
      structureSets: 1,
    });

    // A dose is one file of several planes: one instance, as many images.
    const doses = await made.json<PageOf<{ instances: number; images: number }>>(
      `/studies/${COURSE.planningStudy}/series?modality=RTDOSE`,
    );
    expectSchema(doses, 'SeriesPage');
    const [dose] = doses.items;
    expect(dose.instances).toBe(1);
    expect(dose.images).toBeGreaterThan(1);
    const stored = await made.json<{ frames: number | null }>(`/instances/${COURSE.dose}`);
    expectSchema(stored, 'InstanceDetail');
    expect(stored.frames).toBe(dose.images);
    expect(ct).toMatchObject({ images: 3 });

    const instances = await made.json<PageOf<{ number: number; sopInstanceUid: string }>>(
      `/series/${COURSE.ct}/instances`,
    );
    expectSchema(instances, 'InstancePage');
    expect(instances.items.map((one) => one.number)).toEqual([1, 2, 3]);
  });

  it('gives the radiotherapy objects that belong to a series', async () => {
    const related = await made.json<
      Record<string, { sopInstanceUid?: string; modality: string }[]>
    >(`/series/${COURSE.ct}/related`);
    expectSchema(related, 'Related');
    expect(related['structureSets'].map((one) => one.sopInstanceUid)).toEqual([
      COURSE.structureSet,
    ]);
    expect(related['plans'].map((one) => one.sopInstanceUid)).toEqual([COURSE.plan]);
    expect(related['doses'].map((one) => one.sopInstanceUid)).toEqual([COURSE.dose]);
    expect(related['registrations'].map((one) => one.sopInstanceUid)).toEqual([
      COURSE.registration,
    ]);
    expect(related['sameFrame'].map((one) => one.modality)).toEqual([
      'MR',
      'RTPLAN',
      'RTDOSE',
      'REG',
    ]);
  });

  it('gives one instance with what it refers to', async () => {
    const dose = await made.json(`/instances/${COURSE.dose}`);
    expectSchema(dose, 'InstanceDetail');
    expect(dose).toMatchObject({
      modality: 'RTDOSE',
      studyInstanceUid: COURSE.planningStudy,
      references: [
        { relation: 'dose.plan', targetUid: COURSE.plan },
        { relation: 'dose.structure-set', targetUid: COURSE.structureSet },
      ],
    });
  });

  it('gives a long list in parts, and says when there is more', async () => {
    type Instances = PageOf<{ sopInstanceUid: string }>;
    const first = await made.json<Instances>(`/series/${COURSE.ct}/instances?limit=2`);
    expect(first).toMatchObject({ limit: 2, offset: 0, more: true });
    expect(first.items).toHaveLength(2);
    const second = await made.json<Instances>(`/series/${COURSE.ct}/instances?limit=2&offset=2`);
    expect(second).toMatchObject({ limit: 2, offset: 2, more: false });
    expect(second.items).toHaveLength(1);
    const all = await made.json<Instances>(`/series/${COURSE.ct}/instances`);
    expect([...first.items, ...second.items]).toEqual(all.items);
    // Exactly as many as there are: no more.
    expect((await made.json<Instances>(`/series/${COURSE.ct}/instances?limit=3`)).more).toBe(false);
    expect((await made.json<Instances>(`/series/${COURSE.ct}/instances?limit=0`)).items).toEqual(
      [],
    );
  });

  it.each([
    ['/studies/1.2.3', 404, 'not-found'],
    ['/studies/1.2.3/series', 404, 'not-found'],
    ['/series/1.2.3', 404, 'not-found'],
    ['/series/1.2.3/instances', 404, 'not-found'],
    ['/series/1.2.3/related', 404, 'not-found'],
    ['/instances/1.2.3', 404, 'not-found'],
    ['/instances/1.2.3/file', 404, 'not-found'],
    ['/studies/not-a-uid', 400, 'invalid-uid'],
    ['/instances/..%2F..%2Fetc%2Fpasswd/file', 400, 'invalid-uid'],
    ['/series/1.2.%ZZ', 404, 'not-found'],
    ['/patients?limit=-1', 400, 'invalid-parameter'],
    [`/patients?limit=${MAX_LIMIT + 1}`, 400, 'invalid-parameter'],
    ['/patients?offset=1.5', 400, 'invalid-parameter'],
    ['/patients?surname=x', 400, 'unknown-parameter'],
    ['/studies?date=yesterday', 400, 'invalid-query'],
    ['/studies?patientKey=abc', 400, 'invalid-parameter'],
    ['/nothing', 404, 'not-found'],
  ])('answers %s with %i %s', async (path, status, error) => {
    const body = await made.json(path, status);
    expectSchema(body, 'Error');
    expect(body['error']).toBe(error);
  });

  it('does not repeat in an error what the caller sent', async () => {
    const response = await made.get('/patients?secretname=SYNTHETIC%5EPHANTOM');
    expect(await response.text()).not.toMatch(/secretname|SYNTHETIC|PHANTOM/);
  });

  it('logs the route asked for, and nothing of who was asked about', async () => {
    await made.json('/patients?name=SYNTHETIC*');
    await made.json(`/studies/${COURSE.planningStudy}`);
    await vi.waitFor(() =>
      expect(
        made.log().filter((line) => line['route'] === `${API_PREFIX}/studies/:studyUid`),
      ).toHaveLength(1),
    );
    const text = JSON.stringify(made.log());
    expect(text).toContain(`${API_PREFIX}/patients`);
    expect(text).not.toMatch(/SYNTHETIC|SYN-0001|2\.25\./);
  });
});

describe('fetch', () => {
  let made: Api;
  beforeEach(async () => {
    made = await api({}, COURSE_FILES);
  });

  it('gives every instance of a series back byte for byte', async () => {
    const { items } = await made.json<
      PageOf<{ sopInstanceUid: string; size: number; sha256: string }>
    >(`/series/${COURSE.ct}/instances`);
    expect(items).toHaveLength(COURSE.ctSlices);
    for (const instance of items) {
      const response = await made.get(`/instances/${instance.sopInstanceUid}/file`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/dicom');
      expect(response.headers.get('content-length')).toBe(String(instance.size));
      expect(response.headers.get('etag')).toBe(`"${instance.sha256}"`);
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const original = COURSE_FILES.find((file) => uidOf(file) === instance.sopInstanceUid)!;
      expect(bytes).toEqual(original.bytes);
    }
  });

  it('gives the part of a file a Range asks for', async () => {
    const [slice] = COURSE_FILES;
    const size = slice.bytes.byteLength;
    const part = async (range: string) => {
      const response = await made.get(`/instances/${uidOf(slice)}/file`, { Range: range });
      return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
    };

    const magic = await part('bytes=128-131');
    expect(magic.response.status).toBe(206);
    expect(magic.response.headers.get('content-range')).toBe(`bytes 128-131/${size}`);
    expect(magic.response.headers.get('content-length')).toBe('4');
    expect(new TextDecoder().decode(magic.bytes)).toBe('DICM');

    const tail = await part('bytes=-10');
    expect(tail.response.headers.get('content-range')).toBe(
      `bytes ${size - 10}-${size - 1}/${size}`,
    );
    expect(tail.bytes).toEqual(slice.bytes.subarray(size - 10));

    const rest = await part(`bytes=${size - 5}-`);
    expect(rest.bytes).toEqual(slice.bytes.subarray(size - 5));
    // An end beyond the file means to the end of it.
    expect((await part(`bytes=0-${size * 2}`)).bytes).toEqual(slice.bytes);

    const beyond = await part(`bytes=${size}-`);
    expect(beyond.response.status).toBe(416);
    expect(beyond.response.headers.get('content-range')).toBe(`bytes */${size}`);
  });

  it('says 304 to a caller that has the file already', async () => {
    const [slice] = COURSE_FILES;
    const path = `/instances/${uidOf(slice)}/file`;
    const etag = (await made.get(path)).headers.get('etag')!;
    const again = await made.get(path, { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect((await made.get(path, { 'If-None-Match': '"something else"' })).status).toBe(200);
  });
});

describe('parseRange', () => {
  it.each([
    [undefined, null],
    ['bytes=0-99', { start: 0, end: 99 }],
    ['bytes=900-', { start: 900, end: 999 }],
    ['bytes=-100', { start: 900, end: 999 }],
    ['bytes=-5000', { start: 0, end: 999 }],
    ['bytes=990-2000', { start: 990, end: 999 }],
    // More than one range, or another unit: the whole file is a correct answer.
    ['bytes=0-1,5-6', null],
    ['lines=1-2', null],
    ['bytes=-', null],
  ])('%s of 1000 bytes', (header, range) => {
    expect(parseRange(header, 1000)).toEqual(range);
  });

  it.each(['bytes=1000-', 'bytes=5-4', 'bytes=-0'])(
    '%s of 1000 bytes cannot be given',
    (header) => {
      expect(() => parseRange(header, 1000)).toThrow(/no such bytes/);
    },
  );
});

describe('a web page on another origin', () => {
  const PAGE = 'http://localhost:4200';

  it('can browse, fetch a part of a file and upload once its origin is allowed', async () => {
    const made = await api({ allowedOrigins: [PAGE] }, COURSE_FILES);
    expect(made.log()).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'origins-allowed', count: 1 }),
    );
    const [slice] = COURSE_FILES;

    const listed = await made.get('/patients', { Origin: PAGE });
    expect(listed.status).toBe(200);
    expect(listed.headers.get('access-control-allow-origin')).toBe(PAGE);

    const part = await made.get(`/instances/${uidOf(slice)}/file`, {
      Origin: PAGE,
      Range: 'bytes=128-131',
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('access-control-allow-origin')).toBe(PAGE);
    // The page may read the headers it needs to make sense of the part.
    const exposed = part.headers.get('access-control-expose-headers')!;
    for (const header of ['ETag', 'Content-Range', 'Content-Length']) {
      expect(exposed).toContain(header);
    }

    const asked = await fetch(`${made.url}/instances`, {
      method: 'OPTIONS',
      headers: {
        Origin: PAGE,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(asked.status).toBe(204);
    expect(asked.headers.get('access-control-allow-methods')).toBe('POST');
    expect(asked.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('gets nothing while its origin is not allowed, which is how the server starts', async () => {
    const made = await api({}, COURSE_FILES);
    const [slice] = COURSE_FILES;
    for (const path of [
      '/patients',
      '/counts',
      `/instances/${uidOf(slice)}/file`,
      '/openapi.json',
    ]) {
      const response = await made.get(path, { Origin: PAGE });
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'forbidden-origin' });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    const upload = await fetch(`${made.url}/instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/dicom', Origin: PAGE },
      body: slice.bytes,
    });
    expect(upload.status).toBe(403);
    expect(await made.json('/counts')).toMatchObject({ instances: COURSE.instances });
  });
});

// The issue's "done when": the API description is published with the server.
describe('the API description', () => {
  it('is served, and describes every route the server answers', async () => {
    const made = await api();
    const document = await made.json<{
      openapi: string;
      info: { title: string; version: string };
      paths: Record<
        string,
        Record<
          string,
          { responses: Record<string, unknown>; parameters: { name: string; in: string }[] }
        >
      >;
      components: { schemas: Record<string, unknown> };
    }>('/openapi.json');
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Open RT Studio server');

    const described = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(described.sort()).toEqual(
      [
        'GET /health',
        ...[
          'GET /counts',
          'GET /patients',
          'GET /studies',
          'GET /studies/{studyUid}',
          'GET /studies/{studyUid}/series',
          'GET /series/{seriesUid}',
          'GET /series/{seriesUid}/instances',
          'GET /series/{seriesUid}/related',
          'GET /instances/{sopInstanceUid}',
          'GET /instances/{sopInstanceUid}/file',
          'POST /instances',
          'GET /openapi.json',
          'GET /job-kinds',
          'GET /jobs',
          'POST /jobs',
          'GET /jobs/{jobId}',
          'GET /jobs/{jobId}/log',
          'POST /jobs/{jobId}/cancel',
        ].map((line) => line.replace(' /', ` ${API_PREFIX}/`)),
      ].sort(),
    );
    // Nothing is described that is not served.
    expect(described).toHaveLength(19);
  });

  it('names every part of a path as a parameter, and only schemas that exist', async () => {
    const made = await api();
    const text = JSON.stringify(await made.json('/openapi.json'));
    const document = JSON.parse(text) as {
      paths: Record<
        string,
        Record<string, { parameters: { name: string; in: string; required: boolean }[] }>
      >;
    };
    for (const [path, methods] of Object.entries(document.paths)) {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      for (const operation of Object.values(methods)) {
        const declared = operation.parameters.filter((p) => p.in === 'path');
        expect(declared.map((p) => p.name).sort(), path).toEqual([...inPath].sort());
        expect(declared.every((p) => p.required)).toBe(true);
      }
    }
    const referenced = [...text.matchAll(/#\/components\/schemas\/(\w+)/g)].map(
      (match) => match[1],
    );
    expect(referenced.length).toBeGreaterThan(20);
    for (const name of referenced) expect(SCHEMAS, name).toHaveProperty(name);
  });

  it('writes a route pattern the way OpenAPI does', () => {
    expect(openApiPath('/api/v1/studies/:studyUid/series')).toBe(
      '/api/v1/studies/{studyUid}/series',
    );
    expect(openApiPath('/health')).toBe('/health');
  });

  it('describes the health endpoint as the server answers it', async () => {
    const made = await api();
    const health = (await (await fetch(made.url.replace(API_PREFIX, '/health'))).json()) as unknown;
    expectSchema(health, 'Health');
    expectSchema(await made.json('/counts'), 'Counts');
  });
});
