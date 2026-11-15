/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// An analytic phantom for validating resampling (#92): images, structures
// and transforms that are formulas, so that what a resampled image or a
// propagated structure should be is known at every place, and what comes
// out is measured against it and not against another run of the same code.
//
// A transform here says, for a place of the reference image, where to read
// in the source image: the way a registration is used to draw one image
// over another, and the way a deformation field is written. Each has its
// inverse as a formula too, for going there and back.
//
// Nothing here is a DICOM file. The suite that uses it is
// `resampling-validation.spec.ts`; what it holds the code to is in
// `docs/resampling-validation.md`.

// Like every generator here it stands by itself: its grids, matrices and
// fields are plain numbers in the shapes the DICOM core takes, and it imports
// nothing.

type Triple = readonly [number, number, number];

/** A matrix of four rows of four, row by row: the last row is 0 0 0 1. */
export type PhantomMatrix = readonly number[];

/** Where a grid's voxels are: what the DICOM core takes as an image without its values. */
export interface PhantomGrid {
  readonly dims: Triple;
  readonly spacing: Triple;
  readonly geometry: {
    readonly iStep: Triple;
    readonly jStep: Triple;
    readonly kStep: Triple;
    readonly origin: Triple;
  };
}

/** A deformation field as a grid of vectors: what the DICOM core takes as one. */
export interface PhantomFieldGrid {
  readonly dims: Triple;
  readonly origin: Triple;
  readonly spacing: Triple;
  readonly axes: readonly [Triple, Triple, Triple];
  /** Three 32-bit numbers to a vector, x fastest. */
  readonly vectors: Float32Array;
}

const IDENTITY: PhantomMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Where a matrix puts a place. */
function apply(m: PhantomMatrix, [x, y, z]: Triple): Triple {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

/** The matrix that does `first`, then `then`. */
function after(then: PhantomMatrix, first: PhantomMatrix): PhantomMatrix {
  const out: number[] = [];
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      let sum = 0;
      for (let n = 0; n < 4; n++) sum += then[4 * row + n] * first[4 * n + column];
      out.push(sum);
    }
  }
  return out;
}

/** The matrix that undoes one: its three by three part inverted by cofactors, and its shift taken back. */
function undo(m: PhantomMatrix): PhantomMatrix {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const r = [
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  const [tx, ty, tz] = [m[3], m[7], m[11]];
  return [
    ...[r[0], r[1], r[2], -(r[0] * tx + r[1] * ty + r[2] * tz)],
    ...[r[3], r[4], r[5], -(r[3] * tx + r[4] * ty + r[5] * tz)],
    ...[r[6], r[7], r[8], -(r[6] * tx + r[7] * ty + r[8] * tz)],
    ...[0, 0, 0, 1],
  ];
}

const shiftBy = ([x, y, z]: Triple): PhantomMatrix => [
  1,
  0,
  0,
  x,
  0,
  1,
  0,
  y,
  0,
  0,
  1,
  z,
  0,
  0,
  0,
  1,
];

/** A turn about an axis through the origin, by the right-hand rule. */
function turn(axis: Triple, degrees: number): PhantomMatrix {
  const length = Math.hypot(...axis);
  const [x, y, z] = [axis[0] / length, axis[1] / length, axis[2] / length];
  const angle = (degrees * Math.PI) / 180;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const t = 1 - c;
  return [
    ...[t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0],
    ...[t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0],
    ...[t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0],
    ...[0, 0, 0, 1],
  ];
}

/** A grid of voxels with its axes along the patient's. */
export function phantomGrid(dims: Triple, spacing: Triple, origin: Triple): PhantomGrid {
  return {
    dims,
    spacing,
    geometry: {
      iStep: [spacing[0], 0, 0],
      jStep: [0, spacing[1], 0],
      kStep: [0, 0, spacing[2]],
      origin,
    },
  };
}

/** The place of a voxel's centre. */
export function phantomVoxelPoint(grid: PhantomGrid, i: number, j: number, k: number): Triple {
  const { origin } = grid.geometry;
  return [
    origin[0] + i * grid.spacing[0],
    origin[1] + j * grid.spacing[1],
    origin[2] + k * grid.spacing[2],
  ];
}

/** Whether a place is within a grid's voxel centres, at least `margin` voxels from the outermost. */
export function phantomWithin(grid: PhantomGrid, point: Triple, margin: number): boolean {
  const { origin } = grid.geometry;
  for (let axis = 0; axis < 3; axis++) {
    const index = (point[axis] - origin[axis]) / grid.spacing[axis];
    if (index < margin || index > grid.dims[axis] - 1 - margin) return false;
  }
  return true;
}

export const RESAMPLING_PHANTOM = {
  /** The image everything starts on: voxels of 1 × 1 × 2 mm, as a CT's often are. */
  source: phantomGrid([72, 72, 44], [1, 1, 2], [-36, -36, -44]),
  /** Another image's grid: voxels of 1.5 mm each way, set off from the first. */
  other: phantomGrid([52, 52, 52], [1.5, 1.5, 1.5], [-38.2, -37.6, -39.1]),
  /** The centre of the ball, off every voxel centre of either grid. */
  centre: [0.3, -1.2, 0.5] as Triple,
  /** The ball's radius, in mm. */
  radius: 12,
  /** The linear image: its value at the origin and what it gains in a millimetre along x, y and z. */
  ramp: { at0: 100, perMm: [3, -2, 5] as Triple },
  /** The wavy image: three waves, each with how high it goes and how long it is in mm. */
  waves: {
    level: 1000,
    x: { height: 400, length: 40 },
    y: { height: 400, length: 50 },
    z: { height: 300, length: 60 },
  },
  /** The swell: how far it moves a place at most (mm), along which way, and how wide it is (mm). */
  swell: {
    amplitude: 4,
    along: [0.6, -0.64, 0.48] as Triple,
    width: 10,
    centre: [2, -3, 1] as Triple,
  },
} as const;

const P = RESAMPLING_PHANTOM;

/** The linear image: reading it between voxels loses nothing. */
export function phantomRamp(point: Triple): number {
  const { at0, perMm } = P.ramp;
  return at0 + perMm[0] * point[0] + perMm[1] * point[1] + perMm[2] * point[2];
}

/** How much the linear image changes in a millimetre at most, whichever way one goes. */
export const PHANTOM_RAMP_SLOPE = Math.hypot(...P.ramp.perMm);

/** The wavy image: smooth, and bent everywhere, so that reading it between voxels has an error. */
export function phantomWaves(point: Triple): number {
  const { level, x, y, z } = P.waves;
  const turn = 2 * Math.PI;
  return (
    level +
    x.height * Math.sin((turn * point[0]) / x.length) +
    y.height * Math.cos((turn * point[1]) / y.length) +
    z.height * Math.sin((turn * point[2]) / z.length + 1)
  );
}

/** How much the wavy image changes in a millimetre at most. */
export const PHANTOM_WAVES_SLOPE = (() => {
  const { x, y, z } = P.waves;
  const turn = 2 * Math.PI;
  return Math.hypot(
    (x.height * turn) / x.length,
    (y.height * turn) / y.length,
    (z.height * turn) / z.length,
  );
})();

/**
 * The most that reading the wavy image between voxels `spacing` apart can be
 * off: for each axis an eighth of the spacing squared times how sharply the
 * image bends along it, which is what linear interpolation of a smooth
 * function is off by at most, added up over the three axes.
 */
export function phantomWavesInterpolationBound(spacing: Triple): number {
  const { x, y, z } = P.waves;
  const bend = (wave: { height: number; length: number }): number =>
    wave.height * ((2 * Math.PI) / wave.length) ** 2;
  return (
    (spacing[0] ** 2 * bend(x)) / 8 +
    (spacing[1] ** 2 * bend(y)) / 8 +
    (spacing[2] ** 2 * bend(z)) / 8
  );
}

/** Whether a place is in the ball. */
export function phantomInBall(point: Triple): boolean {
  return phantomBallDistance(point) < 0;
}

/** How far a place is from the ball's surface, in mm: less than nothing inside it. */
export function phantomBallDistance(point: Triple): number {
  const [cx, cy, cz] = P.centre;
  return Math.hypot(point[0] - cx, point[1] - cy, point[2] - cz) - P.radius;
}

/** The ball's volume, in mm³. */
export const PHANTOM_BALL_MM3 = (4 / 3) * Math.PI * P.radius ** 3;

/** A transform as the suite uses one: where a place of the reference is read in the source. */
export interface PhantomTransform {
  readonly name: string;
  /** Where a place of the reference image is read in the source image. */
  readonly toSource: (point: Triple) => Triple;
  /** The other way: where a place of the source image is in the reference. */
  readonly toReference: (point: Triple) => Triple;
  /** The matrix after the field (or the whole transform when there is no field). */
  readonly matrix: PhantomMatrix;
  /**
   * The displacement the field has at a place, in mm; null for a transform
   * that is a matrix alone. The whole is `matrix · (p + field(p))`.
   */
  readonly field: ((point: Triple) => Triple) | null;
}

function matrixTransform(name: string, matrix: PhantomMatrix): PhantomTransform {
  const inverse = undo(matrix);
  return {
    name,
    matrix,
    field: null,
    toSource: (point) => apply(matrix, point),
    toReference: (point) => apply(inverse, point),
  };
}

/** A turn about an axis through `about`, then a shift. */
function turnAbout(about: Triple, axis: Triple, degrees: number, shift: Triple): PhantomMatrix {
  const there = shiftBy([-about[0], -about[1], -about[2]]);
  const back = shiftBy([about[0] + shift[0], about[1] + shift[1], about[2] + shift[2]]);
  return after(back, after(turn(axis, degrees), there));
}

/**
 * A rigid transform that keeps the source's slices as slices: a turn about
 * the slice axis and a shift of whole slices. Contours stay flat on slices
 * through it.
 */
export const PHANTOM_IN_PLANE = matrixTransform(
  'a turn about the slice axis and a shift of whole slices',
  turnAbout(P.centre, [0, 0, 1], 25, [3.5, -2.25, 4]),
);

/** A rigid transform that tilts everything: a turn about a skew axis, and a shift that is no whole voxel. */
export const PHANTOM_RIGID = matrixTransform(
  'a turn of 12° about a skew axis and a shift',
  turnAbout(P.centre, [1, 2, 3], 12, [3.5, -2.25, 1.75]),
);

/** The swell's displacement at a place: along one direction, most at its centre, dying away. */
function swellAt(point: Triple): number {
  const { amplitude, width, centre } = P.swell;
  const d2 =
    (point[0] - centre[0]) ** 2 + (point[1] - centre[1]) ** 2 + (point[2] - centre[2]) ** 2;
  return amplitude * Math.exp(-d2 / (2 * width * width));
}

/**
 * How far a place moved by the swell came, given where it ended: the `t`
 * with `t = swell(q − t·along)`. The swell changes by less than a quarter of
 * a millimetre in a millimetre, so there is one such `t`, and bisection
 * finds it to the last bit.
 */
function swellBack(point: Triple): number {
  const { amplitude, along } = P.swell;
  const off = (t: number): number =>
    t - swellAt([point[0] - t * along[0], point[1] - t * along[1], point[2] - t * along[2]]);
  let low = 0;
  let high: number = amplitude;
  for (let step = 0; step < 60; step++) {
    const middle = (low + high) / 2;
    if (off(middle) < 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** A deformation that is bent: the swell alone, with no matrix. */
export const PHANTOM_SWELL: PhantomTransform = (() => {
  const { along } = P.swell;
  const field = (point: Triple): Triple => {
    const t = swellAt(point);
    return [t * along[0], t * along[1], t * along[2]];
  };
  return {
    name: 'a swell of up to 4 mm',
    matrix: IDENTITY,
    field,
    toSource: (point) => {
      const d = field(point);
      return [point[0] + d[0], point[1] + d[1], point[2] + d[2]];
    },
    toReference: (point) => {
      const t = swellBack(point);
      return [point[0] - t * along[0], point[1] - t * along[1], point[2] - t * along[2]];
    },
  };
})();

/**
 * A deformation that is straight: a stretch and a shear, as a field. A field
 * that goes evenly with the place is read between its vectors without any
 * error, so this tells an error of the code from an error of the grid.
 */
export const PHANTOM_STRETCH: PhantomTransform = (() => {
  // The displacement at p is G·(p − centre) + shift.
  const G = [0.08, 0.03, 0, -0.02, -0.05, 0.04, 0.01, 0, 0.06];
  const shift: Triple = [1.5, -1, 0.75];
  const [cx, cy, cz] = P.centre;
  const field = (point: Triple): Triple => {
    const [x, y, z] = [point[0] - cx, point[1] - cy, point[2] - cz];
    return [
      G[0] * x + G[1] * y + G[2] * z + shift[0],
      G[3] * x + G[4] * y + G[5] * z + shift[1],
      G[6] * x + G[7] * y + G[8] * z + shift[2],
    ];
  };
  // The whole is p ↦ (I + G)(p − c) + c + shift: a matrix, with an inverse.
  const whole: PhantomMatrix = [
    ...[1 + G[0], G[1], G[2], cx + shift[0] - ((1 + G[0]) * cx + G[1] * cy + G[2] * cz)],
    ...[G[3], 1 + G[4], G[5], cy + shift[1] - (G[3] * cx + (1 + G[4]) * cy + G[5] * cz)],
    ...[G[6], G[7], 1 + G[8], cz + shift[2] - (G[6] * cx + G[7] * cy + (1 + G[8]) * cz)],
    ...[0, 0, 0, 1],
  ];
  const inverse = undo(whole);
  return {
    name: 'a stretch and a shear, as a field',
    matrix: IDENTITY,
    field,
    toSource: (point) => apply(whole, point),
    toReference: (point) => apply(inverse, point),
  };
})();

/** A deformation with a matrix after it, as a registration object has them: the swell, then the tilt. */
export const PHANTOM_SWELL_THEN_RIGID: PhantomTransform = {
  name: 'a swell, then a turn and a shift',
  matrix: PHANTOM_RIGID.matrix,
  field: PHANTOM_SWELL.field,
  toSource: (point) => PHANTOM_RIGID.toSource(PHANTOM_SWELL.toSource(point)),
  toReference: (point) => PHANTOM_SWELL.toReference(PHANTOM_RIGID.toReference(point)),
};

/**
 * A transform turned round: what was the source is the reference. Its field
 * is what the inverse moves a place by, which for the swell is no formula
 * but is found to the last bit.
 */
export function phantomInverse(transform: PhantomTransform): PhantomTransform {
  return {
    name: `${transform.name}, turned round`,
    matrix: transform.field ? IDENTITY : undo(transform.matrix),
    field: transform.field
      ? (point) => {
          const to = transform.toReference(point);
          return [to[0] - point[0], to[1] - point[1], to[2] - point[2]];
        }
      : null,
    toSource: transform.toReference,
    toReference: transform.toSource,
  };
}

/**
 * A transform's field as a grid of vectors `spacing` mm apart that covers
 * `over` and a little more: what a Deformable Spatial Registration object
 * holds, as 32-bit floats. Between the vectors a reader interpolates. Null
 * for a transform that is a matrix alone.
 */
export function phantomFieldGrid(
  transform: PhantomTransform,
  over: PhantomGrid,
  spacing: number,
): PhantomFieldGrid | null {
  const { field } = transform;
  if (!field) return null;
  const { origin } = over.geometry;
  const start: Triple = [origin[0] - spacing, origin[1] - spacing, origin[2] - spacing];
  const dims = [0, 1, 2].map(
    (axis) => Math.ceil(((over.dims[axis] - 1) * over.spacing[axis]) / spacing) + 3,
  ) as unknown as Triple;
  const vectors = new Float32Array(dims[0] * dims[1] * dims[2] * 3);
  let at = 0;
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++) {
        vectors.set(
          field([start[0] + i * spacing, start[1] + j * spacing, start[2] + k * spacing]),
          at,
        );
        at += 3;
      }
    }
  }
  return {
    dims,
    origin: start,
    spacing: [spacing, spacing, spacing],
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    vectors,
  };
}

/**
 * The most a field read between vectors `spacing` mm apart is off the swell
 * itself, in mm: an eighth of the spacing squared times how sharply the
 * swell bends (its amplitude over its width squared, at most, along any
 * line), over the three axes.
 */
export function phantomSwellGridBound(spacing: number): number {
  const { amplitude, width } = P.swell;
  return (3 * spacing ** 2 * (amplitude / width ** 2)) / 8;
}
