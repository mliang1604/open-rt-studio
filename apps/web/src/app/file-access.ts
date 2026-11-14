/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The File System Access API, as far as this application uses it. Chromium
// browsers have it; Firefox and Safari do not, and there the hidden file
// inputs do the picking. A handle, unlike the File objects an input gives, can
// be kept and asked for its files again in a later session, after the user
// allows it once more.
//
// The types are written out here because TypeScript's DOM library has only
// part of the API: not the pickers, and not the permission methods.

/** A file or directory the user picked or dropped. */
export interface AccessHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  /** Whether reading is allowed now, without asking. */
  queryPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
  /** Ask the user to allow reading. Needs a user gesture; shows one prompt. */
  requestPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
  /** A file handle's file. */
  getFile?(): Promise<File>;
  /** A directory handle's children. */
  values?(): AsyncIterable<AccessHandle>;
}

/** The two pickers, each present only where the browser has it. */
export interface FilePickers {
  readonly directory: (() => Promise<AccessHandle>) | null;
  readonly files: (() => Promise<AccessHandle[]>) | null;
}

interface PickerWindow {
  showDirectoryPicker?: (options?: object) => Promise<AccessHandle>;
  showOpenFilePicker?: (options?: object) => Promise<AccessHandle[]>;
}

/** The pickers of `host` (the window). Both null where the API is missing. */
export function filePickers(host: unknown = globalThis): FilePickers {
  const win = host as PickerWindow;
  const directory = typeof win.showDirectoryPicker === 'function' ? win.showDirectoryPicker : null;
  const files = typeof win.showOpenFilePicker === 'function' ? win.showOpenFilePicker : null;
  return {
    // One `id` for both, so the dialog opens where the last one was left.
    directory: directory && (() => directory.call(win, { id: 'open-rt-studio', mode: 'read' })),
    files: files && (() => files.call(win, { id: 'open-rt-studio', multiple: true })),
  };
}

/**
 * Every file under a handle: the file itself, or all files of a directory and
 * the directories inside it. A file that cannot be read is left out, as a
 * folder input leaves it out.
 */
export async function filesOf(handle: AccessHandle): Promise<File[]> {
  const out: File[] = [];
  await collect(handle, out);
  return out;
}

async function collect(handle: AccessHandle, out: File[]): Promise<void> {
  if (handle.kind === 'file') {
    try {
      const file = await handle.getFile?.();
      if (file) out.push(file);
    } catch {
      // Removed since the directory was listed, or not readable: skip it.
    }
    return;
  }
  if (!handle.values) return;
  for await (const child of handle.values()) await collect(child, out);
}

/**
 * Make sure a kept handle may be read, asking the user if the browser wants
 * that: at most one prompt. False when the user declines, or when the browser
 * refuses to ask (it does without a recent click or key press).
 */
export async function ensureReadable(handle: AccessHandle): Promise<boolean> {
  const mode = { mode: 'read' } as const;
  try {
    // A handle without the permission methods is one that needs no permission.
    if (!handle.queryPermission) return true;
    if ((await handle.queryPermission(mode)) === 'granted') return true;
    if (!handle.requestPermission) return false;
    return (await handle.requestPermission(mode)) === 'granted';
  } catch {
    return false;
  }
}

/**
 * The handle of a drop, when exactly one thing was dropped and the browser
 * gives handles for drops. Must be called while the drop event is being
 * handled: the items are gone after the first `await`.
 */
export function droppedHandle(dataTransfer: DataTransfer): Promise<AccessHandle | null> {
  type HandleItem = DataTransferItem & {
    getAsFileSystemHandle?: () => Promise<AccessHandle | null>;
  };
  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === 'file');
  const [only] = items as HandleItem[];
  if (items.length !== 1 || typeof only.getAsFileSystemHandle !== 'function') {
    return Promise.resolve(null);
  }
  return only.getAsFileSystemHandle().catch(() => null);
}
