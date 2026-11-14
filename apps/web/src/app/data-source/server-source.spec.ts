/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  groupSeries,
  parseStructureSet,
  readInstanceHeader,
  writeStructureSet,
} from '@open-rt-studio/dicom';
import {
  populationStudies,
  SYNTHETIC_RT_COURSE as COURSE,
  SYNTHETIC_STUDY,
  syntheticPopulation,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';

import {
  AUDIT_PER_PAGE,
  auditFilters,
  connectToServer,
  serverAddress,
  ServerError,
  ServerSource,
  STUDIES_PER_PAGE,
  studyQuery,
  type AuditEntry,
  type ServerSourceOptions,
} from './server-source';
import { FAKE_LOGIN_ATTEMPTS, fakeServer, parseHere, type FakeServer } from './server-testing';

const ADDRESS = 'http://127.0.0.1:4300';
const FILES = syntheticRtCourse();
const asFile = (file: (typeof FILES)[number]): File =>
  new File([file.bytes.slice().buffer], file.name);

/**
 * A structure set as the viewer would write one for the course's CT: the
 * contours of the one the course has, under another label, as a new object
 * unless `sopInstanceUid` says which.
 */
function authored(label: string, sopInstanceUid?: string): ArrayBuffer {
  const file = FILES.find((one) => {
    const read = readInstanceHeader(one.bytes);
    return read.ok && read.header.series.modality === 'RTSTRUCT';
  })!;
  const header = readInstanceHeader(file.bytes);
  if (!header.ok) throw new Error('the course has no structure set');
  const set = parseStructureSet(file.name, file.bytes.slice().buffer)!;
  return writeStructureSet(
    { ...set, label },
    {
      sopInstanceUid,
      patientId: header.header.patient.id,
      patientName: header.header.patient.name ?? undefined,
      studyInstanceUid: header.header.study.uid,
    },
  );
}

/** How many structure sets the source's timeline says a series has. */
function countOn(source: ServerSource, seriesUid: string): number {
  const series = (source.currentPatient()?.studies ?? [])
    .flatMap((study) => study.series)
    .find((one) => one.uid === seriesUid);
  if (!series) throw new Error(`series ${seriesUid} is not listed`);
  return series.structureSets;
}

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

describe('studyQuery', () => {
  const asked = (search: Parameters<typeof studyQuery>[0]): Record<string, string> =>
    Object.fromEntries(new URLSearchParams(studyQuery(search)));

  it('asks for the first part of everything, the latest first, when nothing is searched for', () => {
    expect(asked({})).toEqual({ order: 'newest', limit: String(STUDIES_PER_PAGE), offset: '0' });
  });

  it('looks for a typed name anywhere in the name, and takes a pattern as it is', () => {
    expect(asked({ name: ' thor ' })['patientName']).toBe('*thor*');
    expect(asked({ name: 'ALD*' })['patientName']).toBe('ALD*');
    expect(asked({ name: 'O?K^*' })['patientName']).toBe('O?K^*');
    expect('patientName' in asked({ name: '   ' })).toBe(false);
  });

  it('asks for a Patient ID whole, as typed', () => {
    expect(asked({ patientId: ' SYN-1003 ' })['patientId']).toBe('SYN-1003');
    expect(asked({ patientId: 'SYN-10*' })['patientId']).toBe('SYN-10*');
    expect('patientId' in asked({ patientId: '' })).toBe(false);
  });

  it('makes a range of the two dates, open at an end that is left out', () => {
    expect(asked({ from: '20260101', to: '20260131' })['date']).toBe('20260101-20260131');
    expect(asked({ from: '20260101' })['date']).toBe('20260101-');
    expect(asked({ to: '20260131' })['date']).toBe('-20260131');
    expect(asked({ from: '20260105', to: '20260105' })['date']).toBe('20260105');
    expect('date' in asked({ from: '', to: '' })).toBe(false);
  });

  it('asks for a modality, an order and a part of the list', () => {
    expect(asked({ modality: 'MR', order: 'patient', page: 2 })).toEqual({
      modality: 'MR',
      order: 'patient',
      limit: String(STUDIES_PER_PAGE),
      offset: String(2 * STUDIES_PER_PAGE),
    });
    expect(asked({ page: -1 })['offset']).toBe('0');
  });

  it('writes what was typed so that it stays one value', () => {
    const query = studyQuery({ name: 'a&order=oldest', patientId: 'x y#z' });
    const read = new URLSearchParams(query);
    expect(read.get('patientName')).toBe('*a&order=oldest*');
    expect(read.get('patientId')).toBe('x y#z');
    expect(read.getAll('order')).toEqual(['newest']);
  });
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
    // First who the viewer is to the server: no one, and no one need be.
    expect(server.asked).toEqual(['/session', '/patients?limit=200']);
    expect(source.login()).toEqual({ kind: 'none' });
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

  it('counts the images of each series as the opened files do: the planes of a dose, not its one file', async () => {
    const { source } = await withPatient();
    const opened = groupSeries((await parseHere(FILES.map(asFile))).slices);
    const listed = source.currentPatient()!.studies.flatMap((study) => study.series);
    expect(listed.length).toBeGreaterThan(2);
    for (const series of listed) {
      const local = opened.find((one) => one.uid === series.uid)!;
      expect(series.imageCount, series.modality ?? '').toBe(local.imageCount);
    }
    expect(listed.find((series) => series.modality === 'RTDOSE')!.imageCount).toBeGreaterThan(1);
  });

  it('finds studies, each with its patient, and asks the server for exactly the search', async () => {
    const { source, server } = await connected();
    const found = await source.findStudies({ name: 'synth', modality: 'CT', order: 'oldest' });
    expect(server.asked.at(-1)).toBe(
      `/studies?${studyQuery({ name: 'synth', modality: 'CT', order: 'oldest' })}`,
    );
    expect(found.page).toBe(0);
    expect(found.more).toBe(false);
    expect(found.studies.map((study) => study.studyUid)).toEqual([
      COURSE.planningStudy,
      COURSE.followUpStudy,
    ]);
    expect(found.studies[0]).toMatchObject({
      patient: {
        key: '1',
        patientId: SYNTHETIC_STUDY.patient.id,
        name: SYNTHETIC_STUDY.patient.name,
      },
      date: SYNTHETIC_STUDY.date,
      description: SYNTHETIC_STUDY.description,
      series: 5,
    });
    expect(found.studies[0].modalities).toContain('RTDOSE');
  });

  it('gives a search in parts, and says when there is more', async () => {
    const server = fakeServer(syntheticPopulation());
    const source = await connectToServer(ADDRESS, { fetch: server.fetch, parse: parseHere });
    const total = populationStudies().length;
    const first = await source.findStudies();
    expect(first.studies).toHaveLength(STUDIES_PER_PAGE);
    expect(first.more).toBe(true);
    const second = await source.findStudies({ page: 1 });
    expect(second.page).toBe(1);
    expect(second.studies).toHaveLength(total - STUDIES_PER_PAGE);
    expect(second.more).toBe(false);
    // No study twice.
    expect(new Set([...first.studies, ...second.studies].map((study) => study.studyUid)).size).toBe(
      total,
    );
  });

  it('turns to a patient a search found, who need not be among those listed', async () => {
    const server = fakeServer(syntheticPopulation());
    const source = new ServerSource(ADDRESS, { fetch: server.fetch, parse: parseHere });
    // Not connected through refresh: no patient is listed.
    expect(source.patients()).toEqual([]);
    const { studies } = await source.findStudies({ order: 'oldest' });
    const wanted = studies[3].patient;
    await source.selectPatient(wanted);
    expect(source.currentPatient()).toMatchObject({ ...wanted });
    expect(source.currentPatient()!.studies.length).toBeGreaterThan(0);
    for (const study of source.currentPatient()!.studies) {
      expect(
        populationStudies().find((one) => one.study.date === study.date)!.study.patient.id,
      ).toBe(wanted.patientId);
    }
    // A key alone still has to be one of the listed.
    await expect(source.selectPatient('999')).rejects.toThrow('not among those listed');
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

  describe('saving', () => {
    const dicom = (bytes: ArrayBuffer) => ({
      bytes,
      filename: 'rtstruct.dcm',
      mediaType: 'application/dicom',
    });

    it('uploads a structure set, which comes with its series from then on', async () => {
      const { source, server } = await withPatient();
      const before = await source.fetchSeries(COURSE.ct);
      expect(before.structureSets.map((set) => set.label)).not.toContain('Painted here');
      const listedBefore = countOn(source, COURSE.ct);
      expect(listedBefore).toBe(before.structureSets.length);

      expect(await source.save(dicom(authored('Painted here')))).toEqual({
        kind: 'stored',
        where: 'Server at 127.0.0.1:4300',
      });
      // One upload, as DICOM, asking the server to keep whatever it holds.
      expect(server.uploads).toEqual([{ mediaType: 'application/dicom', status: 201 }]);
      expect(server.asked.filter((path) => path.startsWith('/instances?'))).toEqual([
        '/instances?onDifferent=keep',
      ]);

      // The timeline was told: the CT has one structure set more, without the
      // patient being chosen again.
      expect(countOn(source, COURSE.ct)).toBe(listedBefore + 1);

      const after = await source.fetchSeries(COURSE.ct);
      expect(after.structureSets).toHaveLength(before.structureSets.length + 1);
      // What the timeline says is how many come with the series.
      expect(countOn(source, COURSE.ct)).toBe(after.structureSets.length);
      const saved = after.structureSets.find((set) => set.label === 'Painted here')!;
      expect(saved.referencedSeriesUids).toContain(COURSE.ct);
      expect(saved.rois.map((roi) => roi.name)).toEqual(
        before.structureSets[0].rois.map((roi) => roi.name),
      );
    });

    it('makes each save an object of its own', async () => {
      const { source, server } = await withPatient();
      await source.save(dicom(authored('First')));
      await source.save(dicom(authored('Second')));
      expect(server.uploads.map((upload) => upload.status)).toEqual([201, 201]);
      const labels = (await source.fetchSeries(COURSE.ct)).structureSets.map((set) => set.label);
      expect(labels).toContain('First');
      expect(labels).toContain('Second');
    });

    it('never replaces what the server holds', async () => {
      const { source } = await withPatient();
      const uid = '1.2.826.0.1.3680043.10.1561.999.1';
      const first = authored('First', uid);
      await source.save(dicom(first));
      // The very same object again is nothing new, and no error.
      expect((await source.save(dicom(first))).kind).toBe('stored');

      // Another object under the same UID is refused, and the first is kept.
      const refused = await source.save(dicom(authored('Second', uid))).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ServerError);
      expect((refused as ServerError).status).toBe(409);
      expect((refused as ServerError).message).toBe(
        'The server refused: The server holds this differently, and has kept what it had.',
      );
      const labels = (await source.fetchSeries(COURSE.ct)).structureSets.map((set) => set.label);
      expect(labels).toContain('First');
      expect(labels).not.toContain('Second');
    });

    it('sends nothing that is not DICOM', async () => {
      const { source, server } = await withPatient();
      await expect(
        source.save({ bytes: new ArrayBuffer(8), filename: 'notes.txt', mediaType: 'text/plain' }),
      ).rejects.toThrow('Only DICOM objects can be saved to a server.');
      expect(server.uploads).toEqual([]);
    });

    it('passes on the server’s reason when it cannot file what was sent', async () => {
      const { source } = await withPatient();
      const refused = await source.save(dicom(new ArrayBuffer(200))).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ServerError);
      expect((refused as ServerError).status).toBe(422);
    });

    it('stands when the timeline cannot be brought up to date afterwards', async () => {
      const { source, server } = await withPatient();
      const listed = source.currentPatient();
      const fetcher = server.fetch;
      // The upload goes through; every question after it fails.
      let uploaded = false;
      const flaky: typeof fetch = async (input, init) => {
        if (uploaded) throw new TypeError('Failed to fetch');
        const response = await fetcher(input, init);
        if (init?.method === 'POST') uploaded = true;
        return response;
      };
      const second = new ServerSource(ADDRESS, { fetch: flaky, parse: parseHere });
      await second.refresh();
      await second.selectPatient('1');
      expect(await second.save(dicom(authored('Kept')))).toEqual({
        kind: 'stored',
        where: 'Server at 127.0.0.1:4300',
      });
      // The list is as it was, a save behind.
      expect(second.currentPatient()).toEqual(listed);
      expect(server.uploads).toEqual([{ mediaType: 'application/dicom', status: 201 }]);
    });

    it('says so when the server cannot be reached, and has saved nothing', async () => {
      const { source, server } = await withPatient();
      server.loseUploads();
      const lost = await source.save(dicom(authored('Lost'))).catch((e: unknown) => e);
      expect(lost).toBeInstanceOf(ServerError);
      expect((lost as ServerError).lost).toBe(true);
      expect((lost as ServerError).message).toContain('could not be reached');
      expect(server.uploads).toEqual([]);
    });
  });
});

describe('a server that cannot be reached', () => {
  const unreachable = { fetch: () => Promise.reject(new TypeError('Failed to fetch')) };
  afterEach(() => vi.unstubAllGlobals());

  it('may be one whose certificate the browser does not trust, when its address is https', async () => {
    await expect(connectToServer('https://pacs.example.org', unreachable)).rejects.toThrow(
      'The server at pacs.example.org could not be reached. It may not be running, or it may not allow this page (its allowedOrigins setting). Or this browser does not trust its certificate.',
    );
  });

  it('may be an http address that a page served over https may not call', async () => {
    vi.stubGlobal('location', { protocol: 'https:' });
    await expect(connectToServer('http://pacs.example.org:4300', unreachable)).rejects.toThrow(
      /Or it is an http address, which a page served over https may not call: give its https address\.$/,
    );
    // This machine is the exception a browser makes.
    for (const here of ['http://127.0.0.1:4300', 'http://localhost:4300', 'http://[::1]:4300']) {
      await expect(connectToServer(here, unreachable)).rejects.toThrow(
        /allowedOrigins setting\)\.$/,
      );
    }
  });

  it('is told plainly otherwise', async () => {
    await expect(connectToServer('http://pacs.example.org:4300', unreachable)).rejects.toThrow(
      /allowedOrigins setting\)\.$/,
    );
  });
});

describe('ServerSource on a server with accounts (#55)', () => {
  const ADA = { name: 'ada', password: 'correct horse battery staple', role: 'user' } as const;
  const HOST = '127.0.0.1:4300';

  async function reached(): Promise<Made> {
    const server = fakeServer(FILES, [ADA]);
    const source = await connectToServer(ADDRESS, { fetch: server.fetch, parse: parseHere });
    return { server, source };
  }

  async function loggedIn(): Promise<Made> {
    const made = await reached();
    await made.source.logIn(ADA.name, ADA.password);
    return made;
  }

  const dicom = (bytes: ArrayBuffer) => ({
    bytes,
    filename: 'rtstruct.dcm',
    mediaType: 'application/dicom',
  });

  it('is told that a login is wanted, and asks for nothing more until there is one', async () => {
    const { source, server } = await reached();
    expect(source.login()).toEqual({ kind: 'needed', ended: false });
    expect(server.asked).toEqual(['/session']);
    expect(source.patients()).toEqual([]);
    await expect(source.findStudies()).rejects.toThrow(`The server at ${HOST} asks for a login.`);
    expect(source.login()).toEqual({ kind: 'needed', ended: false });
  });

  it('logs in, lists the patients, and sends the login with everything it asks', async () => {
    const { source, server } = await loggedIn();
    expect(source.login()).toEqual({ kind: 'in', name: 'ada', role: 'user' });
    expect(source.patients().map((patient) => patient.patientId)).toEqual([
      SYNTHETIC_STUDY.patient.id,
    ]);
    // Listing, searching, a patient's timeline, a series and a save: each is answered.
    expect((await source.findStudies()).studies).toHaveLength(2);
    await source.selectPatient('1');
    const ct = source
      .currentPatient()!
      .studies.flatMap((study) => study.series)
      .find((series) => series.modality === 'CT')!;
    expect((await source.fetchSeries(ct.uid)).series.uid).toBe(ct.uid);
    expect((await source.save(dicom(authored('Painted while logged in')))).kind).toBe('stored');
    expect(server.uploads).toEqual([{ mediaType: 'application/dicom', status: 201 }]);
  });

  it('says so when the name or the password is not right, and is not logged in', async () => {
    const { source, server } = await reached();
    await expect(source.logIn(ADA.name, 'not the password')).rejects.toThrow(
      new ServerError('The name or the password is not right.', 401),
    );
    await expect(source.logIn('nobody', ADA.password)).rejects.toThrow(
      'The name or the password is not right.',
    );
    expect(source.login()).toEqual({ kind: 'needed', ended: false });
    expect(server.tokens()).toEqual([]);
  });

  it('says how long to wait when the name is locked', async () => {
    const { source } = await reached();
    for (let i = 0; i < FAKE_LOGIN_ATTEMPTS; i++) {
      await expect(source.logIn(ADA.name, 'wrong')).rejects.toThrow('not right');
    }
    await expect(source.logIn(ADA.name, ADA.password)).rejects.toThrow(
      'Too many wrong passwords for this name. Try again in 30 seconds.',
    );
  });

  it('keeps the login in memory, and neither it nor the password in the browser', async () => {
    localStorage.clear();
    sessionStorage.clear();
    const { server } = await loggedIn();
    const [token] = server.tokens();
    const kept = JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]);
    expect(kept).not.toContain(token);
    expect(kept).not.toContain(ADA.password);
  });

  it('notices a login that has ended, and goes on after another', async () => {
    const { source, server } = await loggedIn();
    await source.selectPatient('1');
    server.endSessions();
    await expect(source.findStudies()).rejects.toThrow(
      `Your login at ${HOST} has ended. Choose "Server…" to log in again.`,
    );
    expect(source.login()).toEqual({ kind: 'needed', ended: true });
    // What was listed stays on screen; only asking for more is refused.
    expect(source.currentPatient()).not.toBeNull();

    await source.logIn(ADA.name, ADA.password);
    expect(source.login().kind).toBe('in');
    expect((await source.findStudies()).studies).toHaveLength(2);
  });

  it('logs out: the server ends the login, and the viewer has forgotten it', async () => {
    const { source, server } = await loggedIn();
    expect(server.tokens()).toHaveLength(1);
    await source.logOut();
    expect(server.tokens()).toEqual([]);
    expect(source.login()).toEqual({ kind: 'needed', ended: false });
    await expect(source.findStudies()).rejects.toThrow('asks for a login');
    // Asked twice, it does nothing the second time.
    const asked = server.asked.length;
    await source.logOut();
    expect(server.asked).toHaveLength(asked);
  });

  it('forgets the login even when the server cannot be told', async () => {
    const server = fakeServer(FILES, [ADA]);
    let reachable = true;
    const source = await connectToServer(ADDRESS, {
      fetch: (input, init) =>
        reachable ? server.fetch(input, init) : Promise.reject(new TypeError('Failed to fetch')),
      parse: parseHere,
    });
    await source.logIn(ADA.name, ADA.password);
    reachable = false;
    await source.logOut();
    expect(source.login()).toEqual({ kind: 'needed', ended: false });
  });

  it('takes a server that does not know the question for one without accounts', async () => {
    const server = fakeServer(FILES);
    const source = await connectToServer(ADDRESS, {
      fetch: (input, init) =>
        String(input).endsWith('/session')
          ? Promise.resolve(new Response('{"error":"not-found"}', { status: 404 }))
          : server.fetch(input, init),
      parse: parseHere,
    });
    expect(source.login()).toEqual({ kind: 'none' });
    expect(source.patients()).toHaveLength(1);
  });

  it('says when the server cannot be reached to log in', async () => {
    const { source } = await reached();
    const lost = new ServerSource(ADDRESS, {
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(lost.logIn(ADA.name, ADA.password)).rejects.toThrow(
      `The server at ${HOST} could not be reached.`,
    );
    expect(source.login().kind).toBe('needed');
  });
});

describe('the audit log of a server (#213)', () => {
  const ROOT = { name: 'root', password: 'the administrator’s password', role: 'admin' } as const;
  const ADA = { name: 'ada', password: 'correct horse battery staple', role: 'user' } as const;
  const entry = (id: number, actor: string): AuditEntry => ({
    id,
    time: new Date(2026, 2, 1, 8, id).toISOString(),
    until: new Date(2026, 2, 1, 8, id).toISOString(),
    count: 1,
    actor,
    origin: 'api',
    action: 'study-read',
    outcome: 'ok',
    patientId: 'SYN-0001',
    studyUid: '1.2.3',
    seriesUid: null,
    object: null,
    detail: null,
  });
  const LOG = Array.from({ length: AUDIT_PER_PAGE + 2 }, (_, i) =>
    entry(i + 1, i % 2 === 0 ? 'ada' : 'root'),
  );

  async function loggedIn(who: { name: string; password: string }, log?: readonly AuditEntry[]) {
    const server = fakeServer(FILES, [ROOT, ADA], log);
    const source = await connectToServer(ADDRESS, { fetch: server.fetch, parse: parseHere });
    await source.logIn(who.name, who.password);
    return { server, source };
  }

  it('is asked for with what was given, trimmed, and nothing for what was not', () => {
    expect(Object.fromEntries(auditFilters({}))).toEqual({});
    expect(
      Object.fromEntries(
        auditFilters({ actor: ' ada ', action: 'login', outcome: 'refused', patientId: ' P 1 ' }),
      ),
    ).toEqual({ actor: 'ada', action: 'login', outcome: 'refused', patientId: 'P 1' });
    expect(Object.fromEntries(auditFilters({ actor: '  ', action: '', from: '', to: '' }))).toEqual(
      {},
    );
  });

  it('is asked for by whole days of this computer’s clock', () => {
    const filters = auditFilters({ from: '2026-03-01', to: '2026-03-31' });
    expect(filters.get('from')).toBe(new Date(2026, 2, 1).toISOString());
    // Up to the first moment of the day after the last: the last day is meant whole.
    expect(filters.get('before')).toBe(new Date(2026, 3, 1).toISOString());
    // What is no day is left out, not sent for the server to refuse.
    expect(Object.fromEntries(auditFilters({ from: '01/03/2026', to: 'tomorrow' }))).toEqual({});
  });

  it('may be read by an administrator, and on a server without accounts; not by a user', async () => {
    expect((await loggedIn(ROOT, LOG)).source.mayReadAudit()).toBe(true);
    expect((await loggedIn(ADA, LOG)).source.mayReadAudit()).toBe(false);
    const open = await connectToServer(ADDRESS, {
      fetch: fakeServer(FILES, undefined, LOG).fetch,
      parse: parseHere,
    });
    expect(open.mayReadAudit()).toBe(true);
    // Before a login there is no one, and so no administrator.
    const waiting = await connectToServer(ADDRESS, {
      fetch: fakeServer(FILES, [ROOT], LOG).fetch,
      parse: parseHere,
    });
    expect(waiting.mayReadAudit()).toBe(false);
  });

  it('comes in parts, the latest first', async () => {
    const { source, server } = await loggedIn(ROOT, LOG);
    const first = await source.auditLog();
    expect(first.records).toHaveLength(AUDIT_PER_PAGE);
    expect(first.records[0].id).toBe(LOG.length);
    expect(first).toMatchObject({ page: 0, more: true });
    const second = await source.auditLog({ page: 1 });
    expect(second.records.map((record) => record.id)).toEqual([2, 1]);
    expect(second).toMatchObject({ page: 1, more: false });
    expect(server.asked.at(-1)).toBe(`/audit?limit=${AUDIT_PER_PAGE}&offset=${AUDIT_PER_PAGE}`);
    const ofAda = await source.auditLog({ actor: 'ada' });
    expect(new Set(ofAda.records.map((record) => record.actor))).toEqual(new Set(['ada']));
  });

  it('is exported as a file of all that fits', async () => {
    const { source, server } = await loggedIn(ROOT, LOG);
    const blob = await source.auditExport({ actor: 'root' });
    expect(server.asked.at(-1)).toBe('/audit/export?actor=root&format=csv');
    const lines = (await blob.text()).trimEnd().split('\r\n');
    expect(lines).toHaveLength(1 + LOG.length / 2);
  });

  it('says plainly why it cannot be had', async () => {
    const user = await loggedIn(ADA, LOG);
    await expect(user.source.auditLog()).rejects.toThrow(
      new ServerError('The audit log is for an administrator.', 403),
    );
    await expect(user.source.auditExport()).rejects.toThrow('for an administrator');
    const none = await loggedIn(ROOT);
    await expect(none.source.auditLog()).rejects.toThrow(
      new ServerError('This server keeps no audit log: it runs without a data directory.', 404),
    );
  });
});
