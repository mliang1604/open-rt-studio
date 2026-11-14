/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  DEFAULT_PASSWORD_COST,
  hashPassword,
  isWeakerThan,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  verifyPassword,
  type PasswordCost,
} from './password.js';

/** Quick to compute, for specs: what is tested is the handling, not the cost. */
const QUICK: PasswordCost = { logN: 4, r: 8, p: 1 };
const PASSWORD = 'correct horse battery staple';

/** A stored hash as this code writes one, from its parts. */
const stored = (...parts: (string | number)[]): string => ['scrypt', ...parts].join('$');
const KEY = 'A'.repeat(43);
const SALT = 'c2FsdA';

describe('hashPassword and verifyPassword', () => {
  it('knows the password it hashed, and no other', async () => {
    const hash = await hashPassword(PASSWORD, QUICK);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    for (const other of [
      '',
      'correct horse battery stapl',
      `${PASSWORD} `,
      PASSWORD.toUpperCase(),
    ]) {
      expect(await verifyPassword(other, hash)).toBe(false);
    }
  });

  it('writes the cost and a salt beside the hash, and never the password', async () => {
    const hash = await hashPassword(PASSWORD, QUICK);
    const parts = hash.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', '4', '8', '1']);
    expect(parts[4]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(parts[5]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toContain(PASSWORD);
    // A salt of its own each time: the same password does not give the same hash.
    expect(await hashPassword(PASSWORD, QUICK)).not.toBe(hash);
  });

  it('works at the cost the server uses, within what Node lets scrypt take', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.split('$').slice(0, 4)).toEqual(['scrypt', '15', '8', '3']);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('not the password', hash)).toBe(false);
  });

  it('takes a password typed with composed or separate accents as the same one', async () => {
    const hash = await hashPassword('café au lait, s’il vous plaît', QUICK);
    expect(await verifyPassword('café au lait, s’il vous plaît', hash)).toBe(true);
  });

  it.each([
    ['nothing', ''],
    ['a plain password', PASSWORD],
    ['another scheme', ['', '2b', '10', 'abcdefghijklmnopqrstuv'].join('$')],
    ['too few parts', stored(4, 8, 1, SALT)],
    ['a cost that is not a number', stored('x', 8, 1, SALT, KEY)],
    ['a key of the wrong length', stored(4, 8, 1, SALT, 'QUJD')],
    ['no salt', stored(4, 8, 1, '', KEY)],
  ])('is false, not an error, for a stored text that is %s', async (_what, text) => {
    expect(await verifyPassword(PASSWORD, text)).toBe(false);
  });

  it('does not try a cost beyond what it would ever write', async () => {
    // 2^30 by r = 8 would take a terabyte: refused by reading it, at once.
    const began = performance.now();
    for (const text of [
      stored(30, 8, 1, SALT, KEY),
      stored(15, 1024, 1, SALT, KEY),
      stored(15, 8, 1000, SALT, KEY),
      stored(0, 8, 1, SALT, KEY),
      stored(4.5, 8, 1, SALT, KEY),
    ]) {
      expect(await verifyPassword(PASSWORD, text)).toBe(false);
    }
    expect(performance.now() - began).toBeLessThan(500);
  });
});

describe('isWeakerThan', () => {
  it('says when a hash was made at a lower cost than is asked for now', async () => {
    const hash = await hashPassword(PASSWORD, QUICK);
    expect(isWeakerThan(hash, QUICK)).toBe(false);
    expect(isWeakerThan(hash, { ...QUICK, logN: 5 })).toBe(true);
    expect(isWeakerThan(hash, { ...QUICK, p: 2 })).toBe(true);
    expect(isWeakerThan(hash, DEFAULT_PASSWORD_COST)).toBe(true);
    // What cannot be read is to be made again.
    expect(isWeakerThan('not a hash', QUICK)).toBe(true);
  });
});

describe('passwordProblem', () => {
  it('asks for length, and for nothing else', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(passwordProblem('a'.repeat(11))).toBe('A password has at least 12 characters.');
    expect(passwordProblem('a'.repeat(12))).toBeNull();
    expect(passwordProblem('all lower case words')).toBeNull();
    expect(passwordProblem('a'.repeat(PASSWORD_MAX_LENGTH))).toBeNull();
    expect(passwordProblem('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe(
      'A password has at most 256 characters.',
    );
  });

  it('counts characters, not the bytes or code units they take', () => {
    // Twelve characters of two code units each.
    expect(passwordProblem('\u{1F511}'.repeat(12))).toBeNull();
    expect(passwordProblem('\u{1F511}'.repeat(11))).not.toBeNull();
  });
});
