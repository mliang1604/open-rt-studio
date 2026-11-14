/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Orientation, type Vec3 } from '@open-rt-studio/dicom';
import { NO_OBLIQUE, type ObliqueRotation, type OrbitCamera } from '@open-rt-studio/render';

import { Camera3dStore } from './camera3d-store';
import type { Drag } from './interaction-controller';
import { View3dController } from './view3d-controller';
import { OBLIQUE_PX_PER_RAD, type PerOrientationOblique } from './viewer-overlays';

// What a tilt turns about (#150): the crosshair as it stood when the plane
// left flat, and the same point for as long as the plane stays tilted.

function setup(initial: ObliqueRotation = NO_OBLIQUE) {
  TestBed.configureTestingModule({ providers: [View3dController, Camera3dStore] });
  const controller = TestBed.inject(View3dController);
  const obliques = signal<PerOrientationOblique>([initial, NO_OBLIQUE, NO_OBLIQUE]);
  const drag = signal<Drag | null>(null);
  const crosshair = signal<Vec3 | undefined>(undefined);
  controller.init({
    volume: () => null,
    isReady: () => true,
    panes: () => [],
    camera3d: () => ({ azimuth: 0, elevation: 0, zoom: 1, panX: 0, panY: 0 }) as OrbitCamera,
    sliceIndices: signal([0, 0, 0] as const),
    crosshairsEnabled: () => true,
    obliques,
    crosshairPoint: crosshair,
    slabThicknessMm: signal(10),
    drag,
    markMipSettling: () => {},
  });
  const event = (clientX: number, clientY: number): PointerEvent =>
    ({
      button: 0,
      clientX,
      clientY,
      pointerId: 1,
      target: {},
      preventDefault: () => {},
      stopPropagation: () => {},
    }) as unknown as PointerEvent;
  /** Drag the axial knob by (dx, dy) pixels. */
  const dragKnob = (dx: number, dy: number) => {
    controller.onObliqueHandleDown(event(100, 100), Orientation.Axial);
    controller.onObliqueHandleMove(event(100 + dx, 100 + dy));
    controller.onObliqueHandleUp(event(100 + dx, 100 + dy));
  };
  return { controller, obliques, drag, crosshair, dragKnob, axial: () => obliques()[0] };
}

describe('View3dController oblique tilt pivot', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('tilts by the knob travel: across yaws, down pitches', () => {
    const { dragKnob, axial, drag } = setup();
    dragKnob(28, -14);
    expect(axial().tiltV).toBeCloseTo(28 / OBLIQUE_PX_PER_RAD, 9);
    expect(axial().tiltU).toBeCloseTo(-14 / OBLIQUE_PX_PER_RAD, 9);
    expect(drag()).toBeNull();
  });

  it('a flat plane takes the crosshair as its pivot', () => {
    const { dragKnob, axial, crosshair } = setup();
    crosshair.set([12, -3, 40]);
    dragKnob(20, 0);
    expect(axial().pivot).toEqual([12, -3, 40]);
  });

  it('with no crosshair there is no pivot: the plane turns about the volume centre', () => {
    const { dragKnob, axial } = setup();
    dragKnob(20, 0);
    expect(axial()).toEqual({ tiltU: 0, tiltV: 20 / OBLIQUE_PX_PER_RAD });
    expect('pivot' in axial()).toBe(false);
  });

  it('a tilted plane keeps its pivot when the crosshair has moved since', () => {
    const { dragKnob, axial, crosshair } = setup();
    crosshair.set([12, -3, 40]);
    dragKnob(20, 0);
    crosshair.set([-50, 8, 2]);

    dragKnob(0, 10);

    expect(axial().pivot).toEqual([12, -3, 40]);
    expect(axial().tiltU).toBeCloseTo(10 / OBLIQUE_PX_PER_RAD, 9);
    expect(axial().tiltV).toBeCloseTo(20 / OBLIQUE_PX_PER_RAD, 9);
  });

  it('a plane tilted about the volume centre stays there when a crosshair appears', () => {
    const { dragKnob, axial, crosshair } = setup({ tiltU: 0.2, tiltV: 0 });
    crosshair.set([12, -3, 40]);
    dragKnob(10, 0);
    expect(axial().pivot).toBeUndefined();
  });

  it('after a reset the next tilt takes the crosshair where it is now', () => {
    const { controller, dragKnob, axial, crosshair } = setup();
    crosshair.set([12, -3, 40]);
    dragKnob(20, 0);
    crosshair.set([-50, 8, 2]);

    controller.resetOblique(Orientation.Axial);
    expect(axial()).toEqual(NO_OBLIQUE);
    dragKnob(20, 0);

    expect(axial().pivot).toEqual([-50, 8, 2]);
  });

  it('a drag back through flat keeps the pivot it began with', () => {
    const { controller, axial, crosshair } = setup();
    crosshair.set([12, -3, 40]);
    const at = (x: number) =>
      ({
        button: 0,
        clientX: x,
        clientY: 100,
        pointerId: 1,
        target: {},
        preventDefault: () => {},
        stopPropagation: () => {},
      }) as unknown as PointerEvent;
    controller.onObliqueHandleDown(at(100), Orientation.Axial);
    controller.onObliqueHandleMove(at(130));
    crosshair.set([0, 0, 0]); // cannot happen mid-drag by hand; the drag must not look again
    controller.onObliqueHandleMove(at(100));
    controller.onObliqueHandleMove(at(90));
    expect(axial().pivot).toEqual([12, -3, 40]);
  });
});
