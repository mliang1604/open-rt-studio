/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SyntheticFile } from '@open-rt-studio/testdata';

/** The shape Playwright's `setInputFiles` takes for an in-memory file. */
export interface InputFile {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

/**
 * Synthetic files as Playwright file-input payloads. The generators return
 * plain bytes so they stay free of Node APIs; Playwright wants Node buffers.
 */
export function toInputFiles(files: readonly SyntheticFile[]): InputFile[] {
  return files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.bytes) }));
}
