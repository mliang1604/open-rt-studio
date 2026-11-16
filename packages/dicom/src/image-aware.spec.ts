/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { refineToImage, visualHull } from './image-aware.js';
import { sliceMask } from './label-rubber-band.js';
import { labelIndex } from './label-volume.js';
import { slicePlane } from './live-wire.js';
import { interpolateSlices } from './slice-interpolation.js';

/** A seeded normal sample. */
function gauss(seed: number): () => number {
  let s = seed >>> 0;
  const uniform = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

const N = 48;
const DIMS: [number, number, number] = [N, N, N];
const PLANE = N * N;
const dice = (a: Uint8Array, b: Uint8Array): number => {
  let [both, sum] = [0, 0];
  for (let i = 0; i < a.length; i++) {
    both += a[i] & b[i];
    sum += a[i] + b[i];
  }
  return (2 * both) / sum;
};

/**
 * A 48³ image of an object of 100 on 0 with noise σ 10: a sphere of radius 15
 * about the middle, or an ellipsoid (semi-axes 18, 10, 12) turned 30° about z
 * and off the middle.
 */
function scene(kind: 'sphere' | 'ellipsoid') {
  const sample = gauss(3);
  const truth = new Uint8Array(N ** 3);
  const image = new Float32Array(N ** 3);
  const turn = Math.PI / 6;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let inside: boolean;
        if (kind === 'sphere') inside = Math.hypot(x - 24, y - 24, z - 24) <= 15;
        else {
          const [dx, dy, dz] = [x - 26, y - 22, z - 25];
          const u = dx * Math.cos(turn) + dy * Math.sin(turn);
          const v = -dx * Math.sin(turn) + dy * Math.cos(turn);
          inside = (u / 18) ** 2 + (v / 10) ** 2 + (dz / 12) ** 2 <= 1;
        }
        const i = labelIndex(DIMS, x, y, z);
        truth[i] = inside ? 1 : 0;
        image[i] = (inside ? 100 : 0) + 10 * sample();
      }
    }
  }
  return { truth, image };
}

/** Each axial slice of a volume settled to the image within 4 pixels. */
function settled(volume: Uint8Array, image: Float32Array, only?: ReadonlySet<number>): Uint8Array {
  const out = Uint8Array.from(volume);
  for (let z = 0; z < N; z++) {
    if (only && !only.has(z)) continue;
    const guess = volume.slice(z * PLANE, (z + 1) * PLANE);
    out.set(refineToImage(slicePlane(image, DIMS, 2, z), guess, 4).mask, z * PLANE);
  }
  return out;
}

// What was measured (Dice against the object; the band 4 pixels, at most three quarters of the
// guess's depth since #295):
//   sphere,    shape-based from every fifth axial slice 0.963, settled to the image 0.994
//   sphere,    hull of three central outlines           0.934, settled               1.000
//   ellipsoid, shape-based                              0.943, settled               0.978
//   ellipsoid, hull                                     0.903, settled               1.000
// A band of 2 or 6 pixels did less well; settling took 1 to 3 ms a 48² slice.
describe('settling interpolation to the image (#120)', () => {
  it('raises shape-based interpolation from every fifth slice of a sphere', () => {
    const { truth, image } = scene('sphere');
    const zs = [...Array(N).keys()].filter((z) =>
      truth.subarray(z * PLANE, (z + 1) * PLANE).some((v) => v),
    );
    const drawn = zs.filter((z) => (z - zs[0]) % 5 === 0);
    if (drawn.at(-1) !== zs.at(-1)) drawn.push(zs.at(-1)!);
    const data = new Uint16Array(N ** 3);
    for (const z of drawn)
      for (let i = 0; i < PLANE; i++) if (truth[z * PLANE + i]) data[z * PLANE + i] = 5;
    const between = interpolateSlices({ dims: DIMS, data, spacing: [1, 1, 1] }, 5, 2, drawn);
    const shaped = Uint8Array.from(data, (v) => (v === 5 ? 1 : 0));
    for (const [z, mask] of between) shaped.set(mask, z * PLANE);
    const shapeOnly = dice(shaped, truth);
    const withImage = dice(settled(shaped, image, new Set(between.keys())), truth);
    expect(shapeOnly).toBeGreaterThan(0.95);
    expect(withImage).toBeGreaterThan(0.99);
    expect(withImage).toBeGreaterThan(shapeOnly);
  });

  it('gives back an empty guess, and one thinner than the band, as it is', () => {
    const plane = { data: new Float32Array(100), width: 10, height: 10 };
    expect(refineToImage(plane, new Uint8Array(100), 4).mask.every((v) => v === 0)).toBe(true);
    // A 2-pixel stripe: nothing in it is more than 4 pixels inside.
    const stripe = new Uint8Array(100);
    for (let y = 0; y < 10; y++) stripe[y * 10 + 4] = stripe[y * 10 + 5] = 1;
    expect(refineToImage(plane, stripe, 4).mask).toEqual(stripe);
  });
});

describe('fitting from outlines in three planes (#120)', () => {
  const mid = (truth: Uint8Array, axis: 0 | 1 | 2) => ({
    axis,
    slice: 24,
    mask: sliceMask({ dims: DIMS, data: Uint16Array.from(truth, (v) => v * 5) }, 5, axis, 24).mask,
  });

  it.each([
    ['sphere', true, 0.93, 0.99],
    ['ellipsoid', false, 0.9, 0.98],
  ] as const)(
    'the hull of three outlines of a %s, settled to the image, is close to it',
    (kind, holds, hullAt, settledAt) => {
      const { truth, image } = scene(kind);
      const hull = visualHull({ dims: DIMS }, [mid(truth, 0), mid(truth, 1), mid(truth, 2)]);
      // Sections through the sphere's middle are its widest, and the hull holds it; sections
      // of the ellipsoid, off the middle and turned, are smaller than it, and the hull cuts it.
      expect(truth.every((v, i) => !v || hull[i] === 1)).toBe(holds);
      expect(dice(hull, truth)).toBeGreaterThan(hullAt);
      expect(dice(settled(hull, image), truth)).toBeGreaterThan(settledAt);
    },
  );

  it('is nothing without outlines, and an outline’s extrusion alone with one', () => {
    expect(visualHull({ dims: [3, 3, 3] }, []).every((v) => v === 0)).toBe(true);
    const mask = new Uint8Array(9);
    mask[4] = 1;
    // The middle pixel of a slice across z, extruded along z: the middle column.
    const hull = visualHull({ dims: [3, 3, 3] }, [{ axis: 2, slice: 0, mask }]);
    expect([...hull.keys()].filter((i) => hull[i])).toEqual([4, 13, 22]);
  });
});
