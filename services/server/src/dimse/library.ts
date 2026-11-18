/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The one file that imports the DIMSE library. Everything else in the server
// takes what it needs of the library from here, so that replacing it is this
// folder's work (docs/dimse-library.md). The lint rule for the server refuses
// the import anywhere else.
//
// The library is CommonJS and Node sees no named exports in it: the default
// is the whole of it.

// eslint-disable-next-line no-restricted-imports
import dimse from 'dcmjs-dimse';

import { IMPLEMENTATION_CLASS_UID, IMPLEMENTATION_VERSION_NAME } from './part10.js';

// It logs every association and message to the console. This server has a
// log of its own, which holds no identifiers; the library's is turned off.
dimse.log.setLevel('silent');

// On an association the server says what it is, as it does in the header of
// a file it writes, and not what library it is made with.
dimse.Implementation.setImplementationClassUid(IMPLEMENTATION_CLASS_UID);
dimse.Implementation.setImplementationVersion(IMPLEMENTATION_VERSION_NAME);

/** The largest PDU the server says it takes, and sends when the other side takes as much: the library's. */
export const MAX_PDU_LENGTH: number = dimse.Implementation.getMaxPduLength();

export const { Client, Dataset, Scp } = dimse;
export const { PresentationContext } = dimse.association;
export const { CEchoRequest, CFindRequest, CGetRequest, CMoveRequest, CStoreRequest } =
  dimse.requests;
export const { CEchoResponse, CFindResponse, CGetResponse, CMoveResponse, CStoreResponse } =
  dimse.responses;

// The library's constants, as far as the server uses them. They are given
// types of our own: the library's cannot be named in a declaration file.
export const PresentationContextResult: {
  readonly Accept: number;
  readonly RejectAbstractSyntaxNotSupported: number;
  readonly RejectTransferSyntaxesNotSupported: number;
} = dimse.constants.PresentationContextResult;
export const RejectResult: { readonly Permanent: number } = dimse.constants.RejectResult;
export const RejectSource: { readonly ServiceUser: number } = dimse.constants.RejectSource;
export const RejectReason: {
  readonly CalledAeNotRecognized: number;
  readonly CallingAeNotRecognized: number;
} = dimse.constants.RejectReason;

export type LibraryAssociation = InstanceType<typeof dimse.association.Association>;
export type LibraryPresentationContext = InstanceType<typeof dimse.association.PresentationContext>;
export type LibraryDataset = InstanceType<typeof dimse.Dataset>;
export type LibraryEchoRequest = InstanceType<typeof dimse.requests.CEchoRequest>;
export type LibraryEchoResponse = InstanceType<typeof dimse.responses.CEchoResponse>;
export type LibraryStoreRequest = InstanceType<typeof dimse.requests.CStoreRequest>;
export type LibraryStoreResponse = InstanceType<typeof dimse.responses.CStoreResponse>;
export type LibraryFindRequest = InstanceType<typeof dimse.requests.CFindRequest>;
export type LibraryFindResponse = InstanceType<typeof dimse.responses.CFindResponse>;
export type LibraryMoveRequest = InstanceType<typeof dimse.requests.CMoveRequest>;
export type LibraryMoveResponse = InstanceType<typeof dimse.responses.CMoveResponse>;
export type LibraryGetRequest = InstanceType<typeof dimse.requests.CGetRequest>;
export type LibraryGetResponse = InstanceType<typeof dimse.responses.CGetResponse>;
export type LibraryCancelRequest = InstanceType<typeof dimse.requests.CCancelRequest>;

/** What a data set that is sent as it is stored is made from. */
export interface StoredObject {
  readonly sopClassUid: string;
  readonly sopInstanceUid: string;
  /** The transfer syntax its bytes are in. */
  readonly transferSyntax: string;
  /** The data set as it is stored: the file without its header. */
  readonly dataSet: Uint8Array;
  /**
   * Whether the library may write it anew in another transfer syntax when
   * the other system takes it in no other: true only for what holds no
   * compressed pixel data.
   */
  readonly rewritable: boolean;
}

/**
 * A data set for a C-STORE request that goes out as the bytes it is stored
 * in, where the library's own would read the object and write it again
 * (docs/dimse-library.md: its writing changes the bytes of an object with
 * sequences, and takes several times the object's size in memory).
 *
 * The library writes a request's data set with `getDenaturalizedDataset`,
 * and reads the whole of it with `getElements` only to write it in another
 * transfer syntax, when the other system accepted no context in the one it
 * has. The first is given the stored bytes; the second reads them then, and
 * not before.
 */
export function storedDataset(object: StoredObject): LibraryDataset {
  class StoredDataset extends dimse.Dataset {
    override getDenaturalizedDataset(): Buffer {
      const { dataSet } = object;
      return Buffer.from(dataSet.buffer, dataSet.byteOffset, dataSet.byteLength);
    }

    override getElements(): Record<string, unknown> {
      if (!object.rewritable) {
        throw new Error('The object is sent as it is stored, or not at all.');
      }
      return new dimse.Dataset(this.getDenaturalizedDataset(), object.transferSyntax).getElements();
    }
  }
  return new StoredDataset(
    { SOPClassUID: object.sopClassUid, SOPInstanceUID: object.sopInstanceUid },
    object.transferSyntax,
  );
}
