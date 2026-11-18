/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isServerRequest } from '@open-rt-studio/desktop-bridge';
import { syntheticRtCourse, SYNTHETIC_STUDY } from '@open-rt-studio/testdata';
import { describe, expect, it } from 'vitest';

import { fakeServer } from './data-source/server-testing';
import {
  importSaid,
  isLibrary,
  LIBRARY_ADDRESS,
  LIBRARY_LABEL,
  openDesktopLibrary,
} from './desktop-library';
import { fakeDesktopLibrary } from './desktop-library-testing';

describe('the library on this computer, in the viewer', () => {
  const files = syntheticRtCourse();

  it('is a source like a server, read through the bridge, with no login and its own name', async () => {
    const server = fakeServer(files);
    const library = fakeDesktopLibrary(server.fetch);
    const source = await openDesktopLibrary(library);
    expect(source.label).toBe(LIBRARY_LABEL);
    expect(source.address).toBe(LIBRARY_ADDRESS);
    expect(isLibrary(source)).toBe(true);
    expect(isLibrary(null)).toBe(false);
    expect(source.login().kind).toBe('none');
    expect(source.patients().map((patient) => patient.patientId)).toEqual([
      SYNTHETIC_STUDY.patient.id,
    ]);
    // Everything went through the bridge, as requests it takes.
    expect(library.requests.length).toBe(server.asked.length);
    expect(library.requests.every((request) => isServerRequest(request))).toBe(true);
  });

  it('says in its own words when it could not be opened, or stops answering', async () => {
    const server = fakeServer(files);
    const library = fakeDesktopLibrary(server.fetch);
    library.broken = true;
    await expect(openDesktopLibrary(library)).rejects.toThrow(
      'The library on this computer could not be opened.',
    );
    library.broken = false;
    const source = await openDesktopLibrary(library);
    library.broken = true;
    const said = await source.refresh().catch((error: unknown) => (error as Error).message);
    expect(said).toContain('library on this computer');
    expect(said).not.toContain('server');
    expect(said).not.toContain('library.invalid');
  });

  it('says what an import came to', () => {
    const counts = {
      total: 0,
      stored: 0,
      unchanged: 0,
      replaced: 0,
      refused: 0,
      failed: 0,
      cancelled: false,
    };
    expect(importSaid({ not: 'chosen' })).toBe('No folder was chosen.');
    expect(importSaid({ not: 'busy' })).toBe('Another import is under way.');
    expect(importSaid({ not: 'unavailable' })).toContain('could not be imported');
    expect(importSaid({ imported: counts })).toBe('The folder holds no files.');
    expect(importSaid({ imported: { ...counts, total: 1, stored: 1 } })).toBe(
      'Imported: 1 file added, of 1 file.',
    );
    expect(
      importSaid({
        imported: {
          ...counts,
          total: 20,
          stored: 12,
          unchanged: 3,
          replaced: 2,
          refused: 2,
          failed: 1,
        },
      }),
    ).toBe(
      'Imported: 12 files added, 2 replaced, 3 already there, 2 not taken (not DICOM, or not an object the library keeps), 1 could not be read, of 20 files.',
    );
    expect(importSaid({ imported: { ...counts, total: 20, stored: 5, cancelled: true } })).toBe(
      'Stopped: 5 files added, of 20 files.',
    );
  });
});
