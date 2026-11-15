/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  GENERIC_ALPHA_BETA_DEFAULTS,
  alphaBetaMap,
  parseAlphaBetaSettings,
  type Contour,
  type Roi,
} from '@open-rt-studio/dicom';

import {
  ALPHA_BETA_RULES_AT_MOST,
  ALPHA_BETA_STORAGE_KEY,
  AlphaBetaStore,
} from './alpha-beta-store';

/** A square about the voxels `from` to `to` of the first slice of a grid of 1 mm voxels. */
const square = (from: number, to: number): Contour => ({
  geometricType: 'CLOSED_PLANAR',
  points: [
    [from - 0.5, from - 0.5, 0],
    [to + 0.5, from - 0.5, 0],
    [to + 0.5, to + 0.5, 0],
    [from - 0.5, to + 0.5, 0],
  ],
});

const roiOf = (number: number, name: string, type: string | null, contours: Contour[]): Roi => ({
  number,
  name,
  color: null,
  interpretedType: type,
  contours,
});

const PTV = roiOf(1, 'PTV', 'PTV', [square(1, 4)]);
const CORD = roiOf(2, 'Cord', 'ORGAN', [square(3, 6)]);
const BODY = roiOf(3, 'Body', 'EXTERNAL', [square(0, 7)]);
const POINT = roiOf(4, 'Iso', 'ISOCENTER', [{ geometricType: 'POINT', points: [[2, 2, 0]] }]);
const ROIS = [PTV, CORD, BODY, POINT];

const said = (store: AlphaBetaStore): (readonly [string, number | null, boolean])[] =>
  store.lines().map((line) => [line.roi.name, line.alphaBetaGy, line.set] as const);

describe('AlphaBetaStore', () => {
  beforeEach(() => localStorage.removeItem(ALPHA_BETA_STORAGE_KEY));
  afterEach(() => localStorage.removeItem(ALPHA_BETA_STORAGE_KEY));

  const setUp = (): AlphaBetaStore => {
    const store = new AlphaBetaStore();
    store.setStructures(ROIS);
    return store;
  };

  it('begins with the structures that bound an area, in the set’s order, by the generic rules', () => {
    const store = setUp();
    expect(said(store)).toEqual([
      ['PTV', 10, false],
      ['Cord', 3, false],
      ['Body', null, false],
    ]);
    expect(store.without()).toBe(1);
    expect(store.outsideGy()).toBeNull();
    expect(store.defaults()).toEqual(GENERIC_ALPHA_BETA_DEFAULTS);
  });

  it('takes a value the user gives, leaves a structure out, and gives it back to the rules', () => {
    const store = setUp();
    expect(store.setValue(CORD, 2)).toBe(true);
    expect(store.setValue(BODY, 3)).toBe(true);
    expect(store.setValue(PTV, null)).toBe(true);
    expect(said(store)).toEqual([
      ['PTV', null, true],
      ['Cord', 2, true],
      ['Body', 3, true],
    ]);
    // What the rules would give is still there to be shown.
    expect(store.lines().map((line) => line.byRule)).toEqual([10, 3, null]);
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(store.setValue(CORD, bad)).toBe(false);
    }
    expect(said(store)[1]).toEqual(['Cord', 2, true]);
    store.clearValue(PTV);
    store.clearValue(CORD);
    expect(said(store)).toEqual([
      ['PTV', 10, false],
      ['Cord', 3, false],
      ['Body', 3, true],
    ]);
  });

  it('moves a structure up and down the priority, which is what the map goes by', () => {
    const store = setUp();
    const grid = { dims: [8, 8, 1], spacing: [1, 1, 1] } as const;
    const shared = 3 * 8 + 3; // In both the target and the cord.
    expect(alphaBetaMap(grid, store.lines(), store.outsideGy()).ratios[shared]).toBe(10);
    store.move(CORD, -1);
    expect(store.lines().map((line) => line.roi.name)).toEqual(['Cord', 'PTV', 'Body']);
    expect(alphaBetaMap(grid, store.lines(), store.outsideGy()).ratios[shared]).toBe(3);
    store.move(CORD, 1);
    store.move(CORD, 1);
    expect(store.lines().map((line) => line.roi.name)).toEqual(['PTV', 'Body', 'Cord']);
    // Past either end, and for a structure that is not in the list, nothing moves.
    store.move(CORD, 1);
    store.move(PTV, -1);
    store.move(POINT, 1);
    expect(store.lines().map((line) => line.roi.name)).toEqual(['PTV', 'Body', 'Cord']);
  });

  it('follows the user’s rules for the structures they have not set', () => {
    const store = setUp();
    store.setValue(CORD, 2);
    expect(store.addDefault({ by: 'name', match: ' body ', alphaBetaGy: 3 })).toBeNull();
    expect(store.addDefault({ by: 'type', match: 'ptv', alphaBetaGy: 8 })).toBeNull();
    expect(store.addDefault({ by: 'type', match: 'ORGAN', alphaBetaGy: 2.5 })).toBeNull();
    expect(said(store)).toEqual([
      ['PTV', 8, false],
      ['Cord', 2, true],
      ['Body', 3, false],
    ]);
    // A rule for the same structures takes the place of the one before it.
    expect(store.defaults().filter((rule) => rule.match.toLowerCase() === 'ptv')).toEqual([
      { by: 'type', match: 'ptv', alphaBetaGy: 8 },
    ]);
    expect(store.defaults()[0]).toEqual({ by: 'type', match: 'ORGAN', alphaBetaGy: 2.5 });
    expect(store.setDefaultValue(0, 4)).toBe(true);
    expect(store.setDefaultValue(0, 0)).toBe(false);
    expect(store.defaults()[0].alphaBetaGy).toBe(4);
    const at = store.defaults().findIndex((rule) => rule.by === 'name');
    store.removeDefault(at);
    expect(said(store)[2]).toEqual(['Body', null, false]);
    store.resetDefaults();
    expect(store.defaults()).toEqual(GENERIC_ALPHA_BETA_DEFAULTS);
    expect(said(store)[0]).toEqual(['PTV', 10, false]);
  });

  it('says why a rule is not taken', () => {
    const store = setUp();
    expect(store.addDefault({ by: 'name', match: '  ', alphaBetaGy: 3 })).toBe(
      'Type a structure name.',
    );
    expect(store.addDefault({ by: 'type', match: '', alphaBetaGy: 3 })).toBe(
      'Type a structure type.',
    );
    expect(store.addDefault({ by: 'name', match: 'Cord', alphaBetaGy: 0 })).toBe(
      'The α/β must be a number of gray more than 0.',
    );
    expect(store.defaults()).toEqual(GENERIC_ALPHA_BETA_DEFAULTS);
    for (let index = store.defaults().length; index < ALPHA_BETA_RULES_AT_MOST; index++) {
      expect(
        store.addDefault({ by: 'name', match: `Structure ${index}`, alphaBetaGy: 3 }),
      ).toBeNull();
    }
    expect(store.addDefault({ by: 'name', match: 'One more', alphaBetaGy: 3 })).toBe(
      `No more than ${ALPHA_BETA_RULES_AT_MOST} rules: take one away first.`,
    );
    // One that takes another's place is still taken.
    expect(store.addDefault({ by: 'type', match: 'ORGAN', alphaBetaGy: 2 })).toBeNull();
  });

  it('keeps the rules and the outside value in the browser, and nothing of the structures', () => {
    const store = setUp();
    store.setValue(CORD, 2);
    store.move(CORD, -1);
    expect(localStorage.getItem(ALPHA_BETA_STORAGE_KEY)).toBeNull();
    expect(store.setOutside(3)).toBe(true);
    expect(store.setOutside(-1)).toBe(false);
    store.addDefault({ by: 'name', match: 'Rectum', alphaBetaGy: 3 });
    const kept = localStorage.getItem(ALPHA_BETA_STORAGE_KEY)!;
    expect(parseAlphaBetaSettings(kept)).toEqual({
      defaults: [{ by: 'name', match: 'Rectum', alphaBetaGy: 3 }, ...GENERIC_ALPHA_BETA_DEFAULTS],
      structures: [],
      outsideGy: 3,
    });
    // The names of the structures in hand are not in it.
    expect(kept).not.toContain('Cord');
    expect(kept).not.toContain('Body');

    const again = new AlphaBetaStore();
    expect(again.outsideGy()).toBe(3);
    expect(again.defaults()[0]).toEqual({ by: 'name', match: 'Rectum', alphaBetaGy: 3 });
    expect(again.lines()).toEqual([]);
    again.setOutside(null);
    expect(new AlphaBetaStore().outsideGy()).toBeNull();
  });

  it('begins with the generic rules when what was kept is not the settings', () => {
    localStorage.setItem(ALPHA_BETA_STORAGE_KEY, '{"version":7,"defaults":"all"}');
    const store = new AlphaBetaStore();
    expect(store.defaults()).toEqual(GENERIC_ALPHA_BETA_DEFAULTS);
    expect(store.outsideGy()).toBeNull();
  });

  it('gives a summation its settings, and takes them back as they were', () => {
    const store = setUp();
    store.setValue(CORD, 2);
    store.setValue(BODY, null);
    store.move(CORD, -1);
    store.setOutside(3);
    const settings = store.settings();
    expect(settings).toEqual({
      defaults: GENERIC_ALPHA_BETA_DEFAULTS,
      structures: [
        { number: 2, name: 'Cord', alphaBetaGy: 2 },
        { number: 1, name: 'PTV', alphaBetaGy: 10 },
        { number: 3, name: 'Body', alphaBetaGy: null },
      ],
      outsideGy: 3,
    });

    localStorage.removeItem(ALPHA_BETA_STORAGE_KEY);
    const other = new AlphaBetaStore();
    // The same structures as another set reads them: other objects, the same numbers and names.
    const copies = ROIS.map((roi) => ({ ...roi }));
    const extra = roiOf(5, 'Lung', 'ORGAN', [square(5, 7)]);
    other.setStructures([...copies, extra]);
    other.restore(settings);
    expect(said(other)).toEqual([
      ['Cord', 2, true],
      ['PTV', 10, true],
      ['Body', null, true],
      // Not in the settings: after them, by the rules.
      ['Lung', 3, false],
    ]);
    expect(other.outsideGy()).toBe(3);
  });

  it('forgets what was said of structures that are no longer in hand', () => {
    const store = setUp();
    store.setValue(CORD, 2);
    store.move(BODY, -1);
    store.setStructures([PTV, BODY]);
    expect(said(store)).toEqual([
      ['PTV', 10, false],
      ['Body', null, false],
    ]);
    store.setStructures(ROIS);
    // The cord is back as a structure nothing was said of; the order the user gave the others stays.
    expect(said(store)).toEqual([
      ['PTV', 10, false],
      ['Body', null, false],
      ['Cord', 3, false],
    ]);
  });
});
