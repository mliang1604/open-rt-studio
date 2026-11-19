/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The servers the desktop application talks to (#63). The page has no
// network of its own: its policy lets it fetch from the application and
// nowhere else. What it asks of a server it asks here, through the bridge,
// of a connection, and a connection is made only when the user agrees, in a
// dialog of the main process that names the address. What comes back is
// bytes and a status, which the page takes as data.
//
// The token of a login never reaches the page. It is taken out of the
// server's answer to a login, held here, and added to what is sent; where
// the system can protect it (its keychain), it is written down sealed and
// the login is there in the next run. This needs no Electron.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  HELD_LOGIN,
  isGrantId,
  isServerRequest,
  SERVER_API_PREFIX,
  type ServerAnswer,
  type ServerConnection,
  type ServerRequest,
} from '@open-rt-studio/desktop-bridge';

/** How the system protects a secret for this user: Electron's `safeStorage`, or a stand-in. */
export interface Seal {
  seal(text: string): string | null;
  open(sealed: string): string | null;
}

/**
 * A seal that is made when it is first needed, and once: when there is a
 * login to seal, or a sealed login to open (#357). Asking the system for
 * its key is not free: on macOS it reads the keychain, makes the entry
 * where there is none, and may have the system ask the user. An application
 * that keeps no login asks for nothing.
 */
export function sealWhenNeeded(make: () => Seal | null): Seal {
  let made: { readonly seal: Seal | null } | null = null;
  const seal = (): Seal | null => (made ??= { seal: make() }).seal;
  return {
    seal: (text) => seal()?.seal(text) ?? null,
    open: (sealed) => seal()?.open(sealed) ?? null,
  };
}

export interface ConnectionsOptions {
  /** Where the connections are written. Null keeps them for this run only. */
  readonly file: string | null;
  readonly fetch: typeof fetch;
  /**
   * Ask the user whether to connect to a server they have not connected to
   * before. `plain` says that what is sent there can be read on the way.
   */
  approve(address: string, plain: boolean): Promise<boolean>;
  /** Null where nothing protects a secret: a login then lasts for the run. */
  readonly seal: Seal | null;
  /** How many servers are remembered; the one unused longest goes first. 16 by default. */
  readonly savedAtMost?: number;
  /** The largest answer taken from a server, in bytes. 1 GiB by default. */
  readonly answerBytesAtMost?: number;
  readonly now?: () => number;
}

export interface Connections {
  connect(typed: string): Promise<ServerConnection | null>;
  list(): readonly ServerConnection[];
  forget(id: string): Promise<void>;
  request(id: string, request: ServerRequest): Promise<ServerAnswer | null>;
  cancel(request: string): void;
}

interface Saved {
  readonly id: string;
  readonly address: string;
  used: number;
  /** The token of the login, when there is one. Never written as it is. */
  token: string | null;
}

const FILE_VERSION = 1;
const SESSION = `${SERVER_API_PREFIX}session`;
/** Headers of an answer that are not the page's: they are about the connection, or would set a login. */
const NOT_PASSED_ON = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'set-cookie',
  'set-cookie2',
  'transfer-encoding',
]);

/**
 * The origin of a server, from what was typed: `http` or `https`, a host,
 * perhaps a port, and nothing else. `127.0.0.1:4300` is taken as `http`.
 * Null for anything else. (The rule of the web client's `serverAddress`.)
 */
export function serverOrigin(typed: string): string | null {
  const text = typed.trim();
  if (text === '' || text.length > 2048) return null;
  const url = URL.parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  // No name and password in an address that is kept and shown.
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  return url.origin;
}

/** Whether what is sent to an address can be read on the way: `http` to another machine. */
export function isPlain(address: string): boolean {
  const url = new URL(address);
  const here = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  return url.protocol === 'http:' && !here;
}

function isSaved(
  value: unknown,
): value is { id: string; address: string; used: number; login?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const saved = value as Record<string, unknown>;
  return (
    isGrantId(saved['id']) &&
    typeof saved['address'] === 'string' &&
    serverOrigin(saved['address']) === saved['address'] &&
    typeof saved['used'] === 'number' &&
    (saved['login'] === undefined || typeof saved['login'] === 'string')
  );
}

export async function openConnections(options: ConnectionsOptions): Promise<Connections> {
  const {
    file,
    seal,
    approve,
    savedAtMost = 16,
    answerBytesAtMost = 1024 ** 3,
    now = Date.now,
  } = options;
  const saved = new Map<string, Saved>();
  /** The requests that have not been answered, by the name the page gave them. */
  const pending = new Map<string, AbortController>();

  if (file !== null) {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      const { version, connections } = (parsed ?? {}) as Record<string, unknown>;
      if (version === FILE_VERSION && Array.isArray(connections)) {
        for (const one of connections.filter(isSaved)) {
          // A login that cannot be opened (another user, another machine) is no login.
          const token = one.login === undefined ? null : (seal?.open(one.login) ?? null);
          saved.set(one.id, { id: one.id, address: one.address, used: one.used, token });
        }
      }
    } catch {
      // No file, or one that cannot be read: no connections yet.
    }
  }

  let writing: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    if (file === null) return Promise.resolve();
    writing = writing.then(async () => {
      const connections = [...saved.values()].map(({ id, address, used, token }) => {
        const login = token === null ? null : (seal?.seal(token) ?? null);
        return { id, address, used, ...(login === null ? {} : { login }) };
      });
      try {
        await mkdir(dirname(file), { recursive: true });
        const partial = `${file}.${randomBytes(6).toString('hex')}.part`;
        await writeFile(partial, JSON.stringify({ version: FILE_VERSION, connections }), {
          mode: 0o600,
        });
        await rename(partial, file);
      } catch {
        // Not written: the connection holds for this run.
      }
    });
    return writing;
  };

  const told = ({ id, address, token }: Saved): ServerConnection => ({
    id,
    address,
    loggedIn: token !== null,
  });

  const setToken = async (connection: Saved, token: string | null): Promise<void> => {
    if (connection.token === token) return;
    connection.token = token;
    await persist();
  };

  /** The answer's bytes, or null when there are more than are taken. */
  const bytesOf = async (response: Response): Promise<Uint8Array | null> => {
    if (Number(response.headers.get('content-length') ?? 0) > answerBytesAtMost) return null;
    if (response.body === null) return new Uint8Array(0);
    const pieces: Uint8Array[] = [];
    let length = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > answerBytesAtMost) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      pieces.push(value);
    }
    const whole = new Uint8Array(length);
    let at = 0;
    for (const piece of pieces) {
      whole.set(piece, at);
      at += piece.byteLength;
    }
    return whole;
  };

  return {
    async connect(typed) {
      const address = serverOrigin(typed);
      if (address === null) return null;
      let connection = [...saved.values()].find((one) => one.address === address);
      if (connection === undefined) {
        if (!(await approve(address, isPlain(address)))) return null;
        // Asked twice at once, and agreed to twice: still one connection.
        connection = [...saved.values()].find((one) => one.address === address);
      }
      if (connection === undefined) {
        const id = randomBytes(16).toString('base64url');
        connection = { id, address, used: now(), token: null };
        saved.set(id, connection);
        const oldest = [...saved.values()].sort((a, b) => a.used - b.used);
        for (const gone of oldest.slice(0, Math.max(0, saved.size - savedAtMost))) {
          saved.delete(gone.id);
        }
      }
      connection.used = now();
      await persist();
      return told(connection);
    },

    list: () => [...saved.values()].sort((a, b) => b.used - a.used).map(told),

    async forget(id) {
      if (saved.delete(id)) await persist();
    },

    async request(id, request) {
      const connection = saved.get(id);
      if (connection === undefined) return null;
      // Checked where it arrives as well as where it is served.
      if (!isServerRequest(request)) return null;
      const url = new URL(request.path, connection.address);
      if (url.origin !== connection.address || !url.pathname.startsWith(SERVER_API_PREFIX)) {
        return null;
      }
      // A login is asked for as nobody: a wrong password is then not taken
      // for a login the server no longer knows.
      const login = url.pathname === SESSION && request.method === 'POST';
      const sent = login ? null : connection.token;
      const headers: Record<string, string> = { ...request.headers };
      if (sent !== null) headers['authorization'] = `Bearer ${sent}`;
      const control = new AbortController();
      pending.set(request.request, control);
      try {
        let response: Response;
        let body: Uint8Array | null;
        try {
          response = await options.fetch(url, {
            method: request.method,
            headers,
            body: request.body === null ? undefined : new Uint8Array(request.body),
            // A server that sends the application elsewhere is not followed there with a login.
            redirect: 'error',
            signal: control.signal,
          });
          body = await bytesOf(response);
        } catch (error) {
          if (control.signal.aborted) return { failed: 'cancelled' };
          const said =
            error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : '';
          return { failed: /CERT|certificate|SSL|TLS/i.test(said) ? 'certificate' : 'unreachable' };
        }
        if (body === null) return { failed: 'too-large' };

        const answered: Record<string, string> = {};
        response.headers.forEach((text, name) => {
          if (!NOT_PASSED_ON.has(name.toLowerCase())) answered[name.toLowerCase()] = text;
        });

        // The login: its token is taken here and never passed on.
        if (url.pathname === SESSION) {
          if (request.method === 'DELETE') await setToken(connection, null);
          if (login && response.ok) {
            try {
              const said = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
              if (typeof said['token'] === 'string') {
                await setToken(connection, said['token']);
                body = new TextEncoder().encode(JSON.stringify({ ...said, token: HELD_LOGIN }));
              }
            } catch {
              // Not the answer of a login: passed on as it is.
            }
          }
        }
        // The server no longer knows the login that was sent: it is not kept.
        if (response.status === 401 && sent !== null && connection.token === sent) {
          await setToken(connection, null);
        }
        connection.used = now();
        return { status: response.status, headers: answered, body };
      } finally {
        pending.delete(request.request);
      }
    },

    cancel(request) {
      pending.get(request)?.abort();
    },
  };
}
