/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The proof of concept of the DIMSE library spike (#40): the least that
// answers a C-ECHO and takes a C-STORE with dcmjs-dimse, for specs to try the
// library with. It is not the server's DICOM listener, which #49 builds, and
// it is not built into the package.
//
// What it shows about how to use the library:
//
// - The library is CommonJS with no named exports Node can see: import the
//   default and take the names from it.
// - An SCP is a class of ours that the library makes one of per association.
//   What it should know (who may call, where objects go) has to reach it
//   some other way than its constructor; here, a subclass made per listener.
// - A received object reaches us through `createStoreWritableStream`, as the
//   bytes of its data set and nothing else. The Part 10 header in front is
//   ours to write.
// - `createDatasetFromStoreWritableStream` must hand the library a Dataset.
//   An empty one will do: the library then parses nothing.

import { createServer } from 'node:net';
import { Writable } from 'node:stream';
import dimse from 'dcmjs-dimse';

const { Client, Dataset, Scp, Server } = dimse;
const { CEchoRequest, CStoreRequest } = dimse.requests;
const { CEchoResponse, CStoreResponse } = dimse.responses;
const { PresentationContextResult, RejectReason, RejectResult, RejectSource, Status } =
  dimse.constants;

// The library logs every association and message to the console.
dimse.log.setLevel('silent');

export const EXPLICIT_VR_LE = '1.2.840.10008.1.2.1';
export const IMPLICIT_VR_LE = '1.2.840.10008.1.2';
/** The DIMSE status of success. */
export const SUCCESS = Status.Success;

type Association = InstanceType<typeof dimse.association.Association>;
type PresentationContext = InstanceType<typeof dimse.association.PresentationContext>;
type StoreRequest = InstanceType<typeof dimse.requests.CStoreRequest>;
type LibraryDataset = InstanceType<typeof Dataset>;

/** A key and its certificate, PEM. */
export interface TlsPair {
  readonly key: string;
  readonly cert: string;
}

/** One object as it arrived by C-STORE. */
export interface ReceivedObject {
  readonly callingAeTitle: string;
  readonly sopClassUid: string;
  readonly sopInstanceUid: string;
  /** The transfer syntax the association agreed for it. */
  readonly transferSyntax: string;
  /** The bytes of the data set, as the store hook was given them. */
  readonly dataSet: Uint8Array;
}

export interface ProofScpOptions {
  /** Calling AE titles let in. Default: any. */
  readonly callers?: readonly string[];
  /** Listen with TLS, with this key and certificate. */
  readonly tls?: TlsPair;
  /** Called with each object once it has all arrived. Its promise is awaited before the answer. */
  readonly onObject?: (object: ReceivedObject) => Promise<void> | void;
  /** Where the bytes of an object go as they arrive. Default: kept in memory. */
  readonly sink?: () => Writable;
}

export interface ProofScp {
  readonly port: number;
  /** What has arrived, in order. Empty of bytes when a `sink` took them. */
  readonly received: ReceivedObject[];
  close(): void;
}

/** A port nothing is listening on. The library does not take port 0. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

/** Bytes gathered in memory, with what the association agreed for them. */
class Gathered extends Writable {
  readonly chunks: Buffer[] = [];
  constructor(
    readonly transferSyntax: string,
    private readonly sink: Writable | null,
  ) {
    super();
  }
  override _write(chunk: Buffer, _encoding: string, done: (error?: Error | null) => void): void {
    if (this.sink) this.sink.write(chunk, done);
    else {
      this.chunks.push(Buffer.from(chunk));
      done();
    }
  }
  override _final(done: (error?: Error | null) => void): void {
    if (this.sink) this.sink.end(done);
    else done();
  }
}

/** Start an SCP that answers C-ECHO and takes C-STORE of anything, in the syntax it is offered. */
export async function startProofScp(options: ProofScpOptions = {}): Promise<ProofScp> {
  const received: ReceivedObject[] = [];

  class ProofScpAssociation extends Scp {
    private calling = '';
    private last: Gathered | null = null;

    override associationRequested(association: Association): void {
      this.calling = association.getCallingAeTitle().trim();
      if (options.callers && !options.callers.includes(this.calling)) {
        this.sendAssociationReject(
          RejectResult.Permanent,
          RejectSource.ServiceUser,
          RejectReason.CallingAeNotRecognized,
        );
        return;
      }
      for (const proposed of association.getPresentationContexts()) {
        const context = association.getPresentationContext(proposed.id);
        // As it was sent, where the sender offers that: nothing is transcoded.
        const offered = context.getTransferSyntaxUids();
        const syntax = offered.includes(EXPLICIT_VR_LE) ? EXPLICIT_VR_LE : offered[0];
        context.setResult(PresentationContextResult.Accept, syntax);
      }
      this.sendAssociationAccept();
    }

    override createStoreWritableStream(context: PresentationContext): Writable {
      const syntax = context.getAcceptedTransferSyntaxUid() ?? IMPLICIT_VR_LE;
      this.last = new Gathered(syntax, options.sink ? options.sink() : null);
      return this.last;
    }

    override createDatasetFromStoreWritableStream(
      _writable: Writable,
      context: PresentationContext,
      callback: (dataset: LibraryDataset) => void,
    ): void {
      // Nothing is parsed: the library gets an empty data set to carry about.
      callback(new Dataset({}, context.getAcceptedTransferSyntaxUid() ?? IMPLICIT_VR_LE));
    }

    override cEchoRequest(
      request: InstanceType<typeof CEchoRequest>,
      callback: (response: InstanceType<typeof CEchoResponse>) => void,
    ): void {
      const response = CEchoResponse.fromRequest(request);
      response.setStatus(Status.Success);
      callback(response);
    }

    override cStoreRequest(
      request: StoreRequest,
      callback: (response: InstanceType<typeof CStoreResponse>) => void,
    ): void {
      const gathered = this.last;
      this.last = null;
      const object: ReceivedObject = {
        callingAeTitle: this.calling,
        sopClassUid: request.getAffectedSopClassUid(),
        sopInstanceUid: request.getAffectedSopInstanceUid(),
        transferSyntax: gathered?.transferSyntax ?? IMPLICIT_VR_LE,
        dataSet: gathered ? Buffer.concat(gathered.chunks) : new Uint8Array(0),
      };
      received.push(object);
      const answer = (status: number): void => {
        const response = CStoreResponse.fromRequest(request);
        response.setStatus(status);
        callback(response);
      };
      Promise.resolve(options.onObject?.(object)).then(
        () => answer(Status.Success),
        () => answer(Status.ProcessingFailure),
      );
    }

    override associationReleaseRequested(): void {
      this.sendAssociationReleaseResponse();
    }
  }

  const port = await freePort();
  const server = new Server(ProofScpAssociation);
  // Without a listener a refused TLS handshake is an unhandled error.
  server.on('networkError', () => undefined);
  server.listen(port, options.tls ? { securityOptions: options.tls } : {});
  return { port, received, close: () => server.close() };
}

export interface SendOptions {
  readonly callingAeTitle?: string;
  readonly calledAeTitle?: string;
  /** Connect with TLS, trusting this certificate. */
  readonly trust?: string;
}

/** What came of an association the library's client made. */
export interface SendResult {
  /** The status of each request's last response, in the order asked. */
  readonly statuses: number[];
  /** Set when the association was refused. */
  readonly rejected: boolean;
}

/** Make an association with the library's client and send the requests over it. */
async function send(
  port: number,
  requests: readonly (InstanceType<typeof CEchoRequest> | StoreRequest)[],
  options: SendOptions,
): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const statuses: number[] = [];
    let rejected = false;
    for (const request of requests) {
      request.on('response', (response: { getStatus(): number }) => {
        statuses.push(response.getStatus());
      });
      client.addRequest(request);
    }
    client.on('associationRejected', () => {
      rejected = true;
    });
    client.on('networkError', (error: Error) => reject(error));
    client.on('closed', () => resolve({ statuses, rejected }));
    client.send(
      '127.0.0.1',
      port,
      options.callingAeTitle ?? 'PROOF-SCU',
      options.calledAeTitle ?? 'PROOF-SCP',
      options.trust ? { securityOptions: { ca: options.trust, rejectUnauthorized: true } } : {},
    );
  });
}

/** C-ECHO with the library's client. */
export async function echo(port: number, options: SendOptions = {}): Promise<SendResult> {
  return send(port, [new CEchoRequest()], options);
}

/** C-STORE Part 10 files with the library's client, on one association. */
export async function store(
  port: number,
  paths: readonly string[],
  options: SendOptions = {},
): Promise<SendResult> {
  return send(
    port,
    paths.map((path) => new CStoreRequest(path)),
    options,
  );
}

/** The data set of a Part 10 file: what follows the preamble, `DICM` and the meta group. */
export function dataSetOf(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.length);
  // (0002,0000) is first: tag, `UL`, a length of 4, then the group's length.
  return file.subarray(132 + 12 + view.getUint32(132 + 8, true));
}

/**
 * A Part 10 file from a data set as it arrived: the preamble, `DICM` and a
 * meta group of our own in front of the bytes, which are not touched.
 */
export function part10(object: ReceivedObject): Uint8Array {
  const ui = (element: number, value: string): Buffer => {
    const text = Buffer.from(value.length % 2 ? `${value}\0` : value, 'ascii');
    const head = Buffer.alloc(8);
    head.writeUInt16LE(0x0002, 0);
    head.writeUInt16LE(element, 2);
    head.write('UI', 4, 'ascii');
    head.writeUInt16LE(text.length, 6);
    return Buffer.concat([head, text]);
  };
  // (0002,0001) File Meta Information Version: OB, two reserved bytes, a 4-byte length.
  const version = Buffer.from([0x02, 0, 0x01, 0, 0x4f, 0x42, 0, 0, 2, 0, 0, 0, 0, 1]);
  const group = Buffer.concat([
    version,
    ui(0x0002, object.sopClassUid),
    ui(0x0003, object.sopInstanceUid),
    ui(0x0010, object.transferSyntax),
  ]);
  const length = Buffer.from([0x02, 0, 0, 0, 0x55, 0x4c, 4, 0, 0, 0, 0, 0]);
  length.writeUInt32LE(group.length, 8);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), length, group, object.dataSet]);
}
