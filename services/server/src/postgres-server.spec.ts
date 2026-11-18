/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A server whose index is in PostgreSQL (#44). What needs a PostgreSQL runs
// where there is one (`pacs-index/postgres-testing.ts`).

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SYNTHETIC_FOLLOW_UP_STUDY,
  SYNTHETIC_STUDY,
  syntheticRtCourse,
} from '@open-rt-studio/testdata';

import { API_PREFIX } from './api/api-routes.js';
import { ConfigError, DEFAULT_CONFIG, type ServerConfig } from './config.js';
import { createLogger, SILENT_LOGGER } from './logger.js';
import { POSTGRES, testSchemas, type TestSchemas } from './pacs-index/postgres-testing.js';
import { startServer, type RunningServer } from './server.js';

const PASSWORD = 'a-password-nobody-may-see';

let directory: string;
let server: RunningServer | null = null;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'open-rt-studio-postgres-'));
});
afterEach(async () => {
  await server?.stop();
  server = null;
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
});

const configured = (databaseUrl: string): ServerConfig => ({
  ...DEFAULT_CONFIG,
  auth: 'none',
  port: 0,
  shutdownTimeoutMs: 2_000,
  dataDir: directory,
  databaseUrl,
});

it('does not start with a database it cannot reach, and says which setting without repeating it', async () => {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  const refused = startServer(
    configured(`postgresql://someone:${PASSWORD}@127.0.0.1:1/somewhere`),
    logger,
  );
  await expect(refused).rejects.toThrow(
    new ConfigError(
      'The index could not be opened in the PostgreSQL database that OPEN_RT_STUDIO_DATABASE_URL names (ECONNREFUSED). Check the address, the database, the user and the password, and that the database can be reached from here.',
    ),
  );
  expect(lines.join('\n')).not.toContain(PASSWORD);
  expect(lines.join('\n')).not.toContain('someone');
});

describe.runIf(POSTGRES)('against PostgreSQL', () => {
  let schemas: TestSchemas;
  beforeAll(() => {
    schemas = testSchemas();
  });
  afterAll(async () => {
    await schemas?.drop();
  });

  const studies = async (running: RunningServer): Promise<string[]> => {
    const response = await fetch(
      `http://127.0.0.1:${running.address.port}${API_PREFIX}/studies?order=oldest`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: { description: string }[] };
    return body.items.map((study) => study.description);
  };

  it('keeps what is uploaded in the database, and has it when it is started again', async () => {
    const url = await schemas.fresh();
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', write: (line) => lines.push(line) });
    server = await startServer(configured(url), logger);
    for (const file of syntheticRtCourse()) {
      const response = await fetch(
        `http://127.0.0.1:${server.address.port}${API_PREFIX}/instances`,
        { method: 'POST', headers: { 'Content-Type': 'application/dicom' }, body: file.bytes },
      );
      expect(response.status).toBe(201);
    }
    const there = [SYNTHETIC_STUDY.description, SYNTHETIC_FOLLOW_UP_STUDY.description];
    expect(await studies(server)).toEqual(there);
    await server.stop();

    // The index is nowhere in the data directory, and the database's address in no line.
    expect(existsSync(join(directory, 'index.sqlite'))).toBe(false);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged.find((line) => line['event'] === 'index-opened')).toMatchObject({
      backend: 'postgresql',
    });
    expect(lines.join('\n')).not.toContain(new URL(url).searchParams.get('options'));

    server = await startServer(configured(url), SILENT_LOGGER);
    expect(await studies(server)).toEqual(there);
  });

  it('says so when the data directory has an index in SQLite that it does not use', async () => {
    await writeFile(join(directory, 'index.sqlite'), '');
    const lines: string[] = [];
    server = await startServer(
      configured(await schemas.fresh()),
      createLogger({ level: 'info', write: (line) => lines.push(line) }),
    );
    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toContain(
      'index-in-sqlite-not-used',
    );
    expect(await studies(server)).toEqual([]);
  });

  it('does not start on a schema that holds something else, and leaves it as it is', async () => {
    const url = await schemas.fresh();
    const db = schemas.within(url);
    await db.query('CREATE TABLE recipes (name TEXT)');
    await expect(startServer(configured(url), SILENT_LOGGER)).rejects.toThrow(
      new ConfigError(
        'The PostgreSQL database that OPEN_RT_STUDIO_DATABASE_URL names cannot hold the index. The database holds something else; it is not an index. Give the index a database, or a schema, of its own.',
      ),
    );
    expect(await db.query('SELECT count(*)::int AS n FROM recipes')).toEqual([{ n: 0 }]);
  });
});
