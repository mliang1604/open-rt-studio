/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Folders and files in the desktop application (#62). There the page does
// not use the browser's pickers: it asks the main process, through the
// bridge, to show the system's dialog, and gets a grant for what the user
// chose. The grant is dressed as the handle the rest of the application
// already knows (`AccessHandle`), so loading and the Recent list work as
// they do in a browser.
//
// What differs is what the Recent list keeps. A browser's handle goes into
// IndexedDB as it is; a grant is kept by its id, and the main process keeps
// what it stands for, so a folder opens again in a later run without the
// dialog and without a prompt.

import { InjectionToken } from '@angular/core';
import {
  desktopBridge,
  isGrantId,
  READ_BYTES_AT_MOST,
  type DesktopFiles,
  type GrantedFile,
} from '@open-rt-studio/desktop-bridge';

import type { AccessHandle, FilePickers } from './file-access';

/** The bridge's file calls; null in a browser. Replaced in tests. */
export const DESKTOP_FILES = new InjectionToken<DesktopFiles | null>('desktop files', {
  providedIn: 'root',
  factory: () => desktopBridge()?.files ?? null,
});

/** What the Recent list keeps of a desktop handle: nothing of where it is on the disk. */
export interface StoredGrant {
  readonly desktopGrant: string;
  readonly kind: 'directory' | 'file';
  readonly name: string;
  /** Of a file: where it is under the grant. */
  readonly path?: string;
}

export function isStoredGrant(value: unknown): value is StoredGrant {
  if (typeof value !== 'object' || value === null) return false;
  const stored = value as Record<string, unknown>;
  return (
    isGrantId(stored['desktopGrant']) &&
    (stored['kind'] === 'directory' || stored['kind'] === 'file') &&
    typeof stored['name'] === 'string' &&
    (stored['path'] === undefined || typeof stored['path'] === 'string')
  );
}

/** What a grant led to is not there now: the folder was moved, or the grant given up. */
export class GrantGoneError extends Error {
  constructor() {
    super('What was chosen is no longer there.');
    this.name = 'GrantGoneError';
  }
}

/** The bytes of a file under a grant, read in pieces so that no one answer is large. */
async function readWhole(
  files: DesktopFiles,
  id: string,
  path: string,
  size: number,
): Promise<ArrayBuffer> {
  const whole = new Uint8Array(size);
  let at = 0;
  while (at < size) {
    const piece = await files.read(id, path, at, Math.min(READ_BYTES_AT_MOST, size - at));
    if (piece === null) throw new GrantGoneError();
    // Shorter than when it was listed: what is there is what there is.
    if (piece.byteLength === 0) break;
    const bytes = new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength);
    whole.set(bytes.subarray(0, size - at), at);
    at += bytes.byteLength;
  }
  return at >= size ? whole.buffer : whole.slice(0, at).buffer;
}

/**
 * A file under a grant. It is a `File` to everything that takes one, with
 * its name and size, and its bytes are read through the bridge when they
 * are asked for and not before: a folder of a thousand slices is a thousand
 * of these, and holds no slice until its turn to be parsed.
 */
class GrantedFileObject extends File {
  readonly #read: () => Promise<ArrayBuffer>;

  constructor(read: () => Promise<ArrayBuffer>, name: string, size: number, modified: number) {
    super([], name, { lastModified: modified });
    this.#read = read;
    Object.defineProperty(this, 'size', { value: size, enumerable: true });
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    return this.#read();
  }

  override async text(): Promise<string> {
    return new TextDecoder().decode(await this.#read());
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const read = this.#read;
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(await read()));
        controller.close();
      },
    });
  }

  // A part of it would have to be there before it is read. Nothing here asks for one.
  override slice(): Blob {
    throw new Error('A file of the desktop application is read whole, with arrayBuffer().');
  }
}

/** The `File` of a listed file of a grant. */
export function grantedFile(files: DesktopFiles, id: string, listed: GrantedFile): File {
  const name = listed.path.slice(listed.path.lastIndexOf('/') + 1);
  return new GrantedFileObject(
    () => readWhole(files, id, listed.path, listed.size),
    name,
    listed.size,
    listed.modified,
  );
}

/**
 * A grant as a handle: a folder with its files, or one file. It has no
 * permission methods, which says that it needs none: the main process reads
 * it for as long as the grant is there.
 */
export class DesktopHandle implements AccessHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  /** Whether the folder held more files than are listed. Known after `values()`. */
  truncated = false;

  constructor(
    private readonly files: DesktopFiles,
    /** What the Recent list keeps of it. */
    readonly stored: StoredGrant,
    /** Of a file that was just listed: what the listing said, to save asking again. */
    private readonly listed: GrantedFile | null = null,
  ) {
    this.kind = stored.kind;
    this.name = stored.name;
  }

  /** A file handle's file. Rejects with {@link GrantGoneError} when it is not there. */
  async getFile(): Promise<File> {
    const { desktopGrant: id, path } = this.stored;
    if (this.kind !== 'file' || path === undefined) throw new GrantGoneError();
    const listed =
      this.listed ?? (await this.files.list(id))?.files.find((file) => file.path === path);
    if (!listed) throw new GrantGoneError();
    return grantedFile(this.files, id, listed);
  }

  /**
   * A folder handle's files, all of them: those of the folders inside it
   * too, each as a file handle. Rejects with {@link GrantGoneError} when the
   * folder is not there.
   */
  async *values(): AsyncIterable<AccessHandle> {
    const id = this.stored.desktopGrant;
    if (this.kind !== 'directory') return;
    const listing = await this.files.list(id);
    if (listing === null) throw new GrantGoneError();
    this.truncated = listing.truncated;
    for (const listed of listing.files) {
      const name = listed.path.slice(listed.path.lastIndexOf('/') + 1);
      yield new DesktopHandle(
        this.files,
        { desktopGrant: id, kind: 'file', name, path: listed.path },
        listed,
      );
    }
  }
}

const dismissed = (): DOMException => new DOMException('Nothing was chosen.', 'AbortError');

/**
 * The pickers of the desktop application: the system's dialogs, shown by the
 * main process. Like the browser's, each rejects with an `AbortError` when
 * the dialog is dismissed.
 */
export function desktopPickers(files: DesktopFiles): FilePickers {
  return {
    directory: async () => {
      const grant = await files.pickFolder();
      if (grant === null) throw dismissed();
      return new DesktopHandle(files, {
        desktopGrant: grant.id,
        kind: 'directory',
        name: grant.name,
      });
    },
    files: async () => {
      const grant = await files.pickFiles();
      if (grant === null) throw dismissed();
      const listing = await files.list(grant.id);
      if (listing === null) throw dismissed();
      return listing.files.map(
        (listed) =>
          new DesktopHandle(
            files,
            { desktopGrant: grant.id, kind: 'file', name: listed.path, path: listed.path },
            listed,
          ),
      );
    },
  };
}
