/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  baseImageLayer,
  findPlacement,
  overlayImageLayer,
  overlayLayerAwaitingChoice,
  overlayLayerUnplaced,
  transformPoint,
  type Layer,
  type LayerPlacement,
  type Volume,
  type VolumeGeometry,
} from '@open-rt-studio/dicom';
import { registrationObject } from '../registration-testing';
import { shiftMatrix } from '../registration-testing';
import { LayersStore, layerLegend, placementChoiceText, placementText } from './layers-store';

function makeVolume(modality: string, windowCenter = 40, windowWidth = 400): Volume {
  return {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    data: new Float32Array(8),
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

/** A two-layer registry: a CT base plus one MR overlay. */
function registry(): readonly Layer[] {
  return [
    baseImageLayer('base', makeVolume('CT')),
    overlayImageLayer('ov', makeVolume('MR', 1000, 2000)),
  ];
}

describe('layerLegend', () => {
  it('projects each layer into a panel row (base first)', () => {
    const rows = layerLegend(registry());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'base',
      roleBadge: 'BASE',
      isBase: true,
      visible: true,
      opacityPercent: 100,
      displayValue: 'grayscale',
    });
    expect(rows[1]).toMatchObject({
      id: 'ov',
      roleBadge: 'OVERLAY',
      isBase: false,
      opacityPercent: 50, // DEFAULT_OVERLAY_OPACITY
      displayValue: 'grayscale',
    });
  });

  it('labels a layer by its modality and reports the chosen colormap', () => {
    const rows = layerLegend([
      overlayImageLayer('dose', makeVolume('RTDOSE')), // RTDOSE defaults to a jet wash
    ]);
    expect(rows[0].label).toBe('RTDOSE');
    expect(rows[0].displayValue).toBe('jet');
  });
});

describe('a placement in words', () => {
  const placed = (
    base: string,
    layer: string,
    ...objects: Parameters<typeof findPlacement>[2]
  ): LayerPlacement => {
    const found = findPlacement(base, layer, objects);
    if (found.kind !== 'placed') throw new Error(found.kind);
    return found.placement;
  };
  const followUpToPlanning = registrationObject('reg', 'follow-up', 'planning', undefined, {
    description: 'Follow-up to planning',
  });

  it('names the registration and says which way it was written', () => {
    // As a file usually has it: this image's frame mapped into the base's.
    expect(placementText(placed('planning', 'follow-up', followUpToPlanning))).toBe(
      'Placed by registration “Follow-up to planning” (written this image → base)',
    );
    // The same registration with the two images the other way round.
    expect(placementText(placed('follow-up', 'planning', followUpToPlanning))).toBe(
      'Placed by registration “Follow-up to planning” (written base → this image)',
    );
  });

  it('goes by the label when there is no description, and says so when there is neither', () => {
    const labelled = registrationObject('reg', 'follow-up', 'planning');
    expect(placementText(placed('planning', 'follow-up', labelled))).toContain('“REGISTRATION”');
    const bare = registrationObject('reg', 'follow-up', 'planning', undefined, { label: null });
    expect(placementText(placed('planning', 'follow-up', bare))).toContain('“unnamed”');
  });

  it('lists the registrations of a way with more than one', () => {
    const mrToPlanning = registrationObject('reg-2', 'mr', 'planning', undefined, {
      description: 'MR to planning',
    });
    expect(placementText(placed('follow-up', 'mr', followUpToPlanning, mrToPlanning))).toBe(
      'Placed by 2 registrations in a row: “Follow-up to planning”, then “MR to planning”',
    );
  });

  it('is in the legend row of a placed layer, and of no other', () => {
    const placement = placed('planning', 'follow-up', followUpToPlanning);
    const rows = layerLegend([
      baseImageLayer('base', makeVolume('CT')),
      overlayImageLayer('same-frame', makeVolume('MR')),
      overlayImageLayer('placed', makeVolume('CT'), placement),
    ]);
    expect(rows.map((row) => row.placement)).toEqual([null, null, placementText(placement)]);
  });
});

describe('a choice among several registrations', () => {
  const found = findPlacement('planning', 'follow-up', [
    registrationObject('reg-a', 'follow-up', 'planning', shiftMatrix(3, 0, 4)),
    registrationObject('reg-b', 'follow-up', 'planning', shiftMatrix(6, 0, 8), {
      description: 'Second try',
    }),
  ]);
  if (found.kind !== 'several') throw new Error(found.kind);
  const choices = found.placements;
  const registry = (): Layer[] => [
    baseImageLayer('base', makeVolume('CT')),
    overlayLayerAwaitingChoice('over', makeVolume('MR'), choices),
  ];

  it('is told apart by name, direction, and how far each moves and turns', () => {
    expect(choices.map(placementChoiceText)).toEqual([
      '“REGISTRATION” (written this image → base) · translation 5.0 mm, rotation 0.0°',
      '“Second try” (written this image → base) · translation 10.0 mm, rotation 0.0°',
    ]);
  });

  it('is offered in the legend, with none in use until the user chooses', () => {
    const store = new LayersStore();
    const row = () => layerLegend(store.apply(registry()))[1];
    expect(row()).toMatchObject({
      visible: false,
      placement: null,
      placementChoices: choices.map(placementChoiceText),
      placementChosen: null,
    });

    store.choosePlacement('over', 1);
    expect(row()).toMatchObject({ visible: true, placement: null, placementChosen: 1 });
    expect(store.apply(registry())[1].placement).toBe(choices[1]);

    // Another can be chosen after, and a number that is no index changes nothing.
    store.choosePlacement('over', 0);
    store.choosePlacement('over', Number.NaN);
    store.choosePlacement('over', -1);
    expect(row().placementChosen).toBe(0);

    // A new load starts without a choice.
    store.reset();
    expect(row()).toMatchObject({ visible: false, placementChosen: null });
  });

  it('is not offered for a layer one registration places, or none', () => {
    const rows = layerLegend([
      baseImageLayer('base', makeVolume('CT')),
      overlayImageLayer('placed', makeVolume('MR'), choices[0]),
    ]);
    expect(rows.map((row) => row.placementChoices)).toEqual([null, null]);
    expect(rows.map((row) => row.placementChosen)).toEqual([null, null]);
  });
});

describe('LayersStore.apply', () => {
  it('keeps a layer’s placement when it is overridden', () => {
    const found = findPlacement('planning', 'follow-up', [
      registrationObject('reg', 'follow-up', 'planning'),
    ]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    const store = new LayersStore();
    store.setOpacity('placed', 80);
    const [, layer] = store.apply([
      baseImageLayer('base', makeVolume('CT')),
      overlayImageLayer('placed', makeVolume('CT'), found.placement),
    ]);
    expect(layer.opacity).toBeCloseTo(0.8);
    expect(layer.placement).toBe(found.placement);
  });

  it('returns the layers unchanged when there are no overrides', () => {
    const store = new LayersStore();
    const layers = registry();
    const out = store.apply(layers);
    expect(out[0]).toBe(layers[0]); // same reference — no edits layered on
    expect(out[1]).toBe(layers[1]);
  });

  it('hides an overlay toggled off without touching the base', () => {
    const store = new LayersStore();
    store.toggleVisible('ov');
    const out = store.apply(registry());
    expect(out[0].visible).toBe(true);
    expect(out[1].visible).toBe(false);
    store.toggleVisible('ov'); // toggling again restores it
    expect(store.apply(registry())[1].visible).toBe(true);
  });

  it('applies a composite-opacity override, clamped to [0, 1]', () => {
    const store = new LayersStore();
    store.setOpacity('ov', 30);
    expect(store.apply(registry())[1].opacity).toBeCloseTo(0.3, 6);
    store.setOpacity('ov', 150); // over 100 clamps to fully opaque
    expect(store.apply(registry())[1].opacity).toBe(1);
    store.setOpacity('ov', -10); // below 0 clamps to transparent
    expect(store.apply(registry())[1].opacity).toBe(0);
  });

  it('applies a display-transform override', () => {
    const store = new LayersStore();
    store.setDisplay('ov', { kind: 'colormap', name: 'viridis' });
    expect(store.apply(registry())[1].display).toEqual({ kind: 'colormap', name: 'viridis' });
    // The legend over the composed layers reflects it.
    expect(layerLegend(store.apply(registry()))[1].displayValue).toBe('viridis');
  });
});

describe('LayersStore.windowFor', () => {
  it('falls back to the layer volume default window when unset', () => {
    const store = new LayersStore();
    const overlay = registry()[1];
    expect(store.windowFor(overlay)).toEqual({ center: 1000, width: 2000 });
  });

  it('returns the per-layer override once set', () => {
    const store = new LayersStore();
    const overlay = registry()[1];
    store.setWindow('ov', { center: 50, width: 350 });
    expect(store.windowFor(overlay)).toEqual({ center: 50, width: 350 });
  });
});

describe('LayersStore checkerboard state', () => {
  it('toggles the checkerboard flag', () => {
    const store = new LayersStore();
    expect(store.checkerboardEnabled()).toBe(false);
    store.toggleCheckerboard();
    expect(store.checkerboardEnabled()).toBe(true);
  });

  it('clamps the checkerboard cell count to its bounds', () => {
    const store = new LayersStore();
    store.setCheckerCells(8);
    expect(store.checkerCells()).toBe(8);
    store.setCheckerCells(1); // below min (2)
    expect(store.checkerCells()).toBe(2);
    store.setCheckerCells(99); // above max (30)
    expect(store.checkerCells()).toBe(30);
  });
});

describe('LayersStore.reset', () => {
  it('drops the per-layer overrides and turns the checkerboard back off', () => {
    const store = new LayersStore();
    store.toggleVisible('ov');
    store.setOpacity('ov', 20);
    store.setDisplay('ov', { kind: 'colormap', name: 'jet' });
    store.setWindow('ov', { center: 5, width: 5 });
    store.toggleCheckerboard();

    store.reset();

    const out = store.apply(registry());
    expect(out[1].visible).toBe(true);
    expect(out[1].opacity).toBe(0.5); // back to the overlay default
    expect(out[1].display).toEqual({ kind: 'grayscale' });
    expect(store.windowFor(registry()[1])).toEqual({ center: 1000, width: 2000 });
    // A stale checkerboard no longer carries into a fresh load (#206).
    expect(store.checkerboardEnabled()).toBe(false);
  });
});

describe('a registration made by hand (#78)', () => {
  const geometry = (origin: [number, number, number]): VolumeGeometry =>
    ({
      origin,
      iStep: [1, 0, 0],
      jStep: [0, 1, 0],
      kStep: [0, 0, 1],
    }) as unknown as VolumeGeometry;
  const base = { ...makeVolume('CT'), dims: [11, 11, 11], geometry: geometry([0, 0, 0]) } as Volume;
  const moving = {
    ...makeVolume('MR'),
    dims: [5, 5, 5],
    geometry: geometry([100, 200, 300]),
  } as Volume;
  const frames = { baseFrame: 'frame-1', layerFrame: 'frame-2' };
  const unplaced = (): readonly Layer[] => [
    baseImageLayer('base', base),
    overlayLayerUnplaced('ov', moving, frames),
  ];
  const fromFile = (): LayerPlacement => {
    const found = findPlacement('frame-1', 'frame-2', [
      registrationObject('reg', 'frame-2', 'frame-1', shiftMatrix(5, -3, 2)),
    ]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    return found.placement;
  };

  it('begins with the image’s middle on the base’s when nothing places it', () => {
    const store = new LayersStore();
    const layers = unplaced();
    expect(store.apply(layers)[1]).toBe(layers[1]);

    store.beginByHand(layers[1], base);
    const hand = store.byHand().get('ov')!;
    // The middles: (5, 5, 5) of the base, (102, 202, 302) of the image.
    expect(hand.params).toEqual({
      translation: [-97, -197, -297],
      rotation: [0, 0, 0],
      centre: [102, 202, 302],
    });
    expect(hand).toMatchObject({ start: hand.params, saved: false });

    const placed = store.apply(layers)[1];
    expect(placed.visible).toBe(true);
    expect(placed.placement).toMatchObject({ baseFrame: 'frame-1', layerFrame: 'frame-2' });
    expect(placed.placement!.steps[0].byHand).toBe(true);
    expect(transformPoint(placed.placement!.layerToBase, [102, 202, 302])).toEqual([5, 5, 5]);
  });

  it('begins from the registration that places the image, when it only moves and turns', () => {
    const store = new LayersStore();
    const layer = overlayImageLayer('ov', moving, fromFile());
    store.beginByHand(layer, base);
    const { params } = store.byHand().get('ov')!;
    expect(params.translation.map((value) => Math.round(value * 1e9) / 1e9)).toEqual([5, -3, 2]);
    expect(params.rotation.map((value) => Math.abs(value))).toEqual([0, 0, 0]);
    // The image is where it was.
    const before = layer.placement!.layerToBase;
    const after = store.apply([baseImageLayer('base', base), layer])[1].placement!.layerToBase;
    after.forEach((value, i) => expect(value).toBeCloseTo(before[i], 9));
  });

  it('does not begin for a layer in the base’s frame, or without positions', () => {
    const store = new LayersStore();
    store.beginByHand(overlayImageLayer('same', moving), base);
    store.beginByHand(overlayLayerUnplaced('bare', makeVolume('MR'), frames), base);
    store.beginByHand(overlayLayerUnplaced('ov', moving, frames), makeVolume('CT'));
    expect(store.byHand().size).toBe(0);
  });

  it('takes new numbers, goes back to where it began, and is let go of', () => {
    const store = new LayersStore();
    const layers = unplaced();
    store.beginByHand(layers[1], base);
    const { start } = store.byHand().get('ov')!;

    const moved = { ...start, translation: [1, 2, 3] as const, rotation: [0, 0, 90] as const };
    store.setByHand('ov', moved);
    expect(store.byHand().get('ov')!.params).toBe(moved);
    // The centre goes to itself and (1, 2, 3) further.
    const matrix = store.apply(layers)[1].placement!.layerToBase;
    transformPoint(matrix, [102, 202, 302]).forEach((value, i) =>
      expect(value).toBeCloseTo([103, 204, 305][i], 9),
    );

    // What is not a number changes nothing; nor do numbers for a layer that has none.
    store.setByHand('ov', { ...moved, translation: [Number.NaN, 0, 0] });
    store.setByHand('other', moved);
    expect(store.byHand().get('ov')!.params).toBe(moved);
    expect(store.byHand().has('other')).toBe(false);

    store.resetByHand('ov');
    expect(store.byHand().get('ov')!.params).toBe(start);

    store.discardByHand('ov');
    expect(store.byHand().has('ov')).toBe(false);
    expect(store.apply(layers)[1]).toBe(layers[1]);
  });

  it('is saved only as it was when the save began, and not once it changes', () => {
    const store = new LayersStore();
    store.beginByHand(unplaced()[1], base);
    const { start } = store.byHand().get('ov')!;
    const moved = { ...start, translation: [1, 2, 3] as const };

    // Changed while the save was under way: what was saved is not what is there.
    store.setByHand('ov', moved);
    store.markByHandSaved('ov', start);
    expect(store.byHand().get('ov')!.saved).toBe(false);

    store.markByHandSaved('ov', moved);
    expect(store.byHand().get('ov')!.saved).toBe(true);
    store.setByHand('ov', { ...moved, rotation: [1, 0, 0] });
    expect(store.byHand().get('ov')!.saved).toBe(false);
  });

  it('goes before a registration from a file, and before a choice among several', () => {
    const store = new LayersStore();
    const placement = fromFile();
    const awaiting = overlayLayerAwaitingChoice('ov', moving, [placement, placement]);
    const layers = [baseImageLayer('base', base), awaiting];
    store.beginByHand(awaiting, base);
    const composed = store.apply(layers);
    expect(composed[1].placement!.steps[0].byHand).toBe(true);

    const [, row] = layerLegend(composed, store.byHand());
    expect(row).toMatchObject({
      placement: 'Placed by hand',
      placementChoices: null,
      placementChosen: null,
      unplaced: false,
      canRegisterByHand: true,
    });
    expect(row.byHand).toBe(store.byHand().get('ov'));
  });

  it('is offered for a layer of another frame only, and an unplaced one says so', () => {
    const rows = layerLegend([
      ...unplaced(),
      overlayImageLayer('same', moving),
      overlayImageLayer('placed', moving, fromFile()),
    ]);
    expect(rows.map((row) => [row.id, row.unplaced, row.canRegisterByHand, row.byHand])).toEqual([
      ['base', false, false, null],
      ['ov', true, true, null],
      ['same', false, false, null],
      ['placed', false, true, null],
    ]);
  });

  it('goes with the other overrides when a new base is loaded', () => {
    const store = new LayersStore();
    store.beginByHand(unplaced()[1], base);
    store.reset();
    expect(store.byHand().size).toBe(0);
  });
});
