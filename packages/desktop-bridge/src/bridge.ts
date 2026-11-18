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
// main process then trusts. (The one address a call takes, a server's, is
// put to the user by the main process before anything is sent there.)

/** The name the bridge has on the window. */
export const BRIDGE_GLOBAL = 'openRtStudioDesktop';

/** Raised when a call changes what it takes or gives. */
export const BRIDGE_VERSION = 5;

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
  /**
   * Whether the application was told to draw in software (#69): a setting
   * for tests and for working on it. Without it the viewer on Linux takes no
   * software adapter, which Chromium offers there by itself and which does
   * not hold.
   */
  readonly softwareGpu: boolean;
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
 * A server the user agreed to connect to. The page has no network of its
 * own: what it asks of a server it asks through the main process, of a
 * connection, and a connection is made only when the user says so in a
 * dialog of the main process that names the address.
 */
export interface ServerConnection {
  /** Made by the main process: {@link isGrantId}. */
  readonly id: string;
  /** The server's origin: `https://pacs.example.org`, `http://127.0.0.1:4300`. */
  readonly address: string;
  /**
   * Whether the application holds a login for it. The token of a login
   * stays in the main process, which adds it to what is sent; the page gets
   * {@link HELD_LOGIN} in its place.
   */
  readonly loggedIn: boolean;
}

/** What the page is given where a server's answer held the token of a login. */
export const HELD_LOGIN = 'held-by-the-desktop-application';

/** The methods a request to a server may have. */
export const SERVER_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ServerMethod = (typeof SERVER_METHODS)[number];

/** The headers the page may give a request, in lower case. Who is asking is not the page's to say. */
export const SERVER_REQUEST_HEADERS = ['accept', 'content-type', 'if-none-match', 'range'] as const;

/** Where every request to a server goes: its API, and nothing else it may serve. */
export const SERVER_API_PREFIX = '/api/v1/';
/** How long the path of a request may be, with what is asked after it. */
export const SERVER_PATH_AT_MOST = 8192;

export interface ServerRequest {
  /** A name for this request, made by the page, to cancel it by: {@link isGrantId}. */
  readonly request: string;
  readonly method: ServerMethod;
  /** Begins with {@link SERVER_API_PREFIX}. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
}

/** Why a request got no answer from the server. */
export type ServerFailure = 'unreachable' | 'certificate' | 'cancelled' | 'too-large';

/** What the server answered, whole; or why it did not. */
export type ServerAnswer =
  | {
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
    }
  | { readonly failed: ServerFailure };

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
  /**
   * Connect to a server at an address the user typed. One that was not
   * connected to before is put to the user first. Null when it is no
   * address of a server, or the user said no.
   */
  'server:connect': {
    readonly args: readonly [address: string];
    readonly result: ServerConnection | null;
  };
  /** The servers that were connected to, the last used first. */
  'server:connections': {
    readonly args: readonly [];
    readonly result: readonly ServerConnection[];
  };
  /** Forget a server, and the login held for it. */
  'server:forget': { readonly args: readonly [id: string]; readonly result: null };
  /** Ask a connected server's API. Null when there is no such connection. */
  'server:request': {
    readonly args: readonly [id: string, request: ServerRequest];
    readonly result: ServerAnswer | null;
  };
  /** Give up a request that has not been answered. */
  'server:cancel': { readonly args: readonly [request: string]; readonly result: null };
  /**
   * Ask the API of the library on this computer: the server's own, answered
   * inside the application with no network (#64). There is one library and
   * no login to it.
   */
  'library:request': {
    readonly args: readonly [request: ServerRequest];
    readonly result: ServerAnswer;
  };
  /** Give up a request to the library that has not been answered. */
  'library:cancel': { readonly args: readonly [request: string]; readonly result: null };
  /**
   * Show the system's dialog for a folder, and take the DICOM files in it
   * into the library. Answers when the import is over.
   */
  'library:import-folder': { readonly args: readonly []; readonly result: LibraryImportResult };
  /** How far the import under way has come. Null when there is none. */
  'library:import-progress': {
    readonly args: readonly [];
    readonly result: LibraryProgress | null;
  };
  /** Stop the import under way after the file in hand. What was taken in stays. */
  'library:cancel-import': { readonly args: readonly []; readonly result: null };
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
  'server:connect': true,
  'server:connections': true,
  'server:forget': true,
  'server:request': true,
  'server:cancel': true,
  'library:request': true,
  'library:cancel': true,
  'library:import-folder': true,
  'library:import-progress': true,
  'library:cancel-import': true,
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
  /** The servers the user connected to. One method for each `server:` call. */
  readonly server: DesktopServer;
  /** The library on this computer. One method for each `library:` call. */
  readonly library: DesktopLibrary;
}

/**
 * What an import of a folder into the library came to: counts, and no names.
 * The folder is chosen in the main process's dialog and read there; the page
 * is told how it went and not where it was.
 */
export interface LibraryImport {
  /** Files found in the folder and below it. */
  readonly total: number;
  /** Files that are now in the library and were not before. */
  readonly stored: number;
  /** Files the library already held, the same. */
  readonly unchanged: number;
  /** Files that took the place of another version of the same object. */
  readonly replaced: number;
  /** Files that were not taken: not DICOM, or not an object the library keeps. */
  readonly refused: number;
  /** Files that could not be read or kept. */
  readonly failed: number;
  /** True when the import was stopped before the last file. */
  readonly cancelled: boolean;
}

/**
 * How asking for an import ended: with an import, or without one because no
 * folder was chosen, another import is under way, or the library could not
 * be opened.
 */
export type LibraryImportResult =
  { readonly imported: LibraryImport } | { readonly not: 'chosen' | 'busy' | 'unavailable' };

/** How far an import has come, in files. */
export interface LibraryProgress {
  readonly done: number;
  readonly total: number;
}

export interface DesktopLibrary {
  request(request: ServerRequest): Promise<ServerAnswer>;
  cancel(request: string): Promise<null>;
  importFolder(): Promise<LibraryImportResult>;
  importProgress(): Promise<LibraryProgress | null>;
  cancelImport(): Promise<null>;
}

const LIBRARY_CALLS: { readonly [M in keyof DesktopLibrary]: true } = {
  request: true,
  cancel: true,
  importFolder: true,
  importProgress: true,
  cancelImport: true,
};

export interface DesktopServer {
  connect(address: string): Promise<ServerConnection | null>;
  connections(): Promise<readonly ServerConnection[]>;
  forget(id: string): Promise<null>;
  request(id: string, request: ServerRequest): Promise<ServerAnswer | null>;
  cancel(request: string): Promise<null>;
}

const SERVER_CALLS: { readonly [M in keyof DesktopServer]: true } = {
  connect: true,
  connections: true,
  forget: true,
  request: true,
  cancel: true,
};

/**
 * Whether a path is one of a server's API: under {@link SERVER_API_PREFIX},
 * written plainly, with no step up or in place and nothing a URL would read
 * as another place.
 */
export function isServerPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > SERVER_PATH_AT_MOST) return false;
  if (!path.startsWith(SERVER_API_PREFIX)) return false;
  // Printable ASCII only: anything else is written with percent signs.
  if (!/^[\x21-\x7e]+$/.test(path) || /[\\#]/.test(path)) return false;
  const [route] = path.split('?');
  return !route.split('/').some((part) => part === '.' || part === '..' || /^%2e/i.test(part));
}

/** Whether a value is a request the page may make of a server. */
export function isServerRequest(value: unknown): value is ServerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  const { headers, body } = request;
  if (!isGrantId(request['request']) || !isServerPath(request['path'])) return false;
  if (!(SERVER_METHODS as readonly unknown[]).includes(request['method'])) return false;
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) return false;
  for (const [name, text] of Object.entries(headers)) {
    if (!(SERVER_REQUEST_HEADERS as readonly string[]).includes(name)) return false;
    // One line of printable text: nothing that would begin another header.
    if (typeof text !== 'string' || text.length > 1024 || !/^[\x20-\x7e]*$/.test(text))
      return false;
  }
  return body === null || body instanceof Uint8Array;
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
    typeof info['packaged'] === 'boolean' &&
    typeof info['softwareGpu'] === 'boolean'
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
  const { version, info, files, server, library } = bridge as Record<string, unknown>;
  if (version !== BRIDGE_VERSION || typeof info !== 'function') return null;
  for (const [part, names] of [
    [files, FILE_METHODS],
    [server, SERVER_CALLS],
    [library, LIBRARY_CALLS],
  ] as const) {
    if (typeof part !== 'object' || part === null) return null;
    const methods = part as Record<string, unknown>;
    if (Object.keys(names).some((name) => typeof methods[name] !== 'function')) return null;
  }
  return bridge as DesktopBridge;
}
