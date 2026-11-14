/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  baseImageLayer,
  findPlacement,
  overlayImageLayer,
  type Layer,
  type LayerPlacement,
  type Volume,
} from '@open-rt-studio/dicom';
import { LayoutMode, NO_OBLIQUE } from '@open-rt-studio/render';

import { registrationObject } from '../registration-testing';
import type { LoadResult } from '../volume-loader';
import { CompareStore } from './compare-store';
import { LayersController } from './layers-controller';
import { LayersStore } from './layers-store';
import type { LoadState } from './load-controller';

// The window/level of the two Compare columns (#149): each its own by default,
// one for both while "Same window" is on and both hold the same modality.

function volumeOf(modality: string, windowCenter: number, windowWidth: number): Volume {
  return {
    dims: [4, 4, 4],
    spacing: [1, 1, 1],
    data: new Float32Array(64),
    min: 0,
    max: 0,
    windowCenter,
    windowWidth,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality,
    geometry: undefined,
  };
}

function setup(overlayModality: string | null, placement?: LayerPlacement) {
  const base = baseImageLayer('base', volumeOf('CT', 40, 400));
  const overlay = overlayModality
    ? overlayImageLayer('over', volumeOf(overlayModality, 600, 1200), placement)
    : null;
  const layers: Layer[] = overlay ? [base, overlay] : [base];
  const load = signal<LoadState>({
    status: 'ready',
    result: { layers } as unknown as LoadResult,
  });
  const activeGroup = signal(0);
  const markMipSettling = vi.fn();
  TestBed.configureTestingModule({ providers: [LayersController, LayersStore, CompareStore] });
  const controller = TestBed.inject(LayersController);
  const noPan = { x: 0, y: 0 };
  controller.init({
    load,
    layoutMode: signal(LayoutMode.Compare),
    panes: () => [],
    sliceIndices: signal([0, 0, 0] as const),
    zooms: signal([1, 1, 1] as const),
    pans: signal([noPan, noPan, noPan] as const),
    obliques: signal([NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE] as const),
    activeCompareGroup: activeGroup,
    markMipSettling,
  });
  controller.windowCenter.set(40);
  controller.windowWidth.set(400);
  const shown = () => controller.layers();
  return {
    controller,
    activeGroup,
    markMipSettling,
    base: () => shown()[0],
    overlay: () => shown()[1],
  };
}

describe('LayersController window/level in Compare', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('gives each column its own window by default', () => {
    const { controller, base, overlay } = setup('CT');
    expect(controller.windowShared()).toBe(false);
    expect(controller.layerWindow(base())).toEqual({ center: 40, width: 400 });
    expect(controller.layerWindow(overlay())).toEqual({ center: 600, width: 1200 });

    controller.setLayerWindow(overlay(), { center: 50, width: 350 });

    expect(controller.layerWindow(overlay())).toEqual({ center: 50, width: 350 });
    expect(controller.layerWindow(base())).toEqual({ center: 40, width: 400 });
  });

  it('linking shows the left column’s window on both', () => {
    const { controller, base, overlay, markMipSettling } = setup('CT');
    expect(controller.canShareWindow()).toBe(true);

    controller.toggleCompareWindowLinked();

    expect(controller.windowShared()).toBe(true);
    expect(controller.layerWindow(base())).toEqual({ center: 40, width: 400 });
    expect(controller.layerWindow(overlay())).toEqual({ center: 40, width: 400 });
    expect(markMipSettling).toHaveBeenCalled();
  });

  it('while linked, a change on either column applies to both', () => {
    const { controller, base, overlay } = setup('CT');
    controller.toggleCompareWindowLinked();

    controller.setLayerWindow(overlay(), { center: -600, width: 1500 });
    expect(controller.layerWindow(base())).toEqual({ center: -600, width: 1500 });
    expect(controller.layerWindow(overlay())).toEqual({ center: -600, width: 1500 });

    controller.setLayerWindow(base(), { center: 300, width: 2000 });
    expect(controller.layerWindow(overlay())).toEqual({ center: 300, width: 2000 });
  });

  it('while linked, the toolbar shows the same window whichever column is active', () => {
    const { controller, activeGroup } = setup('CT');
    controller.toggleCompareWindowLinked();
    controller.setLayerWindow(null, { center: 123, width: 456 });

    activeGroup.set(1);

    expect(controller.activeWindowCenter()).toBe(123);
    expect(controller.activeWindowWidth()).toBe(456);
  });

  it('unlinking leaves the right column on the window it was showing', () => {
    const { controller, base, overlay } = setup('CT');
    controller.toggleCompareWindowLinked();
    controller.setLayerWindow(base(), { center: -600, width: 1500 });

    controller.toggleCompareWindowLinked();

    expect(controller.windowShared()).toBe(false);
    expect(controller.layerWindow(overlay())).toEqual({ center: -600, width: 1500 });
    // And the columns are independent again.
    controller.setLayerWindow(base(), { center: 40, width: 400 });
    expect(controller.layerWindow(overlay())).toEqual({ center: -600, width: 1500 });
  });

  it('cannot link columns of different modalities', () => {
    const { controller, base, overlay } = setup('MR');
    expect(controller.canShareWindow()).toBe(false);

    controller.toggleCompareWindowLinked(); // the control is disabled; asking changes nothing shown

    expect(controller.windowShared()).toBe(false);
    expect(controller.layerWindow(base())).toEqual({ center: 40, width: 400 });
    expect(controller.layerWindow(overlay())).toEqual({ center: 600, width: 1200 });
  });

  it('cannot link with nothing in the second column', () => {
    const { controller } = setup(null);
    expect(controller.canShareWindow()).toBe(false);
    expect(controller.windowShared()).toBe(false);
  });
});

describe('LayersController and an overlay placed by a registration (#76)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function placement(): LayerPlacement {
    const found = findPlacement('planning', 'follow-up', [
      registrationObject('reg', 'follow-up', 'planning'),
    ]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    return found.placement;
  }

  it('is shown by Compare in the base’s planes: the base’s grid, the overlay’s picture and window', () => {
    const { controller, base, overlay, activeGroup } = setup('CT', placement());
    expect(controller.selectedOverlay()).toBe(overlay());
    expect(controller.compareInBasePlanes()).toBe(true);
    // Where the second column is, is the base's: its slices and its zoom.
    expect(controller.groupVolume(1)).toBe(base().volume);
    expect(controller.paneSliceIndex(1, 0)).toBe(controller.paneSliceIndex(0, 0));
    // What it shows is the overlay: its image and its own window.
    expect(controller.groupLayer(1)).toBe(overlay());
    expect(controller.groupLayer(0)).toBe(base());
    activeGroup.set(1);
    expect(controller.activeWlLayer()).toBe(overlay());
    expect(controller.canShareWindow()).toBe(true);
  });

  it('leaves an overlay in the base’s own frame on its own grid', () => {
    const { controller, overlay } = setup('CT');
    expect(controller.compareInBasePlanes()).toBe(false);
    expect(controller.groupVolume(1)).toBe(overlay().volume);
    expect(controller.groupLayer(1)).toBe(overlay());
  });

  it('shows the base in the second column when there is no overlay', () => {
    const { controller, base } = setup(null);
    expect(controller.groupVolume(1)).toBe(base().volume);
    expect(controller.groupLayer(1)).toBe(base());
  });
});

describe('LayersController pane tags (#230)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('gives each column its own slice and count, linked or not', () => {
    const { controller } = setup('CT');
    // Linked: the second column is at the plane the first is at.
    expect(controller.paneSliceLabel(0, 0)).toBe('1 / 4');
    expect(controller.paneSliceLabel(1, 0)).toBe('1 / 4');

    // Unlinked, the second column goes to its third slice by itself.
    controller.toggleCompareLinked();
    controller.updateGroupNav(1, { sliceIndices: [2, 0, 0] });
    expect(controller.paneSliceLabel(1, 0)).toBe('3 / 4');
    expect(controller.paneSliceLabel(0, 0)).toBe('1 / 4');
    // The other orientations of that column stay where they were.
    expect(controller.paneSliceLabel(1, 1)).toBe('1 / 4');
  });
});
