/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { groupSeries } from '@open-rt-studio/dicom';
import {
  SYNTHETIC_RT_COURSE as COURSE,
  SYNTHETIC_STUDY,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';

import {
  connectToServer,
  serverAddress,
  ServerError,
  ServerSource,
  type ServerSourceOptions,
} from './server-source';
import { fakeServer, parseHere, type FakeServer } from './server-testing';

const ADDRESS = 'http://127.0.0.1:4300';
const FILES = syntheticRtCourse();
const asFile = (file: (typeof FILES)[number]): File =>
  new File([file.bytes.slice().buffer], file.name);

interface Made {
  readonly server: FakeServer;
  readonly source: ServerSource;
}

async function connected(options: ServerSourceOptions = {}): Promise<Made> {
  const server = fakeServer(FILES);
  const source = await connectToServer(ADDRESS, {
    fetch: server.fetch,
    parse: parseHere,
    ...options,
  });
  return { server, source };
}

async function withPatient(options: ServerSourceOptions = {}): Promise<Made> {
  const made = await connected(options);
  await made.source.selectPatient('1');
  return made;
}

describe('serverAddress', () => {
  it.each([
    ['127.0.0.1:4300', 'http://127.0.0.1:4300'],
    ['  http://localhost:4300/  ', 'http://localhost:4300'],
    ['https://pacs.example.org', 'https://pacs.example.org'],
    ['http://127.0.0.1:4300/api/v1/patients?name=x', 'http://127.0.0.1:4300'],
    ['HTTP://LOCALHOST:4300', 'http://localhost:4300'],
  ])('reads %j as %s', (typed, address) => {
    expect(serverAddress(typed)).toBe(address);
  });

  it.each(['', '   ', 'ftp://example.org', 'http://', 'http://user:secret@example.org', 'a b'])(
    'refuses %j',
    (typed) => {
      expect(() => serverAddress(typed)).toThrow('That is not a server address.');
    },
  );
});

describe('ServerSource', () => {
  it('lists the server’s patients on connecting, and no history until one is chosen', async () => {
    const { source, server } = await connected();
    expect(source.label).toBe('Server at 127.0.0.1:4300');
    expect(source.patients()).toEqual([
      {
        key: '1',
        patientId: SYNTHETIC_STUDY.patient.id,
        name: SYNTHETIC_STUDY.patient.name,
        studies: 2,
      },
    ]);
    expect(source.morePatients()).toBe(false);
    expect(source.currentPatient()).toBeNull();
    expect(server.asked).toEqual(['/patients?limit=200']);
  });

  it('shows a patient’s studies oldest first, with the series that hold pictures', async () => {
    const { source } = await withPatient();
    const patient = source.currentPatient()!;
    expect(patient).toMatchObject({ key: '1', patientId: SYNTHETIC_STUDY.patient.id });
    expect(patient.studies.map((study) => study.studyUid)).toEqual([
      COURSE.planningStudy,
      COURSE.followUpStudy,
    ]);
    const [planning, followUp] = patient.studies;
    // The structure set and the plan are not series to look at; the dose is.
    expect(planning.series.map((series) => series.modality)).toEqual(['CT', 'MR', 'RTDOSE']);
    expect(planning.modalities).toEqual(['CT', 'MR', 'RTDOSE']);
    expect(planning.series[0]).toMatchObject({
      uid: COURSE.ct,
      imageCount: COURSE.ctSlices,
      frameOfReferenceUid: COURSE.planningFrame,
    });
    // The registration is left off too.
    expect(followUp.series.map((series) => series.modality)).toEqual(['CT']);
  });

  it('keeps to the patient asked for last', async () => {
    const { source } = await connected();
    const first = source.selectPatient('1');
    await source.selectPatient(null);
    await first;
    expect(source.currentPatient()).toBeNull();
    await expect(source.selectPatient('7')).rejects.toThrow('not among those listed');
  });

  it('asks for the rest of a list the server gives in parts', async () => {
    const { source, server } = await connected();
    server.pageSize = 2;
    await source.selectPatient('1');
    expect(source.currentPatient()!.studies[0].series).toHaveLength(3);
    const fetched = await source.fetchSeries(COURSE.ct);
    expect(fetched.series.imageCount).toBe(COURSE.ctSlices);
    expect(server.asked).toContain(`/series/${COURSE.ct}/instances?limit=1000&offset=2`);
  });

  // The issue's "done when", as far as it can be said without a screen: what
  // comes from the server is what the same files give when they are opened.
  it('fetches a series as the same files would parse when opened, with its structure set', async () => {
    const { source } = await withPatient();
    const fetched = await source.fetchSeries(COURSE.ct);

    const opened = await parseHere(FILES.map(asFile));
    const local = groupSeries(opened.slices).find((series) => series.uid === COURSE.ct)!;
    expect(fetched.series.uid).toBe(local.uid);
    expect(fetched.series.imageCount).toBe(local.imageCount);
    expect(fetched.series.frameOfReferenceUid).toBe(local.frameOfReferenceUid);
    expect(fetched.series.patientId).toBe(local.patientId);
    expect(fetched.series.dims).toEqual(local.dims);
    expect(fetched.series.slices.map((slice) => [...slice.pixels])).toEqual(
      local.slices.map((slice) => [...slice.pixels]),
    );
    expect(fetched.series.slices.map((slice) => slice.position)).toEqual(
      local.slices.map((slice) => slice.position),
    );
    // The structure set drawn on it came along, and nothing of another series.
    expect(fetched.structureSets).toHaveLength(1);
    expect(fetched.structureSets[0].referencedSeriesUids).toContain(COURSE.ct);
  });

  it('reports each file as it arrives, and downloads a few at a time', async () => {
    const { source, server } = await withPatient({ parallel: 2 });
    const progress: [number, number][] = [];
    await source.fetchSeries(COURSE.ct, {
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });
    // Three slices and the structure set.
    expect(progress).toEqual([
      [0, 4],
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
    expect(server.mostAtOnce()).toBe(2);
  });

  it('stops downloading when the fetch is abandoned', async () => {
    const { source, server } = await withPatient({ parallel: 1 });
    server.hold(true);
    const abandoned = new AbortController();
    const fetching = source.fetchSeries(COURSE.ct, { signal: abandoned.signal });
    await vi.waitFor(() =>
      expect(server.asked.filter((path) => path.endsWith('/file'))).toHaveLength(1),
    );
    abandoned.abort();
    await expect(fetching).rejects.toMatchObject({ name: 'AbortError' });
    server.hold(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The one that was under way; the other three were never asked for.
    expect(server.asked.filter((path) => path.endsWith('/file'))).toHaveLength(1);

    const already = new AbortController();
    already.abort();
    await expect(source.fetchSeries(COURSE.ct, { signal: already.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('says how far it got when the network goes mid-load, and loads nothing', async () => {
    const { source, server } = await withPatient({ parallel: 1 });
    server.loseNetworkAfter(2);
    const error = await source.fetchSeries(COURSE.ct).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).message).toBe(
      'The connection to the server was lost: 2 of 4 files had arrived. Nothing was loaded.',
    );
    // It did not go on asking for the rest.
    expect(server.asked.filter((path) => path.endsWith('/file'))).toHaveLength(3);
    // And works again when the network is back.
    server.loseNetworkAfter(Infinity);
    expect((await source.fetchSeries(COURSE.ct)).series.imageCount).toBe(COURSE.ctSlices);
  });

  it('passes on what the server says when it refuses', async () => {
    const { source } = await withPatient();
    const error = await source.fetchSeries('1.2.3').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({
      status: 404,
      message: 'The server refused: The server does not hold that.',
    });
  });

  it('refuses a file that arrives shorter than the server said it is', async () => {
    const server = fakeServer(FILES);
    const short: typeof fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      if (!String(input).endsWith('/file')) return response;
      return new Response((await response.arrayBuffer()).slice(0, 100));
    };
    const source = await connectToServer(ADDRESS, { fetch: short, parse: parseHere });
    await expect(source.fetchSeries(COURSE.ct)).rejects.toThrow(
      'A file arrived incomplete from the server.',
    );
  });

  it('says what to check when the server cannot be reached at all', async () => {
    const unreachable: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(connectToServer(ADDRESS, { fetch: unreachable })).rejects.toThrow(
      'The server at 127.0.0.1:4300 could not be reached. It may not be running, or it may not allow this page (its allowedOrigins setting).',
    );
    await expect(connectToServer('not an address')).rejects.toThrow('not a server address');
  });

  it('says so when a series holds nothing that can be shown', async () => {
    const { source } = await withPatient({
      parse: () => Promise.resolve({ slices: [], structureSets: [], skipped: [] }),
    });
    await expect(source.fetchSeries(COURSE.ct)).rejects.toThrow(
      'No DICOM image slices were found in that series.',
    );
  });

  it('draws a preview from the middle of an image series, once, and gives a dose its icon', async () => {
    const { source, server } = await withPatient();
    const doseSeries = source
      .currentPatient()!
      .studies[0].series.find((series) => series.modality === 'RTDOSE')!;
    expect(source.thumbnail(doseSeries.uid)).toEqual({ kind: 'icon', modality: 'RTDOSE' });
    expect(source.thumbnail('9.9.9')).toEqual({ kind: 'icon', modality: null });

    const before = server.asked.length;
    const asked = source.thumbnail(COURSE.ct);
    expect(asked).toBeInstanceOf(Promise);
    expect(source.thumbnail(COURSE.ct)).toBe(asked);
    expect(await asked).toMatchObject({ kind: 'image', pixels: { width: 64, height: 64 } });
    // One instance looked up, one file fetched: not the whole series.
    expect(server.asked.slice(before)).toEqual([
      `/series/${COURSE.ct}/instances?limit=1&offset=1`,
      expect.stringMatching(/^\/instances\/[\d.]+\/file$/),
    ]);
  });

  it('falls back to the icon when a preview cannot be fetched', async () => {
    const { source, server } = await withPatient();
    server.loseNetworkAfter(0);
    expect(await source.thumbnail(COURSE.mr)).toEqual({ kind: 'icon', modality: 'MR' });
  });
});
