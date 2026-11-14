/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Passwords are kept as scrypt hashes (node:crypto; no dependency), each with
// a salt of its own. The cost is written beside the hash, so it can be raised
// later: an old hash is still checked with the cost it was made with, and is
// made again at the new cost the next time its password is given.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** How hard a hash is to compute: scrypt's N (as a power of two), r and p. */
export interface PasswordCost {
  readonly logN: number;
  readonly r: number;
  readonly p: number;
}

/**
 * N = 2^15, r = 8, p = 3: one of the settings OWASP gives for scrypt. It
 * takes 32 MiB and a fraction of a second for each password tried.
 */
export const DEFAULT_PASSWORD_COST: PasswordCost = { logN: 15, r: 8, p: 3 };

/** The least a password may be. Length is what is asked for, not kinds of character. */
export const PASSWORD_MIN_LENGTH = 12;
/** The most: a password is hashed whole, so its length is bounded. */
export const PASSWORD_MAX_LENGTH = 256;

const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** The most a stored hash may ask of this process: 2^20 by r = 16 is 2 GiB, refused before it is tried. */
const MAX_LOG_N = 20;
const MAX_R = 16;
const MAX_P = 16;

/** What is wrong with a password, as a sentence for whoever chose it; null when nothing is. */
export function passwordProblem(password: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) {
    return `A password has at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return `A password has at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

function derive(password: string, salt: Buffer, cost: PasswordCost): Promise<Buffer> {
  const N = 2 ** cost.logN;
  return new Promise((resolve, reject) => {
    scrypt(
      // The same password however its characters were typed (composed or not).
      password.normalize('NFKC'),
      salt,
      KEY_BYTES,
      // Twice what the cost takes: Node refuses a cost above `maxmem`.
      { N, r: cost.r, p: cost.p, maxmem: 2 * 128 * N * cost.r + 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Hash a password for keeping: `scrypt$logN$r$p$salt$key`, salt and key in base64url. */
export async function hashPassword(
  password: string,
  cost: PasswordCost = DEFAULT_PASSWORD_COST,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, cost);
  return [
    'scrypt',
    cost.logN,
    cost.r,
    cost.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

interface Parsed {
  readonly cost: PasswordCost;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [logN, r, p] = parts.slice(1, 4).map(Number);
  const whole = (n: number, most: number): boolean => Number.isInteger(n) && n >= 1 && n <= most;
  if (!whole(logN, MAX_LOG_N) || !whole(r, MAX_R) || !whole(p, MAX_P)) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  if (salt.length === 0 || key.length !== KEY_BYTES) return null;
  return { cost: { logN, r, p }, salt, key };
}

/**
 * Whether a password is the one a stored hash was made from. False, and never
 * an error, for a stored text that is not a hash this code made.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.cost);
  return timingSafeEqual(key, parsed.key);
}

/** Whether a stored hash was made at a lower cost than `cost`, and should be made again. */
export function isWeakerThan(stored: string, cost: PasswordCost = DEFAULT_PASSWORD_COST): boolean {
  const parsed = parse(stored);
  if (!parsed) return true;
  const work = (c: PasswordCost): number => 2 ** c.logN * c.r * c.p;
  return work(parsed.cost) < work(cost);
}
