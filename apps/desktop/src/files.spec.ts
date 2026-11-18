/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FileGrant } from '@open-rt-studio/desktop-bridge';

import { fileAnswers, type Pickers } from './files.js';
import { openGrants } from './grants.js';

let scratch: string;
let chosen: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'open-rt-studio-files-')));
  chosen = join(scratch, 'thorax');
  await mkdir(chosen);
  await writeFile(join(chosen, 'slice.dcm'), 'slice');
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function answersWith(pick: Partial<Pickers> = {}) {
  const grants = await openGrants({ file: null });
  return fileAnswers(grants, {
    folder: async () => chosen,
    files: async () => [join(chosen, 'slice.dcm')],
    ...pick,
  });
}

const ID = 'Zm9sZGVyLW9mLXRlc3RzIQ';

describe("the bridge's calls about files", () => {
  it('make a grant of what the user chose in the dialog, and nothing of a dismissed one', async () => {
    const answers = await answersWith();
    const folder = (await answers['files:pick-folder'].answer()) as FileGrant;
    expect(folder).toMatchObject({ kind: 'folder', name: 'thorax' });
    expect((await answers['files:list'].answer(folder.id))?.files).toHaveLength(1);
    const files = (await answers['files:pick-files'].answer()) as FileGrant;
    expect(files).toMatchObject({ kind: 'files', name: 'slice.dcm' });
    expect(await answers['files:read'].answer(files.id, 'slice.dcm', 0, 5)).toEqual(
      new Uint8Array(Buffer.from('slice')),
    );
    expect(await answers['files:keep'].answer(folder.id)).toBe(true);
    expect(await answers['files:forget'].answer(folder.id)).toBeNull();
    expect(await answers['files:list'].answer(folder.id)).toBeNull();

    const dismissed = await answersWith({ folder: async () => null, files: async () => null });
    expect(await dismissed['files:pick-folder'].answer()).toBeNull();
    expect(await dismissed['files:pick-files'].answer()).toBeNull();
  });

  it('take no place on the disk from the page: a dialog is asked for with nothing', async () => {
    const answers = await answersWith();
    for (const channel of ['files:pick-folder', 'files:pick-files'] as const) {
      expect(answers[channel].accepts([])).toBe(true);
      expect(answers[channel].accepts(['/etc'])).toBe(false);
      expect(answers[channel].accepts([{ defaultPath: '/etc' }])).toBe(false);
    }
  });

  it('take an id as the main process makes them, and nothing else', async () => {
    const answers = await answersWith();
    for (const channel of ['files:list', 'files:keep', 'files:forget'] as const) {
      expect(answers[channel].accepts([ID])).toBe(true);
      for (const wrong of [[], [ID, ID], ['/etc'], [''], [7], [null], [[ID]], [`${ID}/..`]]) {
        expect(answers[channel].accepts(wrong), JSON.stringify(wrong)).toBe(false);
      }
    }
  });

  it('take a read of a path under a grant, from a place in it, of a length', async () => {
    const { accepts } = (await answersWith())['files:read'];
    expect(accepts([ID, 'ct/slice.dcm', 0, 4096])).toBe(true);
    expect(accepts([ID, 'slice.dcm', 2 ** 40, 0])).toBe(true);
    for (const wrong of [
      [ID, 'slice.dcm', 0],
      [ID, 'slice.dcm', 0, 10, 'more'],
      ['/etc', 'passwd', 0, 10],
      [ID, '../secret.txt', 0, 10],
      [ID, '/etc/passwd', 0, 10],
      [ID, 'ct//slice.dcm', 0, 10],
      [ID, '', 0, 10],
      [ID, ['slice.dcm'], 0, 10],
      [ID, 'slice.dcm', -1, 10],
      [ID, 'slice.dcm', 0, -1],
      [ID, 'slice.dcm', 0.5, 10],
      [ID, 'slice.dcm', '0', 10],
      [ID, 'slice.dcm', 0, Number.POSITIVE_INFINITY],
      [ID, 'slice.dcm', 0, null],
    ]) {
      expect(accepts(wrong), JSON.stringify(wrong)).toBe(false);
    }
  });

  it('show one dialog at a time', async () => {
    let open = 0;
    let most = 0;
    let close: (() => void) | undefined;
    const answers = await answersWith({
      folder: async () => {
        open += 1;
        most = Math.max(most, open);
        await new Promise<void>((resolve) => (close = resolve));
        open -= 1;
        return chosen;
      },
    });
    const first = answers['files:pick-folder'].answer();
    // While the first is open, another is as if it was dismissed, of either sort.
    expect(await answers['files:pick-folder'].answer()).toBeNull();
    expect(await answers['files:pick-files'].answer()).toBeNull();
    close!();
    expect(await first).toMatchObject({ name: 'thorax' });
    expect(most).toBe(1);
    // And afterwards a dialog opens again.
    expect(await answers['files:pick-files'].answer()).toMatchObject({ name: 'slice.dcm' });
  });
});
