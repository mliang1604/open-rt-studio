/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Orientation } from '@open-rt-studio/dicom';
import { NO_OBLIQUE } from '@open-rt-studio/render';

import type { PanePlacement } from './pane-placement';
import {
  buildObliqueGizmos,
  CROSSHAIR_GRAB_RADIUS,
  MAX_OBLIQUE_RAD,
  OBLIQUE_CROSSHAIR_CLEARANCE,
  OBLIQUE_KNOB_RADIUS,
  placeObliqueGizmo,
  type OverlayView,
} from './viewer-overlays';

// The tilt gizmo and the crosshair handle (#150): the knob used to rest at the
// middle of the pane, which is where the crosshair starts out, and a press
// there tilted the plane instead of grabbing the crosshair.

const RING = 56; // the full-size ring

describe('placeObliqueGizmo', () => {
  it('sits in the middle of a pane that has no crosshair', () => {
    expect(placeObliqueGizmo(400, 300, null)).toEqual({ cx: 200, cy: 150, radius: RING });
  });

  it('shrinks to fit a small pane, and gives up when there is no room', () => {
    expect(placeObliqueGizmo(60, 200, null)).toEqual({ cx: 30, cy: 100, radius: 26 });
    expect(placeObliqueGizmo(20, 200, null)).toBeNull();
  });

  it('goes to the right of the crosshair, level with it', () => {
    const place = placeObliqueGizmo(400, 300, { x: 200, y: 150 })!;
    expect(place).toEqual({ cx: 200 + OBLIQUE_CROSSHAIR_CLEARANCE + RING, cy: 150, radius: RING });
  });

  it('goes to the left when the right has no room for a full ring', () => {
    const place = placeObliqueGizmo(400, 300, { x: 330, y: 150 })!;
    expect(place).toEqual({ cx: 330 - OBLIQUE_CROSSHAIR_CLEARANCE - RING, cy: 150, radius: RING });
  });

  it('stays inside the pane when the crosshair is near the top or bottom edge', () => {
    const top = placeObliqueGizmo(400, 300, { x: 100, y: 5 })!;
    expect(top.cy - top.radius).toBeGreaterThanOrEqual(4);
    const bottom = placeObliqueGizmo(400, 300, { x: 100, y: 298 })!;
    expect(bottom.cy + bottom.radius).toBeLessThanOrEqual(296);
  });

  it('takes a smaller ring on the roomiest side of a small pane', () => {
    // 223 x 144, crosshair in the middle: neither side takes a full ring.
    const place = placeObliqueGizmo(223, 144, { x: 111.5, y: 72 })!;
    expect(place.radius).toBeLessThan(RING);
    expect(place.radius).toBeGreaterThan(30);
    expect(place.cx).toBeGreaterThan(111.5); // right wins a tie
  });

  it('keeps the knob clear of the crosshair handle, wherever the crosshair is and whatever the tilt', () => {
    const sizes: [number, number][] = [
      [900, 700],
      [451, 216],
      [223, 144],
      [160, 120],
    ];
    for (const [width, height] of sizes) {
      for (let x = 0; x <= width; x += width / 12) {
        for (let y = 0; y <= height; y += height / 12) {
          const place = placeObliqueGizmo(width, height, { x, y });
          expect(place, `${width}x${height} crosshair at ${x},${y}`).not.toBeNull();
          const { cx, cy, radius } = place!;
          // The ring is inside the pane.
          expect(cx - radius).toBeGreaterThanOrEqual(0);
          expect(cx + radius).toBeLessThanOrEqual(width);
          expect(cy - radius).toBeGreaterThanOrEqual(0);
          expect(cy + radius).toBeLessThanOrEqual(height);
          // The knob travels up to `radius` along each axis from the centre.
          // Nowhere in that square is it nearer the crosshair than the two
          // radii together, so neither covers the other.
          const dx = Math.max(Math.abs(x - cx) - radius, 0);
          const dy = Math.max(Math.abs(y - cy) - radius, 0);
          expect(Math.hypot(dx, dy)).toBeGreaterThan(CROSSHAIR_GRAB_RADIUS + OBLIQUE_KNOB_RADIUS);
        }
      }
    }
  });
});

describe('buildObliqueGizmos', () => {
  const pane: PanePlacement = {
    kind: 'mpr',
    orientation: Orientation.Axial,
    rect: { x: 100, y: 50, width: 400, height: 300 },
    group: 0,
  };
  const noPan = { x: 0, y: 0 };
  const view = (tilt = NO_OBLIQUE): OverlayView => ({
    panes: [pane, { kind: 'mip', rect: { x: 500, y: 50, width: 100, height: 100 } }],
    zooms: [1, 1, 1],
    pans: [noPan, noPan, noPan],
    obliques: [tilt, NO_OBLIQUE, NO_OBLIQUE],
    sliceIndices: [0, 0, 0],
    sagittalFlipped: false,
  });
  const KEY = 'mpr-0-0';

  it('shows a gizmo only on the hovered pane or a tilted one', () => {
    expect(buildObliqueGizmos(view(), null)).toEqual([]);
    expect(buildObliqueGizmos(view(), KEY)).toHaveLength(1);
    expect(buildObliqueGizmos(view({ tiltU: 0.1, tiltV: 0 }), null)).toHaveLength(1);
  });

  it('rests the knob in the middle of a pane without a crosshair', () => {
    const [gizmo] = buildObliqueGizmos(view(), KEY);
    expect([gizmo.cx, gizmo.cy, gizmo.knobX, gizmo.knobY]).toEqual([200, 150, 200, 150]);
    expect(gizmo.active).toBe(false);
  });

  it('rests the knob beside the crosshair, which is given in canvas pixels', () => {
    // The crosshair in the middle of the pane: (300, 200) on the canvas.
    const crosshairs = [{ key: KEY, rect: pane.rect, x: 300, y: 200 }];
    const [gizmo] = buildObliqueGizmos(view(), KEY, crosshairs);
    expect(gizmo.knobX).toBe(200 + OBLIQUE_CROSSHAIR_CLEARANCE + RING);
    expect(gizmo.knobY).toBe(150);
  });

  it('ignores the crosshair of another pane', () => {
    const crosshairs = [{ key: 'mpr-0-1', rect: pane.rect, x: 300, y: 200 }];
    const [gizmo] = buildObliqueGizmos(view(), KEY, crosshairs);
    expect([gizmo.cx, gizmo.cy]).toEqual([200, 150]);
  });

  it('moves the knob with the tilt, to the ring at the largest tilt', () => {
    const [gizmo] = buildObliqueGizmos(view({ tiltU: MAX_OBLIQUE_RAD / 2, tiltV: -9 }), null);
    expect(gizmo.active).toBe(true);
    expect(gizmo.knobY - gizmo.cy).toBeCloseTo(RING / 2, 6);
    expect(gizmo.knobX - gizmo.cx).toBe(-RING); // held at the ring
  });
});
