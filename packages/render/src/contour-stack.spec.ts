/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  Orientation,
  voxelToPatient,
  type Contour,
  type StructureSet,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';
import {
  buildContourStack,
  cutContourStack,
  fillContourStack,
  type StackContour,
} from './contour-stack.js';
import {
  classifyContour,
  crossSectionOutline,
  displayedSlicePos,
  projectContour,
  type ContourPolyline,
} from './contours.js';
import { planeToTex, resolveGeometry, texCoordAt, type ObliqueRotation } from './reslice.js';
import type { PlanePoint } from './pane-coords.js';
import { roiContourCoords, roiPlaneShapes, roiScreenShapes } from './roi-overlay.js';

// Shapes of known form are cut with tilted planes and the outline is checked
// against the form. The volume is 128 x 128 x 64 voxels of 2 x 2 x 3 mm with
// its origin at (-128, -128, -96), so the patient origin is near its centre.

const DIMS = [128, 128, 64] as const;
const SPACING = [2, 2, 3] as const;
const SLICE_MM = SPACING[2];
/** How near the outline has to be to the true cut: one slice, and a little. */
const NEAR_MM = SLICE_MM + 0.2;

function makeVolume(): Volume {
  return {
    dims: DIMS,
    spacing: SPACING,
    data: new Float32Array(0),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry: {
      iStep: [2, 0, 0],
      jStep: [0, 2, 0],
      kStep: [0, 0, 3],
      origin: [-127, -127, -94.5],
    },
  } as Volume;
}

const degrees = (d: number): number => (d * Math.PI) / 180;

/** The z of each image slice: contours are drawn on these planes. */
const sliceZ = (k: number): number => -94.5 + k * SLICE_MM;

/** A loop of `count` points around an ellipse at height z. */
function ellipse(
  center: readonly [number, number],
  semi: readonly [number, number],
  z: number,
  count = 96,
): Vec3[] {
  return Array.from({ length: count }, (_, i): Vec3 => {
    const a = (i / count) * 2 * Math.PI;
    return [center[0] + semi[0] * Math.cos(a), center[1] + semi[1] * Math.sin(a), z];
  });
}

const ELLIPSOID = { center: [10, -6, 1.5] as Vec3, semi: [44, 30, 52] as Vec3 };

/** The ellipsoid as a stack of contours, one on every slice that meets it. */
function ellipsoidContours(): Vec3[][] {
  const { center, semi } = ELLIPSOID;
  const loops: Vec3[][] = [];
  for (let k = 0; k < DIMS[2]; k++) {
    const t = (sliceZ(k) - center[2]) / semi[2];
    if (Math.abs(t) >= 1) continue;
    const s = Math.sqrt(1 - t * t);
    loops.push(ellipse([center[0], center[1]], [semi[0] * s, semi[1] * s], sliceZ(k)));
  }
  return loops;
}

/** 1 on the ellipsoid's surface, less inside, more outside. */
function ellipsoidLevel(p: Vec3): number {
  const { center, semi } = ELLIPSOID;
  return Math.hypot(...p.map((x, i) => (x - center[i]) / semi[i])) ** 2;
}

interface Cut {
  readonly outline: ContourPolyline[];
  /** The inside, as rings to fill. */
  readonly rings: PlanePoint[][];
  /** A pane point `(u, v)` on the displayed slice, in the patient. */
  readonly toPatient: (u: number, v: number) => Vec3;
}

/** Cut a stack of loops with the displayed slice of a pane tilted by `rotation`. */
function cut(
  loops: readonly Vec3[][],
  orientation: Orientation,
  rotation: ObliqueRotation,
  sliceIndex: number,
): Cut {
  const volume = makeVolume();
  const contours: StackContour[] = loops.map((points) => ({
    points,
    coords: projectContour(volume, orientation, points, true, rotation)!,
  }));
  const stack = buildContourStack(volume, orientation, rotation, contours, SLICE_MM)!;
  const slicePos = displayedSlicePos(volume, orientation, sliceIndex);
  const map = planeToTex(volume, orientation, rotation);
  const toPatient = (u: number, v: number): Vec3 => {
    const tex = texCoordAt(map, u, v, slicePos);
    return voxelToPatient(resolveGeometry(volume), [
      tex[0] * DIMS[0] - 0.5,
      tex[1] * DIMS[1] - 0.5,
      tex[2] * DIMS[2] - 0.5,
    ]);
  };
  return {
    outline: cutContourStack(stack, slicePos),
    rings: fillContourStack(stack, slicePos),
    toPatient,
  };
}

/** The outline as line segments in the patient. */
function segments(c: Cut): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  for (const { points, closed } of c.outline) {
    const patient = points.map((p) => c.toPatient(p.u, p.v));
    for (let i = 0; i + 1 < patient.length; i++) out.push([patient[i], patient[i + 1]]);
    if (closed) out.push([patient[patient.length - 1], patient[0]]);
  }
  return out;
}

function distanceToSegment(p: Vec3, [a, b]: [Vec3, Vec3]): number {
  const ab = b.map((x, i) => x - a[i]);
  const ap = p.map((x, i) => x - a[i]);
  const length2 = ab.reduce((s, x) => s + x * x, 0);
  const t =
    length2 === 0
      ? 0
      : Math.min(1, Math.max(0, ab.reduce((s, x, i) => s + x * ap[i], 0) / length2));
  return Math.hypot(...ap.map((x, i) => x - t * ab[i]));
}

/**
 * Points of the true cut: where rays from the middle of the cut, in the pane's
 * plane, leave the ellipsoid. Solved exactly, one quadratic per ray.
 */
function trueBoundary(c: Cut, rays = 72): Vec3[] {
  const { center, semi } = ELLIPSOID;
  const o = c.toPatient(0.5, 0.5);
  const unit = (v: number[]): Vec3 => {
    const length = Math.hypot(...v);
    return [v[0] / length, v[1] / length, v[2] / length];
  };
  const right = unit(c.toPatient(1, 0.5).map((x, i) => x - o[i]));
  const down = unit(c.toPatient(0.5, 1).map((x, i) => x - o[i]));
  const normal: Vec3 = [
    right[1] * down[2] - right[2] * down[1],
    right[2] * down[0] - right[0] * down[2],
    right[0] * down[1] - right[1] * down[0],
  ];
  // The point of the plane nearest the ellipsoid's centre: inside the cut.
  const off = center.reduce((s, x, i) => s + (x - o[i]) * normal[i], 0);
  const start = center.map((x, i) => x - off * normal[i]);
  const points: Vec3[] = [];
  for (let r = 0; r < rays; r++) {
    const angle = (r / rays) * 2 * Math.PI;
    const dir = right.map((x, i) => x * Math.cos(angle) + down[i] * Math.sin(angle));
    let a = 0;
    let b = 0;
    let cc = -1;
    for (let i = 0; i < 3; i++) {
      const d = dir[i] / semi[i];
      const s = (start[i] - center[i]) / semi[i];
      a += d * d;
      b += 2 * d * s;
      cc += s * s;
    }
    const reach = (-b + Math.sqrt(b * b - 4 * a * cc)) / (2 * a);
    points.push([start[0] + reach * dir[0], start[1] + reach * dir[1], start[2] + reach * dir[2]]);
  }
  return points;
}

/** The middle slice of each orientation: through the ellipsoid's middle. */
const MIDDLE: Record<Orientation, number> = {
  [Orientation.Axial]: 32,
  [Orientation.Coronal]: 61,
  [Orientation.Sagittal]: 69,
};

describe('an ellipsoid cut by a tilted plane', () => {
  const loops = ellipsoidContours();
  const cases: [string, Orientation, ObliqueRotation][] = [
    ['axial, 3° about one axis', Orientation.Axial, { tiltU: degrees(3), tiltV: 0 }],
    ['axial, 3° about the other', Orientation.Axial, { tiltU: 0, tiltV: degrees(-3) }],
    ['axial, 8° and 5° about both', Orientation.Axial, { tiltU: degrees(8), tiltV: degrees(5) }],
    ['axial, 30°', Orientation.Axial, { tiltU: degrees(30), tiltV: 0 }],
    ['axial, 40° and 20°', Orientation.Axial, { tiltU: degrees(-40), tiltV: degrees(20) }],
    ['axial, 60° (past halfway to coronal)', Orientation.Axial, { tiltU: degrees(60), tiltV: 0 }],
    ['coronal, 4° about one axis', Orientation.Coronal, { tiltU: degrees(4), tiltV: 0 }],
    ['coronal, 4° about the other', Orientation.Coronal, { tiltU: 0, tiltV: degrees(4) }],
    ['coronal, 25° and 15°', Orientation.Coronal, { tiltU: degrees(25), tiltV: degrees(-15) }],
    ['coronal, 70° (past halfway to axial)', Orientation.Coronal, { tiltU: degrees(70), tiltV: 0 }],
    ['sagittal, 10° and 10°', Orientation.Sagittal, { tiltU: degrees(10), tiltV: degrees(10) }],
    ['sagittal, 50°', Orientation.Sagittal, { tiltU: 0, tiltV: degrees(50) }],
  ];

  it.each(cases)(
    '%s: the outline lies on the ellipsoid and goes all the way round',
    (_name, orientation, rotation) => {
      const c = cut(loops, orientation, rotation, MIDDLE[orientation]);
      const drawn = segments(c);
      expect(drawn.length).toBeGreaterThan(8);

      // Every point of the outline is on the surface, to within what half a
      // slice of height does to the level (the slab a contour stands for).
      for (const [a, b] of drawn) {
        expect(Math.abs(ellipsoidLevel(a) - 1)).toBeLessThan(0.07);
        expect(Math.abs(ellipsoidLevel(b) - 1)).toBeLessThan(0.07);
      }
      // And every point of the true cut has outline near it: nothing is missing,
      // in any direction. Near is one slice: the contours say nothing about the
      // shape between the last plane it reaches and the next one.
      for (const p of trueBoundary(c)) {
        const nearest = Math.min(...drawn.map((s) => distanceToSegment(p, s)));
        expect(nearest).toBeLessThan(NEAR_MM);
      }
    },
  );

  it('a plane off the middle is cut as well', () => {
    const rotation = { tiltU: degrees(6), tiltV: degrees(-4) };
    const c = cut(loops, Orientation.Axial, rotation, 44); // 36 mm above the middle
    const drawn = segments(c);
    for (const p of trueBoundary(c)) {
      expect(Math.min(...drawn.map((s) => distanceToSegment(p, s)))).toBeLessThan(NEAR_MM);
    }
    for (const [a] of drawn) expect(Math.abs(ellipsoidLevel(a) - 1)).toBeLessThan(0.1);
  });

  it('a plane that misses the structure has no outline', () => {
    expect(cut(loops, Orientation.Axial, { tiltU: degrees(5), tiltV: 0 }, 2).outline).toEqual([]);
    expect(cut(loops, Orientation.Coronal, { tiltU: degrees(5), tiltV: 0 }, 5).outline).toEqual([]);
  });
});

describe('where a tilt begins', () => {
  const loops = ellipsoidContours();
  const barely = { tiltU: degrees(0.001), tiltV: 0 };

  it('a barely tilted axial pane draws the contour of its slice, as an untilted one does', () => {
    const volume = makeVolume();
    const { outline } = cut(loops, Orientation.Axial, barely, 32);
    // One closed loop: the band of the displayed slice covers the pane.
    expect(outline).toHaveLength(1);
    expect(outline[0].closed).toBe(true);

    const flat = loops
      .map((points) => projectContour(volume, Orientation.Axial, points, true)!)
      .map((coords) => classifyContour(coords, volume, Orientation.Axial, 32))
      .filter((result) => result?.kind === 'loop');
    expect(flat).toHaveLength(1);
    const expected = (flat[0] as { points: { u: number; v: number }[] }).points;
    expect(outline[0].points).toHaveLength(expected.length);
    outline[0].points.forEach((p, i) => {
      expect(p.u).toBeCloseTo(expected[i].u, 4);
      expect(p.v).toBeCloseTo(expected[i].v, 4);
    });
  });

  it('a barely tilted coronal pane draws the silhouette an untilted one does', () => {
    const volume = makeVolume();
    const { outline } = cut(loops, Orientation.Coronal, barely, 61);
    const rows = loops
      .map((points) => projectContour(volume, Orientation.Coronal, points, true)!)
      .map((coords) => classifyContour(coords, volume, Orientation.Coronal, 61))
      .flatMap((result) => (result?.kind === 'cross' ? [result.row] : []));
    const [expected] = crossSectionOutline(rows);

    expect(outline).toHaveLength(1);
    expect(outline[0].closed).toBe(true);
    expect(outline[0].points).toHaveLength(expected.points.length);
    // The same points, whichever end of the stack each outline starts from.
    for (const p of expected.points) {
      const nearest = Math.min(...outline[0].points.map((q) => Math.hypot(q.u - p.u, q.v - p.v)));
      expect(nearest).toBeLessThan(1e-4);
    }
  });
});

describe('a hollow cylinder cut by a tilted plane', () => {
  // The same two circles on every slice: an outer wall and a hole. A cylinder
  // is the same at every height, so its slabs fit together with no step, and
  // seen along its axis the cut is the two circles themselves.
  const OUTER = 40;
  const INNER = 14;
  const loops: Vec3[][] = [];
  for (let k = 10; k <= 54; k++) {
    loops.push(ellipse([0, 0], [OUTER, OUTER], sliceZ(k), 180));
    loops.push(ellipse([0, 0], [INNER, INNER], sliceZ(k), 180));
  }

  it.each([
    ['12°', { tiltU: degrees(12), tiltV: 0 }],
    ['35° and 10°', { tiltU: degrees(35), tiltV: degrees(10) }],
  ])('tilted %s: both walls, whole, and nothing else', (_name, rotation) => {
    const drawn = segments(cut(loops, Orientation.Axial, rotation, 32));
    let outer = 0;
    let inner = 0;
    for (const [a, b] of drawn) {
      const ra = Math.hypot(a[0], a[1]);
      const rb = Math.hypot(b[0], b[1]);
      const wall = Math.abs(ra - OUTER) < 0.05 ? OUTER : INNER;
      // Both ends on the same wall: no step runs across from one to the other.
      expect(Math.abs(ra - wall)).toBeLessThan(0.05);
      expect(Math.abs(rb - wall)).toBeLessThan(0.05);
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (wall === OUTER) outer += length;
      else inner += length;
    }
    // Seen along the axis, each wall is drawn once round: no gap between
    // bands, and no piece drawn twice.
    expect(outer).toBeCloseTo(2 * Math.PI * OUTER, 0);
    expect(inner).toBeCloseTo(2 * Math.PI * INNER, 0);
  });
});

describe('buildContourStack', () => {
  const volume = makeVolume();
  const tilt = { tiltU: degrees(10), tiltV: 0 };
  const stackOf = (
    zs: number[],
    orientation: Orientation = Orientation.Axial,
    rotation: ObliqueRotation = tilt,
  ) =>
    buildContourStack(
      volume,
      orientation,
      rotation,
      zs.map((z) => {
        const points = ellipse([0, 0], [20, 20], z, 24);
        return { points, coords: projectContour(volume, orientation, points, true, rotation)! };
      }),
      SLICE_MM,
    )!;

  it('gives each contour the slab halfway to its neighbours', () => {
    const stack = stackOf([0, 3, 6]);
    expect(stack.spacing).toBeCloseTo(3);
    expect(stack.planes.map((p) => [p.below, p.above])).toEqual([
      [1.5, 1.5],
      [1.5, 1.5],
      [1.5, 1.5],
    ]);
    // Neighbouring slabs share a face.
    expect(stack.planes[0].highFace).toBe(stack.planes[1].lowFace);
    expect(stack.planes[1].highFace).toBe(stack.planes[2].lowFace);
    expect(new Set(stack.planes.flatMap((p) => [p.lowFace, p.highFace])).size).toBe(4);
  });

  it('puts contours of one plane in one slab, in stack order whatever order they came in', () => {
    const stack = stackOf([6, 0, 3, 3]);
    expect(stack.planes.map((p) => p.w)).toEqual(
      [0, 3, 6].map((w) => expect.closeTo(Math.abs(w), 6)),
    );
    expect(stack.planes.map((p) => p.contours.length)).toEqual([1, 2, 1]);
  });

  it('leaves a gap in the structure open', () => {
    const stack = stackOf([0, 3, 30, 33]);
    const [, second, third] = stack.planes;
    expect(second.above).toBeCloseTo(1.5);
    expect(third.below).toBeCloseTo(1.5);
    expect(second.highFace).not.toBe(third.lowFace);
  });

  it('uses the given spacing for a structure drawn on one plane', () => {
    const stack = stackOf([12]);
    expect(stack.spacing).toBe(SLICE_MM);
    expect([stack.planes[0].below, stack.planes[0].above]).toEqual([1.5, 1.5]);
  });

  it('knows which way the plane leans', () => {
    expect(stackOf([0, 3], Orientation.Axial, { tiltU: degrees(44), tiltV: 0 }).crossing).toBe(
      false,
    );
    expect(stackOf([0, 3], Orientation.Axial, { tiltU: degrees(46), tiltV: 0 }).crossing).toBe(
      true,
    );
    expect(stackOf([0, 3], Orientation.Coronal, { tiltU: degrees(44), tiltV: 0 }).crossing).toBe(
      true,
    );
    expect(stackOf([0, 3], Orientation.Coronal, { tiltU: degrees(46), tiltV: 0 }).crossing).toBe(
      false,
    );
  });

  it('is null for contours that span no plane', () => {
    const line: Vec3[] = [
      [0, 0, 0],
      [5, 0, 0],
    ];
    const coords = projectContour(volume, Orientation.Axial, line, false, tilt)!;
    expect(
      buildContourStack(volume, Orientation.Axial, tilt, [{ points: line, coords }], 3),
    ).toBeNull();
  });
});

describe('the overlay pipeline', () => {
  const volume = makeVolume();
  const contours: Contour[] = ellipsoidContours().map(
    (points) => ({ geometricType: 'CLOSED_PLANAR', points }) as unknown as Contour,
  );
  const sets = [
    { rois: [{ number: 1, name: 'Ellipsoid', color: [255, 0, 0], contours }] },
  ] as unknown as StructureSet[];
  const orientations = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal];
  const flat = { tiltU: 0, tiltV: 0 };
  const options = {
    sliceIndices: [32, 61, 69],
    shown: new Set(orientations),
    hidden: new Set<string>(),
    colorOverrides: new Map<string, string>(),
    opacities: new Map<string, number>(),
    selectedSet: -1,
    decimateTolerance: 0,
  };

  it('cuts the stack only for the pane that is tilted', () => {
    const coords = roiContourCoords(volume, sets, orientations, [
      { tiltU: degrees(5), tiltV: 0 },
      flat,
      flat,
    ]);
    expect(coords.get(Orientation.Axial)![0].stack).toBeDefined();
    expect(coords.get(Orientation.Coronal)![0].stack).toBeUndefined();
    expect(coords.get(Orientation.Sagittal)![0].stack).toBeUndefined();

    // The untilted panes draw exactly what they draw with nothing tilted.
    const untilted = roiPlaneShapes(
      volume,
      roiContourCoords(volume, sets, orientations, [flat, flat, flat]),
      options,
    );
    const shapes = roiPlaneShapes(volume, coords, options);
    expect(shapes.get(Orientation.Coronal)).toEqual(untilted.get(Orientation.Coronal));
    expect(shapes.get(Orientation.Sagittal)).toEqual(untilted.get(Orientation.Sagittal));

    // The tilted one draws the structure across its width, not a single line:
    // at 5° the plane meets only a few contours.
    const us = shapes
      .get(Orientation.Axial)![0]
      .polylines.flatMap((line) => line.points.map((p) => p.u));
    const vs = shapes
      .get(Orientation.Axial)![0]
      .polylines.flatMap((line) => line.points.map((p) => p.v));
    const widthMm = (Math.max(...us) - Math.min(...us)) * DIMS[0] * SPACING[0];
    const heightMm = (Math.max(...vs) - Math.min(...vs)) * DIMS[1] * SPACING[1];
    expect(widthMm).toBeGreaterThan(2 * ELLIPSOID.semi[0] - 4);
    expect(heightMm).toBeGreaterThan(2 * ELLIPSOID.semi[1] - 4);
  });
});

/** The area a planar ring encloses, in mm². */
function areaOf(points: readonly Vec3[]): number {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    x += a[1] * b[2] - a[2] * b[1];
    y += a[2] * b[0] - a[0] * b[2];
    z += a[0] * b[1] - a[1] * b[0];
  }
  return Math.hypot(x, y, z) / 2;
}

describe('the inside of a structure on a tilted plane', () => {
  const loops = ellipsoidContours();

  it.each([
    ['axial, 4°', Orientation.Axial, { tiltU: degrees(4), tiltV: 0 }],
    ['axial, 20° and 10°', Orientation.Axial, { tiltU: degrees(20), tiltV: degrees(10) }],
    ['axial, 40°', Orientation.Axial, { tiltU: 0, tiltV: degrees(40) }],
    ['coronal, 15°', Orientation.Coronal, { tiltU: degrees(15), tiltV: 0 }],
    ['sagittal, 30° and 20°', Orientation.Sagittal, { tiltU: degrees(30), tiltV: degrees(20) }],
  ] as [string, Orientation, ObliqueRotation][])(
    '%s: one ring, with the area of the true cut',
    (_name, orientation, rotation) => {
      const c = cut(loops, orientation, rotation, MIDDLE[orientation]);
      expect(c.rings).toHaveLength(1);
      const ring = c.rings[0].map((p) => c.toPatient(p.u, p.v));
      const truth = areaOf(trueBoundary(c, 720));
      // Within 3%: the ring is the outline, steps and all, joined up.
      expect(Math.abs(areaOf(ring) - truth) / truth).toBeLessThan(0.03);
      // Joined up, where the ring is made of pieces (the axial cases): no jump
      // in it longer than a step between two slices can be. Across the stack
      // the ring's first and last sides are whole chords, and long.
      for (let i = 0; orientation === Orientation.Axial && i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(12);
      }
    },
  );

  it('a hole is a ring of its own, inside the outer one', () => {
    const OUTER = 40;
    const INNER = 14;
    const hollow: Vec3[][] = [];
    for (let k = 10; k <= 54; k++) {
      hollow.push(ellipse([0, 0], [OUTER, OUTER], sliceZ(k), 180));
      hollow.push(ellipse([0, 0], [INNER, INNER], sliceZ(k), 180));
    }
    const tilt = degrees(25);
    const c = cut(hollow, Orientation.Axial, { tiltU: tilt, tiltV: 0 }, 32);
    const areas = c.rings
      .map((ring) => areaOf(ring.map((p) => c.toPatient(p.u, p.v))))
      .sort((a, b) => a - b);
    // A circle cut at an angle is an ellipse, longer by 1 / cos.
    expect(areas).toHaveLength(2);
    expect(areas[0] / ((Math.PI * INNER * INNER) / Math.cos(tilt))).toBeCloseTo(1, 2);
    expect(areas[1] / ((Math.PI * OUTER * OUTER) / Math.cos(tilt))).toBeCloseTo(1, 2);
  });

  it('stops at the edge of the pane, as the outline does', () => {
    // A column through every slice, wider than tall: a tilted coronal plane
    // runs out of its rectangle before the column ends.
    const column: Vec3[][] = [];
    for (let k = 0; k < DIMS[2]; k++) column.push(ellipse([0, 0], [100, 60], sliceZ(k)));
    const c = cut(column, Orientation.Coronal, { tiltU: degrees(25), tiltV: 0 }, 64);
    expect(c.rings.length).toBeGreaterThan(0);
    const every = [...c.rings.flat(), ...c.outline.flatMap((line) => line.points)];
    for (const p of every) {
      expect(p.u).toBeGreaterThanOrEqual(0);
      expect(p.u).toBeLessThanOrEqual(1);
      expect(p.v).toBeGreaterThanOrEqual(0);
      expect(p.v).toBeLessThanOrEqual(1);
    }
    // And it does reach the edge: the column goes on past it.
    expect(Math.min(...c.rings.flat().map((p) => p.v))).toBeCloseTo(0, 6);
    expect(Math.max(...c.rings.flat().map((p) => p.v))).toBeCloseTo(1, 6);
  });

  it('is nothing where the plane misses the structure', () => {
    expect(cut(loops, Orientation.Axial, { tiltU: degrees(5), tiltV: 0 }, 2).rings).toEqual([]);
  });
});

describe('filling in the overlay pipeline', () => {
  const volume = makeVolume();
  const NO_PAN = [0, 1, 2].map(() => ({ x: 0, y: 0 }));
  const hollow: Contour[] = [];
  for (let k = 20; k <= 44; k++) {
    for (const radius of [40, 14]) {
      hollow.push({
        geometricType: 'CLOSED_PLANAR',
        points: ellipse([0, 0], [radius, radius], sliceZ(k), 48),
      } as unknown as Contour);
    }
  }
  const sets = [
    { rois: [{ number: 7, name: 'Hollow', color: [0, 128, 255], contours: hollow }] },
  ] as unknown as StructureSet[];
  const orientations = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal];
  const flat = { tiltU: 0, tiltV: 0 };
  const options = {
    sliceIndices: [32, 64, 64],
    shown: new Set(orientations),
    hidden: new Set<string>(),
    colorOverrides: new Map<string, string>(),
    opacities: new Map<string, number>([['0:7', 0.8]]),
    selectedSet: -1,
    decimateTolerance: 0,
  };
  const coords = roiContourCoords(volume, sets, orientations, [flat, flat, flat]);

  it('is left out unless asked for', () => {
    const shapes = roiPlaneShapes(volume, coords, options);
    expect(shapes.get(Orientation.Axial)![0].fills).toBeUndefined();
    const panes = [
      { key: 'a', orientation: Orientation.Axial, rect: { x: 0, y: 0, width: 256, height: 256 } },
    ];
    const [overlay] = roiScreenShapes(volume, shapes, panes, [1, 1, 1], NO_PAN, false);
    expect(overlay.fills).toBeUndefined();
  });

  it('gives an untilted pane the closed lines it draws: wall and hole on the slice, the silhouette across', () => {
    const shapes = roiPlaneShapes(volume, coords, { ...options, fill: true });
    const axial = shapes.get(Orientation.Axial)![0];
    expect(axial.fills).toHaveLength(2);
    expect(axial.fills).toEqual(axial.polylines.map((line) => line.points));
    const coronal = shapes.get(Orientation.Coronal)![0];
    expect(coronal.fills).toHaveLength(1);
  });

  it('becomes one path per structure, a closed subpath per ring', () => {
    const shapes = roiPlaneShapes(volume, coords, { ...options, fill: true });
    const panes = [
      { key: 'a', orientation: Orientation.Axial, rect: { x: 10, y: 20, width: 256, height: 256 } },
    ];
    const [overlay] = roiScreenShapes(volume, shapes, panes, [1, 1, 1], NO_PAN, false);
    expect(overlay.fills).toHaveLength(1);
    const [fill] = overlay.fills!;
    expect(fill.key).toBe('0:7');
    expect(fill.color).toBe('rgb(0, 128, 255)');
    expect(fill.opacity).toBe(0.8);
    expect(fill.d.match(/M/g)).toHaveLength(2);
    expect(fill.d.match(/Z/g)).toHaveLength(2);
    // In the pane's own pixels: the volume is 256 mm across and so is the pane,
    // so the outer wall (40 mm) spans 88..168 around the middle (128).
    const xs = [...fill.d.matchAll(/[ML](-?[\d.]+),/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeCloseTo(88, 0);
    expect(Math.max(...xs)).toBeCloseTo(168, 0);
  });
});
