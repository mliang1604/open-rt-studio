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
import { isUid } from '../uid.js';
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
import { ASK_LEVELS, AskError, checkedKeys, type AskKeys, type AskLevel } from './ask-keys.js';
import type { FindAnswer } from './ask.js';
import type { EchoResult } from './echo.js';
import type { DicomListener } from './listener.js';
import {
  createRetrieveManager,
  type RetrieveManager,
  type RetrieveRecord,
} from './retrieve-manager.js';
import { createSendManager, type SendManager, type SendRecord } from './send-manager.js';
import type { sendObjects } from './send.js';

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
  /** How long a send waits for the connection, the association and each answer. */
  readonly sendTimeoutMs?: number;
  /**
   * How long a retrieve may hear nothing from the system that is sending
   * before it is given up on.
   */
  readonly retrieveTimeoutMs?: number;
  /** How many instances a send puts on one association, for a test. */
  readonly sendInstancesAtOnce?: number;
  /** In place of the sender, for a test. */
  readonly sender?: typeof sendObjects;
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
  /** The systems that can be sent to: those with an address. */
  destinations(): Destination[];
  /**
   * Send a series, or one object of it, to a system. Answered at once with
   * the send's record, which {@link DicomService.sendOf} then follows.
   * Rejects with `not-found`, `no-address`, `no-such-series` or
   * `nothing-to-send`.
   */
  send(what: SendOf): Promise<SendRecord>;
  /** A send's record as it is now; null for one there is none of. */
  sendOf(id: string): SendRecord | null;
  /** The sends kept, the latest first. */
  sends(): SendRecord[];
  /**
   * Send again what did not arrive, as a send of its own. Null for a send
   * there is none of; rejects with `not-done`, `nothing-to-send`,
   * `not-found` or `no-address`.
   */
  retrySend(id: string): Promise<SendRecord | null>;
  /** The systems that can be asked what they hold: those with an address. */
  sources(): Source[];
  /**
   * Ask a system for the patients, studies or series that match (C-FIND).
   * What went wrong on the way is the answer's `outcome`; rejects with
   * `not-found`, `no-address` or `invalid`.
   */
  query(what: QueryOf): Promise<QueryAnswer>;
  /**
   * Have a system send a study, or a series of one, to this server
   * (C-MOVE). Answered at once with the retrieve's record, which
   * {@link DicomService.retrieveOf} then follows. Rejects with `not-found`,
   * `no-address`, `invalid`, `not-listening` (the objects would have nowhere
   * to arrive) or `may-not-store` (they would be refused).
   */
  retrieve(what: RetrieveOf): Promise<RetrieveRecord>;
  /** A retrieve's record as it is now; null for one there is none of. */
  retrieveOf(id: string): RetrieveRecord | null;
  /** The retrieves kept, the latest first. */
  retrieves(): RetrieveRecord[];
  /**
   * Close the listener, once the send and the retrieve under way have
   * ended. True when nothing had to be cut off.
   */
  close(): Promise<boolean>;
}

/** A system that can be asked what it holds. */
export interface Source {
  readonly id: string;
  readonly name: string;
  readonly aeTitle: string;
  /**
   * Whether a retrieve from it can arrive: the server listens, and lets
   * this system store.
   */
  readonly canRetrieve: boolean;
}

/** A question to another system. */
export interface QueryOf {
  /** The id of the system that is asked. */
  readonly source: string;
  /** `patient`, `study` or `series`. */
  readonly level: unknown;
  /** The keys of the level, as `checkedKeys` takes them. */
  readonly keys: unknown;
}

/** What another system answered, or why it did not. */
export type QueryAnswer = { readonly level: AskLevel } & FindAnswer<AskLevel>;

/** What to retrieve, and from where. */
export interface RetrieveOf {
  readonly source: string;
  readonly studyInstanceUid: string;
  /** One series; without, the whole study. */
  readonly seriesInstanceUid?: string;
}

/** A system that can be sent to. */
export interface Destination {
  readonly id: string;
  readonly name: string;
  readonly aeTitle: string;
}

/** What to send, and where. */
export interface SendOf {
  /** The id of the system it goes to. */
  readonly destination: string;
  /** The series to send; may be left out when one object is named. */
  readonly seriesInstanceUid?: string;
  /** One object; without, the whole of the series. */
  readonly sopInstanceUid?: string;
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
      retrievers: () => settings.remotes.filter((r) => r.mayRetrieve).map((r) => r.aeTitle),
      // A move goes to a system on the list that has an address, and to no other.
      destinationOf: (aeTitle) => {
        const there = settings.remotes.find((r) => r.aeTitle === aeTitle);
        return there?.host != null && there.port != null
          ? { host: there.host, port: there.port }
          : null;
      },
      ...(options.sendTimeoutMs === undefined ? {} : { moveTimeoutMs: options.sendTimeoutMs }),
      maxObjectBytes: options.maxObjectBytes,
      ...(options.logger ? { logger: options.logger } : {}),
    });
  };

  // Made by the first retrieve.
  let retrieving: RetrieveManager | null = null;
  const retrieveManager = (): RetrieveManager =>
    (retrieving ??= createRetrieveManager({
      index: options.pacs.index,
      ...(options.logger ? { logger: options.logger } : {}),
    }));

  // Made by the first send.
  let manager: SendManager | null = null;
  const sending = (): SendManager =>
    (manager ??= createSendManager({
      pacs: options.pacs,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.sendInstancesAtOnce === undefined
        ? {}
        : { instancesAtOnce: options.sendInstancesAtOnce }),
      ...(options.sender ? { send: options.sender } : {}),
    }));

  /** The system to send to, as it is now, with where it is. */
  const destinationOf = (id: string) => {
    const remote = settings.remotes.find((r) => r.id === id);
    if (!remote) throw new DicomSettingsError('not-found', 'The server knows no such system.');
    if (remote.host === null || remote.port === null) {
      throw new DicomSettingsError(
        'no-address',
        'That system has no address: it can call this server and cannot be called.',
      );
    }
    return {
      destination: { id: remote.id, name: remote.name, aeTitle: remote.aeTitle },
      target: {
        host: remote.host,
        port: remote.port,
        calledAeTitle: remote.aeTitle,
        callingAeTitle: settings.local.aeTitle,
        ...(options.sendTimeoutMs === undefined ? {} : { timeoutMs: options.sendTimeoutMs }),
      },
    };
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

    destinations: () =>
      settings.remotes
        .filter((r) => r.host !== null)
        .map((r) => ({ id: r.id, name: r.name, aeTitle: r.aeTitle })),

    async send(what) {
      const to = destinationOf(what.destination);
      const { index } = options.pacs;
      // One object says which series it is of, when the request does not.
      const seriesUid =
        what.seriesInstanceUid ??
        (what.sopInstanceUid === undefined
          ? undefined
          : (await index.getInstance(what.sopInstanceUid))?.seriesInstanceUid);
      const series = seriesUid === undefined ? null : await index.getSeries(seriesUid);
      if (!series) {
        throw new DicomSettingsError(
          'no-such-series',
          what.seriesInstanceUid === undefined
            ? 'The server has no such object.'
            : 'The server has no such series.',
        );
      }
      const sopInstanceUids: string[] = [];
      for (let offset = 0; ; offset += 500) {
        const part = await index.findInstances({
          seriesInstanceUid: series.seriesInstanceUid,
          ...(what.sopInstanceUid === undefined ? {} : { sopInstanceUid: what.sopInstanceUid }),
          limit: 500,
          offset,
        });
        sopInstanceUids.push(...part.map((instance) => instance.sopInstanceUid));
        if (part.length < 500) break;
      }
      if (sopInstanceUids.length === 0) {
        throw new DicomSettingsError(
          'nothing-to-send',
          'The series holds no such object: there is nothing to send.',
        );
      }
      return sending().start({
        ...to,
        studyInstanceUid: series.studyInstanceUid,
        seriesInstanceUid: series.seriesInstanceUid,
        sopInstanceUids,
      });
    },

    sendOf: (id) => manager?.get(id) ?? null,
    sends: () => manager?.list() ?? [],

    async retrySend(id) {
      const before = manager?.get(id);
      const failed = manager?.failed(id);
      if (!before || !failed) return null;
      if (before.state !== 'done') {
        throw new DicomSettingsError('not-done', 'That send is not done yet.');
      }
      if (failed.length === 0) {
        throw new DicomSettingsError(
          'nothing-to-send',
          'Every instance of that send arrived: there is nothing to send again.',
        );
      }
      // To the system as it is now: its address may be what was put right.
      return sending().start({
        ...destinationOf(before.destination.id),
        studyInstanceUid: before.studyInstanceUid,
        seriesInstanceUid: before.seriesInstanceUid,
        sopInstanceUids: failed,
        retryOf: before.id,
      });
    },

    sources: () =>
      settings.remotes
        .filter((r) => r.host !== null)
        .map((r) => ({
          id: r.id,
          name: r.name,
          aeTitle: r.aeTitle,
          canRetrieve: listener !== null && r.mayStore,
        })),

    async query(what) {
      const { target } = destinationOf(what.source);
      const level = ASK_LEVELS.find((one) => one === what.level);
      if (!level) {
        throw new DicomSettingsError('invalid', `level is one of ${ASK_LEVELS.join(', ')}.`);
      }
      let keys: AskKeys;
      try {
        keys = checkedKeys(level, what.keys ?? {});
      } catch (error) {
        if (error instanceof AskError) throw new DicomSettingsError('invalid', error.message);
        throw error;
      }
      const started = Date.now();
      const { findAt } = await import('./ask.js');
      const answer = await findAt(target, level, keys);
      logger.info('dicom-query', {
        level,
        outcome: answer.outcome,
        matches: answer.outcome === 'answered' ? answer.matches.length : 0,
        ms: Date.now() - started,
      });
      return { level, ...answer };
    },

    async retrieve(what) {
      const from = destinationOf(what.source);
      if (
        !isUid(what.studyInstanceUid) ||
        (what.seriesInstanceUid !== undefined && !isUid(what.seriesInstanceUid))
      ) {
        throw new DicomSettingsError('invalid', 'A study and a series are named by their UIDs.');
      }
      // The objects come to the listener, from the system that is asked.
      if (listener === null) {
        throw new DicomSettingsError(
          'not-listening',
          'The server does not listen for DICOM: what is retrieved would have nowhere to arrive.',
        );
      }
      if (!settings.remotes.find((r) => r.id === what.source)?.mayStore) {
        throw new DicomSettingsError(
          'may-not-store',
          'That system may not send objects here: what it sent would be refused.',
        );
      }
      const { host, port, calledAeTitle, callingAeTitle } = from.target;
      return retrieveManager().start({
        source: from.destination,
        target: {
          ...{ host, port, calledAeTitle, callingAeTitle },
          // How long it may hear nothing, which is longer than an answer may take.
          ...(options.retrieveTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.retrieveTimeoutMs }),
        },
        destinationAeTitle: settings.local.aeTitle,
        what: {
          studyInstanceUid: what.studyInstanceUid,
          ...(what.seriesInstanceUid === undefined
            ? {}
            : { seriesInstanceUid: what.seriesInstanceUid }),
        },
      });
    },

    retrieveOf: (id) => retrieving?.get(id) ?? null,
    retrieves: () => retrieving?.list() ?? [],

    async close() {
      // The send and the retrieve under way end the associations they are
      // on, as far as the time allows; a retrieve's objects arrive at the
      // listener, which is closed after.
      let late: NodeJS.Timeout | undefined;
      const ended =
        manager === null && retrieving === null
          ? true
          : await Promise.race([
              Promise.all([manager?.close(), retrieving?.close()]).then(() => true),
              new Promise<boolean>((resolve) => {
                late = setTimeout(() => resolve(false), closeTimeoutMs);
                late.unref();
              }),
            ]);
      clearTimeout(late);
      const released = await inTurn(async () => {
        const old = listener;
        listener = null;
        return old ? old.close({ timeoutMs: closeTimeoutMs }) : true;
      });
      return ended && released;
    },
  };
}
