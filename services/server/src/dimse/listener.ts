/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server's DICOM listener: other systems verify that it is there
// (C-ECHO) and send it objects (C-STORE), which go through the ingest like
// anything uploaded; and those that may ask it what it holds (C-FIND) and
// have it sent to a system the server knows (C-MOVE) or back to them
// (C-GET).
//
// The listener is Node's own, bound where the configuration says; each
// connection is handed to the library's protocol class (see
// docs/dimse-library.md for why not the library's server).
//
// DIMSE has no login. Who may send, and who may query and retrieve, is
// decided by the AE title the caller gives, which is a name and not a
// proof: anyone who can reach the port and knows a name on a list can do
// what the list allows, and a name that may retrieve reads everything the
// server holds. So the port is off unless it is asked for, each list is
// empty unless it is filled, and the address is the server's own, which is
// this machine alone by default.
//
// Logs: AE titles are names of systems and are logged. Nothing of an object
// is: not a UID, not a name, only what came of it.

import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { Writable } from 'node:stream';

import { readInstanceHeader } from '@open-rt-studio/dicom';

import { CoreStoppingError, type Pacs } from '../core/core.js';
import type { IngestResult } from '../ingest/ingest.js';
import { errorFields, SILENT_LOGGER, type Logger } from '../logger.js';
import { askedOf, NO_DICOM_AUDIT, type DicomAudit } from './dicom-audit.js';
import {
  CEchoResponse,
  CFindResponse,
  CGetResponse,
  CMoveResponse,
  CStoreRequest,
  CStoreResponse,
  Dataset,
  PresentationContextResult,
  RejectReason,
  RejectResult,
  RejectSource,
  Scp,
  storedDataset,
  type LibraryAssociation,
  type LibraryDataset,
  type LibraryEchoRequest,
  type LibraryEchoResponse,
  type LibraryFindRequest,
  type LibraryFindResponse,
  type LibraryGetRequest,
  type LibraryGetResponse,
  type LibraryMoveRequest,
  type LibraryMoveResponse,
  type LibraryPresentationContext,
  type LibraryStoreRequest,
  type LibraryStoreResponse,
} from './library.js';
import { dataSetOf, part10, type OutgoingObject, type ReceivedDataSet } from './part10.js';
import { BYTES_AT_ONCE, INSTANCES_AT_ONCE, type PartLimits } from './parts.js';
import {
  FIND_MATCHES_AT_MOST,
  IdentifierError,
  RETRIEVE_INSTANCES_AT_MOST,
  findMatches,
  retrieveInstances,
  type Identifier,
} from './query.js';
import {
  RETRIEVE_STATUS,
  moved,
  retrieveStatus,
  runRetrieve,
  type PartSender,
  type RetrieveCounts,
  type SubOperation,
} from './retrieve.js';
import { STORE_WARNINGS, sendObjects, uncompressed } from './send.js';
import {
  chooseTransferSyntax,
  EXPLICIT_VR_LE,
  IMPLICIT_VR_LE,
  QUERY_RETRIEVE_SOP_CLASSES,
  STORAGE_SOP_CLASSES,
  VERIFICATION,
} from './sop-classes.js';

/** The DIMSE statuses the listener answers a C-STORE with (PS3.4 B.2.3, PS3.7 annex C). */
export const STORE_STATUS = {
  success: 0x0000,
  /** Refused: out of resources. The object is larger than the server takes, or the server is stopping. */
  outOfResources: 0xa700,
  /** The data set is not the object the request says it is. */
  dataSetMismatch: 0xa900,
  /** The data set cannot be read as a DICOM object, or lacks what an object must have. */
  cannotUnderstand: 0xc000,
  /** The PACS holds other bytes under this SOP Instance UID. */
  duplicate: 0x0111,
  /** The object places something the PACS knows somewhere else, or the PACS failed. */
  processingFailure: 0x0110,
  /** The caller may retrieve from the server, and may not store to it. */
  notAuthorized: 0x0124,
} as const;

/** The statuses a C-FIND is answered with (PS3.4, C.4.1.1.4). */
export const FIND_STATUS = {
  success: 0x0000,
  pending: 0xff00,
  /** A match, of a question with a key that is not answered. */
  pendingKeysLeftOut: 0xff01,
  /** Out of resources: there were more matches than are answered. */
  tooMany: 0xa700,
  identifierMismatch: 0xa900,
  unableToProcess: 0xc000,
} as const;

/** How many associations are open at once before a new connection is closed unanswered. */
export const ASSOCIATIONS_AT_MOST = 32;

/**
 * How long a connection may say nothing, and be told nothing, before it is
 * closed (it is looked at this often, so it goes after between one and two
 * of these): so that connections left open do not use up the associations
 * there may be.
 */
export const IDLE_TIMEOUT_MS = 120_000;

export interface DicomListenerOptions {
  /** The store, the index and the way in. */
  readonly pacs: Pacs;
  /** The address to listen on. */
  readonly host: string;
  /** The port; 0 lets the operating system choose. */
  readonly port: number;
  /**
   * The AE title callers must address. A function is asked at each
   * association, so the title can change while the listener runs.
   */
  readonly aeTitle: string | (() => string);
  /**
   * The calling AE titles that may store objects here. An empty list lets
   * nobody store. A function is asked at each association.
   */
  readonly callers: readonly string[] | (() => readonly string[]);
  /**
   * The calling AE titles that may query the server and retrieve from it:
   * all that it holds. Nobody, unless it is given.
   */
  readonly retrievers?: readonly string[] | (() => readonly string[]);
  /**
   * Where the system of an AE title listens, for a C-MOVE to it; null for
   * one the server does not know, or knows no address of. Without it no
   * move has a destination.
   */
  readonly destinationOf?: (aeTitle: string) => { host: string; port: number } | null;
  /** How long an association to a move's destination may take over each step. */
  readonly moveTimeoutMs?: number;
  /** In place of the bounds of a retrieve and of a query's answer, for a test. */
  readonly retrieveLimits?: Partial<PartLimits>;
  readonly findAtMost?: number;
  readonly retrieveAtMost?: number;
  /**
   * Where the audit records go (#212): of each object received, each query
   * and retrieve answered, and each association refused. When a record of
   * what is about to leave cannot be written, it does not leave.
   */
  readonly audit?: DicomAudit;
  /** The largest object taken, in bytes: the data set as it arrives. */
  readonly maxObjectBytes: number;
  /**
   * The transfer syntaxes taken, the one it would rather have first. All
   * that the server stores, unless a test stands in for a system that takes
   * fewer.
   */
  readonly transferSyntaxes?: readonly string[];
  /** In place of {@link IDLE_TIMEOUT_MS}, for a test. */
  readonly idleTimeoutMs?: number;
  readonly logger?: Logger;
}

export interface DicomListener {
  readonly host: string;
  readonly port: number;
  /**
   * Stop: no new associations, and the open ones are given `timeoutMs` to
   * end before they are cut off. True when none had to be.
   */
  close(options?: { readonly timeoutMs?: number }): Promise<boolean>;
}

/** The bytes of one object as they arrive, up to a limit. Past it they are dropped. */
class Gathered extends Writable {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  tooLarge = false;

  constructor(
    readonly transferSyntax: string,
    private readonly limit: number,
  ) {
    super();
  }

  override _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.size += chunk.length;
    if (this.size > this.limit) {
      this.tooLarge = true;
      this.chunks.length = 0;
    } else {
      this.chunks.push(Buffer.from(chunk));
    }
    done();
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** The status a C-STORE is answered with for what the ingest made of the object. */
export function storeStatus(result: IngestResult): number {
  if (result.outcome !== 'refused') return STORE_STATUS.success;
  switch (result.reason) {
    case 'not-dicom':
    case 'incomplete':
      return STORE_STATUS.cannotUnderstand;
    case 'different-content':
      return STORE_STATUS.duplicate;
    default:
      return STORE_STATUS.processingFailure;
  }
}

/** What came of taking a received object, and whose it is where it could be read. */
export interface TakenObject {
  readonly status: number;
  readonly outcome: IngestResult['outcome'] | 'mismatch';
  /** Why the PACS refused it, when it did. */
  readonly reason?: string;
  readonly of: {
    readonly patientId: string | null;
    readonly studyUid: string;
    readonly seriesUid: string;
  } | null;
}

/** An AE title as another system wrote it, for a record: what can be printed of it. */
const printable = (aeTitle: string): string => aeTitle.replace(/[^\x20-\x7e]/g, '?').slice(0, 16);

async function bytesOf(pacs: Pacs, sopInstanceUid: string): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for await (const piece of await pacs.store.get(sopInstanceUid)) pieces.push(piece as Buffer);
  return Buffer.concat(pieces);
}

/**
 * Take a received object into the PACS and say what status to answer.
 *
 * The file kept is the data set behind a header of ours, so the same object
 * uploaded as a file and then sent here differs in its header and not in
 * its data set. That is the same object: when the PACS holds the UID with
 * this data set in this transfer syntax, nothing is written and the answer
 * is success.
 */
export async function takeObject(pacs: Pacs, object: ReceivedDataSet): Promise<TakenObject> {
  const file = part10(object);
  const header = readInstanceHeader(file);
  const of = header.ok
    ? {
        patientId: header.header.patient.id || null,
        studyUid: header.header.study.uid,
        seriesUid: header.header.series.uid,
      }
    : null;
  if (
    header.ok &&
    (header.header.sopInstanceUid !== object.sopInstanceUid ||
      header.header.sopClassUid !== object.sopClassUid)
  ) {
    return { status: STORE_STATUS.dataSetMismatch, outcome: 'mismatch', of };
  }
  const held = await pacs.store.stat(object.sopInstanceUid);
  if (held) {
    const kept = await bytesOf(pacs, object.sopInstanceUid);
    const keptHeader = readInstanceHeader(kept);
    const keptSyntax = keptHeader.ok ? keptHeader.header.transferSyntaxUid : null;
    const keptDataSet = dataSetOf(kept);
    if (
      keptDataSet &&
      (keptSyntax ?? IMPLICIT_VR_LE) === object.transferSyntax &&
      Buffer.from(keptDataSet).equals(Buffer.from(object.dataSet))
    ) {
      return { status: STORE_STATUS.success, outcome: 'unchanged', of };
    }
  }
  const result = await pacs.ingest.ingest(file);
  return {
    status: storeStatus(result),
    outcome: result.outcome,
    of,
    ...(result.outcome === 'refused' ? { reason: result.reason } : {}),
  };
}

/** Start listening for DICOM associations. Rejects when the port cannot be had. */
export async function startDicomListener(options: DicomListenerOptions): Promise<DicomListener> {
  const logger = (options.logger ?? SILENT_LOGGER).child({ part: 'dicom' });
  const { pacs, maxObjectBytes } = options;
  const audit = options.audit ?? NO_DICOM_AUDIT;
  const aeTitle = (): string =>
    typeof options.aeTitle === 'function' ? options.aeTitle() : options.aeTitle;
  const callers = (): readonly string[] =>
    typeof options.callers === 'function' ? options.callers() : options.callers;
  const retrievers = (): readonly string[] =>
    typeof options.retrievers === 'function' ? options.retrievers() : (options.retrievers ?? []);
  const limits: PartLimits = {
    instancesAtOnce: options.retrieveLimits?.instancesAtOnce ?? INSTANCES_AT_ONCE,
    bytesAtOnce: options.retrieveLimits?.bytesAtOnce ?? BYTES_AT_ONCE,
  };
  const sockets = new Set<Socket>();
  let closing = false;
  /** One retrieve at a time, whatever the associations: each holds a part in memory. */
  let turn: Promise<void> = Promise.resolve();

  class Association extends Scp {
    private calling = '';
    private mayStore = false;
    private mayRetrieve = false;
    /** The kinds of object the caller takes back on this association, for a C-GET. */
    private readonly takenBack = new Set<string>();
    private incoming: Gathered | null = null;
    private stored = 0;
    private refused = 0;
    private queries = 0;
    private retrieves = 0;
    /** True while a retrieve waits its turn or sends to a third system: no byte passes here then. */
    busy = false;
    private cancelRequested = false;
    private gone = false;
    private whenGone: (() => void) | null = null;

    /** The connection has ended: what waits on it waits no longer. */
    ended(): void {
      this.gone = true;
      this.whenGone?.();
    }

    /** The transfer syntax that was agreed for the context a request came on. */
    private syntaxOf(request: LibraryFindRequest | LibraryMoveRequest | LibraryGetRequest): string {
      const association = (this as unknown as { association: LibraryAssociation }).association;
      return (
        association
          .getAcceptedPresentationContextFromRequest(request)
          ?.getAcceptedTransferSyntaxUid() ?? IMPLICIT_VR_LE
      );
    }

    override associationRequested(association: LibraryAssociation): void {
      this.calling = association.getCallingAeTitle().trim();
      const called = association.getCalledAeTitle().trim();
      const reject = (reason: number, why: string): void => {
        // Who it was is the audit log's to say, not this log's.
        logger.warn('association-rejected', { why });
        audit({
          action: 'dicom-association',
          outcome: 'refused',
          aeTitle: printable(this.calling),
          detail:
            why === 'called-ae'
              ? 'called by an AE title that is not this server’s'
              : 'not among the systems that are let in',
        });
        this.sendAssociationReject(RejectResult.Permanent, RejectSource.ServiceUser, reason);
      };
      if (called !== aeTitle()) return reject(RejectReason.CalledAeNotRecognized, 'called-ae');
      this.mayStore = callers().includes(this.calling);
      this.mayRetrieve = retrievers().includes(this.calling);
      if (!this.mayStore && !this.mayRetrieve) {
        return reject(RejectReason.CallingAeNotRecognized, 'calling-ae');
      }
      for (const proposed of association.getPresentationContexts()) {
        const context = association.getPresentationContext(proposed.id);
        const abstract = context.getAbstractSyntaxUid();
        const offered = context.getTransferSyntaxUids();
        const storage = abstract in STORAGE_SOP_CLASSES;
        // A caller that says it will take a kind of object (the SCP role) is
        // sent it by a C-GET, if it may retrieve.
        const back = storage && this.mayRetrieve && context.getProviderRole() === true;
        const queryRetrieve = abstract in QUERY_RETRIEVE_SOP_CLASSES;
        if (
          !(abstract === VERIFICATION) &&
          !(storage && (this.mayStore || back)) &&
          !(queryRetrieve && this.mayRetrieve)
        ) {
          context.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
          continue;
        }
        // An identifier is written by the library, which writes these two.
        const syntax = queryRetrieve
          ? ([EXPLICIT_VR_LE, IMPLICIT_VR_LE].find((one) => offered.includes(one)) ?? null)
          : options.transferSyntaxes
            ? (options.transferSyntaxes.find((one) => offered.includes(one)) ?? null)
            : chooseTransferSyntax(offered);
        if (syntax) context.setResult(PresentationContextResult.Accept, syntax);
        else context.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
        if (syntax && back) this.takenBack.add(abstract);
      }
      logger.info('association-accepted', {
        mayStore: this.mayStore,
        mayRetrieve: this.mayRetrieve,
      });
      this.sendAssociationAccept();
    }

    override createStoreWritableStream(context: LibraryPresentationContext): Writable {
      // From a caller that may not store, nothing is kept while it arrives.
      this.incoming = new Gathered(
        context.getAcceptedTransferSyntaxUid() ?? IMPLICIT_VR_LE,
        this.mayStore ? maxObjectBytes : 0,
      );
      return this.incoming;
    }

    override createDatasetFromStoreWritableStream(
      _writable: Writable,
      context: LibraryPresentationContext,
      callback: (dataset: LibraryDataset) => void,
    ): void {
      // The library is handed an empty data set, so it parses nothing: the
      // bytes are kept as they came (see docs/dimse-library.md).
      callback(new Dataset({}, context.getAcceptedTransferSyntaxUid() ?? IMPLICIT_VR_LE));
    }

    override cEchoRequest(
      request: LibraryEchoRequest,
      callback: (response: LibraryEchoResponse) => void,
    ): void {
      const response = CEchoResponse.fromRequest(request);
      response.setStatus(STORE_STATUS.success);
      callback(response);
    }

    override cStoreRequest(
      request: LibraryStoreRequest,
      callback: (response: LibraryStoreResponse) => void,
    ): void {
      const incoming = this.incoming;
      this.incoming = null;
      const answer = (given: number, how: string, taken?: TakenObject): void => {
        let [status, outcome] = [given, how];
        const recorded = audit({
          action: 'dicom-store',
          outcome:
            status === STORE_STATUS.success
              ? 'ok'
              : outcome === 'not-allowed'
                ? 'refused'
                : outcome === 'failed' || outcome === 'stopping'
                  ? 'failed'
                  : 'rejected',
          aeTitle: printable(this.calling),
          patientId: taken?.of?.patientId ?? null,
          studyUid: taken?.of?.studyUid ?? null,
          seriesUid: taken?.of?.seriesUid ?? null,
          // The instances of a series, stored one after another, are one record.
          detail: outcome === 'stored' ? null : (taken?.reason ?? outcome),
        });
        // It is here, and there is no record of who sent it: the caller is
        // told that it failed, and what it sends again is the same object.
        if (!recorded && status === STORE_STATUS.success) {
          [status, outcome] = [STORE_STATUS.processingFailure, 'unrecorded'];
        }
        if (status === STORE_STATUS.success) this.stored++;
        else this.refused++;
        logger.info('object-received', { outcome, status });
        const response = CStoreResponse.fromRequest(request);
        response.setStatus(status);
        callback(response);
      };
      if (!this.mayStore) return answer(STORE_STATUS.notAuthorized, 'not-allowed');
      if (!incoming) return answer(STORE_STATUS.cannotUnderstand, 'no-data-set');
      if (incoming.tooLarge) return answer(STORE_STATUS.outOfResources, 'too-large');
      takeObject(pacs, {
        sopClassUid: request.getAffectedSopClassUid(),
        sopInstanceUid: request.getAffectedSopInstanceUid(),
        transferSyntax: incoming.transferSyntax,
        sourceAeTitle: this.calling,
        dataSet: incoming.bytes(),
      }).then(
        (taken) => answer(taken.status, taken.outcome, taken),
        (error: unknown) => {
          if (error instanceof CoreStoppingError) {
            return answer(STORE_STATUS.outOfResources, 'stopping');
          }
          logger.error('object-failed', errorFields(error));
          return answer(STORE_STATUS.processingFailure, 'failed');
        },
      );
    }

    override cFindRequest(
      request: LibraryFindRequest,
      callback: (responses: LibraryFindResponse[]) => void,
    ): void {
      const started = Date.now();
      const sopClass = request.getAffectedSopClassUid();
      const kind = QUERY_RETRIEVE_SOP_CLASSES[sopClass];
      // The library's response says it is of the study root, whatever was asked.
      const response = (status: number): LibraryFindResponse => {
        const one = CFindResponse.fromRequest(request);
        one.setAffectedSopClassUid(sopClass);
        one.setStatus(status);
        return one;
      };
      const asked = askedOf(identifierOf(request));
      const end = (given: number, how: string, found: LibraryFindResponse[] = []): void => {
        let [status, outcome, matches] = [given, how, found];
        const recorded = audit({
          action: 'dicom-find',
          outcome:
            outcome === 'answered' || outcome === 'too-many'
              ? 'ok'
              : outcome === 'not-allowed'
                ? 'refused'
                : outcome === 'identifier'
                  ? 'rejected'
                  : 'failed',
          aeTitle: printable(this.calling),
          patientId: asked.patientId,
          studyUid: asked.studyUid,
          seriesUid: asked.seriesUid,
          detail: [
            `${(asked.level ?? 'no level').toLowerCase()}: ${matches.length} matches`,
            ...(outcome === 'too-many' ? ['not all'] : []),
            ...(asked.keys ? [asked.keys] : []),
          ].join(', '),
        });
        // Nothing of what the server holds is told without a record of who asked.
        if (!recorded) [status, outcome, matches] = [FIND_STATUS.unableToProcess, 'unrecorded', []];
        this.queries++;
        logger.info('query-answered', {
          outcome,
          status,
          matches: matches.length,
          ms: Date.now() - started,
        });
        callback([...matches, response(status)]);
      };
      if (!this.mayRetrieve || kind?.service !== 'find') {
        return end(FIND_STATUS.unableToProcess, 'not-allowed');
      }
      const syntax = this.syntaxOf(request);
      findMatches(
        pacs.index,
        kind.root,
        identifierOf(request),
        aeTitle(),
        options.findAtMost ?? FIND_MATCHES_AT_MOST,
      ).then(
        (answer) => {
          const pending = answer.keysLeftOut ? FIND_STATUS.pendingKeysLeftOut : FIND_STATUS.pending;
          const matches = answer.matches.map((match) => {
            const one = response(pending);
            one.setDataset(new Dataset(match, syntax));
            return one;
          });
          if (answer.more) end(FIND_STATUS.tooMany, 'too-many', matches);
          else end(FIND_STATUS.success, 'answered', matches);
        },
        (error: unknown) => {
          if (error instanceof IdentifierError) {
            return end(FIND_STATUS.identifierMismatch, 'identifier');
          }
          logger.error('query-failed', errorFields(error));
          return end(FIND_STATUS.unableToProcess, 'failed');
        },
      );
    }

    /**
     * A C-MOVE or a C-GET: the instances the identifier names go out a few
     * at a time, with the counts told after each part, and the last answer
     * says how it ended.
     */
    private retrieve<R extends LibraryMoveResponse | LibraryGetResponse>(
      how: 'move' | 'get',
      request: LibraryMoveRequest | LibraryGetRequest,
      make: () => R,
      callback: (responses: R[]) => void,
      sender: () => PartSender | number,
      /** The AE title a move sends to, as the caller wrote it. */
      to: string | null = null,
    ): void {
      const started = Date.now();
      const asked = askedOf(identifierOf(request));
      /** Whose it is: the patient the identifier names, or the one of the study it names. */
      let patientId = asked.patientId;
      /** The record of what was asked for; false when it could not be written. */
      const note = (outcome: 'ok' | 'refused' | 'rejected' | 'failed', said: string): boolean =>
        audit({
          action: how === 'move' ? 'dicom-move' : 'dicom-get',
          outcome,
          aeTitle: printable(this.calling),
          patientId,
          studyUid: asked.studyUid,
          seriesUid: asked.seriesUid,
          detail: [
            ...(to === null ? [] : [`to ${printable(to) || 'no destination'}`]),
            said,
            ...(asked.keys ? [asked.keys] : []),
          ].join(', '),
        });
      /** True once the record of what was asked for is written, and objects may leave. */
      let begun = false;
      const sopClass = request.getAffectedSopClassUid();
      const kind = QUERY_RETRIEVE_SOP_CLASSES[sopClass];
      const syntax = this.syntaxOf(request);
      const response = (status: number, counts?: RetrieveCounts, failed: string[] = []): R => {
        const one = make();
        one.setAffectedSopClassUid(sopClass);
        one.setStatus(status);
        if (counts) {
          // What remains is said while more is to come, and of what a cancel left.
          if (status === RETRIEVE_STATUS.pending || status === RETRIEVE_STATUS.cancelled) {
            one.setRemaining(counts.remaining);
          }
          one.setCompleted(counts.completed);
          one.setFailures(counts.failed);
          one.setWarnings(counts.warning);
        }
        if (failed.length > 0) {
          one.setDataset(new Dataset({ FailedSOPInstanceUIDList: failed }, syntax));
        }
        return one;
      };
      let ended = false;
      const end = (
        status: number,
        outcome: string,
        counts?: RetrieveCounts,
        failed?: string[],
      ): void => {
        // Once: a second answer through the callback is an error of the library's.
        if (ended) return;
        ended = true;
        this.retrieves++;
        logger.info('retrieve-answered', {
          how,
          outcome,
          status,
          completed: counts?.completed ?? 0,
          failed: counts?.failed ?? 0,
          ms: Date.now() - started,
        });
        callback([response(status, counts, failed)]);
      };
      if (!this.mayRetrieve || kind?.service !== how) {
        note('refused', 'not allowed');
        return end(RETRIEVE_STATUS.unableToProcess, 'not-allowed');
      }
      const sendPart = sender();
      if (typeof sendPart === 'number') {
        note('refused', 'the server knows no such destination');
        return end(sendPart, 'no-destination');
      }
      this.cancelRequested = false;
      const run = async (): Promise<void> => {
        const named = await retrieveInstances(
          pacs.index,
          kind.root,
          identifierOf(request),
          options.retrieveAtMost ?? RETRIEVE_INSTANCES_AT_MOST,
        );
        if (named.more) {
          note('rejected', 'more instances than are sent at a request');
          return end(RETRIEVE_STATUS.tooMany, 'too-many');
        }
        const total = named.instances.length;
        if (patientId === null && asked.studyUid !== null) {
          patientId = (await pacs.index.getStudy(asked.studyUid))?.patientId || null;
        }
        // Nothing leaves the server without a record of who asked for it.
        if (!note('ok', `${total} ${total === 1 ? 'instance' : 'instances'}`)) {
          return end(RETRIEVE_STATUS.unableToProcess, 'unrecorded');
        }
        begun = true;
        const result = await runRetrieve({
          pacs,
          instances: named.instances.map((one) => one.sopInstanceUid),
          limits,
          sendPart,
          // The library takes one answer through the callback, which is the
          // last; how far it is goes out beside it.
          progress: (counts) =>
            this.sendResponse(request, response(RETRIEVE_STATUS.pending, counts)),
          cancelled: () => this.cancelRequested || this.gone || closing,
        });
        // How it ended, with where it went: the caller itself, or a move's destination.
        const sent = result.counts.completed + result.counts.warning;
        if (total > 0) {
          audit({
            action: 'dicom-sent',
            outcome: sent === total ? 'ok' : 'failed',
            aeTitle: printable(how === 'move' ? (to ?? '') : this.calling),
            patientId,
            studyUid: asked.studyUid,
            seriesUid: asked.seriesUid,
            detail: [
              how === 'move' ? `move for ${printable(this.calling)}` : 'get',
              `${sent} of ${total} sent`,
              ...(result.cancelled ? ['cancelled'] : []),
            ].join(', '),
          });
        }
        end(
          retrieveStatus(result),
          result.cancelled ? 'cancelled' : 'done',
          result.counts,
          result.failed,
        );
      };
      // A move sends elsewhere and a retrieve that waits sends nothing: no
      // byte passes on this connection meanwhile, and it is not idle for that.
      this.busy = true;
      const mine = turn.then(async () => {
        this.busy = how === 'move';
        try {
          if (this.gone) return;
          await run();
        } catch (error) {
          if (error instanceof IdentifierError) {
            note('rejected', 'an identifier that cannot be answered');
            return end(RETRIEVE_STATUS.identifierMismatch, 'identifier');
          }
          if (!(error instanceof CoreStoppingError)) {
            logger.error('retrieve-failed', errorFields(error));
          }
          // Before anything left, it is the request that failed; after, the sending.
          if (!begun) note('failed', 'the server could not answer');
          else {
            audit({
              action: 'dicom-sent',
              outcome: 'failed',
              aeTitle: printable(how === 'move' ? (to ?? '') : this.calling),
              patientId,
              studyUid: asked.studyUid,
              seriesUid: asked.seriesUid,
              detail: `${how === 'move' ? `move for ${printable(this.calling)}` : 'get'}, not ended`,
            });
          }
          return end(RETRIEVE_STATUS.unableToProcess, 'failed');
        } finally {
          this.busy = false;
        }
      });
      turn = mine.catch(() => undefined);
    }

    override cMoveRequest(
      request: LibraryMoveRequest,
      callback: (responses: LibraryMoveResponse[]) => void,
    ): void {
      const destination = String(
        request.getCommandDataset().getElement('MoveDestination') ?? '',
      ).trim();
      this.retrieve(
        'move',
        request,
        () => CMoveResponse.fromRequest(request),
        callback,
        () => {
          const there = options.destinationOf?.(destination) ?? null;
          if (!there) return RETRIEVE_STATUS.destinationUnknown;
          return async (objects) =>
            moved(
              await sendObjects(
                {
                  ...there,
                  calledAeTitle: destination,
                  callingAeTitle: aeTitle(),
                  ...(options.moveTimeoutMs === undefined
                    ? {}
                    : { timeoutMs: options.moveTimeoutMs }),
                },
                objects,
              ),
            );
        },
        destination,
      );
    }

    override cGetRequest(
      request: LibraryGetRequest,
      callback: (responses: LibraryGetResponse[]) => void,
    ): void {
      this.retrieve(
        'get',
        request,
        () => CGetResponse.fromRequest(request),
        callback,
        () => (objects) => this.storeBack(objects),
      );
    }

    /** Send objects to the caller on its own association, each by a C-STORE. */
    private storeBack(objects: readonly OutgoingObject[]): Promise<SubOperation[] | null> {
      if (this.gone) return Promise.resolve(null);
      return new Promise((resolve) => {
        const became: SubOperation[] = objects.map(() => 'failed');
        const requests: InstanceType<typeof CStoreRequest>[] = [];
        const finish = (): void => {
          this.whenGone = null;
          resolve(became);
        };
        let left = 0;
        objects.forEach((object, i) => {
          // What the caller did not say it takes is not sent to it.
          if (!this.takenBack.has(object.sopClassUid)) return;
          const request = new CStoreRequest(
            storedDataset({ ...object, rewritable: uncompressed(object.transferSyntax) }),
          );
          request.on('response', (response: { getStatus(): number }) => {
            const status = response.getStatus();
            became[i] =
              status === STORE_STATUS.success
                ? 'completed'
                : STORE_WARNINGS.has(status)
                  ? 'warning'
                  : 'failed';
          });
          // Done with an answer, or without: what could not be written in the
          // transfer syntax that was agreed is not sent.
          request.on('done', () => {
            left -= 1;
            if (left === 0) finish();
          });
          requests.push(request);
          left += 1;
        });
        if (left === 0) return finish();
        this.whenGone = () => resolve(null);
        this.sendRequests(requests);
      });
    }

    override cCancelRequest(): void {
      this.cancelRequested = true;
    }

    override associationReleaseRequested(): void {
      logger.info('association-released', {
        stored: this.stored,
        refused: this.refused,
        queries: this.queries,
        retrieves: this.retrieves,
      });
      this.sendAssociationReleaseResponse();
    }
  }

  /** The identifier of a request, as the library read it. */
  const identifierOf = (
    request: LibraryFindRequest | LibraryMoveRequest | LibraryGetRequest,
  ): Identifier => (request.getDataset()?.getElements() ?? {}) as Identifier;

  const server: NetServer = createServer((socket) => {
    if (sockets.size >= ASSOCIATIONS_AT_MOST) {
      logger.warn('association-refused', { why: 'too-many', open: sockets.size });
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // The library sets the socket's own timeout as it sees fit, so idleness
    // is watched here: no byte either way between two looks, and it goes.
    let seen = -1;
    const watch = setInterval(() => {
      const passed = socket.bytesRead + socket.bytesWritten;
      if (passed !== seen || association.busy) {
        seen = passed;
        return;
      }
      logger.info('association-idle');
      socket.destroy();
    }, options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
    watch.unref();
    socket.once('close', () => clearInterval(watch));
    // A connection that breaks is the caller's affair; it must not be an unhandled error.
    const association = new Association(socket, {});
    association.on('networkError', (error: unknown) => {
      logger.debug('association-broken', errorFields(error));
    });
    socket.once('close', () => association.ended());
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : options.port);
    });
  });
  if (callers().length === 0 && retrievers().length === 0) logger.warn('dicom-no-callers');
  logger.info('dicom-listening', {
    host: options.host,
    port,
    aeTitle: aeTitle(),
    callers: callers().length,
    retrievers: retrievers().length,
  });

  let closed: Promise<boolean> | null = null;
  return {
    host: options.host,
    port,
    close({ timeoutMs = 0 } = {}) {
      closing = true;
      closed ??= new Promise<boolean>((resolve) => {
        // What is still open when the time is up is cut off.
        const timer = setTimeout(() => {
          const left = sockets.size;
          for (const socket of sockets) socket.destroy();
          if (left > 0) {
            logger.warn('associations-cut-off', { count: left });
            resolve(false);
          }
        }, timeoutMs);
        // Its callback comes when the last connection has ended.
        server.close(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      return closed;
    },
  };
}
