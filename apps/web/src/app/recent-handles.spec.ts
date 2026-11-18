/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DESKTOP_FILES, DesktopHandle, type StoredGrant } from './desktop-files';
import { fakeDesktopFiles, type FakeDesktopFiles } from './desktop-files-testing';
import { filesOf, type AccessHandle } from './file-access';
import {
  HANDLE_DATABASE,
  RecentHandles,
  indexedDbHandles,
  recentKey,
  type HandleDatabase,
} from './recent-handles';
import type { RecentEntry } from './recent-store';

const folder = (label: string): RecentEntry => ({ label, kind: 'folder' });
const handle = (name: string): AccessHandle => ({ kind: 'directory', name });

/** A database in memory; `broken` makes every call fail, as a full or blocked store does. */
function memoryDatabase(initial: Record<string, AccessHandle | StoredGrant> = {}) {
  const rows = new Map(Object.entries(initial));
  const state = { broken: false };
  const guard = <T>(value: () => T): Promise<T> =>
    state.broken ? Promise.reject(new Error('storage failed')) : Promise.resolve(value());
  const db: HandleDatabase = {
    keys: () => guard(() => [...rows.keys()]),
    get: (key) => guard(() => rows.get(key)),
    set: (key, value) => guard(() => void rows.set(key, value)),
    delete: (key) => guard(() => void rows.delete(key)),
  };
  return { db, rows, state };
}

function storeWith(
  db: HandleDatabase | null,
  desktop: FakeDesktopFiles | null = null,
): RecentHandles {
  TestBed.configureTestingModule({
    providers: [
      { provide: HANDLE_DATABASE, useValue: db },
      { provide: DESKTOP_FILES, useValue: desktop },
    ],
  });
  return TestBed.inject(RecentHandles);
}

/** Let the store's own start-up read finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RecentHandles', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('tells entries apart by kind and label', () => {
    expect(recentKey(folder('study'))).toBe('folder:study');
    expect(recentKey({ label: 'study', kind: 'files' })).toBe('files:study');
    // Whether it was added as an overlay is not part of what it is.
    expect(recentKey({ label: 'study', kind: 'folder', overlay: true })).toBe('folder:study');
  });

  it('knows from the start which entries have a handle', async () => {
    const { db } = memoryDatabase({ 'folder:study': handle('study') });
    const store = storeWith(db);
    await settled();
    expect(store.has(folder('study'))).toBe(true);
    expect(store.has(folder('other'))).toBe(false);
    expect(store.has({ label: 'study', kind: 'files' })).toBe(false);
  });

  it('keeps a handle and gives it back', async () => {
    const { db } = memoryDatabase();
    const store = storeWith(db);
    const study = handle('study');
    await store.keep(folder('study'), study, [folder('study')]);
    expect(store.has(folder('study'))).toBe(true);
    expect(await store.handleFor(folder('study'))).toBe(study);
    expect(await store.handleFor(folder('other'))).toBeNull();
  });

  it('drops the handles of entries that have left the recent list', async () => {
    const { db, rows } = memoryDatabase({
      'folder:old': handle('old'),
      'folder:kept': handle('kept'),
    });
    const store = storeWith(db);
    await store.keep(folder('new'), handle('new'), [folder('new'), folder('kept')]);
    expect([...rows.keys()].sort()).toEqual(['folder:kept', 'folder:new']);
    expect(store.has(folder('old'))).toBe(false);
  });

  it('forgets a handle that leads nowhere', async () => {
    const { db } = memoryDatabase({ 'folder:study': handle('study') });
    const store = storeWith(db);
    await settled();
    await store.forget(folder('study'));
    expect(store.has(folder('study'))).toBe(false);
    expect(await store.handleFor(folder('study'))).toBeNull();
  });

  it('has no handles where there is no database', async () => {
    const store = storeWith(null);
    await store.keep(folder('study'), handle('study'), [folder('study')]);
    expect(store.has(folder('study'))).toBe(false);
    expect(await store.handleFor(folder('study'))).toBeNull();
    await store.forget(folder('study')); // and does not throw
  });

  it('takes a failing database as no handles, without throwing', async () => {
    const { db, state } = memoryDatabase({ 'folder:study': handle('study') });
    const store = storeWith(db);
    await settled();
    expect(store.has(folder('study'))).toBe(true);

    state.broken = true;
    await store.keep(folder('new'), handle('new'), []);
    expect(store.has(folder('new'))).toBe(false);
    expect(store.has(folder('study'))).toBe(false);
    expect(await store.handleFor(folder('study'))).toBeNull();
    await store.forget(folder('study'));
  });
});

describe('RecentHandles in the desktop application', () => {
  afterEach(() => TestBed.resetTestingModule());

  const picked = (desktop: FakeDesktopFiles, name: string, id: string) =>
    new DesktopHandle(desktop, { desktopGrant: id, kind: 'directory', name });

  it('keeps the id of a grant, has the main process keep the grant, and opens it again', async () => {
    const desktop = fakeDesktopFiles();
    const id = desktop.add('folder', 'thorax', { 'ct/1.dcm': new Uint8Array([1]) });
    const { db, rows } = memoryDatabase();
    const store = storeWith(db, desktop);
    await store.keep(folder('thorax'), picked(desktop, 'thorax', id), [folder('thorax')]);

    // Plain data, with nothing of where the folder is.
    expect(rows.get('folder:thorax')).toEqual({
      desktopGrant: id,
      kind: 'directory',
      name: 'thorax',
    });
    expect(structuredClone(rows.get('folder:thorax'))).toEqual(rows.get('folder:thorax'));
    expect(desktop.kept).toEqual(new Set([id]));
    expect(store.has(folder('thorax'))).toBe(true);

    // In a later run: the database and the main process are what is left.
    TestBed.resetTestingModule();
    const later = storeWith(db, desktop);
    await settled();
    expect(later.has(folder('thorax'))).toBe(true);
    const again = await later.handleFor(folder('thorax'));
    expect(again).toBeInstanceOf(DesktopHandle);
    expect((await filesOf(again!)).map((file) => file.name)).toEqual(['1.dcm']);
  });

  it('has the main process give up the grants of entries that left the list', async () => {
    const desktop = fakeDesktopFiles();
    const old = desktop.add('folder', 'old', {});
    const kept = desktop.add('folder', 'kept', {});
    const fresh = desktop.add('folder', 'fresh', {});
    const { db, rows } = memoryDatabase({
      'folder:old': { desktopGrant: old, kind: 'directory', name: 'old' },
      'folder:kept': { desktopGrant: kept, kind: 'directory', name: 'kept' },
    });
    const store = storeWith(db, desktop);
    await store.keep(folder('fresh'), picked(desktop, 'fresh', fresh), [
      folder('fresh'),
      folder('kept'),
    ]);
    expect([...rows.keys()].sort()).toEqual(['folder:fresh', 'folder:kept']);
    expect(desktop.forgotten).toEqual([old]);

    await store.forget(folder('kept'));
    expect(desktop.forgotten).toEqual([old, kept]);
  });

  it('gives up the grant an entry had when another folder of the same name takes its place', async () => {
    const desktop = fakeDesktopFiles();
    const first = desktop.add('folder', 'study', {});
    const second = desktop.add('folder', 'study (elsewhere)', {});
    const { db } = memoryDatabase();
    const store = storeWith(db, desktop);
    await store.keep(folder('study'), picked(desktop, 'study', first), [folder('study')]);
    await store.keep(folder('study'), picked(desktop, 'study', second), [folder('study')]);
    expect(desktop.forgotten).toEqual([first]);
    // The same folder again is the same grant, and is not given up.
    await store.keep(folder('study'), picked(desktop, 'study', second), [folder('study')]);
    expect(desktop.forgotten).toEqual([first]);
  });

  it('does not open a grant where there is no bridge to ask', async () => {
    const { db } = memoryDatabase({
      'folder:thorax': {
        desktopGrant: 'Zm9sZGVyLW9mLXRlc3RzIQ',
        kind: 'directory',
        name: 'thorax',
      },
    });
    const store = storeWith(db, null);
    await settled();
    expect(await store.handleFor(folder('thorax'))).toBeNull();
  });
});

describe('indexedDbHandles', () => {
  it('is null where the browser has no IndexedDB', () => {
    // The unit tests run without one; the real database is used end to end.
    expect(typeof indexedDB).toBe('undefined');
    expect(indexedDbHandles()).toBeNull();
  });
});
