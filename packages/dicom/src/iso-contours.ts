/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The outline of where a field of numbers is at or above a level, on one
// slice: marching squares with the crossing of each grid edge put where the
// field, taken as linear along the edge, is at the level. It is how a
// structure that was resampled as an occupancy between 0 and 1 becomes
// contours again (#90): the outline at one half.
//
// `traceMaskLoops` in `marching-squares.ts` is the same for a field of
// nothing but 0 and 1, where it is exact and runs along pixel edges. This
// one gives an outline that cuts between pixel centres.

/**
 * A closed outline as points `[x, y]` in pixel coordinates, where a pixel's
 * centre is at whole numbers. The first point is not repeated at the end.
 */
export type IsoLoop = [number, number][];

/**
 * The outlines of where `values` (rows of `width`, `height` of them) are at
 * or above `level`.
 *
 * Beyond the grid the field is taken to be `outside`, which must be below
 * the level: an outline that reaches the grid's edge closes there, between
 * the outermost pixel centres and where the next would be. For an occupancy,
 * with `outside` 0 and the level one half, that is the pixels' own edge.
 *
 * Each outline is closed, and a hole is an outline of its own. Where two
 * regions meet at a corner only (two pixels at or above the level on one
 * diagonal of four, two below on the other), they are joined when the mean
 * of the four is at or above the level and apart otherwise.
 */
export function traceIsoLoops(
  values: ArrayLike<number>,
  width: number,
  height: number,
  level: number,
  outside = Number.NEGATIVE_INFINITY,
): IsoLoop[] {
  if (!(outside < level))
    throw new RangeError('The field beyond the grid must be below the level.');
  if (width <= 0 || height <= 0) return [];
  const at = (x: number, y: number): number =>
    x >= 0 && x < width && y >= 0 && y < height ? values[y * width + x] : outside;
  const inside = (value: number): boolean => value >= level;

  // A grid edge is named by its lower corner and whether it runs along x
  // (even) or along y (odd), one pixel beyond the grid on every side included.
  const span = width + 2;
  const alongX = (x: number, y: number): number => 2 * ((y + 1) * span + (x + 1));
  const alongY = (x: number, y: number): number => alongX(x, y) + 1;

  /** How far from `from` to `to` the field, linear between them, is at the level: 0 to 1. */
  const part = (from: number, to: number): number => {
    if (!Number.isFinite(from)) return 1;
    if (!Number.isFinite(to)) return 0;
    const t = (level - from) / (to - from);
    return t > 0 ? (t < 1 ? t : 1) : 0;
  };

  const points = new Map<number, [number, number]>();
  /** Each crossed edge's two neighbours along the outline, as they are found. */
  const joined = new Map<number, number[]>();
  const join = (a: number, b: number): void => {
    const ofA = joined.get(a);
    if (ofA) ofA.push(b);
    else joined.set(a, [b]);
    const ofB = joined.get(b);
    if (ofB) ofB.push(a);
    else joined.set(b, [a]);
  };

  for (let y = -1; y < height; y++) {
    for (let x = -1; x < width; x++) {
      // The four pixel centres about the cell: top left, top right, bottom right, bottom left.
      const [a, b, c, d] = [at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1)];
      const [ia, ib, ic, id] = [inside(a), inside(b), inside(c), inside(d)];
      if (ia === ib && ib === ic && ic === id) continue;
      const [top, right, bottom, left] = [
        alongX(x, y),
        alongY(x + 1, y),
        alongX(x, y + 1),
        alongY(x, y),
      ];
      // Each crossing belongs to the edge, so the cell on its other side finds the same point.
      if (ia !== ib && !points.has(top)) points.set(top, [x + part(a, b), y]);
      if (ib !== ic && !points.has(right)) points.set(right, [x + 1, y + part(b, c)]);
      if (id !== ic && !points.has(bottom)) points.set(bottom, [x + part(d, c), y + 1]);
      if (ia !== id && !points.has(left)) points.set(left, [x, y + part(a, d)]);

      const crossed = [ia !== ib, ib !== ic, ic !== id, id !== ia];
      const count = crossed.filter(Boolean).length;
      if (count === 2) {
        const [first, second] = [top, right, bottom, left].filter((_, edge) => crossed[edge]);
        join(first, second);
        continue;
      }
      // All four: one diagonal is in and the other out. Whether the two that
      // are in are one region is decided by the middle of the cell.
      const middle = inside((a + b + c + d) / 4);
      // Joined through the middle, the outline cuts off each corner that is out.
      const cutsOffTopRight = ia === middle; // a and c are as the middle is
      if (cutsOffTopRight) {
        join(top, right);
        join(bottom, left);
      } else {
        join(top, left);
        join(right, bottom);
      }
    }
  }

  // Every crossed edge has two neighbours, so each outline closes. Walk each once.
  const loops: IsoLoop[] = [];
  const done = new Set<number>();
  for (const start of joined.keys()) {
    if (done.has(start)) continue;
    const loop: IsoLoop = [];
    let previous = -1;
    let current = start;
    for (let guard = joined.size + 1; guard > 0; guard--) {
      done.add(current);
      const point = points.get(current)!;
      const last = loop[loop.length - 1];
      // Two crossings at one place (a pixel exactly at the level) are one point.
      if (!last || last[0] !== point[0] || last[1] !== point[1]) loop.push([point[0], point[1]]);
      const [first, second] = joined.get(current)!;
      const next = first !== previous ? first : second;
      previous = current;
      current = next;
      if (current === start || current === undefined) break;
    }
    const [head, tail] = [loop[0], loop[loop.length - 1]];
    if (loop.length > 1 && head[0] === tail[0] && head[1] === tail[1]) loop.pop();
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** The area an outline encloses, in pixels: positive whichever way it runs. */
export function loopArea(loop: readonly (readonly [number, number])[]): number {
  let twice = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    twice += x0 * y1 - x1 * y0;
  }
  return Math.abs(twice) / 2;
}
