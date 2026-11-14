/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import type { AccessHandle } from './file-access';
import type { RecentEntry } from './recent-store';

// The handles behind the Recent list. The list itself (labels) is in
// localStorage; a handle cannot go there, only into IndexedDB, which stores it
// as the browser's own object. With the handle, choosing a recent entry reads
// the folder again instead of opening the picker.
//
// Only a folder or a single file gets a handle. A set of several files has one
// handle per file and the browser asks about each, which is worse than picking
// them again.

/** Where the handles are kept. Null where the browser has no IndexedDB. */
export interface HandleDatabase {
  keys(): Promise<string[]>;
  get(key: string): Promise<AccessHandle | undefined>;
  set(key: string, handle: AccessHandle): Promise<void>;
  delete(key: string): Promise<void>;
}

const DATABASE = 'open-rt-studio';
const STORE = 'recent-handles';

/** The key a recent entry's handle is kept under: entries are told apart by kind and label. */
export function recentKey(entry: RecentEntry): string {
  return `${entry.kind}:${entry.label}`;
}

/** The handle database in IndexedDB, or null when there is no IndexedDB. */
export function indexedDbHandles(): HandleDatabase | null {
  if (typeof indexedDB === 'undefined') return null;
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> =>
    (opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  const run = async <T>(
    mode: IDBTransactionMode,
    act: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    keys: async () => (await run('readonly', (store) => store.getAllKeys())).map(String),
    get: (key) =>
      run('readonly', (store) => store.get(key) as IDBRequest<AccessHandle | undefined>),
    set: async (key, handle) => {
      await run('readwrite', (store) => store.put(handle, key));
    },
    delete: async (key) => {
      await run('readwrite', (store) => store.delete(key));
    },
  };
}

/** The database {@link RecentHandles} uses; replaced in tests. */
export const HANDLE_DATABASE = new InjectionToken<HandleDatabase | null>('recent handles', {
  providedIn: 'root',
  factory: indexedDbHandles,
});

/**
 * Keeps the handle of each recent entry that has one. Every failure of the
 * database (private browsing, storage full, a handle that will not store) is
 * taken as "no handle": the entry then reopens the picker, as it always did.
 */
@Injectable({ providedIn: 'root' })
export class RecentHandles {
  private readonly db = inject(HANDLE_DATABASE);
  private readonly kept = signal<ReadonlySet<string>>(new Set());

  constructor() {
    void this.refresh();
  }

  /** Whether an entry has a handle, so that choosing it reopens it. */
  has(entry: RecentEntry): boolean {
    return this.kept().has(recentKey(entry));
  }

  /**
   * Keep `handle` for `entry`, and drop the handles of entries that are no
   * longer in the `current` recent list.
   */
  async keep(
    entry: RecentEntry,
    handle: AccessHandle,
    current: readonly RecentEntry[],
  ): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.set(recentKey(entry), handle);
      const listed = new Set([recentKey(entry), ...current.map(recentKey)]);
      for (const key of await this.db.keys()) {
        if (!listed.has(key)) await this.db.delete(key);
      }
    } catch {
      // Not kept; refresh() below says what is there.
    }
    await this.refresh();
  }

  /** The handle kept for an entry, or null. */
  async handleFor(entry: RecentEntry): Promise<AccessHandle | null> {
    if (!this.db) return null;
    try {
      return (await this.db.get(recentKey(entry))) ?? null;
    } catch {
      return null;
    }
  }

  /** Drop an entry's handle: what it pointed to is gone. */
  async forget(entry: RecentEntry): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.delete(recentKey(entry));
    } catch {
      // Nothing to do: refresh() reports what is left.
    }
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.db) return;
    try {
      this.kept.set(new Set(await this.db.keys()));
    } catch {
      this.kept.set(new Set());
    }
  }
}
