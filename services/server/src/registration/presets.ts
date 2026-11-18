/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The presets of the deformable registration (#81): files beside the native
// tools (native/presets/deformable), each an elastix parameter file that
// says in its first lines what it is for:
//
//   // title: CT to CT
//   // description: Two CT images of one patient. ...
//
// A preset goes by the name of its file. The server reads the directory
// once, when it starts; a request names a preset and never a file.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RegistrationPreset {
  /** What a request calls it: the file's name without `.txt`. */
  readonly name: string;
  /** What a person is shown. */
  readonly title: string;
  readonly description: string;
  /** The file, for the tool. Never part of an answer. */
  readonly file: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** As much of a file as its first lines can be. */
const HEAD_BYTES = 4096;

/** What a line of the form `// <label>: text` says, in the first lines of a file. */
function said(head: string, label: string, atMost: number): string | null {
  const line = head.split('\n').find((one) => one.startsWith(`// ${label}:`));
  // Printable text only: it goes into answers and onto screens.
  const text = line
    ?.slice(label.length + 4)
    .replace(/[^\x20-\x7e]/g, ' ')
    .trim();
  return text ? text.slice(0, atMost) : null;
}

/**
 * The presets in a directory, by name. A file whose name is not a plain
 * one (lower case, digits, hyphens) is passed over, as is anything that is
 * not a `.txt` file. A directory that is not there holds none.
 */
export function readPresets(directory: string): RegistrationPreset[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const presets: RegistrationPreset[] = [];
  for (const fileName of names.sort()) {
    if (!fileName.endsWith('.txt')) continue;
    const name = fileName.slice(0, -4);
    if (!NAME.test(name)) continue;
    const file = join(directory, fileName);
    let head: string;
    try {
      head = readFileSync(file).subarray(0, HEAD_BYTES).toString('latin1');
    } catch {
      continue;
    }
    presets.push({
      name,
      title: said(head, 'title', 80) ?? name,
      description: said(head, 'description', 400) ?? '',
      file,
    });
  }
  return presets;
}
