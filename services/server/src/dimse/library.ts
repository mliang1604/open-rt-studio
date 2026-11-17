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

// It logs every association and message to the console. This server has a
// log of its own, which holds no identifiers; the library's is turned off.
dimse.log.setLevel('silent');

export const { Client, Dataset, Scp } = dimse;
export const { CEchoRequest, CStoreRequest } = dimse.requests;
export const { CEchoResponse, CStoreResponse } = dimse.responses;

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
