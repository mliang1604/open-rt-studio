/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only; not exported from the package. A self-signed certificate
// made on the spot, so that no key is kept in the repository and none
// expires there. Node makes keys but not certificates, so the certificate is
// written out here: X.509 in DER, as little of it as a TLS client asks for.

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';

const der = (tag: number, ...content: Uint8Array[]): Buffer => {
  const body = Buffer.concat(content);
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const size: number[] = [];
  for (let left = body.length; left > 0; left >>= 8) size.unshift(left & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | size.length, ...size]), body]);
};

const sequence = (...content: Uint8Array[]): Buffer => der(0x30, ...content);

/** An object identifier from its dotted form. */
function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const part of rest) {
    const digits = [part & 0x7f];
    for (let left = part >> 7; left > 0; left >>= 7) digits.unshift((left & 0x7f) | 0x80);
    bytes.push(...digits);
  }
  return der(0x06, Buffer.from(bytes));
}

/** A whole number that is not negative. */
function integer(value: number): Buffer {
  const bytes: number[] = [];
  for (let left = value; left > 0; left = Math.floor(left / 256)) bytes.unshift(left % 256);
  if (bytes.length === 0 || bytes[0] >= 0x80) bytes.unshift(0);
  return der(0x02, Buffer.from(bytes));
}

/** A moment as UTCTime, which serves until 2050. */
function time(date: Date): Buffer {
  const two = (value: number): string => String(value).padStart(2, '0');
  return der(
    0x17,
    Buffer.from(
      two(date.getUTCFullYear() % 100) +
        two(date.getUTCMonth() + 1) +
        two(date.getUTCDate()) +
        two(date.getUTCHours()) +
        two(date.getUTCMinutes()) +
        two(date.getUTCSeconds()) +
        'Z',
      'ascii',
    ),
  );
}

const pem = (label: string, bytes: Uint8Array): string =>
  `-----BEGIN ${label}-----\n${Buffer.from(bytes)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd()}\n-----END ${label}-----\n`;

const ECDSA_WITH_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));
/** With its parameters, which are null. */
const RSA_WITH_SHA256 = sequence(oid('1.2.840.113549.1.1.11'), der(0x05));
const DAY = 86_400_000;

export interface TestCertificate {
  /** The certificate, PEM. A client that is given it as its authority trusts the server. */
  readonly cert: string;
  /** Its private key, PEM (PKCS #8), with no passphrase. */
  readonly key: string;
}

const named = (commonName: string): Buffer =>
  sequence(der(0x31, sequence(oid('2.5.4.3'), der(0x0c, Buffer.from(commonName, 'utf8')))));
const SUBJECT = named('Open RT Studio test');
const AUTHORITY = named('Open RT Studio test authority');

/**
 * A certificate for `localhost` and `127.0.0.1`, with a new key: signed by
 * itself, or by an authority made here with `authority`. Valid from a day
 * ago for thirty days unless told otherwise.
 */
export function testCertificate(
  options: {
    readonly notBefore?: Date;
    readonly notAfter?: Date;
    /** The DNS names it is for, in place of `localhost` and `127.0.0.1`. */
    readonly names?: readonly string[];
    /** Make an authority, which signs other certificates and is for no name. */
    readonly authority?: boolean;
    /** The authority (made with `authority`) that signs it, in place of itself. */
    readonly signedBy?: TestCertificate;
    /** An RSA key of 2048 bits in place of one on P-256, for a peer that wants one. */
    readonly rsa?: boolean;
  } = {},
): TestCertificate {
  const { publicKey, privateKey } = options.rsa
    ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signer = options.signedBy ? createPrivateKey(options.signedBy.key) : privateKey;
  // How it is signed is the signer's kind of key, not its own.
  const signedWith = signer.asymmetricKeyType === 'rsa' ? RSA_WITH_SHA256 : ECDSA_WITH_SHA256;
  const name = options.authority ? AUTHORITY : SUBJECT;
  const issuer = options.signedBy ? AUTHORITY : name;
  const alternativeNames = options.names
    ? sequence(...options.names.map((one) => der(0x82, Buffer.from(one, 'ascii'))))
    : sequence(
        der(0x82, Buffer.from('localhost', 'ascii')),
        der(0x87, Buffer.from([127, 0, 0, 1])),
      );
  const toBeSigned = sequence(
    // Version 3, which is what has extensions.
    der(0xa0, integer(2)),
    integer(Math.floor(Math.random() * 0x7fff_ffff) + 1),
    signedWith,
    issuer,
    sequence(
      time(options.notBefore ?? new Date(Date.now() - DAY)),
      time(options.notAfter ?? new Date(Date.now() + 30 * DAY)),
    ),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(
      0xa3,
      sequence(
        options.authority
          ? // Basic constraints, critical: it is an authority.
            sequence(
              oid('2.5.29.19'),
              der(0x01, Buffer.from([0xff])),
              der(0x04, sequence(der(0x01, Buffer.from([0xff])))),
            )
          : sequence(oid('2.5.29.17'), der(0x04, alternativeNames)),
      ),
    ),
  );
  const signature = sign('sha256', toBeSigned, signer);
  const certificate = sequence(
    toBeSigned,
    signedWith,
    // A bit string: no unused bits, then the signature.
    der(0x03, Buffer.from([0]), signature),
  );
  return {
    cert: pem('CERTIFICATE', certificate),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
