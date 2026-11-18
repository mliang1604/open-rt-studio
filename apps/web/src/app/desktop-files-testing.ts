/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A stand-in for the main process's file calls, for specs: grants over files
// held in memory, with a record of what was asked.

import {
  READ_BYTES_AT_MOST,
  type DesktopFiles,
  type FileGrant,
} from '@open-rt-studio/desktop-bridge';

export interface FakeGrant {
  readonly grant: FileGrant;
  /** The files under it, by path. */
  readonly files: Map<string, Uint8Array>;
  truncated?: boolean;
}

export interface FakeDesktopFiles extends DesktopFiles {
  /** What the next dialog gives: a grant's id, or null for one that is dismissed. */
  next: string | null;
  readonly grants: Map<string, FakeGrant>;
  /** The grants the page asked to be kept, and to be given up. */
  readonly kept: Set<string>;
  readonly forgotten: string[];
  /** Every `read`, as `path@offset+length`. */
  readonly reads: string[];
  /** Add a grant. Its id is made from `name`, as 22 characters. */
  add(kind: FileGrant['kind'], name: string, files: Record<string, Uint8Array>): string;
}

/** An id as the main process makes them, told apart by `seed`. */
export const fakeGrantId = (seed: string): string =>
  seed
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .padEnd(22, '0')
    .slice(0, 22);

export function fakeDesktopFiles(): FakeDesktopFiles {
  const grants = new Map<string, FakeGrant>();
  const kept = new Set<string>();
  const forgotten: string[] = [];
  const reads: string[] = [];
  const picked = (state: FakeDesktopFiles, kind: FileGrant['kind']) => {
    const grant = state.next === null ? undefined : grants.get(state.next)?.grant;
    return Promise.resolve(grant && grant.kind === kind ? grant : null);
  };
  const fake: FakeDesktopFiles = {
    next: null,
    grants,
    kept,
    forgotten,
    reads,
    add(kind, name, files) {
      const id = fakeGrantId(name);
      grants.set(id, { grant: { id, kind, name }, files: new Map(Object.entries(files)) });
      return id;
    },
    pickFolder: () => picked(fake, 'folder'),
    pickFiles: () => picked(fake, 'files'),
    list: async (id) => {
      const held = grants.get(id);
      if (!held) return null;
      return {
        files: [...held.files].map(([path, bytes]) => ({
          path,
          size: bytes.length,
          modified: 1_700_000_000_000,
        })),
        truncated: held.truncated ?? false,
      };
    },
    read: async (id, path, offset, length) => {
      reads.push(`${path}@${offset}+${length}`);
      const bytes = grants.get(id)?.files.get(path);
      if (!bytes) return null;
      return bytes.slice(offset, offset + Math.min(length, READ_BYTES_AT_MOST));
    },
    keep: async (id) => {
      if (!grants.has(id)) return false;
      kept.add(id);
      return true;
    },
    forget: async (id) => {
      forgotten.push(id);
      kept.delete(id);
      grants.delete(id);
      return null;
    },
  };
  return fake;
}
