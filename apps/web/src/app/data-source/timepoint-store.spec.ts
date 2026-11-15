/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { keyOf, TimepointStore } from './timepoint-store';
import type { Timepoint } from './timepoints';

const MADE: Timepoint[] = [
  { id: 'a', name: 'Planning', studyUids: ['1.2.3'] },
  { id: 'b', name: 'Fraction 10', studyUids: [] },
];
const PATIENT = 'SYN-0001';

describe('TimepointStore', () => {
  const store = new TimepointStore();
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps a patient’s timepoints, and gives them back to whoever asks for that patient', async () => {
    expect(await store.read(PATIENT)).toEqual([]);
    await store.write(PATIENT, MADE);
    expect(await store.read(PATIENT)).toEqual(MADE);
    expect(await new TimepointStore().read(PATIENT)).toEqual(MADE);
    expect(await store.read('SYN-0002')).toEqual([]);
  });

  it('keeps them under a digest of the Patient ID, and nothing that says who the patient is', async () => {
    await store.write(PATIENT, MADE);
    expect(localStorage.length).toBe(1);
    const key = localStorage.key(0)!;
    expect(key).toMatch(/^open-rt-studio\.timepoints\.v1\.[0-9a-f]{64}$/);
    expect(key).toBe(await keyOf(PATIENT));
    expect(key + localStorage.getItem(key)!).not.toContain(PATIENT);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(MADE);
  });

  it('keeps nothing of a patient whose timepoints are all removed', async () => {
    await store.write(PATIENT, MADE);
    await store.write(PATIENT, []);
    expect(localStorage.length).toBe(0);
    expect(await store.read(PATIENT)).toEqual([]);
  });

  it('keeps nothing for a patient without a Patient ID, and says that it cannot', async () => {
    expect(await keyOf('  ')).toBeNull();
    await expect(store.write('', MADE)).rejects.toThrow(
      'A patient without a Patient ID cannot be known again.',
    );
    expect(localStorage.length).toBe(0);
    expect(await store.read('')).toEqual([]);
  });

  it('reads what is not timepoints as none, and only what is well formed of the rest', async () => {
    const key = (await keyOf(PATIENT))!;
    for (const kept of ['not json', '{"a":1}', 'null']) {
      localStorage.setItem(key, kept);
      expect(await store.read(PATIENT), kept).toEqual([]);
    }
    localStorage.setItem(key, JSON.stringify([MADE[0], { id: 'no name' }]));
    expect(await store.read(PATIENT)).toEqual([MADE[0]]);
  });

  it('rejects when the browser keeps nothing, and reads none when it gives nothing', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    await expect(store.write(PATIENT, MADE)).rejects.toThrow();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Denied.', 'SecurityError');
    });
    expect(await store.read(PATIENT)).toEqual([]);
  });
});
