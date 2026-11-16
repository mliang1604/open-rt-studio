/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Live wire (#118): a path between two points of a slice that keeps to the
// image's edges, by the least cost over a map that is cheap where the edge is
// strong.
//
// **The cost** of a pixel of the slice is low where the image changes
// fastest there (the gradient's size, by central differences) and high where
// it is flat: `1 − g / gmax`, and a small floor so that no step is free.
//
// **The path** is the least-cost path through the pixels' 8 neighbours, a
// step costing the pixel stepped onto times the step's length (1, or √2
// across a corner). The paths from one anchor to every pixel are found at
// once (Dijkstra), so that the path to the cursor, as it moves, is only
// traced back. Pixels of the slice are taken as square: a slice of voxels
// that are not is still searched in pixels.

/** One slice of a grid, as a picture: its values, and its width and height in pixels. */
export interface SlicePlane {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

/**
 * The image's values on one slice of the grid: across axis `fixedAxis` at
 * `slice`, its pixels in the two other axes' order (x then y across z; x
 * then z across y; y then z across x), as `fillSliceLoop` takes them.
 */
export function slicePlane(
  image: Float32Array,
  dims: readonly [number, number, number],
  fixedAxis: 0 | 1 | 2,
  slice: number,
): SlicePlane {
  const [nx, ny] = dims;
  const [a, b] = ([0, 1, 2] as const).filter((axis) => axis !== fixedAxis);
  const [width, height] = [dims[a], dims[b]];
  const data = new Float32Array(width * height);
  const at = [0, 0, 0];
  at[fixedAxis] = slice;
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      at[a] = u;
      at[b] = v;
      data[v * width + u] = image[(at[2] * ny + at[1]) * nx + at[0]];
    }
  }
  return { data, width, height };
}

/** The least a step may cost, so that a path does not wander for free along a flat stretch. */
const COST_FLOOR = 0.01;

/** Each pixel's cost: low where the slice's values change fastest, high where they are flat. */
export function edgeCost(plane: SlicePlane): Float32Array {
  const { data, width: w, height: h } = plane;
  const gradient = new Float32Array(w * h);
  let most = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const left = data[y * w + Math.max(0, x - 1)];
      const right = data[y * w + Math.min(w - 1, x + 1)];
      const up = data[Math.max(0, y - 1) * w + x];
      const down = data[Math.min(h - 1, y + 1) * w + x];
      const g = Math.hypot(right - left, down - up);
      gradient[y * w + x] = g;
      if (g > most) most = g;
    }
  }
  const cost = new Float32Array(w * h);
  for (let i = 0; i < cost.length; i++) {
    cost[i] = COST_FLOOR + (most > 0 ? 1 - gradient[i] / most : 1);
  }
  return cost;
}

/** The least-cost paths from a seed to every pixel: each pixel's way back towards the seed (−1 for the seed). */
export interface PathTree {
  readonly width: number;
  readonly height: number;
  readonly seed: readonly [number, number];
  readonly previous: Int32Array;
}

/** A binary heap of pixels by their cost so far. */
class Queue {
  private readonly items: number[] = [];
  constructor(private readonly key: Float64Array) {}
  get size(): number {
    return this.items.length;
  }
  push(item: number): void {
    const { items, key } = this;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (key[items[parent]] <= key[items[i]]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop(): number {
    const { items, key } = this;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const [l, r] = [2 * i + 1, 2 * i + 2];
        let least = i;
        if (l < items.length && key[items[l]] < key[items[least]]) least = l;
        if (r < items.length && key[items[r]] < key[items[least]]) least = r;
        if (least === i) break;
        [items[least], items[i]] = [items[i], items[least]];
        i = least;
      }
    }
    return top;
  }
}

/** The least-cost paths from `seed` over `cost`, through each pixel's eight neighbours. */
export function shortestPaths(
  cost: Float32Array,
  width: number,
  height: number,
  seed: readonly [number, number],
): PathTree {
  const total = new Float64Array(width * height).fill(Infinity);
  const previous = new Int32Array(width * height).fill(-1);
  const done = new Uint8Array(width * height);
  const start = seed[1] * width + seed[0];
  total[start] = 0;
  const queue = new Queue(total);
  queue.push(start);
  while (queue.size > 0) {
    const i = queue.pop();
    if (done[i]) continue;
    done[i] = 1;
    const [x, y] = [i % width, Math.floor(i / width)];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const [px, py] = [x + dx, y + dy];
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const j = py * width + px;
        if (done[j]) continue;
        const step = cost[j] * (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
        if (total[i] + step < total[j]) {
          total[j] = total[i] + step;
          previous[j] = i;
          queue.push(j);
        }
      }
    }
  }
  return { width, height, seed, previous };
}

/** The path from the tree's seed to a pixel, both ends included; empty for a pixel off the slice. */
export function tracePath(tree: PathTree, to: readonly [number, number]): [number, number][] {
  const { width, height, previous } = tree;
  const [x, y] = to;
  if (x < 0 || y < 0 || x >= width || y >= height) return [];
  const path: [number, number][] = [];
  for (let i = y * width + x; i !== -1; i = previous[i])
    path.push([i % width, Math.floor(i / width)]);
  return path.reverse();
}
