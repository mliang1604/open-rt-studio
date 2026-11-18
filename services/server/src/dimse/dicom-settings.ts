/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server's DICOM settings as they can be changed while it runs (#53):
// its own AE title and port, and the other systems it knows. They are kept
// in the data directory, so that a change outlives a restart.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isAeTitle } from './sop-classes.js';

/** How the server is reached by DICOM. */
export interface LocalDicom {
  /** Whether the server listens for DICOM associations. */
  readonly enabled: boolean;
  /** The port it listens on when it does. */
  readonly port: number;
  /** The AE title it is addressed by, and calls under. */
  readonly aeTitle: string;
}

/** Another system the server knows. */
export interface RemoteSystem {
  /** The server's own name for it, of no meaning, which a change keeps. */
  readonly id: string;
  /** What people call it. */
  readonly name: string;
  readonly aeTitle: string;
  /** Where it listens; null for a system that only calls this one. */
  readonly host: string | null;
  readonly port: number | null;
  /** Whether it may send objects here when it calls. */
  readonly mayStore: boolean;
  /**
   * Whether it may ask what the server holds and have it sent (C-FIND,
   * C-MOVE, C-GET) when it calls: all that the server holds.
   */
  readonly mayRetrieve: boolean;
}

export interface DicomSettings {
  readonly local: LocalDicom;
  readonly remotes: readonly RemoteSystem[];
}

/** What a remote system is made or changed from: everything but its id. */
export type RemoteInput = Omit<RemoteSystem, 'id'>;

export const REMOTES_AT_MOST = 200;
export const REMOTE_NAME_AT_MOST = 64;

/** A setting that is not what it has to be. The message says which, and repeats nothing given. */
export class DicomSettingsError extends Error {
  override readonly name = 'DicomSettingsError';
  constructor(
    readonly code:
      | 'invalid'
      | 'not-found'
      | 'ae-title-taken'
      | 'too-many'
      | 'port-unavailable'
      | 'no-address'
      | 'no-such-series'
      | 'nothing-to-send'
      | 'not-done',
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string): DicomSettingsError => new DicomSettingsError('invalid', message);

const isPort = (value: unknown, least: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= least && value <= 65535;

// One line of text: no control characters.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A host name, or an IPv4 or IPv6 address, and nothing that is not one of those. */
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:]{2,45})$/;

/** The local settings, checked. Throws {@link DicomSettingsError}. */
export function checkedLocal(value: unknown): LocalDicom {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('The local settings are an object.');
  }
  const { enabled, port, aeTitle, ...more } = value as Record<string, unknown>;
  if (Object.keys(more).length > 0) {
    throw invalid('The local settings are enabled, port and aeTitle, and nothing else.');
  }
  if (typeof enabled !== 'boolean') throw invalid('enabled is true or false.');
  if (!isPort(port, 0)) throw invalid('port is a whole number from 0 to 65535.');
  if (typeof aeTitle !== 'string' || !isAeTitle(aeTitle)) {
    throw invalid('aeTitle is 1 to 16 printable ASCII characters, with no backslash.');
  }
  return { enabled, port, aeTitle };
}

/** A remote system as it was given, checked. Throws {@link DicomSettingsError}. */
export function checkedRemote(value: unknown): RemoteInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('A remote system is an object.');
  }
  const {
    name,
    aeTitle,
    host,
    port,
    mayStore,
    // Left out by what was kept, or is sent, from before there was such a thing: it may not.
    mayRetrieve = false,
    ...more
  } = value as Record<string, unknown>;
  if (Object.keys(more).length > 0) {
    throw invalid(
      'A remote system is name, aeTitle, host, port, mayStore and mayRetrieve, and nothing else.',
    );
  }
  if (
    typeof name !== 'string' ||
    name === '' ||
    name !== name.trim() ||
    [...name].length > REMOTE_NAME_AT_MOST ||
    CONTROL.test(name)
  ) {
    throw invalid(
      `name is one line of 1 to ${REMOTE_NAME_AT_MOST} characters, with no space at either end.`,
    );
  }
  if (typeof aeTitle !== 'string' || !isAeTitle(aeTitle)) {
    throw invalid('aeTitle is 1 to 16 printable ASCII characters, with no backslash.');
  }
  if (host !== null && (typeof host !== 'string' || !HOST.test(host))) {
    throw invalid('host is a host name or an address, or null for a system that only calls.');
  }
  if (port !== null && !isPort(port, 1)) {
    throw invalid('port is a whole number from 1 to 65535, or null with a host of null.');
  }
  if ((host === null) !== (port === null)) {
    throw invalid('host and port are given together, or are both null.');
  }
  if (typeof mayStore !== 'boolean') throw invalid('mayStore is true or false.');
  if (typeof mayRetrieve !== 'boolean') throw invalid('mayRetrieve is true or false.');
  return { name, aeTitle, host, port, mayStore, mayRetrieve };
}

/** A new id for a remote system. */
export const newRemoteId = (): string => randomBytes(8).toString('hex');

/** Where the settings are kept between runs. */
export interface DicomSettingsStore {
  /** What was kept, or null when nothing was, or when what is there cannot be read. */
  read(): DicomSettings | null;
  write(settings: DicomSettings): void;
}

/** Settings kept for as long as the server runs: for a server with no data directory, and for tests. */
export function createMemorySettingsStore(
  initial: DicomSettings | null = null,
): DicomSettingsStore {
  let kept = initial;
  return {
    read: () => kept,
    write: (settings) => {
      kept = settings;
    },
  };
}

const ID = /^[0-9a-f]{16}$/;

/** The settings in a file's JSON, checked whole. Null for anything that is not them. */
export function settingsOf(json: unknown): DicomSettings | null {
  try {
    if (typeof json !== 'object' || json === null) return null;
    const { version, local, remotes } = json as Record<string, unknown>;
    if (version !== 1 || !Array.isArray(remotes) || remotes.length > REMOTES_AT_MOST) return null;
    const ids = new Set<string>();
    return {
      local: checkedLocal(local),
      remotes: (remotes as unknown[]).map((one) => {
        const { id, ...rest } = one as Record<string, unknown>;
        if (typeof id !== 'string' || !ID.test(id) || ids.has(id)) throw invalid('id');
        ids.add(id);
        return { id, ...checkedRemote(rest) };
      }),
    };
  } catch {
    return null;
  }
}

/**
 * Settings kept in a JSON file. It is written whole, beside itself and then
 * renamed, so a reader finds the old settings or the new ones.
 */
export function openFileSettingsStore(path: string): DicomSettingsStore {
  return {
    read() {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        return null;
      }
      try {
        return settingsOf(JSON.parse(text));
      } catch {
        return null;
      }
    },
    write(settings) {
      mkdirSync(dirname(path), { recursive: true });
      const beside = `${path}.${process.pid}.tmp`;
      const body = JSON.stringify({ version: 1, ...settings }, null, 2);
      writeFileSync(beside, `${body}\n`, { mode: 0o600 });
      renameSync(beside, path);
    },
  };
}
