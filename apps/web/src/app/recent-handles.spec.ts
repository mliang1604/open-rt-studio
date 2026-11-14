/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessHandle } from './file-access';
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
function memoryDatabase(initial: Record<string, AccessHandle> = {}) {
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

function storeWith(db: HandleDatabase | null): RecentHandles {
  TestBed.configureTestingModule({ providers: [{ provide: HANDLE_DATABASE, useValue: db }] });
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

describe('indexedDbHandles', () => {
  it('is null where the browser has no IndexedDB', () => {
    // The unit tests run without one; the real database is used end to end.
    expect(typeof indexedDB).toBe('undefined');
    expect(indexedDbHandles()).toBeNull();
  });
});
