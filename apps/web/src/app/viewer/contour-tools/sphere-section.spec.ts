/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PlaneFrame } from '@open-rt-studio/render';

import { sectionRadiusMm, sphereSection } from './sphere-section';

// A plane z = 10, 100 mm across from (0, 0).
const AXIAL: PlaneFrame = { origin: [0, 0, 10], alongU: [100, 0, 0], alongV: [0, 100, 0] };

describe('where a ball cuts a plane (#108)', () => {
  it('is at the foot of the centre, in the plane’s own coordinates, and how far off', () => {
    expect(sphereSection([25, 50, 13], 5, AXIAL)).toEqual({ u: 0.25, v: 0.5, distanceMm: 3 });
    expect(sphereSection([25, 50, 10], 5, AXIAL)).toEqual({ u: 0.25, v: 0.5, distanceMm: 0 });
  });

  it('is nothing for a plane as far as the radius or farther', () => {
    expect(sphereSection([25, 50, 15], 5, AXIAL)).toBeNull();
    expect(sphereSection([25, 50, 30], 5, AXIAL)).toBeNull();
    expect(sphereSection([25, 50, 10], 5, { ...AXIAL, alongU: [0, 0, 0] })).toBeNull();
  });

  it('is a circle of √(r² − d²): 4 mm for a 5 mm ball cut 3 mm off its centre', () => {
    expect(sectionRadiusMm(5, 3)).toBe(4);
    expect(sectionRadiusMm(5, 0)).toBe(5);
    expect(sectionRadiusMm(5, 5)).toBe(0);
  });
});
