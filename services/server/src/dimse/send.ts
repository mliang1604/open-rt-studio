/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// C-STORE to another system (#50): one association, a number of objects,
// and what became of each.
//
// An object goes out as the bytes it is stored in. For that the association
// proposes, for each kind of object, a presentation context of its own in
// the transfer syntax the object has, beside the one the library proposes
// (Implicit and Explicit VR Little Endian together, of which the other
// system picks one). Where the other system takes the object's own syntax,
// the stored bytes are sent. Where it takes only the other uncompressed one,
// the library writes the object anew in that, and the result says so. An
// object with compressed pixel data is never written anew: it is sent as it
// is or not at all.

import {
  Client,
  CStoreRequest,
  PresentationContext,
  PresentationContextResult,
  storedDataset,
  type LibraryAssociation,
} from './library.js';
import type { OutgoingObject } from './part10.js';
import { EXPLICIT_VR_LE, IMPLICIT_VR_LE } from './sop-classes.js';

export { outgoingFrom, type OutgoingObject } from './part10.js';

/** What became of one object. */
export type SendOutcome =
  /** The other system answered success, or a warning (`status` is then not 0). */
  | {
      readonly outcome: 'stored';
      readonly status: number;
      /** True when it went in another transfer syntax than it is stored in. */
      readonly rewritten: boolean;
    }
  /** The other system answered that it did not store it. */
  | { readonly outcome: 'refused'; readonly status: number }
  /** The other system takes no object of this kind, or not in this transfer syntax. */
  | { readonly outcome: 'not-taken'; readonly why: 'kind' | 'transfer-syntax' }
  /** The association was refused: the other system does not know the caller, or the called. */
  | { readonly outcome: 'rejected' }
  /** Nothing answered at the address. */
  | { readonly outcome: 'unreachable' }
  /** The connection ended before the object was answered. */
  | { readonly outcome: 'broken' };

export interface SendTarget {
  readonly host: string;
  readonly port: number;
  readonly calledAeTitle: string;
  readonly callingAeTitle: string;
  /** How long to wait for the connection, the association and each answer. */
  readonly timeoutMs?: number;
}

/** Warnings of the storage service (PS3.4, B.2.3): the object was stored. */
const WARNINGS = new Set([0xb000, 0xb006, 0xb007]);

const uncompressed = (transferSyntax: string): boolean =>
  transferSyntax === IMPLICIT_VR_LE || transferSyntax === EXPLICIT_VR_LE;

/** How the association that was accepted will carry an object. */
type Carried = 'stored' | 'rewritten' | 'kind' | 'transfer-syntax';

function carried(association: LibraryAssociation, object: OutgoingObject): Carried {
  let other = false;
  for (const { context } of association.getPresentationContexts()) {
    if (
      context.getAbstractSyntaxUid() !== object.sopClassUid ||
      context.getResult() !== PresentationContextResult.Accept
    ) {
      continue;
    }
    if (context.getAcceptedTransferSyntaxUid() === object.transferSyntax) return 'stored';
    other = true;
  }
  if (!other) return 'kind';
  return uncompressed(object.transferSyntax) ? 'rewritten' : 'transfer-syntax';
}

/**
 * Send objects on one association, in the order given, and say what became
 * of each. Resolves in every case; it does not reject.
 */
export function sendObjects(
  target: SendTarget,
  objects: readonly OutgoingObject[],
): Promise<SendOutcome[]> {
  const timeoutMs = target.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    if (objects.length === 0) return resolve([]);
    const client = new Client();
    const statuses: (number | null)[] = objects.map(() => null);
    let how: Carried[] | null = null;
    let connected = false;
    let rejected = false;

    const proposed = new Set<string>();
    objects.forEach((object, i) => {
      const request = new CStoreRequest(
        storedDataset({ ...object, rewritable: uncompressed(object.transferSyntax) }),
      );
      request.on('response', (response: { getStatus(): number }) => {
        statuses[i] = response.getStatus();
      });
      client.addRequest(request);
      // A context in the object's own syntax alone, once for each kind. The
      // library proposes one itself for a compressed object.
      const key = `${object.sopClassUid} ${object.transferSyntax}`;
      if (uncompressed(object.transferSyntax) && !proposed.has(key)) {
        proposed.add(key);
        client.addAdditionalPresentationContext(
          new PresentationContext(0, object.sopClassUid, object.transferSyntax),
          true,
        );
      }
    });

    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve(
        objects.map((_, i): SendOutcome => {
          const status = statuses[i];
          const way = how?.[i];
          if (status !== null) {
            return status === 0 || WARNINGS.has(status)
              ? { outcome: 'stored', status, rewritten: way === 'rewritten' }
              : { outcome: 'refused', status };
          }
          if (rejected) return { outcome: 'rejected' };
          if (!connected) return { outcome: 'unreachable' };
          if (way === 'kind' || way === 'transfer-syntax')
            return { outcome: 'not-taken', why: way };
          return { outcome: 'broken' };
        }),
      );
    };

    client.on('connected', () => {
      connected = true;
    });
    client.on('associationAccepted', (association: LibraryAssociation) => {
      how = objects.map((object) => carried(association, object));
    });
    client.on('associationRejected', () => {
      rejected = true;
    });
    client.on('networkError', settle);
    client.on('closed', settle);
    client.send(target.host, target.port, target.callingAeTitle, target.calledAeTitle, {
      connectTimeout: timeoutMs,
      associationTimeout: timeoutMs,
      pduTimeout: timeoutMs,
    });
  });
}
