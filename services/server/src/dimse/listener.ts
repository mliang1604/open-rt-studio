/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server's DICOM listener: other systems verify that it is there
// (C-ECHO) and send it objects (C-STORE), which go through the ingest like
// anything uploaded.
//
// The listener is Node's own, bound where the configuration says; each
// connection is handed to the library's protocol class (see
// docs/dimse-library.md for why not the library's server).
//
// DIMSE has no login. Who may send is decided by the AE title the caller
// gives, which is a name and not a proof: anyone who can reach the port and
// knows a name on the list can store objects. So the port is off unless it
// is asked for, the list is empty unless it is filled, and the address is
// the server's own, which is this machine alone by default.
//
// Logs: AE titles are names of systems and are logged. Nothing of an object
// is: not a UID, not a name, only what came of it.

import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { Writable } from 'node:stream';

import { readInstanceHeader } from '@open-rt-studio/dicom';

import { CoreStoppingError, type Pacs } from '../core/core.js';
import type { IngestResult } from '../ingest/ingest.js';
import { errorFields, SILENT_LOGGER, type Logger } from '../logger.js';
import {
  CEchoResponse,
  CStoreResponse,
  Dataset,
  PresentationContextResult,
  RejectReason,
  RejectResult,
  RejectSource,
  Scp,
  type LibraryAssociation,
  type LibraryDataset,
  type LibraryEchoRequest,
  type LibraryEchoResponse,
  type LibraryPresentationContext,
  type LibraryStoreRequest,
  type LibraryStoreResponse,
} from './library.js';
import { dataSetOf, part10, type ReceivedDataSet } from './part10.js';
import {
  chooseTransferSyntax,
  IMPLICIT_VR_LE,
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
  /** The AE title callers must address. */
  readonly aeTitle: string;
  /** The calling AE titles that are let in. An empty list lets nobody in. */
  readonly callers: readonly string[];
  /** The largest object taken, in bytes: the data set as it arrives. */
  readonly maxObjectBytes: number;
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
export async function takeObject(
  pacs: Pacs,
  object: ReceivedDataSet,
): Promise<{ status: number; outcome: IngestResult['outcome'] | 'mismatch' }> {
  const file = part10(object);
  const header = readInstanceHeader(file);
  if (
    header.ok &&
    (header.header.sopInstanceUid !== object.sopInstanceUid ||
      header.header.sopClassUid !== object.sopClassUid)
  ) {
    return { status: STORE_STATUS.dataSetMismatch, outcome: 'mismatch' };
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
      return { status: STORE_STATUS.success, outcome: 'unchanged' };
    }
  }
  const result = await pacs.ingest.ingest(file);
  return { status: storeStatus(result), outcome: result.outcome };
}

/** Start listening for DICOM associations. Rejects when the port cannot be had. */
export async function startDicomListener(options: DicomListenerOptions): Promise<DicomListener> {
  const logger = (options.logger ?? SILENT_LOGGER).child({ part: 'dicom' });
  const { pacs, aeTitle, callers, maxObjectBytes } = options;
  const sockets = new Set<Socket>();

  class Association extends Scp {
    private calling = '';
    private incoming: Gathered | null = null;
    private stored = 0;
    private refused = 0;

    override associationRequested(association: LibraryAssociation): void {
      this.calling = association.getCallingAeTitle().trim();
      const called = association.getCalledAeTitle().trim();
      const reject = (reason: number, why: string): void => {
        logger.warn('association-rejected', { why, callingAe: this.calling });
        this.sendAssociationReject(RejectResult.Permanent, RejectSource.ServiceUser, reason);
      };
      if (called !== aeTitle) return reject(RejectReason.CalledAeNotRecognized, 'called-ae');
      if (!callers.includes(this.calling)) {
        return reject(RejectReason.CallingAeNotRecognized, 'calling-ae');
      }
      for (const proposed of association.getPresentationContexts()) {
        const context = association.getPresentationContext(proposed.id);
        const abstract = context.getAbstractSyntaxUid();
        if (abstract !== VERIFICATION && !(abstract in STORAGE_SOP_CLASSES)) {
          context.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
          continue;
        }
        const syntax = chooseTransferSyntax(context.getTransferSyntaxUids());
        if (syntax) context.setResult(PresentationContextResult.Accept, syntax);
        else context.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
      }
      logger.info('association-accepted', { callingAe: this.calling });
      this.sendAssociationAccept();
    }

    override createStoreWritableStream(context: LibraryPresentationContext): Writable {
      this.incoming = new Gathered(
        context.getAcceptedTransferSyntaxUid() ?? IMPLICIT_VR_LE,
        maxObjectBytes,
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
      const answer = (status: number, outcome: string): void => {
        if (status === STORE_STATUS.success) this.stored++;
        else this.refused++;
        logger.info('object-received', { outcome, status });
        const response = CStoreResponse.fromRequest(request);
        response.setStatus(status);
        callback(response);
      };
      if (!incoming) return answer(STORE_STATUS.cannotUnderstand, 'no-data-set');
      if (incoming.tooLarge) return answer(STORE_STATUS.outOfResources, 'too-large');
      takeObject(pacs, {
        sopClassUid: request.getAffectedSopClassUid(),
        sopInstanceUid: request.getAffectedSopInstanceUid(),
        transferSyntax: incoming.transferSyntax,
        sourceAeTitle: this.calling,
        dataSet: incoming.bytes(),
      }).then(
        ({ status, outcome }) => answer(status, outcome),
        (error: unknown) => {
          if (error instanceof CoreStoppingError) {
            return answer(STORE_STATUS.outOfResources, 'stopping');
          }
          logger.error('object-failed', errorFields(error));
          return answer(STORE_STATUS.processingFailure, 'failed');
        },
      );
    }

    override associationReleaseRequested(): void {
      logger.info('association-released', {
        callingAe: this.calling,
        stored: this.stored,
        refused: this.refused,
      });
      this.sendAssociationReleaseResponse();
    }
  }

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
      if (passed !== seen) {
        seen = passed;
        return;
      }
      logger.info('association-idle');
      socket.destroy();
    }, options.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
    watch.unref();
    socket.once('close', () => clearInterval(watch));
    // A connection that breaks is the caller's affair; it must not be an unhandled error.
    new Association(socket, {}).on('networkError', (error: unknown) => {
      logger.debug('association-broken', errorFields(error));
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : options.port);
    });
  });
  if (callers.length === 0) logger.warn('dicom-no-callers');
  logger.info('dicom-listening', { host: options.host, port, aeTitle, callers: callers.length });

  let closed: Promise<boolean> | null = null;
  return {
    host: options.host,
    port,
    close({ timeoutMs = 0 } = {}) {
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
