/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The bridge between the desktop application's page and its main process
// (#61). The page runs in a sandbox with no Node, and reaches the main
// process only through what is declared here: the preload script puts a
// `DesktopBridge` on the window, and each of its methods is one call of
// `BridgeCalls`, which the main process answers.
//
// It is declared once so that the three sides cannot drift apart: the main
// process serves `BridgeCalls`, the preload script is checked against both
// types, and the page reads the bridge with `desktopBridge()`.
//
// Add to it sparingly. Everything here is something a page can ask of a
// process that can read the disk: a call takes the least it can, says what
// it gives back, and never takes a path, a program or an address that the
// main process then trusts.

/** The name the bridge has on the window. */
export const BRIDGE_GLOBAL = 'openRtStudioDesktop';

/** Raised when a call changes what it takes or gives. */
export const BRIDGE_VERSION = 2;

/** The systems the desktop application runs on, as Node names them. */
export const DESKTOP_PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];

/** What the desktop application says of itself. Nothing of the machine's user or its files. */
export interface DesktopInfo {
  /** The application's version. */
  readonly appVersion: string;
  /** The versions of Electron and of the Chromium inside it. */
  readonly electron: string;
  readonly chromium: string;
  readonly platform: DesktopPlatform;
  /** The processor architecture it was built for: `arm64`, `x64`. */
  readonly arch: string;
  /** Whether it runs as an installed application, and not from the repository. */
  readonly packaged: boolean;
}

/**
 * What the user chose in one of the system's dialogs: a folder, or some
 * files. The page never learns where it is, and never names a place itself:
 * it holds the `id`, which the main process made, and asks for what is
 * under it. A grant lasts until the application closes unless it is kept
 * (`files.keep`), which is what the Recent list does.
 */
export interface FileGrant {
  /** Made by the main process, and not to be guessed: {@link isGrantId}. */
  readonly id: string;
  readonly kind: 'folder' | 'files';
  /** The folder's name, or a file's when one was chosen. No path. */
  readonly name: string;
}

/** A file under a grant. */
export interface GrantedFile {
  /** Where it is under the grant: parts joined by `/`, the last its name. */
  readonly path: string;
  /** Its size in bytes when it was listed. */
  readonly size: number;
  /** When it was last changed, in milliseconds since 1970. */
  readonly modified: number;
}

/** The files under a grant. */
export interface GrantListing {
  readonly files: readonly GrantedFile[];
  /** Whether there were more than {@link GRANT_FILES_AT_MOST}, and the rest were left out. */
  readonly truncated: boolean;
}

/** How many files of a grant are listed. */
export const GRANT_FILES_AT_MOST = 100_000;
/** How many bytes one `files.read` gives at most: a large file is read in pieces. */
export const READ_BYTES_AT_MOST = 4 * 1024 * 1024;
/** How long a path under a grant may be, in characters. */
export const GRANT_PATH_AT_MOST = 4096;

/**
 * Every call the page can make of the main process: the channel it goes by,
 * what it sends and what comes back.
 *
 * A call about a grant answers null when the grant is not there (it was
 * never made, was forgotten, or what it led to is gone), and nothing else
 * of why.
 */
export interface BridgeCalls {
  'desktop:info': { readonly args: readonly []; readonly result: DesktopInfo };
  /** Show the system's dialog for a folder. Null when it was dismissed. */
  'files:pick-folder': { readonly args: readonly []; readonly result: FileGrant | null };
  /** Show the system's dialog for files. Null when it was dismissed. */
  'files:pick-files': { readonly args: readonly []; readonly result: FileGrant | null };
  /** Every file under a grant, in the folders inside it too. */
  'files:list': { readonly args: readonly [id: string]; readonly result: GrantListing | null };
  /**
   * Bytes of a file under a grant, from `offset`, at most `length` of them
   * (and at most {@link READ_BYTES_AT_MOST}); fewer at the end of the file.
   */
  'files:read': {
    readonly args: readonly [id: string, path: string, offset: number, length: number];
    readonly result: Uint8Array | null;
  };
  /** Keep a grant for later runs of the application. False when it is not there. */
  'files:keep': { readonly args: readonly [id: string]; readonly result: boolean };
  /** Give a grant up. */
  'files:forget': { readonly args: readonly [id: string]; readonly result: null };
}
export type BridgeChannel = keyof BridgeCalls;

const CHANNELS: { readonly [C in BridgeChannel]: true } = {
  'desktop:info': true,
  'files:pick-folder': true,
  'files:pick-files': true,
  'files:list': true,
  'files:read': true,
  'files:keep': true,
  'files:forget': true,
};
/** The channels, for a main process that must serve each one. */
export const BRIDGE_CHANNELS = Object.keys(CHANNELS) as readonly BridgeChannel[];

/** What the page sees on its window, under {@link BRIDGE_GLOBAL}. */
export interface DesktopBridge {
  readonly version: typeof BRIDGE_VERSION;
  /** What the application is: its versions and the system it runs on. */
  info(): Promise<DesktopInfo>;
  /** The files the user chose, through the main process. One method for each `files:` call. */
  readonly files: DesktopFiles;
}

export interface DesktopFiles {
  pickFolder(): Promise<FileGrant | null>;
  pickFiles(): Promise<FileGrant | null>;
  list(id: string): Promise<GrantListing | null>;
  read(id: string, path: string, offset: number, length: number): Promise<Uint8Array | null>;
  keep(id: string): Promise<boolean>;
  forget(id: string): Promise<null>;
}

/** The names of {@link DesktopFiles}, for a check of what a window carries. */
const FILE_METHODS: { readonly [M in keyof DesktopFiles]: true } = {
  pickFolder: true,
  pickFiles: true,
  list: true,
  read: true,
  keep: true,
  forget: true,
};

/** What the id of a grant looks like: 128 random bits, as the main process writes them. */
export function isGrantId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
}

/** Whether a value is a grant, as the main process gives one. */
export function isFileGrant(value: unknown): value is FileGrant {
  if (typeof value !== 'object' || value === null) return false;
  const grant = value as Record<string, unknown>;
  return (
    isGrantId(grant['id']) &&
    (grant['kind'] === 'folder' || grant['kind'] === 'files') &&
    typeof grant['name'] === 'string'
  );
}

/**
 * The parts of a path under a grant, or null for what is none: it names a
 * file by the folders that lead to it and nothing else. No step up or in
 * place, no empty part, nothing that begins at a root.
 */
export function grantPathParts(path: unknown): readonly string[] | null {
  if (typeof path !== 'string' || path === '' || path.length > GRANT_PATH_AT_MOST) return null;
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\0'))) {
    return null;
  }
  return parts;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Whether a value is what `info()` promises. What crosses the bridge is checked where it arrives. */
export function isDesktopInfo(value: unknown): value is DesktopInfo {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Record<string, unknown>;
  return (
    isText(info['appVersion']) &&
    isText(info['electron']) &&
    isText(info['chromium']) &&
    (DESKTOP_PLATFORMS as readonly unknown[]).includes(info['platform']) &&
    isText(info['arch']) &&
    typeof info['packaged'] === 'boolean'
  );
}

/**
 * The bridge of `host` (the window), or null in a browser, where there is
 * none. Null also for a bridge of another version: a page and a shell that
 * do not agree on the calls do not make them.
 */
export function desktopBridge(host: unknown = globalThis): DesktopBridge | null {
  if (typeof host !== 'object' || host === null) return null;
  const bridge = (host as Record<string, unknown>)[BRIDGE_GLOBAL];
  if (typeof bridge !== 'object' || bridge === null) return null;
  const { version, info, files } = bridge as Record<string, unknown>;
  if (version !== BRIDGE_VERSION || typeof info !== 'function') return null;
  if (typeof files !== 'object' || files === null) return null;
  const methods = files as Record<string, unknown>;
  if (Object.keys(FILE_METHODS).some((name) => typeof methods[name] !== 'function')) return null;
  return bridge as DesktopBridge;
}
