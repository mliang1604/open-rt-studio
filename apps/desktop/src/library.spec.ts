/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ServerAnswer, ServerRequest } from '@open-rt-studio/desktop-bridge';
import {
  createLogger,
  openEmbeddedServer,
  SILENT_LOGGER,
  type EmbeddedServer,
} from '@open-rt-studio/server';
import { syntheticCtSeries, SYNTHETIC_STUDY } from '@open-rt-studio/testdata';

import { libraryAnswers } from './library-calls.js';
import { nativeToolsDirectory, openLibrary, type Library, type LibraryOptions } from './library.js';

const FILES = syntheticCtSeries(4, 16);
const REQUEST = 'Zm9sZGVyLW9mLXRlc3RzIQ';

let scratch: string;
let folder: string;
const open: Library[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'open-rt-studio-library-'));
  folder = join(scratch, 'PATIENT^NAME^IN^A^FOLDER');
  await mkdir(join(folder, 'ct'), { recursive: true });
  for (const file of FILES) await writeFile(join(folder, 'ct', file.name), file.bytes);
  await writeFile(join(folder, 'notes.txt'), 'not DICOM');
});
afterEach(async () => {
  for (const library of open.splice(0)) await library.stop();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

function library(more: Partial<LibraryOptions> = {}): Library {
  const made = openLibrary({
    directory: join(scratch, 'profile', 'library'),
    pickFolder: async () => folder,
    logger: SILENT_LOGGER,
    ...more,
  });
  open.push(made);
  return made;
}

const request = (more: Partial<ServerRequest> = {}): ServerRequest => ({
  request: REQUEST,
  method: 'GET',
  path: '/api/v1/counts',
  headers: {},
  body: null,
  ...more,
});
const said = (answer: ServerAnswer): unknown => {
  if ('failed' in answer) return answer;
  return JSON.parse(Buffer.from(answer.body).toString('utf8'));
};

/** Wait for something that happens when the library is ready, however long that takes here. */
async function until(happened: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2000 && !happened(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(happened()).toBe(true);
}

describe('the library on this computer', () => {
  it("answers the server's API from its own folder, with no login", async () => {
    const lib = library();
    const counts = await lib.request(request());
    expect(counts).toMatchObject({ status: 200 });
    expect(said(counts)).toEqual({ patients: 0, studies: 0, series: 0, instances: 0 });
    expect(said(await lib.request(request({ path: '/api/v1/session' })))).toMatchObject({
      account: null,
    });

    const stored = await lib.request(
      request({
        method: 'POST',
        path: '/api/v1/instances',
        headers: { 'content-type': 'application/dicom' },
        body: FILES[0].bytes,
      }),
    );
    expect(stored).toMatchObject({ status: 201 });
    expect(said(await lib.request(request()))).toMatchObject({ patients: 1, instances: 1 });
  });

  it('gives an answer in bytes of its own', async () => {
    const lib = library();
    const answer = await lib.request(request());
    if ('failed' in answer) throw new Error(answer.failed);
    // A view into memory that holds other things would take them across the bridge.
    expect(answer.body.buffer.byteLength).toBe(answer.body.byteLength);
    expect(Buffer.isBuffer(answer.body)).toBe(false);
  });

  it('asks nothing that is not the API, and says a library that could not be opened cannot be reached', async () => {
    const lib = library();
    for (const path of ['/health', '/api/v1/../../health', '//elsewhere.example/api/v1/counts']) {
      expect(await lib.request(request({ path })), path).toEqual({ failed: 'unreachable' });
    }
    expect(
      await lib.request(
        request({ headers: { authorization: 'Bearer x' } as Record<string, string> }),
      ),
    ).toEqual({ failed: 'unreachable' });

    const lines: string[] = [];
    const broken = library({
      open: () => Promise.reject(new Error(`cannot open ${scratch}`)),
      logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    });
    expect(await broken.request(request())).toEqual({ failed: 'unreachable' });
    expect(await broken.importFolder()).toEqual({ not: 'unavailable' });
    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual([
      'library-not-opened',
    ]);
  });

  it('takes in the folder the user chooses, and says how it went and not where it was', async () => {
    const lines: string[] = [];
    const lib = library({
      logger: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    });
    expect(lib.importProgress()).toBeNull();
    const result = await lib.importFolder();
    expect(result).toEqual({
      imported: {
        total: FILES.length + 1,
        stored: FILES.length,
        unchanged: 0,
        replaced: 0,
        refused: 1,
        failed: 0,
        cancelled: false,
      },
    });
    expect(lib.importProgress()).toBeNull();
    expect(said(await lib.request(request()))).toMatchObject({ instances: FILES.length });
    // Again: nothing new.
    expect(await lib.importFolder()).toMatchObject({
      imported: { stored: 0, unchanged: FILES.length },
    });

    // Neither the answer nor the log says where the folder was, what was in it or whose it is.
    const told = JSON.stringify(result) + lines.join('\n');
    for (const secret of [
      'PATIENT^NAME',
      'notes.txt',
      FILES[0].name,
      SYNTHETIC_STUDY.patient.id,
      SYNTHETIC_STUDY.patient.name,
    ]) {
      expect(told, secret).not.toContain(secret);
    }
    expect(lines.some((line) => line.includes('library-import'))).toBe(true);
  });

  it('imports nothing when no folder is chosen, and one folder at a time', async () => {
    let choose: (folder: string | null) => void = () => undefined;
    let asked = 0;
    const lib = library({
      pickFolder: () => {
        asked += 1;
        return new Promise((resolve) => (choose = resolve));
      },
      // A library that takes its time to open, as on a slow disk: the dialog comes after.
      open: async (directory, logger) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return openEmbeddedServer({ dataDir: directory }, logger);
      },
    });
    const first = lib.importFolder();
    await until(() => asked === 1);
    // The dialog is open: a second import is refused, and shows no second dialog.
    expect(await lib.importFolder()).toEqual({ not: 'busy' });
    expect(asked).toBe(1);
    choose(null);
    expect(await first).toEqual({ not: 'chosen' });
    expect(said(await lib.request(request()))).toMatchObject({ instances: 0 });

    const second = lib.importFolder();
    await until(() => asked === 2);
    choose(folder);
    expect(await second).toMatchObject({ imported: { stored: FILES.length } });
    expect(asked).toBe(2);
  });

  it('stops an import when asked, and keeps what was taken in', async () => {
    const lib = library();
    // Stopped as soon as it begins: before the first file.
    const stopping = library({
      directory: join(scratch, 'profile', 'stopping'),
      open: async (directory, logger) => {
        const server = await openEmbeddedServer({ dataDir: directory }, logger);
        const ingest = server.core.pacs!.ingest;
        const core = {
          ...server.core,
          pacs: {
            ...server.core.pacs!,
            ingest: {
              ...ingest,
              importFolder: (where: string, options: Parameters<typeof ingest.importFolder>[1]) => {
                stopping.cancelImport();
                return ingest.importFolder(where, options);
              },
            },
          },
        };
        return { ...server, core, ask: server.ask, stop: server.stop } as EmbeddedServer;
      },
    });
    expect(await stopping.importFolder()).toMatchObject({
      imported: { total: FILES.length + 1, stored: 0, cancelled: true },
    });
    // Nothing to stop: nothing happens.
    lib.cancelImport();
    expect(await lib.importFolder()).toMatchObject({ imported: { cancelled: false } });
  });

  it('keeps what it holds for the next run, and takes nothing once it is stopped', async () => {
    const first = library();
    await first.importFolder();
    await first.stop();
    await first.stop();
    expect(await first.request(request())).toEqual({ failed: 'unreachable' });
    expect(await first.importFolder()).toEqual({ not: 'unavailable' });

    const next = library();
    expect(said(await next.request(request()))).toMatchObject({
      patients: 1,
      instances: FILES.length,
    });
  });
});

describe("the bridge's calls about the library", () => {
  it('ask, import and stop through it', async () => {
    const calls = libraryAnswers(library());
    expect(await calls['library:request'].answer(request())).toMatchObject({ status: 200 });
    expect(await calls['library:cancel'].answer(REQUEST)).toBeNull();
    expect(await calls['library:import-progress'].answer()).toBeNull();
    expect(await calls['library:import-folder'].answer()).toMatchObject({
      imported: { stored: FILES.length },
    });
    expect(await calls['library:cancel-import'].answer()).toBeNull();
  });

  it('take what each call takes, and nothing else: an import names no folder', async () => {
    const calls = libraryAnswers(library());
    expect(calls['library:request'].accepts([request()])).toBe(true);
    for (const wrong of [
      [],
      [REQUEST, request()],
      [request({ path: '/health' })],
      [request({ headers: { authorization: 'Bearer x' } as Record<string, string> })],
      [request(), 'more'],
    ]) {
      expect(calls['library:request'].accepts(wrong), JSON.stringify(wrong).slice(0, 60)).toBe(
        false,
      );
    }
    expect(calls['library:cancel'].accepts([REQUEST])).toBe(true);
    expect(calls['library:cancel'].accepts(['/etc'])).toBe(false);
    for (const channel of [
      'library:import-folder',
      'library:import-progress',
      'library:cancel-import',
    ] as const) {
      expect(calls[channel].accepts([])).toBe(true);
      for (const wrong of [['/Users/someone/dicom'], [{ folder: '/x' }], [null]]) {
        expect(calls[channel].accepts(wrong), channel).toBe(false);
      }
    }
  });
});

describe('the native tools of the library (#70)', () => {
  /** The names of the two tools the registration jobs run, on this system. */
  const TOOLS = ['ors-register-rigid', 'ors-register-deformable'].map(
    (name) => name + (process.platform === 'win32' ? '.exe' : ''),
  );

  /** A folder laid out as the tools are packed. The files are never run here. */
  async function toolsDirectory(tools: readonly string[] = TOOLS): Promise<string> {
    const bin = join(scratch, 'resources', 'native', 'bin');
    await mkdir(bin, { recursive: true });
    for (const tool of tools) await writeFile(join(bin, tool), '');
    const presets = join(scratch, 'resources', 'native', 'presets', 'deformable');
    await mkdir(presets, { recursive: true });
    await writeFile(join(presets, 'ct-ct.txt'), '// title: CT to CT\n(Metric "X")\n');
    return bin;
  }
  const kinds = async (lib: Library): Promise<string[]> =>
    (
      said(await lib.request(request({ path: '/api/v1/job-kinds' }))) as {
        items: { name: string }[];
      }
    ).items.map((kind) => kind.name);

  it('are where the installer put them, and nowhere a setting says, once installed', () => {
    const resources = join(scratch, 'resources');
    expect(nativeToolsDirectory({ resources, named: undefined })).toBe(
      join(resources, 'native', 'bin'),
    );
    expect(nativeToolsDirectory({ resources, named: join(scratch, 'elsewhere') })).toBe(
      join(resources, 'native', 'bin'),
    );
    // Run from the repository: those a setting names, or none.
    expect(nativeToolsDirectory({ resources: null, named: undefined })).toBeNull();
    expect(nativeToolsDirectory({ resources: null, named: '' })).toBeNull();
    expect(nativeToolsDirectory({ resources: null, named: 'native/build/dist/bin' })).toBe(
      resolve('native/build/dist/bin'),
    );
  });

  it('give the library the registration jobs', async () => {
    const lib = library({ nativeTools: await toolsDirectory() });
    expect(await kinds(lib)).toEqual(['rigid-registration', 'deformable-registration']);
    expect(said(await lib.request(request({ path: '/api/v1/registration-presets' })))).toEqual({
      items: [{ name: 'ct-ct', title: 'CT to CT', description: '' }],
    });
  });

  it('are not there by default, and the library has no such job', async () => {
    expect(await kinds(library())).toEqual([]);
  });

  it('that are not all there leave a library that works, without the jobs, and say so once', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
    for (const nativeTools of [join(scratch, 'nowhere'), await toolsDirectory(TOOLS.slice(0, 1))]) {
      lines.length = 0;
      const lib = library({
        directory: join(scratch, 'profile', `library-${nativeTools.length}`),
        nativeTools,
        logger,
      });
      expect(await kinds(lib)).toEqual([]);
      expect(said(await lib.request(request()))).toMatchObject({ instances: 0 });
      const events = lines.map((line) => JSON.parse(line) as { event: string });
      expect(events.filter((line) => line.event === 'library-without-native-tools')).toHaveLength(
        1,
      );
      // The log does not say where: a profile's path can name a person.
      expect(lines.join('\n')).not.toContain(scratch);
    }
  });
});
