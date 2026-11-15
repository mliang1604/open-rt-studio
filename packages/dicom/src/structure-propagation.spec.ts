/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { loopArea } from './iso-contours.js';
import {
  IDENTITY_MAT4,
  invertMat4,
  multiplyMat4,
  rigidMat4,
  transformPoint,
  type Mat4,
} from './mat4.js';
import type { DeformationGrid } from './registration.js';
import type { ResampleGrid } from './resample.js';
import { ON_PLANE_MM, propagateRois, type PropagateThrough } from './structure-propagation.js';
import type { Contour, Roi, Vec3 } from './types.js';

// A sphere drawn on one image, taken to another through transforms whose
// result is known: a sphere again, with its centre where the transform puts
// it. Every point of every contour that comes out is held against that.

type Dims = readonly [number, number, number];

/** A grid with its axes along the patient's. */
const grid = (dims: Dims, spacing: Vec3, origin: Vec3): ResampleGrid => ({
  dims,
  spacing,
  geometry: {
    iStep: [spacing[0], 0, 0],
    jStep: [0, spacing[1], 0],
    kStep: [0, 0, spacing[2]],
    origin,
  },
});

/** The source image: voxels of 1 × 1 × 2 mm. */
const SOURCE = grid([48, 48, 30], [1, 1, 2], [-24, -24, -30]);
const CENTRE: Vec3 = [0.3, -1.2, 0.5];
const RADIUS = 12;
const SPHERE_MM3 = (4 / 3) * Math.PI * RADIUS ** 3;

/** A circle of `count` points about `(cx, cy)` on the plane `z`. */
function circle(cx: number, cy: number, z: number, radius: number, count = 90): Contour {
  const points: Vec3[] = [];
  for (let n = 0; n < count; n++) {
    const angle = (2 * Math.PI * n) / count;
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), z]);
  }
  return { geometricType: 'CLOSED_PLANAR', points };
}

/** A sphere as it is contoured on the slices of a grid: a circle on each slice it cuts. */
function sphere(on: ResampleGrid, centre: Vec3, radius: number, number = 1): Roi {
  const contours: Contour[] = [];
  const { origin, kStep } = on.geometry!;
  for (let k = 0; k < on.dims[2]; k++) {
    const z = origin[2] + k * kStep[2];
    const dz = z - centre[2];
    if (Math.abs(dz) >= radius) continue;
    contours.push(circle(centre[0], centre[1], z, Math.sqrt(radius * radius - dz * dz)));
  }
  return {
    number,
    name: `Sphere ${number}`,
    color: [255, 0, 0],
    interpretedType: 'ORGAN',
    contours,
  };
}

const SPHERE = sphere(SOURCE, CENTRE, RADIUS);

const shift = (x: number, y: number, z: number): Mat4 =>
  [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1] as unknown as Mat4;

/** A placement by a matrix that takes the source's coordinates to the target's. */
function by(layerToBase: Mat4): PropagateThrough {
  return { layerToBase, baseToLayer: invertMat4(layerToBase)! };
}

/** How far the points of a structure's contours are from a sphere's surface: the most, and the mean. */
function offSphere(roi: Roi, centre: Vec3, radius: number): { worst: number; mean: number } {
  let [worst, sum, count] = [0, 0, 0];
  for (const contour of roi.contours) {
    for (const point of contour.points) {
      const off = Math.abs(
        Math.hypot(point[0] - centre[0], point[1] - centre[1], point[2] - centre[2]) - radius,
      );
      worst = Math.max(worst, off);
      sum += off;
      count++;
    }
  }
  return { worst, mean: count ? sum / count : Number.NaN };
}

/** The slice of a grid each contour is on, and how far off its plane its points are at most. */
function slicesOf(roi: Roi, on: ResampleGrid): { slices: number[]; off: number } {
  const { origin, kStep } = on.geometry!;
  let off = 0;
  const slices = roi.contours.map((contour) => {
    const ks = contour.points.map((point) => (point[2] - origin[2]) / kStep[2]);
    const slice = Math.round(ks[0]);
    for (const k of ks) off = Math.max(off, Math.abs(k - slice) * kStep[2]);
    return slice;
  });
  return { slices, off };
}

describe('structures taken to another image by moving their points', () => {
  // Slices of the same thickness, and a shift of whole slices: every contour lands on a slice.
  const TARGET = grid([64, 64, 40], [0.8, 0.8, 2], [-20, -30, -41]);
  const MOVE = shift(3.2, -4.7, 5);

  it('puts every point where the matrix puts it, exactly, on the target’s own slices', () => {
    const [out] = propagateRois([SPHERE], SOURCE, TARGET, by(MOVE));
    expect(out.method).toBe('points');
    expect(out.sourceContours).toBe(12);
    expect(out.roi.contours).toHaveLength(12);
    expect(out.leftOut).toBe(0);
    expect(offSphere(out.roi, transformPoint(MOVE, CENTRE), RADIUS).worst).toBeLessThan(1e-9);
    const { slices, off } = slicesOf(out.roi, TARGET);
    expect(off).toBe(0);
    expect(new Set(slices).size).toBe(12);
    // Each point is the point it was, moved: the first of the first contour.
    const moved = transformPoint(MOVE, SPHERE.contours[0].points[0]);
    out.roi.contours[0].points[0].forEach((value, axis) =>
      expect(value).toBeCloseTo(moved[axis], 9),
    );
    // What the structure is called and looks like goes with it; nothing is filled in.
    expect(out.roi).toMatchObject({
      number: 1,
      name: 'Sphere 1',
      color: [255, 0, 0],
      interpretedType: 'ORGAN',
    });
    expect([out.sourceVolumeMm3, out.volumeMm3]).toEqual([null, null]);
  });

  it('does so through a turn about the slices’ own axis, which keeps their planes', () => {
    const turn = multiplyMat4(MOVE, rigidMat4([0, 0, 1], 33));
    const [out] = propagateRois([SPHERE], SOURCE, TARGET, by(turn));
    expect(out.method).toBe('points');
    expect(offSphere(out.roi, transformPoint(turn, CENTRE), RADIUS).worst).toBeLessThan(1e-9);
  });

  it('does so with no registration, for two images of one frame whose slices coincide', () => {
    const same = grid([30, 30, 60], [2, 2, 1], [-30, -30, -40]);
    const [out] = propagateRois([SPHERE], SOURCE, same, null);
    expect(out.method).toBe('points');
    expect(out.roi.contours).toHaveLength(SPHERE.contours.length);
    out.roi.contours.forEach((contour, at) =>
      contour.points.forEach((point, n) =>
        point.forEach((value, axis) =>
          expect(value).toBeCloseTo(SPHERE.contours[at].points[n][axis], 9),
        ),
      ),
    );
  });

  it('takes a contour within a hundredth of a millimetre of a slice as on it, and puts it there', () => {
    const [out] = propagateRois([SPHERE], SOURCE, TARGET, by(shift(0, 0, 5 + 0.9 * ON_PLANE_MM)));
    expect(out.method).toBe('points');
    expect(slicesOf(out.roi, TARGET).off).toBe(0);
    // Further off than that is not on a slice: the structure goes the other way.
    const [off] = propagateRois([SPHERE], SOURCE, TARGET, by(shift(0, 0, 5 + 2 * ON_PLANE_MM)));
    expect(off.method).toBe('label-volume');
  });

  it('leaves out the contours that land beyond the target’s slices, and counts them', () => {
    // The target ends at z = −3: the sphere's contours above it have no slice.
    const short = grid([64, 64, 20], [0.8, 0.8, 2], [-20, -30, -41]);
    const [out] = propagateRois([SPHERE], SOURCE, short, by(MOVE));
    expect(out.method).toBe('points');
    expect(out.sourceContours).toBe(12);
    // Moved up by 5, the contours are at z = −5 to 17; the target's slices end at −3.
    expect(out.roi.contours).toHaveLength(2);
    expect(out.leftOut).toBe(10);
    expect(Math.max(...slicesOf(out.roi, short).slices)).toBe(19);
  });

  it('keeps open contours and points as they are, moved', () => {
    const marks: Roi = {
      ...SPHERE,
      contours: [
        {
          geometricType: 'OPEN_PLANAR',
          points: [
            [0, 0, 0],
            [5, 0, 0],
            [5, 5, 0],
          ],
        },
        { geometricType: 'POINT', points: [[1, 2, 4]] },
      ],
    };
    const [out] = propagateRois([marks], SOURCE, TARGET, by(MOVE));
    expect(out.method).toBe('points');
    expect(out.roi.contours.map((contour) => contour.geometricType)).toEqual([
      'OPEN_PLANAR',
      'POINT',
    ]);
    const mark = transformPoint(MOVE, [1, 2, 4]);
    out.roi.contours[1].points[0].forEach((value, axis) =>
      expect(value).toBeCloseTo(mark[axis], 9),
    );
    expect(out.roi.contours[0].points).toHaveLength(3);
  });

  it('is nothing for a structure without contours', () => {
    const [out] = propagateRois([{ ...SPHERE, contours: [] }], SOURCE, TARGET, by(MOVE));
    expect(out).toMatchObject({ method: 'points', sourceContours: 0, leftOut: 0 });
    expect(out.roi.contours).toEqual([]);
  });
});

describe('structures taken to another image by a label volume', () => {
  // How near the sphere the outlines must come: the source's voxels are
  // 1 × 1 × 2 mm, and the outlines start from them. Measured at most 0.69 mm.
  const WITHIN_MM = 0.75;
  const MEAN_WITHIN_MM = 0.2;

  const cases: [string, ResampleGrid, Mat4][] = [
    [
      'a turn that tilts the contours’ planes',
      grid([64, 64, 40], [1, 1, 2], [-32, -32, -40]),
      multiplyMat4(shift(2, 3, 1), rigidMat4([1, 0, 0], 20)),
    ],
    ['a shift of half a slice', grid([64, 64, 40], [1, 1, 2], [-32, -32, -41]), IDENTITY_MAT4],
    [
      'a turn onto finer voxels',
      grid([128, 128, 80], [0.5, 0.5, 1], [-32, -32, -40.3]),
      rigidMat4([0.3, 1, 0.2], 35),
    ],
    [
      'a turn onto coarser voxels',
      grid([32, 32, 20], [2, 2, 4], [-32, -32, -41]),
      rigidMat4([0.3, 1, 0.2], 35),
    ],
  ];

  it.each(cases)('is the sphere where the matrix puts it, through %s', (_name, target, move) => {
    const [out] = propagateRois([SPHERE], SOURCE, target, by(move));
    expect(out.method).toBe('label-volume');
    expect(out.roi.contours.length).toBeGreaterThan(4);
    const { worst, mean } = offSphere(out.roi, transformPoint(move, CENTRE), RADIUS);
    expect(worst).toBeLessThan(WITHIN_MM);
    expect(mean).toBeLessThan(MEAN_WITHIN_MM);
    // Each outline is closed, on a slice of the target, and one to a slice for a sphere.
    const { slices, off } = slicesOf(out.roi, target);
    expect(off).toBeLessThan(1e-9);
    expect(new Set(slices).size).toBe(slices.length);
    for (const contour of out.roi.contours) expect(contour.geometricType).toBe('CLOSED_PLANAR');
    // Filled in on the source it is the sphere to a tenth of a percent; on
    // the target, within what straight lines between slices cut off a ball.
    expect(out.sourceVolumeMm3! / SPHERE_MM3).toBeCloseTo(1, 2);
    expect(out.volumeMm3! / SPHERE_MM3).toBeGreaterThan(0.97);
    expect(out.volumeMm3! / SPHERE_MM3).toBeLessThan(1.01);
    expect(out.leftOut).toBe(0);
  });

  it('is the structure itself, to half a voxel, when the target is the source image', () => {
    // Slices that coincide go by points. Tilted by nothing but put through a
    // field of no displacement, the structure goes by the label volume.
    const still: DeformationGrid = {
      dims: [2, 2, 2],
      origin: [-100, -100, -100],
      spacing: [200, 200, 200],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      vectors: new Float32Array(24),
    };
    const through = {
      ...by(IDENTITY_MAT4),
      field: { pre: IDENTITY_MAT4, grid: still, post: IDENTITY_MAT4 },
    };
    const [out] = propagateRois([SPHERE], SOURCE, SOURCE, through);
    expect(out.method).toBe('label-volume');
    // A contour on every slice that had one, and on no other.
    expect(slicesOf(out.roi, SOURCE).slices).toEqual(slicesOf(SPHERE, SOURCE).slices);
    expect(offSphere(out.roi, CENTRE, RADIUS).worst).toBeLessThan(0.75);
    // The same voxels are inside as were filled in.
    expect(out.volumeMm3).toBe(out.sourceVolumeMm3);
  });

  it('follows a deformation field: a shift, and a shrinking about the centre', () => {
    const target = grid([64, 64, 40], [1, 1, 2], [-32, -32, -40.6]);
    // A field over everything whose vector at q is `at(q)`: read as it is
    // between its corners when it goes evenly with the place.
    const field = (at: (q: Vec3) => Vec3): DeformationGrid => {
      const vectors = new Float32Array(24);
      let n = 0;
      for (const z of [-100, 100]) {
        for (const y of [-100, 100])
          for (const x of [-100, 100]) vectors.set(at([x, y, z]), 3 * n++);
      }
      return {
        dims: [2, 2, 2],
        origin: [-100, -100, -100],
        spacing: [200, 200, 200],
        axes: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        vectors,
      };
    };
    const through = (grid: DeformationGrid): PropagateThrough => ({
      ...by(IDENTITY_MAT4),
      field: { pre: IDENTITY_MAT4, grid, post: IDENTITY_MAT4 },
    });

    // A place p of the target is read at p + d in the source: the sphere is at its centre − d.
    const d: Vec3 = [4.5, -3.25, 2.7];
    const [moved] = propagateRois([SPHERE], SOURCE, target, through(field(() => d)));
    expect(moved.method).toBe('label-volume');
    const centre: Vec3 = [CENTRE[0] - d[0], CENTRE[1] - d[1], CENTRE[2] - d[2]];
    expect(offSphere(moved.roi, centre, RADIUS).worst).toBeLessThan(0.75);

    // Read at p + 0.25 (p − c): a sphere about c of radius 12 / 1.25.
    const shrink = (q: Vec3): Vec3 => [
      0.25 * (q[0] - CENTRE[0]),
      0.25 * (q[1] - CENTRE[1]),
      0.25 * (q[2] - CENTRE[2]),
    ];
    const [smaller] = propagateRois([SPHERE], SOURCE, target, through(field(shrink)));
    const { worst, mean } = offSphere(smaller.roi, CENTRE, RADIUS / 1.25);
    expect(worst).toBeLessThan(0.75);
    expect(mean).toBeLessThan(0.2);
    // Smaller by 1.25 three times over, less what the slices cut off.
    expect(smaller.volumeMm3! / (SPHERE_MM3 / 1.25 ** 3)).toBeGreaterThan(0.9);
    expect(smaller.volumeMm3! / (SPHERE_MM3 / 1.25 ** 3)).toBeLessThan(1.02);
  });

  it('has nothing where a field has no vector, and its volume says so', () => {
    const target = grid([64, 64, 40], [1, 1, 2], [-32, -32, -40.6]);
    // A field of no displacement that is only there for x below 0.3: half the sphere.
    const half: DeformationGrid = {
      dims: [2, 2, 2],
      origin: [-100, -100, -100],
      spacing: [100.3, 200, 200],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      vectors: new Float32Array(24),
    };
    const [out] = propagateRois([SPHERE], SOURCE, target, {
      ...by(IDENTITY_MAT4),
      field: { pre: IDENTITY_MAT4, grid: half, post: IDENTITY_MAT4 },
    });
    expect(out.volumeMm3! / out.sourceVolumeMm3!).toBeGreaterThan(0.45);
    expect(out.volumeMm3! / out.sourceVolumeMm3!).toBeLessThan(0.55);
    for (const contour of out.roi.contours) {
      for (const point of contour.points) expect(point[0]).toBeLessThanOrEqual(0.3 + 1e-9);
    }
  });

  it('keeps a hole a hole, and two structures apart', () => {
    // A tube: on each slice a circle of 14 mm with one of 6 mm inside it.
    const tube: Roi = {
      ...SPHERE,
      number: 2,
      name: 'Tube',
      contours: [-6, -4, -2, 0, 2, 4].flatMap((z) => [circle(0, 0, z, 14), circle(0, 0, z, 6)]),
    };
    const far = sphere(SOURCE, [-12, -12, -20], 5, 3);
    const target = grid([64, 64, 40], [1, 1, 2], [-32, -32, -40.9]);
    const [first, second] = propagateRois([tube, far], SOURCE, target, by(IDENTITY_MAT4));
    expect(first.method).toBe('label-volume');
    // Two outlines on every slice the tube is on: the wall's outside and its inside.
    const perSlice = new Map<number, number[]>();
    for (const contour of first.roi.contours) {
      const z = contour.points[0][2];
      const area = loopArea(contour.points.map((point) => [point[0], point[1]]));
      perSlice.set(z, [...(perSlice.get(z) ?? []), area]);
    }
    expect(perSlice.size).toBeGreaterThanOrEqual(5);
    let between = 0;
    for (const [z, areas] of perSlice) {
      expect(areas, `z = ${z}`).toHaveLength(2);
      // Beyond the tube's first and last contours its wall is rounded off, and thinner.
      if (z < -6 || z > 4) continue;
      between++;
      const [hole, rim] = [...areas].sort((a, b) => a - b);
      expect(hole / (Math.PI * 36)).toBeCloseTo(1, 1);
      expect(rim / (Math.PI * 196)).toBeCloseTo(1, 1);
    }
    expect(between).toBe(5);
    // The second structure is itself: nothing of the first is left in it.
    expect(offSphere(second.roi, [-12, -12, -20], 5).worst).toBeLessThan(0.75);
    expect(second.roi.name).toBe('Sphere 3');
  });

  it('keeps a structure of one voxel, and leaves out a crumb beside a larger outline', () => {
    // A square about one voxel's centre: the smallest structure there is.
    const dot: Roi = {
      ...SPHERE,
      contours: [
        {
          geometricType: 'CLOSED_PLANAR',
          points: [
            [-0.4, -0.4, 0],
            [0.4, -0.4, 0],
            [0.4, 0.4, 0],
            [-0.4, 0.4, 0],
          ],
        },
      ],
    };
    // Slices a little off the source's, so that it goes by the label volume.
    const target = grid([48, 48, 30], [1, 1, 2], [-24, -24, -30.4]);
    const [small] = propagateRois([dot], SOURCE, target, by(IDENTITY_MAT4));
    expect(small.method).toBe('label-volume');
    expect(small.sourceVolumeMm3).toBe(2);
    // Smaller than a voxel's face, and kept: it is all there is of the structure.
    expect(small.roi.contours).toHaveLength(1);
    const area = loopArea(small.roi.contours[0].points.map((point) => [point[0], point[1]]));
    expect(area).toBeGreaterThan(0);
    expect(area).toBeLessThan(1);
    // On a slice that grazes a sphere there is one outline, not one and crumbs.
    const fine = grid([128, 128, 80], [0.5, 0.5, 1], [-32, -32, -40.3]);
    const move = rigidMat4([0.3, 1, 0.2], 35);
    const [ball] = propagateRois([SPHERE], SOURCE, fine, by(move));
    const { slices } = slicesOf(ball.roi, fine);
    expect(new Set(slices).size).toBe(slices.length);
  });

  it('leaves out contours that enclose nothing, and counts them', () => {
    const mixed: Roi = {
      ...SPHERE,
      contours: [
        ...SPHERE.contours,
        {
          geometricType: 'OPEN_PLANAR',
          points: [
            [0, 0, 0],
            [5, 0, 0],
            [5, 5, 0],
          ],
        },
        { geometricType: 'POINT', points: [[1, 2, 4]] },
      ],
    };
    const target = grid([64, 64, 40], [1, 1, 2], [-32, -32, -41]);
    const [out] = propagateRois([mixed], SOURCE, target, by(IDENTITY_MAT4));
    expect(out.method).toBe('label-volume');
    expect(out.sourceContours).toBe(14);
    expect(out.leftOut).toBe(2);
    expect(out.roi.contours.every((contour) => contour.geometricType === 'CLOSED_PLANAR')).toBe(
      true,
    );
  });

  it('is nothing for a structure the target image does not reach, and says what it was', () => {
    const elsewhere = grid([20, 20, 10], [1, 1, 2], [200, 200, 200.5]);
    const [out] = propagateRois([SPHERE], SOURCE, elsewhere, by(IDENTITY_MAT4));
    expect(out.method).toBe('label-volume');
    expect(out.roi.contours).toEqual([]);
    expect(out.volumeMm3).toBe(0);
    expect(out.sourceVolumeMm3! / SPHERE_MM3).toBeCloseTo(1, 2);
  });

  it('ends a structure within half a slice beyond its last contour, rounded off', () => {
    // A cylinder of radius 10 on four slices of the source, z = 0 to 6.
    const cylinder: Roi = { ...SPHERE, contours: [0, 2, 4, 6].map((z) => circle(0, 0, z, 10)) };
    // Slices of the target every 0.25 mm, none on a slice of the source.
    const fine = grid([64, 64, 60], [1, 1, 0.25], [-32, -32, -4.1]);
    const [out] = propagateRois([cylinder], SOURCE, fine, by(IDENTITY_MAT4));
    const zs = out.roi.contours.map((contour) => contour.points[0][2]);
    // From less than half a slice (1 mm) below the first contour to less than that above the last.
    expect(Math.min(...zs)).toBeGreaterThan(-1);
    expect(Math.min(...zs)).toBeLessThan(-0.5);
    expect(Math.max(...zs)).toBeLessThan(7);
    expect(Math.max(...zs)).toBeGreaterThan(6.5);
    // Between its contours it is the cylinder; beyond them it narrows.
    const radiusAt = (z: number): number => {
      const contour = out.roi.contours.find((one) => Math.abs(one.points[0][2] - z) < 1e-6)!;
      return Math.sqrt(loopArea(contour.points.map((point) => [point[0], point[1]])) / Math.PI);
    };
    expect(radiusAt(2.9)).toBeCloseTo(10, 0);
    expect(radiusAt(6.65)).toBeLessThan(radiusAt(6.15));
    expect(radiusAt(6.65)).toBeGreaterThan(2);
  });
});
