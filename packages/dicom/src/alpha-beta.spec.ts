/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  AlphaBetaError,
  DEFAULT_ALPHA_BETA_SETTINGS,
  GENERIC_ALPHA_BETA_DEFAULTS,
  alphaBetaEntries,
  alphaBetaMap,
  alphaBetaSettingsOf,
  defaultAlphaBeta,
  isAlphaBeta,
  parseAlphaBetaSettings,
  serializeAlphaBetaSettings,
  type AlphaBetaEntry,
} from './alpha-beta.js';
import { eqdGy, sumDoses } from './dose-sum.js';
import type { ResampleGrid } from './resample.js';
import type { Contour, Roi, Vec3, VolumeGeometry } from './types.js';

// The structures are rectangles whose edges lie halfway between voxels, so
// which voxels are in each is plain: those whose middle is between the
// edges. What a voxel's α/β should be is worked out from that, and from the
// order of the structures, and not copied from a run.

/** 12 by 10 voxels of 1 mm on 4 slices 2 mm apart, the first voxel at the origin. */
const GRID: ResampleGrid & { geometry: VolumeGeometry } = {
  dims: [12, 10, 4],
  spacing: [1, 1, 2],
  geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 2], origin: [0, 0, 0] },
};
const [NX, NY, NZ] = GRID.dims;
const VOXELS = NX * NY * NZ;

/** A box of voxels: from `x0` to `x1` and `y0` to `y1`, on the slices `k0` to `k1`, all within. */
interface Box {
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
  readonly k: readonly [number, number];
}

const inBox = (box: Box, x: number, y: number, k: number): boolean =>
  x >= box.x[0] &&
  x <= box.x[1] &&
  y >= box.y[0] &&
  y <= box.y[1] &&
  k >= box.k[0] &&
  k <= box.k[1];

const boxVoxels = (box: Box): number =>
  (box.x[1] - box.x[0] + 1) * (box.y[1] - box.y[0] + 1) * (box.k[1] - box.k[0] + 1);

/** A rectangle about the voxels `x0` to `x1` and `y0` to `y1` on slice `k`. */
const rectangle = (x0: number, x1: number, y0: number, y1: number, k: number): Contour => {
  const z = k * 2;
  const points: Vec3[] = [
    [x0 - 0.5, y0 - 0.5, z],
    [x1 + 0.5, y0 - 0.5, z],
    [x1 + 0.5, y1 + 0.5, z],
    [x0 - 0.5, y1 + 0.5, z],
  ];
  return { geometricType: 'CLOSED_PLANAR', points };
};

function roiOf(number: number, name: string, type: string | null, contours: Contour[]): Roi {
  return { number, name, color: null, interpretedType: type, contours };
}

function boxRoi(number: number, name: string, type: string | null, box: Box): Roi {
  const contours: Contour[] = [];
  for (let k = box.k[0]; k <= box.k[1]; k++) {
    contours.push(rectangle(box.x[0], box.x[1], box.y[0], box.y[1], k));
  }
  return roiOf(number, name, type, contours);
}

// A target, an organ that overlaps it, and a body that both are within.
const TARGET: Box = { x: [2, 6], y: [2, 6], k: [1, 2] };
const ORGAN: Box = { x: [5, 9], y: [4, 8], k: [0, 2] };
const BODY: Box = { x: [1, 10], y: [1, 8], k: [0, 3] };
/** What the target and the organ share: x 5 to 6, y 4 to 6, on slices 1 and 2. */
const SHARED = 2 * 3 * 2;

const target = boxRoi(1, 'PTV', 'PTV', TARGET);
const organ = boxRoi(2, 'Cord', 'ORGAN', ORGAN);
const body = boxRoi(3, 'Body', 'EXTERNAL', BODY);

/** Each voxel with its index and its place. */
function forEachVoxel(visit: (voxel: number, x: number, y: number, k: number) => void): void {
  for (let k = 0, voxel = 0; k < NZ; k++) {
    for (let y = 0; y < NY; y++) {
      for (let x = 0; x < NX; x++, voxel++) visit(voxel, x, y, k);
    }
  }
}

describe('the α/β a structure starts with (#100)', () => {
  it('is generic and by type alone: 10 Gy for a target, 3 Gy for an organ, none otherwise', () => {
    expect(defaultAlphaBeta(target)).toBe(10);
    expect(defaultAlphaBeta(roiOf(1, 'x', 'GTV', []))).toBe(10);
    expect(defaultAlphaBeta(roiOf(1, 'x', 'CTV', []))).toBe(10);
    expect(defaultAlphaBeta(organ)).toBe(3);
    expect(defaultAlphaBeta(roiOf(1, 'x', 'AVOIDANCE', []))).toBe(3);
    // Nothing is taken from a name, and a body or a structure of no type has none.
    expect(defaultAlphaBeta(body)).toBeNull();
    expect(defaultAlphaBeta(roiOf(1, 'Spinal cord', null, []))).toBeNull();
    expect(defaultAlphaBeta(roiOf(1, 'PTV', null, []))).toBeNull();
    expect(GENERIC_ALPHA_BETA_DEFAULTS.every((rule) => rule.by === 'type')).toBe(true);
  });

  it('follows the user’s rules: one for a name before one for a type', () => {
    const rules = [
      { by: 'type', match: 'organ', alphaBetaGy: 2.5 },
      { by: 'name', match: ' cord ', alphaBetaGy: 2 },
      { by: 'name', match: 'Cord', alphaBetaGy: 0.87 },
      { by: 'type', match: 'ORGAN', alphaBetaGy: 4 },
    ] as const;
    // Without regard to case or to spaces at the ends; the first of a kind is the one.
    expect(defaultAlphaBeta(organ, rules)).toBe(2);
    expect(defaultAlphaBeta(roiOf(4, 'Lung', 'ORGAN', []), rules)).toBe(2.5);
    expect(defaultAlphaBeta(target, rules)).toBeNull();
    expect(defaultAlphaBeta(organ, [])).toBeNull();
  });

  it('passes over a rule whose value is no ratio', () => {
    const rules = [
      { by: 'name', match: 'Cord', alphaBetaGy: 0 },
      { by: 'name', match: 'Cord', alphaBetaGy: Number.NaN },
      { by: 'type', match: 'ORGAN', alphaBetaGy: 3 },
    ] as const;
    expect(defaultAlphaBeta(organ, rules)).toBe(3);
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined]) {
      expect(isAlphaBeta(value)).toBe(false);
    }
    expect(isAlphaBeta(0.5)).toBe(true);
  });
});

describe('the α/β of every voxel, from structures that overlap (#100)', () => {
  const entries: AlphaBetaEntry[] = [
    { roi: target, alphaBetaGy: 10 },
    { roi: organ, alphaBetaGy: 2 },
    { roi: body, alphaBetaGy: 3 },
  ];

  /** The α/β a voxel should have: of the first of `order` it is in. */
  const expected = (
    order: readonly (readonly [Box, number | null])[],
    outside: number,
    x: number,
    y: number,
    k: number,
  ): number => {
    for (const [box, value] of order) if (value !== null && inBox(box, x, y, k)) return value;
    return outside;
  };

  it('gives a voxel two structures are in to the first in the list', () => {
    const map = alphaBetaMap(GRID, entries, null);
    const order = [
      [TARGET, 10],
      [ORGAN, 2],
      [BODY, 3],
    ] as const;
    forEachVoxel((voxel, x, y, k) => {
      expect(map.ratios[voxel]).toBe(expected(order, 0, x, y, k));
    });
    // The shared voxels are the target's.
    expect(map.ratios[1 * NX * NY + 5 * NX + 6]).toBe(10);
    // Each has what it is within that none before it has.
    expect(map.voxels).toEqual([
      boxVoxels(TARGET),
      boxVoxels(ORGAN) - SHARED,
      boxVoxels(BODY) - boxVoxels(TARGET) - boxVoxels(ORGAN) + SHARED,
    ]);
    expect(map.outside).toBe(VOXELS - boxVoxels(BODY));
    // With no value outside, those voxels have none: 0, which is no ratio.
    expect(map.without).toBe(VOXELS - boxVoxels(BODY));
    expect(map.ratios[0]).toBe(0);
  });

  it('follows the order when it is changed', () => {
    const map = alphaBetaMap(GRID, [entries[1], entries[0], entries[2]], null);
    const order = [
      [ORGAN, 2],
      [TARGET, 10],
      [BODY, 3],
    ] as const;
    forEachVoxel((voxel, x, y, k) => {
      expect(map.ratios[voxel]).toBe(expected(order, 0, x, y, k));
    });
    expect(map.ratios[1 * NX * NY + 5 * NX + 6]).toBe(2);
    expect(map.voxels).toEqual([
      boxVoxels(ORGAN),
      boxVoxels(TARGET) - SHARED,
      boxVoxels(BODY) - boxVoxels(TARGET) - boxVoxels(ORGAN) + SHARED,
    ]);
    // The body first has everything within it.
    const bodyFirst = alphaBetaMap(GRID, [entries[2], entries[0], entries[1]], null);
    expect(bodyFirst.voxels).toEqual([boxVoxels(BODY), 0, 0]);
  });

  it('gives the outside value to a voxel in no structure, when there is one', () => {
    const map = alphaBetaMap(GRID, entries, 2.5);
    const order = [
      [TARGET, 10],
      [ORGAN, 2],
      [BODY, 3],
    ] as const;
    forEachVoxel((voxel, x, y, k) => {
      expect(map.ratios[voxel]).toBe(expected(order, 2.5, x, y, k));
    });
    expect(map.outside).toBe(VOXELS - boxVoxels(BODY));
    expect(map.without).toBe(0);
    // With no structures at all, every voxel is outside.
    const none = alphaBetaMap(GRID, [], 3);
    expect(none.outside).toBe(VOXELS);
    expect([...none.ratios].every((ratio) => ratio === 3)).toBe(true);
    expect(alphaBetaMap(GRID, [], null).without).toBe(VOXELS);
  });

  it('leaves a structure with no value out: its voxels are the next one’s, or outside', () => {
    const map = alphaBetaMap(
      GRID,
      [
        { roi: target, alphaBetaGy: null },
        { roi: organ, alphaBetaGy: 2 },
      ],
      null,
    );
    const order = [
      [TARGET, null],
      [ORGAN, 2],
    ] as const;
    forEachVoxel((voxel, x, y, k) => {
      expect(map.ratios[voxel]).toBe(expected(order, 0, x, y, k));
    });
    expect(map.voxels).toEqual([0, boxVoxels(ORGAN)]);
    expect(map.outside).toBe(VOXELS - boxVoxels(ORGAN));
  });

  it('does not fill a hole in a structure', () => {
    // A ring: the body's outline on one slice with the target's cut out of it.
    const ring = roiOf(4, 'Ring', 'ORGAN', [rectangle(1, 10, 1, 8, 1), rectangle(2, 6, 2, 6, 1)]);
    const map = alphaBetaMap(GRID, [{ roi: ring, alphaBetaGy: 3 }], null);
    expect(map.voxels).toEqual([10 * 8 - 5 * 5]);
    expect(map.ratios[1 * NX * NY + 4 * NX + 4]).toBe(0);
    expect(map.ratios[1 * NX * NY + 1 * NX + 1]).toBe(3);
  });

  it('refuses a value that is no ratio, and a structure not drawn on the grid’s slices', () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => alphaBetaMap(GRID, [{ roi: target, alphaBetaGy: bad }], null)).toThrow(
        'The α/β of “PTV” is not a number of gray more than 0.',
      );
      expect(() => alphaBetaMap(GRID, entries, bad)).toThrow(
        'The α/β outside the structures is not a number of gray more than 0.',
      );
    }
    expect(() => alphaBetaMap(GRID, [{ roi: target, alphaBetaGy: 0 }], null)).toThrow(
      AlphaBetaError,
    );
    // Between two slices, and beyond the last.
    const between = roiOf(5, 'Between', null, [
      {
        ...rectangle(2, 6, 2, 6, 1),
        points: rectangle(2, 6, 2, 6, 1).points.map(([x, y]) => [x, y, 2.6]),
      },
    ]);
    const beyond = roiOf(6, 'Beyond', null, [rectangle(2, 6, 2, 6, 7)]);
    for (const [roi, name] of [
      [between, 'Between'],
      [beyond, 'Beyond'],
    ] as const) {
      expect(() => alphaBetaMap(GRID, [{ roi, alphaBetaGy: 3 }], null)).toThrow(
        `“${name}” is not drawn on the slices of the grid the doses are summed on.`,
      );
      // With no value it takes no part, and is not looked at.
      expect(alphaBetaMap(GRID, [{ roi, alphaBetaGy: null }], 3).outside).toBe(VOXELS);
    }
  });
});

describe('a converted dose follows the α/β of its voxels (#100)', () => {
  // 20 Gy in 5 fractions everywhere, on the grid itself.
  const dose = { ...GRID, data: new Float32Array(VOXELS).fill(20) };
  const terms = [{ dose, through: null, weight: 1, fractions: 5 }];
  const convert = (entries: readonly AlphaBetaEntry[], outsideGy: number | null) => {
    const map = alphaBetaMap(GRID, entries, outsideGy);
    return {
      map,
      sum: sumDoses(GRID, terms, { kind: 'eqd', alphaBetaGy: map.ratios, fractionGy: 2 }),
    };
  };
  const inTarget = 1 * NX * NY + 3 * NX + 3;
  const inShared = 1 * NX * NY + 5 * NX + 6;
  const inOrgan = 0 * NX * NY + 7 * NX + 8;
  const outside = 0;

  it('is the hand-calculated EQD2 of each structure’s α/β', () => {
    const { sum, map } = convert(
      [
        { roi: target, alphaBetaGy: 10 },
        { roi: organ, alphaBetaGy: 3 },
      ],
      null,
    );
    // 20 Gy in 5: EQD2 23.33 Gy at α/β 10 Gy and 28 Gy at 3 Gy.
    expect(sum.data[inTarget]).toBeCloseTo(70 / 3, 4);
    expect(sum.data[inShared]).toBeCloseTo(70 / 3, 4);
    expect(sum.data[inOrgan]).toBeCloseTo(28, 4);
    // Outside both there is no α/β, and no sum.
    expect(sum.known[outside]).toBe(0);
    expect(sum.withoutAlphaBeta).toBe(map.without);
    expect(sum.knownCount).toBe(VOXELS - map.without);
  });

  it('changes when a value is changed, and only where that structure has the voxel', () => {
    const before = convert(
      [
        { roi: target, alphaBetaGy: 10 },
        { roi: organ, alphaBetaGy: 3 },
      ],
      3,
    ).sum;
    const after = convert(
      [
        { roi: target, alphaBetaGy: 10 },
        { roi: organ, alphaBetaGy: 2 },
      ],
      3,
    ).sum;
    // 20 Gy in 5 at α/β 2 Gy: 20 × (4 + 2) / (2 + 2) = 30 Gy.
    expect(before.data[inOrgan]).toBeCloseTo(28, 4);
    expect(after.data[inOrgan]).toBeCloseTo(30, 4);
    expect(after.data[inOrgan]).toBeCloseTo(eqdGy(20, 5, 2), 4);
    forEachVoxel((voxel, x, y, k) => {
      const organs = inBox(ORGAN, x, y, k) && !inBox(TARGET, x, y, k);
      if (organs) expect(after.data[voxel]).not.toBe(before.data[voxel]);
      else expect(after.data[voxel]).toBe(before.data[voxel]);
    });
    // And when the order is changed, where the two overlap.
    const swapped = convert(
      [
        { roi: organ, alphaBetaGy: 3 },
        { roi: target, alphaBetaGy: 10 },
      ],
      3,
    ).sum;
    expect(before.data[inShared]).toBeCloseTo(70 / 3, 4);
    expect(swapped.data[inShared]).toBeCloseTo(28, 4);
    expect(swapped.data[inTarget]).toBe(before.data[inTarget]);
    // And the outside value, outside.
    expect(before.data[outside]).toBeCloseTo(28, 4);
    expect(before.withoutAlphaBeta).toBe(0);
  });
});

describe('the α/β settings that are kept (#100)', () => {
  const open = roiOf(7, 'Line', 'ORGAN', [
    { geometricType: 'OPEN_PLANAR', points: rectangle(1, 2, 1, 2, 0).points },
  ]);
  const rois = [target, organ, body, open];

  it('begin with every structure that bounds an area, in the set’s order, by the rules', () => {
    const entries = alphaBetaEntries(rois);
    expect(entries.map((one) => [one.roi.name, one.alphaBetaGy])).toEqual([
      ['PTV', 10],
      ['Cord', 3],
      ['Body', null],
    ]);
    expect(alphaBetaEntries(rois, DEFAULT_ALPHA_BETA_SETTINGS)).toEqual(entries);
  });

  it('put the structures the user has set first, in their order and with their values', () => {
    const settings = {
      defaults: [{ by: 'name', match: 'PTV', alphaBetaGy: 8 }] as const,
      structures: [
        { number: 3, name: 'Body', alphaBetaGy: 3 },
        { number: 2, name: 'Cord', alphaBetaGy: null },
        // Of another structure set: no structure here has both this number and name.
        { number: 1, name: 'Bladder', alphaBetaGy: 5 },
        { number: 9, name: 'PTV', alphaBetaGy: 5 },
      ],
      outsideGy: 3,
    };
    const entries = alphaBetaEntries(rois, settings);
    expect(entries.map((one) => [one.roi.name, one.alphaBetaGy])).toEqual([
      ['Body', 3],
      // Left without one by the user: the rules do not give it one again.
      ['Cord', null],
      // Not in the settings: after them, by the user's rule.
      ['PTV', 8],
    ]);
    // What is kept of them says the same again.
    const kept = alphaBetaSettingsOf(entries, settings.defaults, settings.outsideGy);
    expect(kept.structures).toEqual([
      { number: 3, name: 'Body', alphaBetaGy: 3 },
      { number: 2, name: 'Cord', alphaBetaGy: null },
      { number: 1, name: 'PTV', alphaBetaGy: 8 },
    ]);
    expect(alphaBetaEntries(rois, kept)).toEqual(entries);
  });

  it('are read back as they were written', () => {
    const settings = {
      defaults: [
        { by: 'name', match: 'Cord', alphaBetaGy: 2 },
        { by: 'type', match: 'PTV', alphaBetaGy: 10 },
      ] as const,
      structures: [
        { number: 2, name: 'Cord', alphaBetaGy: 2 },
        { number: 1, name: 'PTV', alphaBetaGy: null },
      ],
      outsideGy: 3,
    };
    expect(parseAlphaBetaSettings(serializeAlphaBetaSettings(settings))).toEqual(settings);
    expect(parseAlphaBetaSettings(serializeAlphaBetaSettings(DEFAULT_ALPHA_BETA_SETTINGS))).toEqual(
      DEFAULT_ALPHA_BETA_SETTINGS,
    );
  });

  it('are not guessed at when they are not as they should be', () => {
    for (const text of [null, '', 'not json', '3', 'null', '[]', '{"version":2,"defaults":[]}']) {
      expect(parseAlphaBetaSettings(text)).toBeNull();
    }
    const read = parseAlphaBetaSettings(
      JSON.stringify({
        version: 1,
        defaults: [
          { by: 'name', match: 'Cord', alphaBetaGy: 2 },
          { by: 'colour', match: 'Cord', alphaBetaGy: 2 },
          { by: 'name', match: '  ', alphaBetaGy: 2 },
          { by: 'type', match: 'ORGAN', alphaBetaGy: -3 },
          { by: 'type', match: 'ORGAN', alphaBetaGy: '3' },
          'nothing',
          null,
        ],
        structures: [
          { number: 1, name: 'PTV', alphaBetaGy: 10 },
          { number: 2, name: 'Cord', alphaBetaGy: 0 },
          { number: 2.5, name: 'Half', alphaBetaGy: 3 },
          { number: 3, alphaBetaGy: 3 },
        ],
        outsideGy: 'three',
      }),
    );
    expect(read).toEqual({
      defaults: [{ by: 'name', match: 'Cord', alphaBetaGy: 2 }],
      structures: [
        { number: 1, name: 'PTV', alphaBetaGy: 10 },
        // A value that is no ratio is none.
        { number: 2, name: 'Cord', alphaBetaGy: null },
      ],
      outsideGy: null,
    });
    expect(parseAlphaBetaSettings('{"version":1}')).toEqual({
      defaults: [],
      structures: [],
      outsideGy: null,
    });
  });
});
