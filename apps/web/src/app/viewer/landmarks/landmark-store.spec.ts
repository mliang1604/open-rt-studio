/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { LandmarkStore } from './landmark-store';

describe('LandmarkStore', () => {
  const brief = (store: LandmarkStore) =>
    store.landmarks().map((one) => [one.name, one.fixed, one.moving]);

  it('makes a pair of a click in each image, and begins the next with the click after', () => {
    const store = new LandmarkStore();
    const first = store.place('fixed', [1, 2, 3]);
    expect(store.activeId()).toBe(first);
    expect(store.place('moving', [4, 5, 6])).toBe(first);
    expect(brief(store)).toEqual([['L1', [1, 2, 3], [4, 5, 6]]]);

    // The pair is whole: either side begins a new one.
    const second = store.place('moving', [7, 8, 9]);
    expect(second).not.toBe(first);
    expect(store.place('fixed', [0, 0, 0])).toBe(second);
    expect(brief(store)).toEqual([
      ['L1', [1, 2, 3], [4, 5, 6]],
      ['L2', [0, 0, 0], [7, 8, 9]],
    ]);
  });

  it('begins a new landmark for a second click in the same image', () => {
    const store = new LandmarkStore();
    store.place('fixed', [1, 0, 0]);
    store.place('fixed', [2, 0, 0]);
    expect(brief(store)).toEqual([
      ['L1', [1, 0, 0], null],
      ['L2', [2, 0, 0], null],
    ]);
  });

  it('places a point that was taken away again on the same landmark', () => {
    const store = new LandmarkStore();
    const first = store.place('fixed', [1, 0, 0]);
    store.place('moving', [1, 1, 0]);
    store.place('fixed', [2, 0, 0]);
    // Back to the first: its moving point is to be placed again.
    store.clearPoint(first, 'moving');
    expect(store.activeId()).toBe(first);
    expect(store.place('moving', [9, 9, 9])).toBe(first);
    expect(brief(store)[0]).toEqual(['L1', [1, 0, 0], [9, 9, 9]]);
  });

  it('moves a point, and keeps the point it is given as its own', () => {
    const store = new LandmarkStore();
    const id = store.place('fixed', [1, 0, 0]);
    const given: [number, number, number] = [5, 6, 7];
    store.setPoint(id, 'fixed', given);
    given[0] = 99;
    expect(store.landmarks()[0].fixed).toEqual([5, 6, 7]);
    // What is not a place changes nothing; nor does a landmark there is not.
    store.setPoint(id, 'fixed', [Number.NaN, 0, 0]);
    store.setPoint(999, 'fixed', [0, 0, 0]);
    expect(brief(store)).toEqual([['L1', [5, 6, 7], null]]);
  });

  it('renames, and does not take an empty name', () => {
    const store = new LandmarkStore();
    const id = store.add();
    store.rename(id, '  Carina ');
    expect(store.landmarks()[0].name).toBe('Carina');
    const before = store.landmarks();
    store.rename(id, '   ');
    store.rename(id, 'Carina');
    expect(store.landmarks()).toBe(before);
    store.rename(id, 'x'.repeat(200));
    expect(store.landmarks()[0].name).toHaveLength(64);
  });

  it('names a new landmark as none is named', () => {
    const store = new LandmarkStore();
    const first = store.add();
    store.add();
    store.remove(first);
    // Counted on from how many there are, past any name that is taken.
    store.add();
    expect(store.landmarks().map((one) => one.name)).toEqual(['L2', 'L3']);
    store.rename(store.landmarks()[1].id, 'L4');
    store.add();
    expect(store.landmarks().map((one) => one.name)).toEqual(['L2', 'L4', 'L3']);
  });

  it('removes a landmark, and it is no longer the active one', () => {
    const store = new LandmarkStore();
    const id = store.add();
    store.remove(id);
    expect(store.landmarks()).toEqual([]);
    expect(store.activeId()).toBeNull();
  });

  it('takes the landmarks of a file in place of its own, with ids of their own', () => {
    const store = new LandmarkStore();
    const old = store.place('fixed', [1, 0, 0]);
    store.replace([
      { name: 'Carina', fixed: [1, 2, 3], moving: [4, 5, 6] },
      { name: 'Apex', fixed: null, moving: [0, 0, 0] },
    ]);
    expect(brief(store)).toEqual([
      ['Carina', [1, 2, 3], [4, 5, 6]],
      ['Apex', null, [0, 0, 0]],
    ]);
    const ids = store.landmarks().map((one) => one.id);
    expect(new Set([...ids, old]).size).toBe(3);
    expect(store.activeId()).toBeNull();
  });

  it('lets go of everything on a reset, and puts the tool down', () => {
    const store = new LandmarkStore();
    store.place('fixed', [1, 0, 0]);
    store.placing.set(true);
    store.pair.set('a|b');
    store.reset();
    expect(store.landmarks()).toEqual([]);
    expect(store.activeId()).toBeNull();
    expect(store.placing()).toBe(false);
    expect(store.pair()).toBeNull();
  });
});
