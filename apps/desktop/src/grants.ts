/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the page may read of the disk (#62): the folders and files the user
// chose in the system's dialog, and nothing else. A choice becomes a grant
// with an id the main process makes; the page holds the id and asks for
// what is under it, by a path that is checked to stay there. The page never
// names a place on the disk, and is never told one.
//
// A grant lasts while the application runs. One that is kept, which is what
// the Recent list does, is written to a file of the profile and is there
// the next time. This needs no Electron.

import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';

import {
  GRANT_FILES_AT_MOST,
  grantPathParts,
  isGrantId,
  READ_BYTES_AT_MOST,
  type FileGrant,
  type GrantedFile,
  type GrantListing,
} from '@open-rt-studio/desktop-bridge';

export interface GrantsOptions {
  /** Where kept grants are written. Null keeps them for this run only. */
  readonly file: string | null;
  /** How many grants are kept across runs; the one unused longest goes first. 32 by default. */
  readonly keptAtMost?: number;
  /** How many grants that are not kept are held at once. 256 by default. */
  readonly heldAtMost?: number;
  /** How deep folders are listed. 64 by default. */
  readonly depthAtMost?: number;
  /** How many files are listed. {@link GRANT_FILES_AT_MOST} by default. */
  readonly filesAtMost?: number;
  readonly now?: () => number;
}

export interface Grants {
  /** A grant for a folder the user chose. Null when it is not a folder that can be read. */
  folder(path: string): Promise<FileGrant | null>;
  /** A grant for files the user chose. Null when none of them is a file that can be read. */
  files(paths: readonly string[]): Promise<FileGrant | null>;
  list(id: string): Promise<GrantListing | null>;
  read(id: string, path: string, offset: number, length: number): Promise<Uint8Array | null>;
  keep(id: string): Promise<boolean>;
  forget(id: string): Promise<void>;
}

interface Held {
  readonly id: string;
  readonly kind: 'folder' | 'files';
  readonly name: string;
  /** The folder, or the files: where they really are, links followed, as they were chosen. */
  readonly paths: readonly string[];
  kept: boolean;
  /** When it was last made, listed or kept. */
  used: number;
}

const FILE_VERSION = 1;

function isHeld(value: unknown): value is Omit<Held, 'kept'> {
  if (typeof value !== 'object' || value === null) return false;
  const grant = value as Record<string, unknown>;
  const paths = grant['paths'];
  return (
    isGrantId(grant['id']) &&
    (grant['kind'] === 'folder' || grant['kind'] === 'files') &&
    typeof grant['name'] === 'string' &&
    typeof grant['used'] === 'number' &&
    Array.isArray(paths) &&
    paths.length > 0 &&
    (grant['kind'] === 'files' || paths.length === 1) &&
    paths.every((path) => typeof path === 'string' && isAbsolute(path))
  );
}

/** What the file of kept grants holds. One that cannot be read holds nothing. */
async function readKept(file: string | null): Promise<Held[]> {
  if (file === null) return [];
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return [];
    const { version, grants } = parsed as Record<string, unknown>;
    if (version !== FILE_VERSION || !Array.isArray(grants)) return [];
    return grants.filter(isHeld).map((grant) => ({ ...grant, kept: true }));
  } catch {
    return [];
  }
}

const within = (path: string, folder: string): boolean => path.startsWith(folder + sep);

export async function openGrants(options: GrantsOptions): Promise<Grants> {
  const {
    file,
    keptAtMost = 32,
    heldAtMost = 256,
    depthAtMost = 64,
    filesAtMost = GRANT_FILES_AT_MOST,
    now = Date.now,
  } = options;
  const held = new Map<string, Held>();
  for (const grant of await readKept(file)) held.set(grant.id, grant);

  /** Write the kept grants: whole, or not at all. The file says where the user's data is, so it is theirs alone. */
  let writing: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    if (file === null) return Promise.resolve();
    writing = writing.then(async () => {
      const grants = [...held.values()]
        .filter((grant) => grant.kept)
        .map(({ id, kind, name, paths, used }) => ({ id, kind, name, paths, used }));
      try {
        await mkdir(dirname(file), { recursive: true });
        const partial = `${file}.${randomBytes(6).toString('hex')}.part`;
        await writeFile(partial, JSON.stringify({ version: FILE_VERSION, grants }), {
          mode: 0o600,
        });
        await rename(partial, file);
      } catch {
        // Not written: the grant holds for this run, and is picked again in the next.
      }
    });
    return writing;
  };

  /** Let go of what is over the limits: of each sort, the one unused longest. */
  const trim = (): boolean => {
    let changed = false;
    for (const [kept, atMost] of [
      [true, keptAtMost],
      [false, heldAtMost],
    ] as const) {
      const sort = [...held.values()].filter((grant) => grant.kept === kept);
      sort.sort((a, b) => a.used - b.used);
      for (const grant of sort.slice(0, Math.max(0, sort.length - atMost))) {
        held.delete(grant.id);
        changed ||= kept;
      }
    }
    return changed;
  };

  const grant = (kind: Held['kind'], name: string, paths: readonly string[]): FileGrant => {
    // The same choice again is the same grant: a folder that is opened twice is kept once.
    const same = [...held.values()].find(
      (other) =>
        other.kind === kind &&
        other.paths.length === paths.length &&
        other.paths.every((path, at) => path === paths[at]),
    );
    if (same) {
      same.used = now();
      return { id: same.id, kind, name: same.name };
    }
    const id = randomBytes(16).toString('base64url');
    held.set(id, { id, kind, name, paths, kept: false, used: now() });
    trim();
    return { id, kind, name };
  };

  /** A path as it really is, when it is of the sort that is wanted. */
  const real = async (path: string, sort: 'file' | 'folder'): Promise<string | null> => {
    try {
      if (!isAbsolute(path)) return null;
      const resolved = await realpath(path);
      const stats = await lstat(resolved);
      return (sort === 'file' ? stats.isFile() : stats.isDirectory()) ? resolved : null;
    } catch {
      return null;
    }
  };

  /** The files of a folder and of the folders in it, by name. Links are not followed. */
  const walk = async (root: string): Promise<GrantListing | null> => {
    const files: GrantedFile[] = [];
    let truncated = false;
    const pending: { readonly folder: string; readonly parts: readonly string[] }[] = [
      { folder: root, parts: [] },
    ];
    while (pending.length > 0) {
      const { folder, parts } = pending.shift()!;
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        // The folder that was chosen is gone: so is the grant. One inside it is left out.
        if (parts.length === 0) return null;
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        // A name that could not be asked for again is not listed.
        if (grantPathParts(entry.name)?.length !== 1) continue;
        const path = [...parts, entry.name];
        if (entry.isDirectory()) {
          if (path.length < depthAtMost)
            pending.push({ folder: join(folder, entry.name), parts: path });
        } else if (entry.isFile()) {
          if (files.length >= filesAtMost) {
            truncated = true;
            continue;
          }
          try {
            const stats = await lstat(join(folder, entry.name));
            files.push({
              path: path.join('/'),
              size: stats.size,
              modified: Math.round(stats.mtimeMs),
            });
          } catch {
            // Gone since it was listed.
          }
        }
      }
    }
    return { files, truncated };
  };

  /** Where a path under a grant is on the disk, when it is a file under it. */
  const locate = async (grant: Held, path: string): Promise<string | null> => {
    const parts = grantPathParts(path);
    if (parts === null) return null;
    if (grant.kind === 'files') {
      if (parts.length !== 1) return null;
      const chosen = grant.paths.find((file) => basename(file) === parts[0]);
      if (chosen === undefined) return null;
      // Still the file that was chosen, and not a link put in its place.
      return (await real(chosen, 'file')) === chosen ? chosen : null;
    }
    const [root] = grant.paths;
    // On Windows a part can hold a separator of its own, or name a drive or a stream.
    if (sep === '\\' && parts.some((part) => /[\\:]/.test(part))) return null;
    const found = await real(join(root, ...parts), 'file');
    // A link in the folder that leads out of it is not followed.
    return found !== null && within(found, root) ? found : null;
  };

  return {
    async folder(path) {
      const root = await real(path, 'folder');
      return root === null ? null : grant('folder', basename(root), [root]);
    },

    async files(paths) {
      const chosen: string[] = [];
      for (const path of paths) {
        const file = await real(path, 'file');
        // Two of one name could not be told apart by the page: the first is the file.
        if (file !== null && !chosen.some((other) => basename(other) === basename(file))) {
          chosen.push(file);
        }
      }
      if (chosen.length === 0) return null;
      const name = chosen.length === 1 ? basename(chosen[0]) : `${chosen.length} files`;
      return grant('files', name, chosen);
    },

    async list(id) {
      const grant = held.get(id);
      if (grant === undefined) return null;
      let listing: GrantListing | null;
      if (grant.kind === 'folder') {
        listing =
          (await real(grant.paths[0], 'folder')) === null ? null : await walk(grant.paths[0]);
      } else {
        const files: GrantedFile[] = [];
        for (const file of grant.paths) {
          try {
            const stats = await lstat(file);
            if (!stats.isFile()) continue;
            files.push({
              path: basename(file),
              size: stats.size,
              modified: Math.round(stats.mtimeMs),
            });
          } catch {
            // Gone since it was chosen.
          }
        }
        listing = files.length === 0 ? null : { files, truncated: false };
      }
      if (listing !== null) {
        grant.used = now();
        if (grant.kept) await persist();
      }
      return listing;
    },

    async read(id, path, offset, length) {
      const grant = held.get(id);
      if (grant === undefined) return null;
      if (!Number.isSafeInteger(offset) || offset < 0) return null;
      if (!Number.isSafeInteger(length) || length < 0) return null;
      const file = await locate(grant, path);
      if (file === null) return null;
      let handle;
      try {
        handle = await open(file, 'r');
        const bytes = new Uint8Array(Math.min(length, READ_BYTES_AT_MOST));
        let read = 0;
        while (read < bytes.length) {
          const { bytesRead } = await handle.read(bytes, read, bytes.length - read, offset + read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        return read === bytes.length ? bytes : bytes.slice(0, read);
      } catch {
        return null;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },

    async keep(id) {
      const grant = held.get(id);
      if (grant === undefined) return false;
      grant.kept = true;
      grant.used = now();
      trim();
      await persist();
      return true;
    },

    async forget(id) {
      const grant = held.get(id);
      if (grant === undefined) return;
      held.delete(id);
      if (grant.kept) await persist();
    },
  };
}
