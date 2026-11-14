/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  baseImageLayer,
  findPlacement,
  invertMat4,
  jacobianDeterminants,
  manualPlacement,
  overlayImageLayer,
  rigidMat4,
  transformVector,
  deformableTransform,
  type DeformableSpatialRegistration,
  type DeformationGrid,
  type Layer,
  type LayerPlacement,
  type RegistrationObject,
  type Volume,
} from '@open-rt-studio/dicom';
import { LayoutMode, NO_OBLIQUE } from '@open-rt-studio/render';

import { registrationObject, shiftMatrix } from '../registration-testing';
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

function setup(
  overlayModality: string | null,
  placement?: LayerPlacement,
  registrations: readonly RegistrationObject[] = [],
) {
  const base = baseImageLayer('base', volumeOf('CT', 40, 400));
  const overlay = overlayModality
    ? overlayImageLayer('over', volumeOf(overlayModality, 600, 1200), placement)
    : null;
  const layers: Layer[] = overlay ? [base, overlay] : [base];
  const load = signal<LoadState>({
    status: 'ready',
    result: { layers, registrations } as unknown as LoadResult,
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

describe('LayersController and what a deformation field is doing (#83)', () => {
  afterEach(() => TestBed.resetTestingModule());

  /**
   * A grid of 5 × 3 × 3 vectors 2 mm apart from the origin, whose x part is
   * `along(x)` of its place.
   */
  function gridOf(along: (x: number) => number): DeformationGrid {
    const vectors = new Float32Array(5 * 3 * 3 * 3);
    for (let n = 0; n < 45; n++) vectors[n * 3] = along((n % 5) * 2);
    return {
      dims: [5, 3, 3],
      origin: [0, 0, 0],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      spacing: [2, 2, 2],
      vectors,
    };
  }
  /** A placement through `grid`, after a matrix that moves the base's points 2 mm along x. */
  function through(grid: DeformationGrid): LayerPlacement {
    const pre = shiftMatrix(2, 0, 0);
    const plain = manualPlacement('planning', 'follow-up', shiftMatrix(0, 0, 0));
    return {
      ...plain,
      steps: [{ ...plain.steps[0], byHand: false, deformable: true }],
      field: { pre, grid, post: plain.baseToLayer },
    };
  }
  /** A squeeze to three quarters along x: 0.75 everywhere, moving a place by a quarter of its x. */
  const SQUEEZE = gridOf((x) => -0.25 * x);

  it('shows nothing of the field until asked, on the scale that fits the field', () => {
    const { controller } = setup('MR', through(SQUEEZE));
    expect(controller.selectedField()?.grid).toBe(SQUEEZE);
    // The field moves a place by 2 mm at most: a scale to 2 mm.
    expect(controller.fieldView()).toEqual({ kind: 'none', opacity: 0.6, maxMm: 2 });
    expect(controller.fieldViewScaleFits()).toBe(true);
    expect(controller.fieldViewDeterminants()).toBeNull();
    expect(controller.fieldReading([2, 2, 2])).toBeNull();
  });

  it('takes a scale the user sets, and goes back to the fitting one', () => {
    const { controller } = setup('MR', through(SQUEEZE));
    controller.setFieldViewKind('displacement');
    controller.setFieldViewOpacity(0.9);
    controller.setFieldViewMaxMm(12.5);
    expect(controller.fieldView()).toEqual({ kind: 'displacement', opacity: 0.9, maxMm: 12.5 });
    expect(controller.fieldViewScaleFits()).toBe(false);
    controller.setFieldViewMaxMm(null);
    expect(controller.fieldView().maxMm).toBe(2);
    expect(controller.fieldViewScaleFits()).toBe(true);
  });

  it('reads how far the field moves a point of the base, after the matrix before the field', () => {
    const { controller } = setup('MR', through(SQUEEZE));
    controller.setFieldViewKind('displacement');
    // The base's x = 2 is the grid's x = 4, where the field moves by 1 mm; between vectors, between.
    expect(controller.fieldReading([2, 2, 2])).toEqual({ kind: 'displacement', mm: 1 });
    const between = controller.fieldReading([3, 1, 3]);
    expect(between).toMatchObject({ kind: 'displacement' });
    expect((between as { mm: number }).mm).toBeCloseTo(1.25, 6);
    // Outside the grid, where no wash is drawn: nothing.
    expect(controller.fieldReading([7, 2, 2])).toBeNull();
    // The determinants are not worked out for this wash.
    expect(controller.fieldViewDeterminants()).toBeNull();
  });

  it('gives the renderer the determinants its wash is of, and reads the same under the cursor', () => {
    // Still up to the grid's x = 4, then taking back twice what it is given: a fold.
    const fold = gridOf((x) => (x <= 4 ? 0 : -2 * (x - 4)));
    const placement = through(fold);
    const { controller } = setup('MR', placement);
    controller.setFieldViewKind('jacobian');
    const determinants = controller.fieldViewDeterminants()!;
    expect([...determinants]).toEqual([
      ...jacobianDeterminants(fold, placement.field!.pre, placement.field!.post),
    ]);
    // Along a row: no change, half the turn at the vector between, then the fold.
    expect([...determinants.slice(0, 5)]).toEqual([1, 1, 0, -1, -1]);
    // Worked out once for a field: the same numbers when asked again.
    controller.setFieldViewOpacity(0.3);
    expect(controller.fieldViewDeterminants()).toBe(determinants);

    // The base's x is the grid's less 2.
    expect(controller.fieldReading([0, 2, 2])).toEqual({ kind: 'jacobian', determinant: 1 });
    expect(controller.fieldReading([4, 2, 2])).toEqual({ kind: 'jacobian', determinant: -1 });
    expect(controller.fieldReading([1, 2, 2])).toEqual({ kind: 'jacobian', determinant: 0.5 });
  });

  it('draws the deformed grid at a spacing that fits the overlay, or the one the user sets', () => {
    const { controller } = setup('MR', through(SQUEEZE));
    // The renderer is given no spacing until the grid is asked for.
    expect(controller.fieldGridDrawn()).toBeNull();
    controller.toggleFieldGrid();
    // The overlay is 4 mm a side: about an eighth of that, as 1, 2 or 5 times a power of ten.
    expect(controller.fieldGridSpacingMm()).toBeCloseTo(0.5, 9);
    expect(controller.fieldGridSpacingFits()).toBe(true);
    expect(controller.fieldGridDrawn()).toBeCloseTo(0.5, 9);
    controller.setFieldGridSpacingMm(2);
    expect(controller.fieldGridDrawn()).toBe(2);
    expect(controller.fieldGridSpacingFits()).toBe(false);
    controller.setFieldGridSpacingMm(null);
    expect(controller.fieldGridDrawn()).toBeCloseTo(0.5, 9);
    controller.toggleFieldGrid();
    expect(controller.fieldGridDrawn()).toBeNull();
  });

  it('gives the field’s displacement at a point of the base as a vector of the base’s frame', () => {
    // The base's x = 2 is the grid's x = 4, where the field moves by −1 mm along x.
    const { controller } = setup('MR', through(SQUEEZE));
    expect(controller.fieldDisplacementAt([2, 2, 2])).toEqual([-1, 0, 0]);
    expect(controller.fieldDisplacementAt([7, 2, 2])).toBeNull();
    // It does not wait for a wash to be on.
    expect(controller.fieldView().kind).toBe('none');
  });

  it('turns the displacement back into the base’s frame when the matrix before the field turns it', () => {
    // The matrix before the field turns the base a quarter about the head-foot
    // axis: the base's x is the grid's y. The field moves along the grid's x.
    const quarter = rigidMat4([0, 0, 1], 90);
    const plain = manualPlacement('planning', 'follow-up', shiftMatrix(0, 0, 0));
    const grid: DeformationGrid = {
      ...gridOf(() => 1),
      origin: [-4, -2, -2],
    };
    const { controller } = setup('MR', {
      ...plain,
      steps: [{ ...plain.steps[0], byHand: false, deformable: true }],
      field: { pre: quarter, grid, post: plain.baseToLayer },
    });
    const moved = controller.fieldDisplacementAt([0, 0, 0])!;
    // 1 mm along the grid's x is 1 mm along the base's −y... or +y: whichever the turn undone gives.
    const back = transformVector(invertMat4(quarter), [1, 0, 0]);
    moved.forEach((part, axis) => expect(part).toBeCloseTo(back[axis], 9));
    expect(Math.abs(moved[1])).toBeCloseTo(1, 9);
    expect(moved[0]).toBeCloseTo(0, 9);
  });

  it('has nothing to show for an overlay placed by a matrix', () => {
    const found = findPlacement('planning', 'follow-up', [
      registrationObject('reg', 'follow-up', 'planning'),
    ]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    const { controller } = setup('MR', found.placement);
    controller.setFieldViewKind('jacobian');
    expect(controller.selectedField()).toBeNull();
    expect(controller.fieldViewDeterminants()).toBeNull();
    expect(controller.fieldReading([1, 1, 1])).toBeNull();
  });
});

describe('LayersController and the way back from a field (#84)', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** A deformable object in frame `from` whose field maps into `to`: every place moved 1 mm along x. */
  function fieldObject(uid: string, from: string, to: string): DeformableSpatialRegistration {
    return {
      sopInstanceUid: uid,
      registeredFrame: from,
      patientId: null,
      label: 'DEFORMABLE',
      description: `Field ${uid}`,
      registrations: [
        {
          item: 0,
          transform: deformableTransform({
            id: `${uid}#0`,
            from,
            to,
            grid: {
              dims: [3, 3, 3],
              origin: [0, 0, 0],
              axes: [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
              ],
              spacing: [5, 5, 5],
              vectors: Float32Array.from({ length: 81 }, (_, i) => (i % 3 === 0 ? 1 : 0)),
            },
          }),
          vectorsTurned: false,
          comment: null,
        },
      ],
      identityItems: [],
      unread: [],
    };
  }
  const there = fieldObject('there', 'planning', 'follow-up');
  /** The overlay placed through `there`, with `others` known beside it. */
  function through(others: readonly RegistrationObject[]) {
    const found = findPlacement('planning', 'follow-up', [there]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    return setup('MR', found.placement, [there, ...others]).controller;
  }

  it('has none when the field’s own registration is all there is', () => {
    expect(through([]).fieldWayBack()).toBeNull();
  });

  it('is another registration that leads back, by name, mapping the compared image’s points to the base’s', () => {
    // As a file has it: the follow-up's frame mapped into the planning frame, 2 mm along y.
    const back = through([
      registrationObject('rigid', 'follow-up', 'planning', shiftMatrix(0, 2, 0)),
    ]).fieldWayBack();
    if (back?.kind !== 'one') throw new Error('no one way back');
    expect(back.name).toBe('“REGISTRATION”');
    expect(back.deformable).toBe(false);
    expect(back.map([1, 1, 1])).toEqual([1, 3, 1]);
  });

  it('takes a matrix written the other way turned round, as a placement does', () => {
    const back = through([
      registrationObject('rigid', 'planning', 'follow-up', shiftMatrix(0, 2, 0)),
    ]).fieldWayBack();
    if (back?.kind !== 'one') throw new Error('no one way back');
    expect(back.map([1, 1, 1])).toEqual([1, -1, 1]);
  });

  it('goes back through another field, as that field is written', () => {
    const back = through([fieldObject('back', 'follow-up', 'planning')]).fieldWayBack();
    if (back?.kind !== 'one') throw new Error('no one way back');
    expect(back.name).toBe('“Field back” (deformable)');
    expect(back.deformable).toBe(true);
    expect(back.map([2, 2, 2])).toEqual([3, 2, 2]);
    // Where that field has no vector there is no way back.
    expect(back.map([50, 2, 2])).toBeNull();
  });

  it('is not a second field written the same way as the first: a field is not turned round', () => {
    expect(through([fieldObject('again', 'planning', 'follow-up')]).fieldWayBack()).toBeNull();
  });

  it('picks none of several that lead back', () => {
    const back = through([
      registrationObject('one', 'follow-up', 'planning', shiftMatrix(0, 2, 0)),
      registrationObject('two', 'follow-up', 'planning', shiftMatrix(0, 3, 0)),
    ]).fieldWayBack();
    expect(back).toEqual({ kind: 'several', count: 2 });
  });

  it('has none for an overlay a matrix places', () => {
    const rigid = registrationObject('rigid', 'follow-up', 'planning');
    const found = findPlacement('planning', 'follow-up', [rigid]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    const { controller } = setup('MR', found.placement, [rigid, there]);
    expect(controller.fieldWayBack()).toBeNull();
  });
});
