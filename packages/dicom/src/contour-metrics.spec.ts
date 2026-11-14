/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { compareMasks, compareRois, MaskComparisonError } from './contour-metrics.js';
import type { Contour, Roi, Vec3, Volume, VolumeGeometry } from './types.js';
import { voxelToPatient } from './volume.js';

type Dims = [number, number, number];

/** A mask of the voxels a test says are in it. */
function mask(dims: Dims, inside: (x: number, y: number, z: number) => boolean): Uint8Array {
  const [nx, ny, nz] = dims;
  const out = new Uint8Array(nx * ny * nz);
  for (let z = 0, i = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) out[i] = inside(x, y, z) ? 1 : 0;
    }
  }
  return out;
}

/** A box of voxels from `min` to `max`, both in it. */
const box =
  (min: Vec3, max: Vec3) =>
  (x: number, y: number, z: number): boolean =>
    x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2];

/** A ball about a point of the grid, by voxel centres, in mm. */
const ball =
  (centre: Vec3, radiusMm: number, spacing: Vec3) =>
  (x: number, y: number, z: number): boolean =>
    Math.hypot(
      (x - centre[0]) * spacing[0],
      (y - centre[1]) * spacing[1],
      (z - centre[2]) * spacing[2],
    ) <= radiusMm;

const UNIT: Vec3 = [1, 1, 1];

describe('compareMasks: the overlap', () => {
  const dims: Dims = [12, 8, 8];

  it('is 1, and no distance, for a mask against itself', () => {
    const a = mask(dims, box([2, 2, 2], [6, 5, 5]));
    const same = compareMasks(a, a, dims, UNIT);
    expect(same).toMatchObject({ voxelsA: 80, voxelsB: 80, voxelsBoth: 80, dice: 1 });
    expect(same.surface).toMatchObject({ meanMm: 0, p95Mm: 0, maxMm: 0 });
  });

  it('is what two equal boxes share when one is moved along', () => {
    // Two boxes of 4 × 4 × 4, the second 1 voxel along x: they share 3 of 4.
    const a = mask(dims, box([2, 2, 2], [5, 5, 5]));
    const b = mask(dims, box([3, 2, 2], [6, 5, 5]));
    const found = compareMasks(a, b, dims, UNIT);
    expect(found).toMatchObject({ voxelsA: 64, voxelsB: 64, voxelsBoth: 48 });
    expect(found.dice).toBeCloseTo(3 / 4, 12);
  });

  it('is 0 for masks that do not touch, with the distance between them', () => {
    const a = mask(dims, box([1, 2, 2], [2, 3, 3]));
    const b = mask(dims, box([8, 2, 2], [9, 3, 3]));
    const found = compareMasks(a, b, dims, UNIT);
    expect(found.dice).toBe(0);
    // Every voxel of a small box is on its surface: the nearest of the other
    // is 6 away from the near face and 7 from the far one.
    expect(found.surface!.aToB).toMatchObject({ count: 8, meanMm: 6.5, maxMm: 7 });
    expect(found.surface!.maxMm).toBe(7);
  });

  it('counts the volume of a voxel by the spacing', () => {
    const a = mask(dims, box([2, 2, 2], [5, 5, 5]));
    expect(compareMasks(a, a, dims, [0.5, 0.5, 3]).voxelMm3).toBeCloseTo(0.75, 12);
  });

  it('takes any element that is not 0 as in the mask', () => {
    const a = mask(dims, box([2, 2, 2], [5, 5, 5]));
    const labelled = Uint8Array.from(a, (value) => value * 7);
    expect(compareMasks(labelled, a, dims, UNIT).dice).toBe(1);
  });
});

describe('compareMasks: the surface distances', () => {
  it('are the shift, for a box moved by whole voxels', () => {
    const dims: Dims = [16, 10, 10];
    const a = mask(dims, box([2, 2, 2], [7, 7, 7]));
    const b = mask(dims, box([5, 2, 2], [10, 7, 7]));
    const { surface } = compareMasks(a, b, dims, [0.8, 1, 1]);
    // The far face of each is 3 voxels of 0.8 mm from the other's surface.
    expect(surface!.maxMm).toBeCloseTo(2.4, 12);
    expect(surface!.aToB.maxMm).toBeCloseTo(2.4, 12);
    expect(surface!.bToA.maxMm).toBeCloseTo(2.4, 12);
    // The two are mirror images: each way is the same.
    expect(surface!.aToB.meanMm).toBeCloseTo(surface!.bToA.meanMm, 12);
    expect(surface!.meanMm).toBeCloseTo(surface!.aToB.meanMm, 12);
  });

  it('are the margin from a box to one that is larger by it all round, and more at its corners', () => {
    const dims: Dims = [14, 14, 14];
    const inner = mask(dims, box([4, 4, 4], [9, 9, 9]));
    const outer = mask(dims, box([2, 2, 2], [11, 11, 11]));
    const { surface, dice } = compareMasks(inner, outer, dims, UNIT);
    // 6³ in 10³.
    expect(dice).toBeCloseTo((2 * 216) / (216 + 1000), 12);
    // From the inner box every surface voxel is 2 from the outer surface.
    expect(surface!.aToB).toMatchObject({ meanMm: 2, p95Mm: 2, maxMm: 2 });
    expect(surface!.aToB.count).toBe(216 - 64);
    // From the outer box, its corner is 2 along each of three axes from the
    // inner one's corner.
    expect(surface!.bToA.maxMm).toBeCloseTo(2 * Math.sqrt(3), 12);
    expect(surface!.maxMm).toBeCloseTo(2 * Math.sqrt(3), 12);
    expect(surface!.bToA.count).toBe(1000 - 512);
    // Both directions together, each surface voxel once.
    const pooled =
      (surface!.aToB.meanMm * surface!.aToB.count + surface!.bToA.meanMm * surface!.bToA.count) /
      (surface!.aToB.count + surface!.bToA.count);
    expect(surface!.meanMm).toBeCloseTo(pooled, 12);
    expect(surface!.p95Mm).toBe(Math.max(surface!.aToB.p95Mm, surface!.bToA.p95Mm));
  });

  it('use the spacing of each axis', () => {
    const dims: Dims = [8, 8, 12];
    const a = mask(dims, box([2, 2, 2], [5, 5, 5]));
    const b = mask(dims, box([2, 2, 4], [5, 5, 7]));
    // Moved 2 slices of 2.5 mm.
    expect(compareMasks(a, b, dims, [1, 1, 2.5]).surface!.maxMm).toBeCloseTo(5, 12);
    // With fine slices the nearest surface voxel of the other is along z.
    expect(compareMasks(a, b, dims, [1, 1, 0.1]).surface!.maxMm).toBeCloseTo(0.2, 12);
  });

  it('are between single voxels the distance between them', () => {
    const dims: Dims = [6, 6, 6];
    const a = mask(dims, (x, y, z) => x === 1 && y === 1 && z === 1);
    const b = mask(dims, (x, y, z) => x === 4 && y === 5 && z === 1);
    const { surface } = compareMasks(a, b, dims, [2, 1, 1]);
    // 3 voxels of 2 mm and 4 of 1 mm: 6 and 4.
    const apart = Math.hypot(6, 4);
    for (const way of [surface!.aToB, surface!.bToA]) {
      expect(way.count).toBe(1);
      expect(way.meanMm).toBeCloseTo(apart, 12);
      expect(way.p95Mm).toBeCloseTo(apart, 12);
      expect(way.maxMm).toBeCloseTo(apart, 12);
    }
    expect(surface!.meanMm).toBeCloseTo(apart, 12);
  });

  it('take the edge of the grid as outside: a mask that fills it has a surface', () => {
    const dims: Dims = [4, 4, 4];
    const full = mask(dims, () => true);
    const core = mask(dims, box([1, 1, 1], [2, 2, 2]));
    const { surface } = compareMasks(full, core, dims, UNIT);
    // The outer shell, 64 − 8 voxels, and the 8 of the core, all on a surface.
    expect(surface!.aToB.count).toBe(56);
    expect(surface!.bToA.count).toBe(8);
    expect(surface!.bToA.maxMm).toBe(1);
    expect(surface!.aToB.maxMm).toBeCloseTo(Math.sqrt(3), 12);
  });

  it('give a 95th percentile that one stray voxel does not decide', () => {
    const dims: Dims = [40, 12, 12];
    const a = mask(dims, box([2, 2, 2], [9, 9, 9]));
    // The same box, and one voxel far off.
    const b = mask(
      dims,
      (x, y, z) => box([2, 2, 2], [9, 9, 9])(x, y, z) || (x === 35 && y === 5 && z === 5),
    );
    const { surface } = compareMasks(a, b, dims, UNIT);
    expect(surface!.maxMm).toBe(26);
    expect(surface!.p95Mm).toBe(0);
    expect(surface!.bToA.count).toBe(surface!.aToB.count + 1);
  });

  it('take the 95th percentile by nearest rank', () => {
    // A row of 20 single voxels against one voxel at its start: distances 0 to 19.
    const dims: Dims = [20, 1, 1];
    const row = mask(dims, () => true);
    const first = mask(dims, (x) => x === 0);
    const { surface } = compareMasks(row, first, dims, UNIT);
    expect(surface!.aToB.count).toBe(20);
    // 95 in 100 of 20 is 19: the 19th smallest, which is 18.
    expect(surface!.aToB.p95Mm).toBe(18);
    expect(surface!.aToB.maxMm).toBe(19);
    expect(surface!.aToB.meanMm).toBe(9.5);
  });
});

describe('compareMasks: against shapes with a formula', () => {
  it('gives the difference of the radii for one ball inside another', () => {
    const dims: Dims = [64, 64, 64];
    const spacing: Vec3 = [1, 1, 1];
    const centre: Vec3 = [31.5, 31.5, 31.5];
    const [small, large] = [14, 22];
    const a = mask(dims, ball(centre, small, spacing));
    const b = mask(dims, ball(centre, large, spacing));
    const { surface, dice } = compareMasks(a, b, dims, spacing);
    // Every point of either sphere is 8 mm from the other. On voxels the
    // surfaces are within a voxel of the spheres.
    expect(Math.abs(surface!.meanMm - (large - small))).toBeLessThan(0.5);
    expect(Math.abs(surface!.maxMm - (large - small))).toBeLessThan(1.5);
    expect(Math.abs(surface!.p95Mm - (large - small))).toBeLessThan(1);
    // The overlap is the small ball: 2 r³ / (r³ + R³).
    const expected = (2 * small ** 3) / (small ** 3 + large ** 3);
    expect(Math.abs(dice! - expected)).toBeLessThan(0.01);
  });

  it('gives the overlap of two equal balls moved apart, and their offset as the largest distance', () => {
    const dims: Dims = [80, 56, 56];
    const spacing: Vec3 = [1, 1, 1];
    const [radius, offset] = [20, 10];
    const a = mask(dims, ball([27.5, 27.5, 27.5], radius, spacing));
    const b = mask(dims, ball([27.5 + offset, 27.5, 27.5], radius, spacing));
    const { surface, dice } = compareMasks(a, b, dims, spacing);
    // The lens two balls of radius r share at distance d has the volume
    // π (4r + d)(2r − d)² / 12; over the volume of one ball that is Dice.
    const lens = (Math.PI * (4 * radius + offset) * (2 * radius - offset) ** 2) / 12;
    const expected = lens / ((4 / 3) * Math.PI * radius ** 3);
    expect(Math.abs(dice! - expected)).toBeLessThan(0.01);
    // The far pole of each ball is the offset from the other's surface.
    expect(Math.abs(surface!.maxMm - offset)).toBeLessThan(1);
    expect(surface!.aToB.meanMm).toBeCloseTo(surface!.bToA.meanMm, 9);
  });

  it('gives the same on a finer grid with other spacing along each axis', () => {
    const dims: Dims = [90, 60, 30];
    const spacing: Vec3 = [0.5, 0.75, 1.5];
    const centre: Vec3 = [44.5, 29.5, 14.5];
    const a = mask(dims, ball(centre, 10, spacing));
    const b = mask(dims, ball(centre, 16, spacing));
    const { surface } = compareMasks(a, b, dims, spacing);
    expect(Math.abs(surface!.meanMm - 6)).toBeLessThan(0.75);
    expect(Math.abs(surface!.maxMm - 6)).toBeLessThan(1.6);
  });
});

describe('compareMasks: the distances are exact', () => {
  /** The same numbers by trying every pair of surface voxels. */
  function bruteForce(a: Uint8Array, b: Uint8Array, dims: Dims, spacing: Vec3) {
    const [nx, ny, nz] = dims;
    const at = (m: Uint8Array, x: number, y: number, z: number): boolean =>
      x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && m[x + nx * (y + ny * z)] !== 0;
    const surface = (m: Uint8Array): Vec3[] => {
      const out: Vec3[] = [];
      for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) {
            if (!at(m, x, y, z)) continue;
            const inside =
              at(m, x - 1, y, z) &&
              at(m, x + 1, y, z) &&
              at(m, x, y - 1, z) &&
              at(m, x, y + 1, z) &&
              at(m, x, y, z - 1) &&
              at(m, x, y, z + 1);
            if (!inside) out.push([x, y, z]);
          }
        }
      }
      return out;
    };
    const directed = (from: Vec3[], to: Vec3[]): number[] =>
      from
        .map((p) =>
          Math.min(
            ...to.map((q) =>
              Math.hypot(
                (p[0] - q[0]) * spacing[0],
                (p[1] - q[1]) * spacing[1],
                (p[2] - q[2]) * spacing[2],
              ),
            ),
          ),
        )
        .sort((x, y) => x - y);
    const [sa, sb] = [surface(a), surface(b)];
    return { aToB: directed(sa, sb), bToA: directed(sb, sa) };
  }

  it('agrees with every pair tried, on irregular masks and uneven spacing', () => {
    // A generator with a fixed seed: the same masks every run.
    let seed = 20261114;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const dims: Dims = [13, 11, 9];
    const spacing: Vec3 = [0.7, 1.3, 2.1];
    for (let round = 0; round < 6; round++) {
      const fill = 0.15 + 0.12 * round;
      const a = mask(dims, () => random() < fill);
      const b = mask(dims, (x) => x > 2 && random() < fill);
      const found = compareMasks(a, b, dims, spacing).surface!;
      const tried = bruteForce(a, b, dims, spacing);
      for (const way of ['aToB', 'bToA'] as const) {
        const distances = tried[way];
        const mean = distances.reduce((sum, d) => sum + d, 0) / distances.length;
        expect(found[way].count).toBe(distances.length);
        expect(found[way].meanMm).toBeCloseTo(mean, 9);
        expect(found[way].maxMm).toBeCloseTo(distances.at(-1)!, 9);
        expect(found[way].p95Mm).toBeCloseTo(
          distances[Math.max(1, Math.ceil(0.95 * distances.length)) - 1],
          9,
        );
      }
    }
  });

  it('does not depend on how much empty grid there is round the masks', () => {
    const inside = box([1, 1, 1], [4, 3, 2]);
    const other = box([2, 2, 1], [6, 5, 4]);
    const small: Dims = [8, 7, 6];
    const tight = compareMasks(mask(small, inside), mask(small, other), small, [1, 2, 3]);
    // The same two boxes, 9, 4 and 7 voxels into a much larger grid.
    const large: Dims = [30, 20, 25];
    const moved = (shape: (x: number, y: number, z: number) => boolean) =>
      mask(large, (x, y, z) => shape(x - 9, y - 4, z - 7));
    expect(compareMasks(moved(inside), moved(other), large, [1, 2, 3])).toEqual(tight);
  });
});

describe('compareMasks: what cannot be compared', () => {
  const dims: Dims = [4, 4, 4];
  const empty = new Uint8Array(64);
  const some = mask(dims, box([1, 1, 1], [2, 2, 2]));

  it('has no overlap to speak of when both masks are empty', () => {
    expect(compareMasks(empty, empty, dims, UNIT)).toEqual({
      voxelsA: 0,
      voxelsB: 0,
      voxelsBoth: 0,
      voxelMm3: 1,
      dice: null,
      surface: null,
    });
  });

  it('has an overlap of 0 and no surface distance when one mask is empty', () => {
    expect(compareMasks(some, empty, dims, UNIT)).toMatchObject({ dice: 0, surface: null });
    expect(compareMasks(empty, some, dims, UNIT)).toMatchObject({ dice: 0, surface: null });
  });

  it('refuses masks that are not on the grid, and a grid or spacing that is none', () => {
    expect(() => compareMasks(new Uint8Array(63), some, dims, UNIT)).toThrow(MaskComparisonError);
    expect(() => compareMasks(some, some, [4, 4, 0], UNIT)).toThrow(MaskComparisonError);
    expect(() => compareMasks(some, some, dims, [1, 0, 1])).toThrow(MaskComparisonError);
    expect(() => compareMasks(some, some, dims, [1, Number.NaN, 1])).toThrow(MaskComparisonError);
  });
});

describe('compareRois', () => {
  // A grid of 0.5 × 0.5 mm pixels on slices 2 mm apart, away from the origin.
  const geometry: VolumeGeometry = {
    iStep: [0.5, 0, 0],
    jStep: [0, 0.5, 0],
    kStep: [0, 0, 2],
    origin: [-40, 12, 100],
  };
  const volume = (geom: VolumeGeometry = geometry): Volume =>
    ({
      dims: [12, 10, 6],
      spacing: [0.5, 0.5, 2],
      data: new Float32Array(0),
      modality: 'CT',
      geometry: geom,
    }) as unknown as Volume;

  /** A structure that fills pixels `x0..x1`, `y0..y1` on slices `z0..z1`: one square contour a slice. */
  function boxRoi(
    [x0, x1]: [number, number],
    [y0, y1]: [number, number],
    [z0, z1]: [number, number],
    more: readonly Contour[] = [],
  ): Roi {
    const contours: Contour[] = [...more];
    for (let z = z0; z <= z1; z++) {
      const corners: [number, number][] = [
        [x0 - 0.5, y0 - 0.5],
        [x1 + 0.5, y0 - 0.5],
        [x1 + 0.5, y1 + 0.5],
        [x0 - 0.5, y1 + 0.5],
      ];
      contours.push({
        geometricType: 'CLOSED_PLANAR',
        points: corners.map(([x, y]) => voxelToPatient(geometry, [x, y, z])),
      });
    }
    return { number: 1, name: 'Box', color: [255, 0, 0], interpretedType: 'ORGAN', contours };
  }

  it('compares two structures as the voxels of the image’s grid', () => {
    const a = boxRoi([2, 5], [2, 5], [1, 4]);
    const b = boxRoi([3, 6], [2, 5], [1, 4]);
    const found = compareRois(volume(), a, b);
    expect(found).toMatchObject({ voxelsA: 64, voxelsB: 64, voxelsBoth: 48, skippedA: 0 });
    expect(found.dice).toBeCloseTo(0.75, 12);
    expect(found.spacingMm).toEqual([0.5, 0.5, 2]);
    expect(found.voxelMm3).toBeCloseTo(0.5, 12);
    // Moved one pixel of 0.5 mm.
    expect(found.surface!.maxMm).toBeCloseTo(0.5, 12);
  });

  it('measures across slices in mm', () => {
    const a = boxRoi([2, 5], [2, 5], [1, 2]);
    const b = boxRoi([2, 5], [2, 5], [2, 3]);
    // One slice of 2 mm further; within a slice the far edge is nearer than that.
    const { surface } = compareRois(volume(), a, b);
    expect(surface!.maxMm).toBeCloseTo(2, 12);
  });

  it('says how many contours of each bound no area and were left out', () => {
    const line: Contour = {
      geometricType: 'OPEN_PLANAR',
      points: [voxelToPatient(geometry, [1, 1, 1]), voxelToPatient(geometry, [4, 1, 1])],
    };
    const a = boxRoi([2, 5], [2, 5], [1, 4], [line]);
    const found = compareRois(volume(), a, boxRoi([2, 5], [2, 5], [1, 4]));
    expect(found).toMatchObject({ skippedA: 1, skippedB: 0, dice: 1 });
  });

  it('has no surface distance for a structure with nothing on this image', () => {
    const none: Roi = { ...boxRoi([2, 5], [2, 5], [1, 4]), contours: [] };
    expect(compareRois(volume(), boxRoi([2, 5], [2, 5], [1, 4]), none)).toMatchObject({
      voxelsB: 0,
      dice: 0,
      surface: null,
    });
  });

  it('refuses a grid whose slices are tilted', () => {
    const tilted: VolumeGeometry = { ...geometry, kStep: [0, 0.7, 2] };
    const roi = boxRoi([2, 5], [2, 5], [1, 4]);
    expect(() => compareRois(volume(tilted), roi, roi)).toThrow(MaskComparisonError);
    expect(() => compareRois(volume(tilted), roi, roi)).toThrow(/not rectangular/);
  });

  it('takes a grid that is rectangular but turned in the patient', () => {
    // The same grid turned a quarter about z: x runs along the patient's y.
    const turned: VolumeGeometry = {
      iStep: [0, 0.5, 0],
      jStep: [-0.5, 0, 0],
      kStep: [0, 0, 2],
      origin: [-40, 12, 100],
    };
    const square = (x0: number): Roi => ({
      number: 1,
      name: 'Box',
      color: [255, 0, 0],
      interpretedType: 'ORGAN',
      contours: [1, 2].map((z) => ({
        geometricType: 'CLOSED_PLANAR',
        points: (
          [
            [x0 - 0.5, 1.5],
            [x0 + 3.5, 1.5],
            [x0 + 3.5, 5.5],
            [x0 - 0.5, 5.5],
          ] as [number, number][]
        ).map(([x, y]) => voxelToPatient(turned, [x, y, z])),
      })),
    });
    const found = compareRois(volume(turned), square(2), square(4));
    expect(found.spacingMm).toEqual([0.5, 0.5, 2]);
    expect(found.dice).toBeCloseTo(0.5, 12);
    expect(found.surface!.maxMm).toBeCloseTo(1, 12);
  });
});
