/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import dicomParser from 'dicom-parser';
import { describe, expect, it } from 'vitest';

import {
  characterSetValues,
  decodeAsRead,
  decoderFor,
  plain,
  readTextByCharacterSet,
  writableText,
} from './character-set.js';
import { readInstanceHeader } from './instance-header.js';
import { concat, element, p10Head, padEven, sequence } from './p10-encode.js';

const CT = '1.2.840.10008.5.1.4.1.1.2';

/** Bytes as they are, space-padded: text in whatever set a test writes it in. */
const raw = (bytes: Uint8Array | number[]): Uint8Array => padEven(Uint8Array.from(bytes), 0x20);
const ascii = (value: string): Uint8Array => raw(Array.from(value, (c) => c.charCodeAt(0)));
const utf8 = (value: string): Uint8Array => raw(new TextEncoder().encode(value));
const latin1 = (value: string): Uint8Array => raw(Array.from(value, (c) => c.charCodeAt(0)));

/** A file whose name, study description and an item's text are the bytes given, saying `declared`. */
function file(declared: string | null, name: Uint8Array, itemText = name): Uint8Array {
  const body = concat([
    ...(declared === null ? [] : [element(0x0008, 0x0005, 'CS', ascii(declared))]),
    element(0x0008, 0x0016, 'UI', ascii(CT)),
    element(0x0008, 0x0018, 'UI', ascii('1.2.3.4')),
    element(0x0008, 0x0060, 'CS', ascii('CT')),
    element(0x0008, 0x1030, 'LO', name),
    // An item, as a structure set's ROIs are: its text is the file's too.
    sequence(0x0008, 0x1115, [element(0x0008, 0x103e, 'LO', itemText)]),
    element(0x0010, 0x0010, 'PN', name),
    element(0x0010, 0x0020, 'LO', ascii('ID-1')),
    element(0x0020, 0x000d, 'UI', ascii('1.2.3')),
    element(0x0020, 0x000e, 'UI', ascii('1.2.3.1')),
  ]);
  return concat([p10Head(CT, '1.2.3.4'), body]);
}

const parsed = (bytes: Uint8Array) => dicomParser.parseDicom(bytes);

describe('text by the character set a file says it is in (#249)', () => {
  const NAME = 'Łukasiewicz-Müller^Zoë 山田';

  it('reads UTF-8 (ISO_IR 192), in the file and in its items', () => {
    const dataSet = parsed(file('ISO_IR 192', utf8(NAME)));
    expect(readTextByCharacterSet(dataSet)).toEqual({ declared: 'ISO_IR 192', decoded: 'yes' });
    expect(dataSet.string('x00100010')).toBe(NAME);
    expect(dataSet.text('x00081030')).toBe(NAME);
    const item = dataSet.elements['x00081115'].items![0].dataSet!;
    expect(item.string('x0008103e')).toBe(NAME);
    // What is ASCII is as it was.
    expect(dataSet.string('x00100020')).toBe('ID-1');
    expect(dataSet.string('x0020000d')).toBe('1.2.3');
  });

  it('reads Latin-1, and the default repertoire, a byte to a character, as they were read', () => {
    const latin = parsed(file('ISO_IR 100', latin1('Ødegård^José')));
    expect(readTextByCharacterSet(latin)).toEqual({ declared: 'ISO_IR 100', decoded: 'default' });
    expect(latin.string('x00100010')).toBe('Ødegård^José');
    const none = parsed(file(null, ascii('PLAIN^NAME')));
    expect(readTextByCharacterSet(none)).toEqual({ declared: '', decoded: 'default' });
    expect(none.string('x00100010')).toBe('PLAIN^NAME');
  });

  it('reads another single-byte set of ISO 8859 by its decoder', () => {
    // ISO_IR 101, Latin-2: 0xA3 is Ł.
    const dataSet = parsed(file('ISO_IR 101', raw([0xa3, 0x6f, 0x64, 0x7a])));
    expect(readTextByCharacterSet(dataSet).decoded).toBe('yes');
    expect(dataSet.string('x00100010')).toBe('Łodz');
  });

  it('leaves text with escapes, and a set it does not know, as it was read, and says so', () => {
    const bytes = utf8(NAME);
    for (const declared of ['ISO 2022 IR 6\\ISO 2022 IR 87', 'ISO_IR 13', 'NOT A SET']) {
      const dataSet = parsed(file(declared, bytes));
      expect(readTextByCharacterSet(dataSet).decoded).toBe('no');
      // A byte to a character: the bytes, not a guess at them.
      expect(dataSet.string('x00100010')).toBe(String.fromCharCode(...Array.from(bytes)).trim());
    }
  });

  it('is what the header reader gives, a name in UTF-8 and one in Latin-1', () => {
    const read = readInstanceHeader(file('ISO_IR 192', utf8(NAME)));
    expect(read.ok && read.header.patient.name).toBe(NAME);
    expect(read.ok && read.header.study.description).toBe(NAME);
    const latin = readInstanceHeader(file('ISO_IR 100', latin1('Ødegård^José')));
    expect(latin.ok && latin.header.patient.name).toBe('Ødegård^José');
  });
});

describe('the parts of reading by a character set', () => {
  it('splits a Specific Character Set into its values', () => {
    expect(characterSetValues('iso_ir 192')).toEqual(['ISO_IR 192']);
    expect(characterSetValues('\\ISO 2022 IR 87')).toEqual(['', 'ISO 2022 IR 87']);
    expect(characterSetValues(null)).toEqual(['']);
  });

  it('decodes only what has a byte above 127', () => {
    const decode = decoderFor('ISO_IR 192');
    if (typeof decode !== 'function') throw new Error('no decoder');
    expect(decodeAsRead('PLAIN', decode)).toBe('PLAIN');
    expect(decodeAsRead('ZÃ«', decode)).toBe('Zë');
    expect(decoderFor('ISO_IR 100')).toBe('as-read');
    expect(decoderFor('')).toBe('as-read');
    expect(decoderFor('ISO 2022 IR 6\\ISO 2022 IR 87')).toBeNull();
  });
});

describe('what is written as text', () => {
  it('keeps every character but those that print nothing', () => {
    expect(plain('Zoë 山田 →\nnext\u0000')).toBe('Zoë 山田 →?next?');
  });

  it('is cut at whole characters', () => {
    // An emoji is two halves in UTF-16: it is kept whole or not at all.
    expect(writableText('ab😀cd', 3)).toBe('ab😀');
    expect(writableText('ab😀cd', 2)).toBe('ab');
  });
});
