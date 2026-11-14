/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type Orientation, type Vec3, type Volume } from '@open-rt-studio/dicom';
import type { PlanePoint } from './pane-coords.js';
import {
  patientToPlane,
  sliceCrossings,
  type ContourCoords,
  type ContourPolyline,
} from './contours.js';
import type { ObliqueRotation, PlaneCoords } from './reslice.js';

/**
 * The outline of a structure on a plane that is neither parallel nor at right
 * angles to its contours: a pane tilted with the oblique knob.
 *
 * A structure is a stack of parallel planar contours. Each contour stands for
 * the slab around its plane, halfway to its neighbours, which is how a
 * structure set describes a solid. Two things follow for a tilted plane, and
 * which one applies depends on which way the plane leans:
 *
 * - **Nearer to the contours' planes** (under 45° from them). The plane stays
 *   inside one slab over a wide band, and in that band the cut is that slab's
 *   contour, carried onto the plane. The outline is those pieces of contour,
 *   band by band, with a step on the line where two bands meet. A tilt of a
 *   few degrees crosses only a few contours, so the crossings alone say almost
 *   nothing; the contour inside the band says it all. As the tilt goes to zero
 *   the band covers the pane and the outline is the contour of the displayed
 *   slice, which is what an untilted pane draws.
 *
 *   A contour is not carried straight along the stack's normal: on the way to
 *   a neighbouring plane it is stretched and moved towards the box that holds
 *   the neighbour's contours, so that halfway there the two agree in place and
 *   size. Where a structure narrows quickly (the ends of a small target), this
 *   takes the outline in with the structure instead of in steps a slice high.
 *   Structures of the same section at every height are not changed by it.
 *
 * - **Nearer to the stack's normal** (45° or more). The plane crosses many
 *   contours, each along a chord, and the chords are parallel lines close
 *   together. The outline joins the ends of the chords, in stack order. As the
 *   tilt goes to zero this is the silhouette an untilted cross-sectional pane
 *   draws.
 *
 * Everything is done in the pane's own `(u, v, slicePos)` frame. That frame is
 * an affine image of the patient, and the construction uses only what an
 * affine map keeps: straight lines, parallels, and ratios along a line. The
 * one thing it does not keep, the direction of the stack's normal, is carried
 * into the frame as a vector ({@link ContourStack.extrusion}).
 */

/** Contours of one structure that lie in the same plane, with the slab they stand for. */
export interface StackPlane {
  /** Position along the stack's normal, in mm. */
  readonly w: number;
  /** How far the slab reaches below and above the plane, in mm. */
  readonly below: number;
  readonly above: number;
  /**
   * The slab's two faces, as indices shared with the neighbour that touches
   * each face. Steps are worked out per face, from both neighbours at once.
   */
  readonly lowFace: number;
  readonly highFace: number;
  readonly contours: readonly PlacedContour[];
}

/** One contour of a {@link StackPlane}, with the way each of its points is carried. */
export interface PlacedContour {
  readonly coords: ContourCoords;
  /**
   * For each point, its pane-frame displacement per mm of height above the
   * contour's plane (`up`) and below it (`down`): the stack's normal, leaning
   * towards the neighbour on that side.
   */
  readonly up: readonly PlaneCoords[];
  readonly down: readonly PlaneCoords[];
}

/** One structure's contours arranged for cutting with a tilted plane. Slice-independent. */
export interface ContourStack {
  /** The pane-frame displacement for 1 mm along the stack's normal. */
  readonly extrusion: PlaneCoords;
  /** True when the plane is nearer to the stack's normal than to the contours' planes. */
  readonly crossing: boolean;
  /** The stack's own spacing: the smallest gap between two of its planes, in mm. */
  readonly spacing: number;
  /** The planes in stack order. */
  readonly planes: readonly StackPlane[];
}

/** One contour as {@link buildContourStack} needs it: in the patient and in the pane's frame. */
export interface StackContour {
  readonly points: readonly Vec3[];
  readonly coords: ContourCoords;
}

/** Planes closer together than this (mm) are one plane. */
const SAME_PLANE_MM = 0.01;
/** A gap wider than this many spacings is a gap in the structure, not a wide slab. */
const GAP_SPACINGS = 1.5;
/** Outline pieces shorter than this, in plane units, are dropped. */
const TINY = 1e-9;
/**
 * How far a point may lean towards the neighbouring contour, as a share of
 * the rate at which the stack's normal crosses the pane's plane. Past this a
 * leaning point would run nearly along the plane, or back through it.
 */
const LEAN_LIMIT = 0.5;

/** A unit vector at right angles to `n`, along a patient axis where `n` allows. */
function acrossFrom(n: Vec3): Vec3 {
  // Cross with the axis n has least of; for axial contours this gives x and y.
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  const axis: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const c: Vec3 = [
    n[1] * axis[2] - n[2] * axis[1],
    n[2] * axis[0] - n[0] * axis[2],
    n[0] * axis[1] - n[1] * axis[0],
  ];
  const length = Math.hypot(...c);
  return [c[0] / length, c[1] / length, c[2] / length];
}

/** The box that holds a plane's contours, along the two in-plane axes. */
interface Box {
  readonly lo: readonly [number, number];
  readonly hi: readonly [number, number];
}

/** Where a coordinate inside one box falls in another: the same share of the way across. */
function intoBox(c: number, from: Box, to: Box, axis: 0 | 1): number {
  const width = from.hi[axis] - from.lo[axis];
  if (width < 1e-9) return (to.lo[axis] + to.hi[axis]) / 2;
  return to.lo[axis] + ((c - from.lo[axis]) / width) * (to.hi[axis] - to.lo[axis]);
}

/** Newell's normal of a planar loop; null when the points span no area. */
function loopNormal(points: readonly Vec3[]): Vec3 | null {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const length = Math.hypot(x, y, z);
  return length > 1e-9 ? [x / length, y / length, z / length] : null;
}

/**
 * Arrange one structure's contours for cutting with the plane of `orientation`
 * tilted by `rotation`. Null when the contours do not define a stack: fewer
 * than three points in every one, or a volume whose geometry cannot be inverted.
 *
 * `defaultSpacing` is the slab thickness for a structure drawn on one plane
 * only, which has no spacing of its own (the slice spacing of the image).
 */
export function buildContourStack(
  volume: Volume,
  orientation: Orientation,
  rotation: ObliqueRotation | undefined,
  contours: readonly StackContour[],
  defaultSpacing: number,
): ContourStack | null {
  let normal: Vec3 | null = null;
  for (const contour of contours) {
    normal = contour.points.length >= 3 ? loopNormal(contour.points) : null;
    if (normal) break;
  }
  if (!normal) return null;
  const n: Vec3 = normal;

  // The patient-to-pane map is affine; three unit steps give its linear part.
  const at = (point: Vec3) => patientToPlane(volume, orientation, point, rotation);
  const origin = at([0, 0, 0]);
  const steps = [at([1, 0, 0]), at([0, 1, 0]), at([0, 0, 1])];
  if (!origin || steps.some((step) => !step)) return null;
  const inPane = (vector: Vec3): PlaneCoords => {
    const along = (pick: (c: PlaneCoords) => number): number =>
      steps.reduce((sum, step, axis) => sum + vector[axis] * (pick(step!) - pick(origin)), 0);
    return { u: along((c) => c.u), v: along((c) => c.v), slicePos: along((c) => c.slicePos) };
  };
  const extrusion = inPane(n);
  // Two axes in the contours' planes, and what a step along each is in the pane.
  const across1 = acrossFrom(n);
  const across2: Vec3 = [
    n[1] * across1[2] - n[2] * across1[1],
    n[2] * across1[0] - n[0] * across1[2],
    n[0] * across1[1] - n[1] * across1[0],
  ];
  const inPane1 = inPane(across1);
  const inPane2 = inPane(across2);
  const dotWith = (axis: Vec3, p: Vec3): number => p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2];
  // slicePos changes fastest along the pane's own normal, by this much per mm.
  // Along the stack's normal it changes by that times the cosine between the two.
  const steepest = Math.hypot(...steps.map((step) => step!.slicePos - origin.slicePos));
  const cosine = steepest > 0 ? Math.abs(extrusion.slicePos) / steepest : 0;

  const placed = contours
    .map((contour) => {
      let sum = 0;
      for (const p of contour.points) sum += dotWith(n, p);
      return { w: sum / contour.points.length, contour };
    })
    .sort((a, b) => a.w - b.w);

  const groups: { w: number; contours: StackContour[]; box: Box }[] = [];
  for (const { w, contour } of placed) {
    const last = groups[groups.length - 1];
    if (last && w - last.w < SAME_PLANE_MM) last.contours.push(contour);
    else groups.push({ w, contours: [contour], box: { lo: [0, 0], hi: [0, 0] } });
  }
  for (const group of groups) {
    const lo: [number, number] = [Infinity, Infinity];
    const hi: [number, number] = [-Infinity, -Infinity];
    for (const { points } of group.contours) {
      for (const p of points) {
        const c = [dotWith(across1, p), dotWith(across2, p)];
        for (const axis of [0, 1] as const) {
          lo[axis] = Math.min(lo[axis], c[axis]);
          hi[axis] = Math.max(hi[axis], c[axis]);
        }
      }
    }
    group.box = { lo, hi };
  }

  // A point's displacement per mm of height towards a neighbouring plane: the
  // stack's normal, plus the lean that takes it to the same place in the
  // neighbour's box by the time it gets there.
  const limit = LEAN_LIMIT * Math.abs(extrusion.slicePos);
  const carry = (
    points: readonly Vec3[],
    from: Box,
    to: Box | null,
    gap: number,
    sign: 1 | -1,
  ): PlaneCoords[] =>
    points.map((p) => {
      if (!to) return extrusion;
      const c1 = dotWith(across1, p);
      const c2 = dotWith(across2, p);
      const d1 = (intoBox(c1, from, to, 0) - c1) / gap;
      const d2 = (intoBox(c2, from, to, 1) - c2) / gap;
      let lean = {
        u: d1 * inPane1.u + d2 * inPane2.u,
        v: d1 * inPane1.v + d2 * inPane2.v,
        slicePos: d1 * inPane1.slicePos + d2 * inPane2.slicePos,
      };
      const steep = Math.abs(lean.slicePos);
      if (steep > limit) {
        const f = limit / steep;
        lean = { u: lean.u * f, v: lean.v * f, slicePos: lean.slicePos * f };
      }
      return {
        u: extrusion.u + sign * lean.u,
        v: extrusion.v + sign * lean.v,
        slicePos: extrusion.slicePos + sign * lean.slicePos,
      };
    });

  let spacing = Infinity;
  for (let k = 1; k < groups.length; k++)
    spacing = Math.min(spacing, groups[k].w - groups[k - 1].w);
  if (!Number.isFinite(spacing)) spacing = defaultSpacing;

  // A slab reaches halfway to a neighbour. Where the neighbour is further than
  // a slice or so, there is a gap in the structure, and the slab ends half a
  // spacing out with a face of its own.
  let faces = 0;
  const planes: StackPlane[] = [];
  groups.forEach((group, k) => {
    const gapBelow = k > 0 ? group.w - groups[k - 1].w : Infinity;
    const gapAbove = k + 1 < groups.length ? groups[k + 1].w - group.w : Infinity;
    const touchesBelow = gapBelow <= GAP_SPACINGS * spacing;
    const touchesAbove = gapAbove <= GAP_SPACINGS * spacing;
    const lowFace = touchesBelow ? planes[k - 1].highFace : faces++;
    const boxBelow = touchesBelow ? groups[k - 1].box : null;
    const boxAbove = touchesAbove ? groups[k + 1].box : null;
    planes.push({
      w: group.w,
      below: touchesBelow ? gapBelow / 2 : spacing / 2,
      above: touchesAbove ? gapAbove / 2 : spacing / 2,
      lowFace,
      highFace: faces++,
      contours: group.contours.map(({ points, coords }) => ({
        coords,
        up: carry(points, group.box, boxAbove, gapAbove, 1),
        down: carry(points, group.box, boxBelow, gapBelow, -1),
      })),
    });
  });

  return { extrusion, crossing: cosine < Math.SQRT1_2, spacing, planes };
}

/**
 * The structure's outline on the pane's plane at through-plane position
 * `slicePos`, as far as the pane's rectangle goes. A tilted plane is cut off
 * where it leaves the rectangle the image is drawn in, and a structure can go
 * on past that; its outline stops with the image.
 */
export function cutContourStack(stack: ContourStack, slicePos: number): ContourPolyline[] {
  const outline = stack.crossing ? chordOutline(stack, slicePos) : slabOutline(stack, slicePos);
  return outline.flatMap(insidePane);
}

/** The part `[t0, t1]` of the segment from `a` to `b` inside the unit square, or null. */
function insideSquare(a: PlanePoint, b: PlanePoint): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  for (const axis of ['u', 'v'] as const) {
    const d = b[axis] - a[axis];
    for (const [p, q] of [
      [-d, a[axis]],
      [d, 1 - a[axis]],
    ]) {
      if (p === 0) {
        if (q < 0) return null;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/** A polyline cut to the pane's rectangle: itself when it is inside, else its inside pieces. */
function insidePane(line: ContourPolyline): ContourPolyline[] {
  const inside = (p: PlanePoint): boolean => p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1;
  if (line.points.every(inside)) return [line];

  const { points, closed } = line;
  const pieces: PlanePoint[][] = [];
  let current: PlanePoint[] | null = null;
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const part = insideSquare(a, b);
    if (!part) {
      current = null;
      continue;
    }
    const at = (t: number): PlanePoint =>
      t === 0 ? a : t === 1 ? b : { u: a.u + t * (b.u - a.u), v: a.v + t * (b.v - a.v) };
    if (!current || part[0] > 0) pieces.push((current = [at(part[0])]));
    current.push(at(part[1]));
    if (part[1] < 1) current = null;
  }
  // A closed line that starts inside: its last piece runs on into its first.
  if (closed && current && pieces.length > 1 && inside(points[0])) {
    const last = pieces.pop()!;
    pieces[0] = [...last.slice(0, -1), ...pieces[0]];
  }
  return pieces
    .filter((piece) => piece.length >= 2)
    .map((piece) => ({ points: piece, closed: false }));
}

// ---------------------------------------------------------------------------
// Nearer to the stack's normal: join the ends of the chords.
// ---------------------------------------------------------------------------

/** The two ends of a set of points on one line, along whichever axis the line runs. */
function ends(points: readonly PlanePoint[], axis: 'u' | 'v'): [PlanePoint, PlanePoint] {
  let lo = points[0];
  let hi = points[0];
  for (const p of points) {
    if (p[axis] < lo[axis]) lo = p;
    if (p[axis] > hi[axis]) hi = p;
  }
  return [lo, hi];
}

/** The axis a set of collinear points spreads along more. */
function spreadAxis(points: readonly PlanePoint[]): { axis: 'u' | 'v'; spread: number } {
  const [uLo, uHi] = ends(points, 'u');
  const [vLo, vHi] = ends(points, 'v');
  const du = uHi.u - uLo.u;
  const dv = vHi.v - vLo.v;
  return du >= dv ? { axis: 'u', spread: du } : { axis: 'v', spread: dv };
}

function chordOutline(stack: ContourStack, slicePos: number): ContourPolyline[] {
  // One chord per plane the pane's plane crosses: every crossing of every
  // contour in that plane. They all lie on one line.
  const chords: { w: number; points: PlanePoint[] }[] = [];
  for (const plane of stack.planes) {
    const points: PlanePoint[] = [];
    for (const { coords: c } of plane.contours) {
      if (c.minSlicePos > slicePos || c.maxSlicePos < slicePos) continue;
      points.push(...sliceCrossings(c.coords, slicePos, c.closed));
    }
    if (points.length >= 2) chords.push({ w: plane.w, points });
  }
  if (chords.length === 0) return [];

  // The chords are parallel, so one axis orders the points of every chord. Take
  // it from the longest chord, where it is least in doubt.
  let axis: 'u' | 'v' = 'u';
  let longest = -1;
  for (const chord of chords) {
    const { axis: a, spread } = spreadAxis(chord.points);
    if (spread > longest) [axis, longest] = [a, spread];
  }

  const outlines: ContourPolyline[] = [];
  let run: [PlanePoint, PlanePoint][] = [];
  const close = () => {
    if (run.length === 1) outlines.push({ points: run[0], closed: false });
    else if (run.length > 1) {
      const near = run.map(([lo]) => lo);
      const far = run.map(([, hi]) => hi).reverse();
      outlines.push({ points: [...near, ...far], closed: true });
    }
    run = [];
  };
  chords.forEach((chord, i) => {
    // A missing plane between two chords is a gap in the structure, or a place
    // where the plane leaves it: the outline does not bridge it.
    if (i > 0 && chord.w - chords[i - 1].w > GAP_SPACINGS * stack.spacing) close();
    run.push(ends(chord.points, axis));
  });
  close();
  return outlines;
}

// ---------------------------------------------------------------------------
// Nearer to the contours' planes: the contour of each slab, inside its band.
// ---------------------------------------------------------------------------

/** A contour vertex carried onto the pane's plane. */
interface Carried {
  readonly u: number;
  readonly v: number;
  /** How far it was carried, in mm: the plane's height above the contour there. */
  readonly t: number;
}

const pointOf = (c: Carried): PlanePoint => ({ u: c.u, v: c.v });

const lerp = (a: Carried, b: Carried, t: number): PlanePoint => {
  const f = (t - a.t) / (b.t - a.t);
  return { u: a.u + f * (b.u - a.u), v: a.v + f * (b.v - a.v) };
};

/**
 * The parts of one contour that lie in the band `lo < t <= hi` of the plane,
 * as polylines. Where the contour passes through a face of the band the point
 * is also added to `onLow` or `onHigh` (closed contours only: an open one
 * encloses nothing, so it leaves no step).
 */
function contourInBand(
  carried: readonly Carried[],
  closed: boolean,
  lo: number,
  hi: number,
  onLow: PlanePoint[],
  onHigh: PlanePoint[],
): ContourPolyline[] {
  // Which side of the band a height is on: -1 below, 0 inside, 1 above. A point
  // exactly on a face belongs to the slab below it, so two slabs never share one.
  const side = (t: number): -1 | 0 | 1 => (t > hi ? 1 : t > lo ? 0 : -1);
  const face = (which: -1 | 1, a: Carried, b: Carried): PlanePoint => {
    const point = lerp(a, b, which === 1 ? hi : lo);
    if (closed) (which === 1 ? onHigh : onLow).push(point);
    return point;
  };

  const n = carried.length;
  const pieces: PlanePoint[][] = [];
  let current: PlanePoint[] | null = side(carried[0].t) === 0 ? [pointOf(carried[0])] : null;
  let left = false; // whether the contour ever left the band
  const edges = closed ? n : n - 1;
  for (let i = 0; i < edges; i++) {
    const a = carried[i];
    const b = carried[(i + 1) % n];
    const sa = side(a.t);
    const sb = side(b.t);
    if (sa === 0 && sb === 0) {
      current!.push(pointOf(b));
    } else if (sa === 0) {
      current!.push(face(sb as -1 | 1, a, b));
      pieces.push(current!);
      current = null;
      left = true;
    } else if (sb === 0) {
      current = [face(sa, a, b), pointOf(b)];
      left = true;
    } else if (sa !== sb) {
      // Straight through the band, in at one face and out at the other.
      pieces.push([face(sa, a, b), face(sb, a, b)]);
      left = true;
    }
  }

  if (current) {
    if (closed && !left) {
      current.pop(); // the walk ended on the vertex it began with
      return [{ points: current, closed: true }];
    }
    if (closed && pieces.length > 0 && side(carried[0].t) === 0) {
      // The walk began inside the band: its first piece continues the last.
      pieces[0] = [...current.slice(0, -1), ...pieces[0]];
    } else {
      pieces.push(current);
    }
  }
  return pieces.filter((points) => points.length >= 2).map((points) => ({ points, closed: false }));
}

/** The cut of a stack nearer to the contours' planes, in the parts it is made of. */
interface SlabCut {
  /** Contours that lie in one band whole. */
  readonly loops: (readonly PlanePoint[])[];
  /** Pieces of closed contours, each ending on a face of its band at both ends. */
  readonly pieces: (readonly PlanePoint[])[];
  /** Pieces of open contours: lines, not part of any boundary. */
  readonly strays: (readonly PlanePoint[])[];
  /**
   * The steps: on each face, the pairs of points between which the structure
   * is on one side only. A pair can be one place twice (no step to draw), and
   * is still listed: it says which two pieces meet there.
   */
  readonly steps: [PlanePoint, PlanePoint][];
}

function slabCut(stack: ContourStack, slicePos: number): SlabCut {
  const { extrusion } = stack;
  const cut: SlabCut = { loops: [], pieces: [], strays: [], steps: [] };
  const faces = new Map<number, PlanePoint[]>();
  const faceList = (index: number): PlanePoint[] => {
    let list = faces.get(index);
    if (!list) faces.set(index, (list = []));
    return list;
  };

  for (const plane of stack.planes) {
    const lo = -plane.below;
    const hi = plane.above;
    for (const { coords: c, up, down } of plane.contours) {
      // Straight along the normal, the plane's height above the contour runs
      // between these two. A leaning point crosses the plane at between two
      // thirds and twice that height (LEAN_LIMIT), on the same side; skip the
      // contour when even so the whole of it is outside the slab.
      const t0 = (slicePos - c.minSlicePos) / extrusion.slicePos;
      const t1 = (slicePos - c.maxSlicePos) / extrusion.slicePos;
      const reach = 1 + LEAN_LIMIT;
      if (Math.max(t0, t1) <= lo * reach || Math.min(t0, t1) > hi * reach) continue;
      const carried = c.coords.map((p, i): Carried => {
        // Above the contour's plane the point leans towards the neighbour
        // above, below it towards the one below.
        const rise = slicePos - p.slicePos;
        const by = rise / extrusion.slicePos > 0 ? up[i] : down[i];
        const t = rise / by.slicePos;
        return { u: p.u + t * by.u, v: p.v + t * by.v, t };
      });
      const parts = contourInBand(
        carried,
        c.closed,
        lo,
        hi,
        faceList(plane.lowFace),
        faceList(plane.highFace),
      );
      for (const part of parts) {
        (part.closed ? cut.loops : c.closed ? cut.pieces : cut.strays).push(part.points);
      }
    }
  }

  // On a face, the points where contours pass through it mark where the
  // structure's inside begins and ends along the face's line. With the points
  // of both neighbours together, each pair in order bounds a stretch that is
  // inside one slab and outside the other: a step of the outline. Where the two
  // contours agree the pair is one point twice, and there is no step.
  for (const points of faces.values()) {
    if (points.length < 2) continue;
    const { axis } = spreadAxis(points);
    points.sort((p, q) => p[axis] - q[axis]);
    for (let i = 0; i + 1 < points.length; i += 2) cut.steps.push([points[i], points[i + 1]]);
  }
  return cut;
}

function slabOutline(stack: ContourStack, slicePos: number): ContourPolyline[] {
  const { loops, pieces, strays, steps } = slabCut(stack, slicePos);
  return [
    ...loops.map((points) => ({ points, closed: true })),
    ...[...pieces, ...strays].map((points) => ({ points, closed: false })),
    ...steps
      .filter(([a, b]) => Math.hypot(b.u - a.u, b.v - a.v) > TINY)
      .map((points) => ({ points, closed: false })),
  ];
}

/**
 * The closed rings the pieces and steps of a cut make. Every end of a piece is
 * a point on a face, and every such point is in exactly one step, so following
 * piece, step, piece, step comes back to where it began.
 */
function slabRings(stack: ContourStack, slicePos: number): (readonly PlanePoint[])[] {
  const { loops, pieces, steps } = slabCut(stack, slicePos);
  const ends = new Map<PlanePoint, { piece: number; atStart: boolean }>();
  pieces.forEach((points, piece) => {
    ends.set(points[0], { piece, atStart: true });
    ends.set(points[points.length - 1], { piece, atStart: false });
  });
  const across = new Map<PlanePoint, PlanePoint>();
  for (const [a, b] of steps) {
    across.set(a, b);
    across.set(b, a);
  }

  const rings = [...loops];
  const used = pieces.map(() => false);
  for (let first = 0; first < pieces.length; first++) {
    if (used[first]) continue;
    const ring: PlanePoint[] = [];
    let next: { piece: number; atStart: boolean } | undefined = { piece: first, atStart: true };
    while (next && !used[next.piece]) {
      used[next.piece] = true;
      const points = next.atStart ? pieces[next.piece] : [...pieces[next.piece]].reverse();
      ring.push(...points);
      const far = across.get(points[points.length - 1]);
      next = far ? ends.get(far) : undefined;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** A ring cut to the pane's rectangle, edge by edge. Empty when none of it is inside. */
function ringInsidePane(ring: readonly PlanePoint[]): PlanePoint[] {
  let points = ring.slice();
  for (const axis of ['u', 'v'] as const) {
    for (const bound of [0, 1]) {
      const inside = (p: PlanePoint): boolean => (bound === 0 ? p[axis] >= 0 : p[axis] <= 1);
      const out: PlanePoint[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        if (inside(a)) out.push(a);
        if (inside(a) !== inside(b)) {
          const t = (bound - a[axis]) / (b[axis] - a[axis]);
          out.push({ u: a.u + t * (b.u - a.u), v: a.v + t * (b.v - a.v) });
        }
      }
      points = out;
      if (points.length < 3) return [];
    }
  }
  return points;
}

/**
 * The structure's inside on the pane's plane at `slicePos`, as closed rings to
 * fill by the even-odd rule (a ring inside another is a hole), cut to the
 * pane's rectangle. The rings bound the same region {@link cutContourStack}
 * outlines.
 */
export function fillContourStack(stack: ContourStack, slicePos: number): PlanePoint[][] {
  const rings = stack.crossing
    ? chordOutline(stack, slicePos)
        .filter((line) => line.closed)
        .map((line) => [...line.points])
    : slabRings(stack, slicePos);
  return rings.map(ringInsidePane).filter((ring) => ring.length >= 3);
}
