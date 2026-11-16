/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the specs of the brush and the contouring tools (#106) share: a small
// image, a pane over it, and the controllers wired as the viewer wires them.

import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Orientation, sheetHalfMm, type Volume } from '@open-rt-studio/dicom';
import { type PaneRect, NO_OBLIQUE } from '@open-rt-studio/render';

import { DATA_SOURCE, type DataSource } from '../data-source/data-source';
import { BrushController, type BrushInit } from './brush-controller';
import { CONTOUR_TOOL_PROVIDERS } from './contour-tools/contour-tools';
import { ContourToolsController } from './contour-tools/contour-tools-controller';
import { EditableStructuresStore } from './editable-structures-store';
import { type PanePlacement } from './pane-placement';
import {
  type PerOrientation,
  type PerOrientationOblique,
  type PerOrientationPan,
} from './viewer-overlays';

export const SQUARE: PaneRect = { x: 0, y: 0, width: 100, height: 100 };

/** The value of the test image at a voxel: 0 everywhere unless a spec gives a formula. */
export type ImageFormula = (x: number, y: number, z: number) => number;

export function makeVolume(formula: ImageFormula = () => 0): Volume {
  const [x, y, z] = [4, 4, 4];
  const data = new Float32Array(x * y * z);
  for (let k = 0; k < z; k++) {
    for (let j = 0; j < y; j++)
      for (let i = 0; i < x; i++) data[(k * y + j) * x + i] = formula(i, j, k);
  }
  let [min, max] = [Infinity, -Infinity];
  for (const value of data) [min, max] = [Math.min(min, value), Math.max(max, value)];
  return {
    dims: [x, y, z],
    spacing: [1, 1, 1],
    data,
    min,
    max,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
  };
}

/** A pointer event stand-in at canvas pixel (x, y); the canvas sits at the origin. */
export function pointer(x: number, y: number): PointerEvent {
  return { clientX: x, clientY: y, pointerId: 1 } as unknown as PointerEvent;
}

/** A change/input event whose target is a real DOM control with the given value. */
export function controlEvent(tag: 'select' | 'input', value: string): Event {
  const el = document.createElement(tag);
  if (el instanceof HTMLSelectElement) {
    // A <select> only takes a value that matches one of its options.
    const option = document.createElement('option');
    option.value = value;
    el.append(option);
  }
  el.value = value;
  return { target: el } as unknown as Event;
}

export const AXIAL_MID: Extract<PanePlacement, { kind: 'mpr' }> = {
  kind: 'mpr',
  orientation: Orientation.Axial,
  rect: SQUARE,
  group: 0,
};

/** How the panes are tilted: as they stay, or a signal a spec changes. */
export type Obliques = PerOrientationOblique | Signal<PerOrientationOblique>;

/** The axial pane tilted about its horizontal axis (#303). */
export const TILTED_AXIAL: PerOrientationOblique = [
  { tiltU: 0.6, tiltV: 0 },
  NO_OBLIQUE,
  NO_OBLIQUE,
];

/**
 * Of some voxels of the 4 × 4 × 4 test image, by flat index: whether every
 * one is on the sheet of the plane the tilted axial pane shows, and how many
 * slices of the grid they are on.
 */
export function onTiltedSheet(
  brush: BrushController,
  indices: readonly number[],
): { readonly onSheet: boolean; readonly slices: number } {
  const { stamp } = brush.tiltedPlaneOf(AXIAL_MID)!;
  const half = sheetHalfMm(stamp.normal, [1, 1, 1]);
  const off = (i: number): number =>
    stamp.normal[0] * (i % 4) +
    stamp.normal[1] * (Math.floor(i / 4) % 4) +
    stamp.normal[2] * Math.floor(i / 16) -
    stamp.offsetMm;
  return {
    onSheet: indices.every((i) => Math.abs(off(i)) <= half + 1e-9),
    slices: new Set(indices.map((i) => Math.floor(i / 16))).size,
  };
}

export interface Notice {
  readonly message: string;
  readonly problem: boolean;
}

/** `source` is where saves go; left out, it is the application's own (opened files). */
export function setup(
  source?: DataSource,
  formula?: ImageFormula,
  panes: readonly PanePlacement[] = [],
  slices: PerOrientation = [2, 2, 2],
  obliques?: Obliques,
): {
  brush: BrushController;
  store: EditableStructuresStore;
  tools: ContourToolsController;
  notices: Notice[];
} {
  const notices: Notice[] = [];
  TestBed.configureTestingModule({
    providers: [
      EditableStructuresStore,
      BrushController,
      ...CONTOUR_TOOL_PROVIDERS,
      ...(source ? [{ provide: DATA_SOURCE, useValue: source }] : []),
    ],
  });
  const { brush, store } = wireBrush(notices, formula, panes, slices, obliques);
  return { brush, store, tools: TestBed.inject(ContourToolsController), notices };
}

/**
 * Load the small image into the structures store of the TestBed as it is
 * configured, and wire the brush over an axial pane of it, as the viewer
 * does.
 */
export function wireBrush(
  notices: Notice[] = [],
  formula?: ImageFormula,
  panes: readonly PanePlacement[] = [],
  slices: PerOrientation = [2, 2, 2],
  obliques?: Obliques,
): {
  brush: BrushController;
  store: EditableStructuresStore;
} {
  const store = TestBed.inject(EditableStructuresStore);
  const volume = makeVolume(formula);
  store.resetForLoad(volume);
  const brush = TestBed.inject(BrushController);
  const noObliques: PerOrientationOblique = [NO_OBLIQUE, NO_OBLIQUE, NO_OBLIQUE];
  const deps: BrushInit = {
    volume: () => store.labelVolume() && volume,
    panes: () => panes,
    isReady: () => true,
    canvasBounds: () => ({ left: 0, top: 0 }) as DOMRect,
    zooms: signal<PerOrientation>([1, 1, 1]),
    pans: signal<PerOrientationPan>([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]),
    obliques: typeof obliques === 'function' ? obliques : signal(obliques ?? noObliques),
    sliceIndices: signal<PerOrientation>(slices),
    sagittalFlipped: () => false,
    baseSeries: () => null,
    notify: (message, problem) => notices.push({ message, problem }),
  };
  brush.init(deps);
  return { brush, store };
}
