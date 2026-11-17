/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server's DICOM side as one thing that can be changed while it runs
// (#53): the settings, the listener they ask for, and an echo to a system
// they name. A change is kept and takes effect at once: the calling AE
// titles and the server's own are asked for at each association, and a new
// port or a switch on or off opens and closes the listener.
//
// The DIMSE library is loaded only when it is needed: by a server that
// listens, or that is asked for an echo.

import type { Pacs } from '../core/core.js';
import { errorFields, SILENT_LOGGER, type Logger } from '../logger.js';
import {
  checkedLocal,
  checkedRemote,
  DicomSettingsError,
  newRemoteId,
  REMOTES_AT_MOST,
  type DicomSettings,
  type DicomSettingsStore,
  type LocalDicom,
  type RemoteSystem,
} from './dicom-settings.js';
import type { EchoResult } from './echo.js';
import type { DicomListener } from './listener.js';

export interface DicomServiceOptions {
  readonly pacs: Pacs;
  /** The address the listener is on: the server's own. */
  readonly host: string;
  /**
   * Whether that address is reached from other machines. DICOM has no login,
   * so the log says so each time a listener opens there.
   */
  readonly exposed?: boolean;
  /** The largest object taken, in bytes. */
  readonly maxObjectBytes: number;
  /** Where the settings are kept between runs. */
  readonly store: DicomSettingsStore;
  /** The settings of a server that has kept none: what its configuration says. */
  readonly defaults: DicomSettings;
  /** How long open associations are given when the listener closes. */
  readonly closeTimeoutMs?: number;
  /** How long an echo waits. */
  readonly echoTimeoutMs?: number;
  readonly logger?: Logger;
}

/** The settings, and what the listener is doing. */
export interface DicomState extends DicomSettings {
  /** Where the listener is, or null when the server is not listening for DICOM. */
  readonly listening: { readonly host: string; readonly port: number } | null;
}

export interface DicomService {
  /** Open the listener if the settings ask for one. Rejects when its port cannot be had. */
  start(): Promise<void>;
  state(): DicomState;
  /**
   * Change how the server is reached. A new port is opened before the old
   * one is closed: when it cannot be had, nothing changes and this rejects
   * with `port-unavailable`.
   */
  setLocal(local: unknown): Promise<DicomState>;
  addRemote(remote: unknown): Promise<RemoteSystem>;
  /** Rejects with `not-found` for an id that is no system's. */
  changeRemote(id: string, remote: unknown): Promise<RemoteSystem>;
  /** False when there was no such system. */
  removeRemote(id: string): Promise<boolean>;
  /** C-ECHO to a system, under the server's AE title. Rejects with `not-found` or `no-address`. */
  echo(id: string): Promise<EchoResult>;
  /** Close the listener. True when no association had to be cut off. */
  close(): Promise<boolean>;
}

export function createDicomService(options: DicomServiceOptions): DicomService {
  const logger = (options.logger ?? SILENT_LOGGER).child({ part: 'dicom' });
  const kept = options.store.read();
  if (kept) logger.info('dicom-settings-kept', { remotes: kept.remotes.length });
  let settings: DicomSettings = kept ?? options.defaults;
  let listener: DicomListener | null = null;
  const closeTimeoutMs = options.closeTimeoutMs ?? 10_000;

  const open = async (port: number): Promise<DicomListener> => {
    const { startDicomListener } = await import('./listener.js');
    // DICOM has no login, and an AE title is not a proof of who calls.
    if (options.exposed) logger.warn('dicom-without-login', { host: options.host });
    return startDicomListener({
      pacs: options.pacs,
      host: options.host,
      port,
      // Asked for at each association: a change needs no new listener.
      aeTitle: () => settings.local.aeTitle,
      callers: () => settings.remotes.filter((r) => r.mayStore).map((r) => r.aeTitle),
      maxObjectBytes: options.maxObjectBytes,
      ...(options.logger ? { logger: options.logger } : {}),
    });
  };

  // One change at a time: each waits for the one before it.
  let last: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const turn = last.then(work, work);
    last = turn.catch(() => undefined);
    return turn;
  };

  const keep = (next: DicomSettings): void => {
    options.store.write(next);
    settings = next;
  };

  const state = (): DicomState => ({
    local: settings.local,
    remotes: settings.remotes,
    listening: listener ? { host: listener.host, port: listener.port } : null,
  });

  /** Refuse a remote whose AE title another system has. */
  const unique = (aeTitle: string, but?: string): void => {
    if (settings.remotes.some((r) => r.aeTitle === aeTitle && r.id !== but)) {
      throw new DicomSettingsError('ae-title-taken', 'Another system has that AE title.');
    }
  };

  return {
    start: () =>
      inTurn(async () => {
        if (settings.local.enabled && !listener) listener = await open(settings.local.port);
      }),

    state,

    setLocal: (given) =>
      inTurn(async () => {
        const local: LocalDicom = checkedLocal(given);
        // The port it has may be one it was given as 0, and is asked for by number.
        const samePlace =
          listener !== null &&
          local.enabled &&
          (local.port === settings.local.port || local.port === listener.port);
        if (!samePlace) {
          let next: DicomListener | null = null;
          if (local.enabled) {
            try {
              // The settings are not yet the new ones: the listener asks for
              // them at each association, and none comes before they are.
              next = await open(local.port);
            } catch (error) {
              logger.warn('dicom-port-unavailable', errorFields(error));
              throw new DicomSettingsError(
                'port-unavailable',
                'The server cannot listen on that port. Nothing was changed.',
              );
            }
          }
          const old = listener;
          listener = next;
          if (old) void old.close({ timeoutMs: closeTimeoutMs });
        }
        keep({ ...settings, local });
        logger.info('dicom-local-changed', { enabled: local.enabled });
        return state();
      }),

    addRemote: (given) =>
      inTurn(async () => {
        const input = checkedRemote(given);
        if (settings.remotes.length >= REMOTES_AT_MOST) {
          throw new DicomSettingsError(
            'too-many',
            `The server knows at most ${REMOTES_AT_MOST} systems.`,
          );
        }
        unique(input.aeTitle);
        const remote: RemoteSystem = { id: newRemoteId(), ...input };
        keep({ ...settings, remotes: [...settings.remotes, remote] });
        logger.info('dicom-remote-added', { remotes: settings.remotes.length });
        return remote;
      }),

    changeRemote: (id, given) =>
      inTurn(async () => {
        const input = checkedRemote(given);
        if (!settings.remotes.some((r) => r.id === id)) {
          throw new DicomSettingsError('not-found', 'The server knows no such system.');
        }
        unique(input.aeTitle, id);
        const remote: RemoteSystem = { id, ...input };
        keep({ ...settings, remotes: settings.remotes.map((r) => (r.id === id ? remote : r)) });
        logger.info('dicom-remote-changed');
        return remote;
      }),

    removeRemote: (id) =>
      inTurn(async () => {
        if (!settings.remotes.some((r) => r.id === id)) return false;
        keep({ ...settings, remotes: settings.remotes.filter((r) => r.id !== id) });
        logger.info('dicom-remote-removed', { remotes: settings.remotes.length });
        return true;
      }),

    async echo(id) {
      const remote = settings.remotes.find((r) => r.id === id);
      if (!remote) throw new DicomSettingsError('not-found', 'The server knows no such system.');
      if (remote.host === null || remote.port === null) {
        throw new DicomSettingsError(
          'no-address',
          'That system has no address: it can call this server and cannot be called.',
        );
      }
      const { dicomEcho } = await import('./echo.js');
      const result = await dicomEcho({
        host: remote.host,
        port: remote.port,
        calledAeTitle: remote.aeTitle,
        callingAeTitle: settings.local.aeTitle,
        ...(options.echoTimeoutMs === undefined ? {} : { timeoutMs: options.echoTimeoutMs }),
      });
      logger.info('dicom-echo', { outcome: result.outcome });
      return result;
    },

    close: () =>
      inTurn(async () => {
        const old = listener;
        listener = null;
        return old ? old.close({ timeoutMs: closeTimeoutMs }) : true;
      }),
  };
}
