/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  baseImageLayer,
  deformableTransform,
  findPlacement,
  overlayImageLayer,
  overlayLayerAwaitingChoice,
  overlayLayerUnplaced,
  transformPoint,
  type DeformableSpatialRegistration,
  type Layer,
  type LayerPlacement,
  type Volume,
  type VolumeGeometry,
} from '@open-rt-studio/dicom';
import { registrationObject } from '../registration-testing';
import { shiftMatrix } from '../registration-testing';
import {
  LayersStore,
  fittingFieldScaleMm,
  layerLegend,
  madeStill,
  placementChoiceText,
  placementText,
  samePlacement,
  type MadeLayer,
} from './layers-store';

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

  it('says of a dose what it says of itself, and of anything else its name (#93)', () => {
    const dose = {
      ...makeVolume('RTDOSE'),
      dose: {
        units: 'RELATIVE' as const,
        type: 'PHYSICAL' as const,
        summationType: 'BEAM',
        scaling: 0.1,
        sopInstanceUid: '1.2.3',
        frameOffsets: 'relative' as const,
        interpolatedPlanes: 0,
      },
    };
    const rows = layerLegend([
      overlayImageLayer('dose', dose),
      overlayImageLayer('mr', makeVolume('MR')),
    ]);
    expect(rows.map((row) => row.said)).toEqual([
      'RT Dose: relative, with no unit, physical, summation type BEAM',
      'MR',
    ]);
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

describe('a layer placed through a deformation field (#77)', () => {
  /** A deformable object in frame `f1` whose field maps into `f2`. */
  const field: DeformableSpatialRegistration = {
    sopInstanceUid: 'def-1',
    registeredFrame: 'f1',
    patientId: null,
    label: 'DEFORMABLE',
    description: 'Planning to MR',
    registrations: [
      {
        item: 0,
        transform: deformableTransform({
          id: 'def-1#0',
          from: 'f1',
          to: 'f2',
          grid: {
            dims: [2, 2, 2],
            origin: [0, 0, 0],
            axes: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
            spacing: [10, 10, 10],
            vectors: new Float32Array(24).fill(1),
          },
          post: shiftMatrix(5, 0, 0),
        }),
        vectorsTurned: false,
        comment: null,
      },
    ],
    identityItems: [],
    unread: [],
  };
  const placed = (): LayerPlacement => {
    const found = findPlacement('f1', 'f2', [field]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    return found.placement;
  };
  const layers = (): readonly Layer[] => [
    baseImageLayer('base', makeVolume('CT')),
    overlayImageLayer('ov', makeVolume('MR'), placed()),
  ];

  it('says that the registration is a deformable one', () => {
    expect(placementText(placed())).toBe(
      'Placed by deformable registration “Planning to MR” (written base → this image)',
    );
  });

  it('has its field on until the user leaves it out, and says so when they do', () => {
    const store = new LayersStore();
    const on = store.apply(layers());
    expect(on[1].placement?.field).toBeDefined();
    expect(layerLegend(on)[1].deformation).toBe('on');
    expect(layerLegend(on)[0].deformation).toBeNull();

    store.toggleDeformation('ov');
    const off = store.apply(layers());
    expect(off[1].placement?.field).toBeUndefined();
    // By its matrices alone: the matrix after the field.
    expect(transformPoint(off[1].placement!.baseToLayer, [1, 2, 3])).toEqual([6, 2, 3]);
    expect(off[1].visible).toBe(true);
    const row = layerLegend(off)[1];
    expect(row.deformation).toBe('off');
    expect(row.placement).toBe(
      'Placed by deformable registration “Planning to MR” (written base → this image). Its deformation is left out: placed by its matrices only',
    );

    store.toggleDeformation('ov');
    expect(layerLegend(store.apply(layers()))[1].deformation).toBe('on');
  });

  it('has no switch for a layer a matrix places', () => {
    const rigid = findPlacement('f1', 'f2', [registrationObject('reg-1', 'f2', 'f1')]);
    if (rigid.kind !== 'placed') throw new Error(rigid.kind);
    const row = layerLegend([
      baseImageLayer('base', makeVolume('CT')),
      overlayImageLayer('ov', makeVolume('MR'), rigid.placement),
    ])[1];
    expect(row.deformation).toBeNull();
    // Leaving a field out of it changes nothing.
    const store = new LayersStore();
    store.toggleDeformation('ov');
    const same = [
      baseImageLayer('base', makeVolume('CT')),
      overlayImageLayer('ov', makeVolume('MR'), rigid.placement),
    ];
    expect(store.apply(same)[1].placement).toBe(rigid.placement);
  });

  it('is one of the choices when a matrix leads there too, and stays the chosen one with its field left out', () => {
    const found = findPlacement('f1', 'f2', [field, registrationObject('reg-1', 'f2', 'f1')]);
    if (found.kind !== 'several') throw new Error(found.kind);
    const index = found.placements.findIndex((one) => one.field);
    expect(placementChoiceText(found.placements[index])).toMatch(
      /^“Planning to MR” \(deformable\) \(written base → this image\) · its matrices: translation 5\.0 mm, rotation 0\.0°$/,
    );
    const raw = [
      baseImageLayer('base', makeVolume('CT')),
      overlayLayerAwaitingChoice('ov', makeVolume('MR'), found.placements),
    ];
    const store = new LayersStore();
    store.choosePlacement('ov', index);
    expect(layerLegend(store.apply(raw))[1]).toMatchObject({
      placementChosen: index,
      deformation: 'on',
    });
    store.toggleDeformation('ov');
    expect(layerLegend(store.apply(raw))[1]).toMatchObject({
      placementChosen: index,
      deformation: 'off',
      visible: true,
    });
  });

  it('has its field again after a new base is loaded', () => {
    const store = new LayersStore();
    store.toggleDeformation('ov');
    store.reset();
    expect(layerLegend(store.apply(layers()))[1].deformation).toBe('on');
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

describe('a layer that was made of the layers on screen (#102)', () => {
  const placementOf = (id: string): LayerPlacement => {
    const found = findPlacement('planning', 'follow-up', [
      registrationObject(id, 'follow-up', 'planning'),
    ]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    return found.placement;
  };
  const sumVolume: Volume = {
    ...makeVolume('RTDOSE'),
    dose: {
      units: 'GY',
      type: 'EFFECTIVE',
      sum: { doses: 2, model: 'eqd', fractionGy: 2, alphaBetaGy: 3 },
      summationType: null,
      scaling: 1,
      sopInstanceUid: null,
      frameOffsets: 'relative',
      interpolatedPlanes: 0,
    },
  };
  const placement = placementOf('reg');
  const loaded = (): Layer[] => [
    baseImageLayer('base', makeVolume('CT')),
    overlayImageLayer('one', makeVolume('RTDOSE')),
    overlayImageLayer('two', makeVolume('RTDOSE'), placement),
  ];
  const madeOf = (layers: readonly Layer[]): MadeLayer => ({
    layer: overlayImageLayer('sum', sumVolume),
    base: layers[0].volume,
    of: layers.slice(1).map(({ id, volume, placement: by }) => ({ id, volume, placement: by })),
  });

  it('is the last of the layers, while what it was made of is on screen', () => {
    const store = new LayersStore();
    const layers = loaded();
    expect(store.apply(layers).map((layer) => layer.id)).toEqual(['base', 'one', 'two']);
    store.setMade(madeOf(layers));
    expect(store.apply(layers).map((layer) => layer.id)).toEqual(['base', 'one', 'two', 'sum']);
    expect(store.made()!.layer.id).toBe('sum');
    store.setMade(null);
    expect(store.apply(layers).map((layer) => layer.id)).toEqual(['base', 'one', 'two']);
  });

  it('takes the overrides a loaded layer does', () => {
    const store = new LayersStore();
    const layers = loaded();
    store.setMade(madeOf(layers));
    store.setOpacity('sum', 80);
    store.setDisplay('sum', { kind: 'colormap', name: 'hot' });
    expect(store.apply(layers)[3]).toMatchObject({
      opacity: 0.8,
      display: { kind: 'colormap', name: 'hot' },
      visible: true,
    });
    store.toggleVisible('sum');
    expect(store.apply(layers)[3].visible).toBe(false);
  });

  it('is not a layer once the image is another, or a layer it was made of is gone or another', () => {
    const store = new LayersStore();
    const layers = loaded();
    store.setMade(madeOf(layers));
    const ids = (now: readonly Layer[]) => store.apply(now).map((layer) => layer.id);
    expect(ids([baseImageLayer('base', makeVolume('CT')), ...layers.slice(1)])).not.toContain(
      'sum',
    );
    expect(ids(layers.slice(0, 2))).not.toContain('sum');
    expect(
      ids([layers[0], layers[1], { ...layers[2], volume: makeVolume('RTDOSE') }]),
    ).not.toContain('sum');
    // Another layer beside them changes nothing.
    expect(ids([...layers, overlayImageLayer('mr', makeVolume('MR'))])).toEqual([
      'base',
      'one',
      'two',
      'mr',
      'sum',
    ]);
  });

  it('is not a layer once a layer it was made of is placed otherwise', () => {
    const store = new LayersStore();
    const layers = loaded();
    store.setMade(madeOf(layers));
    const moved = {
      ...placement,
      baseToLayer: shiftMatrix(1, 2, 3),
      layerToBase: shiftMatrix(-1, -2, -3),
    };
    expect(store.apply([layers[0], layers[1], { ...layers[2], placement: moved }])).toHaveLength(3);
    // Placed the same by another object: the same place.
    expect(
      store.apply([layers[0], layers[1], { ...layers[2], placement: { ...placement } }]),
    ).toHaveLength(4);
    // Hidden, a layer it was made of is still what it was made of.
    store.toggleVisible('two');
    expect(store.apply(layers)).toHaveLength(4);
  });

  it('tells two placements apart by their matrix and their field', () => {
    expect(samePlacement(undefined, undefined)).toBe(true);
    expect(samePlacement(placement, placement)).toBe(true);
    expect(
      samePlacement(placement, { ...placement, baseToLayer: [...placement.baseToLayer] as never }),
    ).toBe(true);
    expect(samePlacement(placement, undefined)).toBe(false);
    expect(samePlacement(undefined, placement)).toBe(false);
    expect(samePlacement(placement, { ...placement, baseToLayer: shiftMatrix(9, 0, 0) })).toBe(
      false,
    );
    const field = { grid: {} } as LayerPlacement['field'];
    expect(samePlacement(placement, { ...placement, field })).toBe(false);
    expect(samePlacement({ ...placement, field }, { ...placement, field })).toBe(true);
    expect(madeStill(madeOf(loaded()), loaded())).toBe(false);
  });

  it('shows one overlay in place of the others, and puts back what was hidden before', () => {
    const store = new LayersStore();
    const layers = loaded();
    store.setMade(madeOf(layers));
    store.toggleVisible('one');
    const before = store.showOnly('sum', store.apply(layers));
    expect(store.apply(layers).map((layer) => layer.visible)).toEqual([true, false, false, true]);
    expect([...before]).toEqual(['one']);
    store.setHidden(before);
    expect(store.apply(layers).map((layer) => layer.visible)).toEqual([true, false, true, true]);
  });

  it('goes by what it is in the layers panel, and is let go of with the load', () => {
    const store = new LayersStore();
    const layers = loaded();
    store.setMade(madeOf(layers));
    const legend = layerLegend(store.apply(layers));
    expect(legend[3].label).toBe('EQD2 (α/β 3 Gy)');
    expect(legend[3].said).toContain('Dose made here by summing, not read from a file');
    expect(legend[1].label).toBe('RTDOSE');
    // A dose that is less than a whole plan's says what it is the dose of (#257).
    const beam = layers.map((layer, index) =>
      index === 1
        ? {
            ...layer,
            volume: {
              ...layer.volume,
              dose: {
                units: 'GY' as const,
                type: 'PHYSICAL' as const,
                summationType: 'BEAM',
                beams: [2],
                fractionGroup: 1,
                scaling: 1,
                sopInstanceUid: null,
                frameOffsets: 'relative' as const,
                interpolatedPlanes: 0,
              },
            },
          }
        : layer,
    );
    expect(layerLegend(beam)[1].label).toBe('RTDOSE (beam 2)');
    store.reset();
    expect(store.made()).toBeNull();
    expect(store.apply(layers)).toHaveLength(3);
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
    store.toggleByHandDrag('ov', 'turn');
    expect(store.byHandDrag()).toEqual({ id: 'ov', mode: 'turn' });
    store.reset();
    expect(store.byHand().size).toBe(0);
    expect(store.byHandDrag()).toBeNull();
  });
});

describe('what of a deformation field is shown (#83)', () => {
  it('is nothing until asked, and is held to what a wash can take', () => {
    const store = new LayersStore();
    expect(store.fieldViewKind()).toBe('none');
    expect(store.fieldViewOpacity()).toBe(0.6);
    expect(store.fieldViewMaxMm()).toBeNull();

    store.setFieldViewKind('jacobian');
    expect(store.fieldViewKind()).toBe('jacobian');
    store.setFieldViewOpacity(1.4);
    expect(store.fieldViewOpacity()).toBe(1);
    store.setFieldViewOpacity(-0.2);
    expect(store.fieldViewOpacity()).toBe(0);
    store.setFieldViewOpacity(Number.NaN);
    expect(store.fieldViewOpacity()).toBe(0);

    store.setFieldViewMaxMm(25);
    expect(store.fieldViewMaxMm()).toBe(25);
    store.setFieldViewMaxMm(0);
    expect(store.fieldViewMaxMm()).toBe(0.1);
    store.setFieldViewMaxMm(1e6);
    expect(store.fieldViewMaxMm()).toBe(500);
    store.setFieldViewMaxMm(Number.NaN);
    expect(store.fieldViewMaxMm()).toBeNull();
  });

  it('goes back to nothing when a new base is loaded', () => {
    const store = new LayersStore();
    store.setFieldViewKind('displacement');
    store.setFieldViewOpacity(0.9);
    store.setFieldViewMaxMm(25);
    store.reset();
    expect(store.fieldViewKind()).toBe('none');
    expect(store.fieldViewOpacity()).toBe(0.6);
    expect(store.fieldViewMaxMm()).toBeNull();
  });

  it('draws no grid and no arrows until asked, and none again after a new base is loaded', () => {
    const store = new LayersStore();
    expect([store.fieldGrid(), store.fieldArrows(), store.fieldGridSpacingMm()]).toEqual([
      false,
      false,
      null,
    ]);
    store.toggleFieldGrid();
    store.toggleFieldArrows();
    store.setFieldGridSpacingMm(2.5);
    expect([store.fieldGrid(), store.fieldArrows(), store.fieldGridSpacingMm()]).toEqual([
      true,
      true,
      2.5,
    ]);
    store.setFieldGridSpacingMm(0);
    expect(store.fieldGridSpacingMm()).toBe(0.1);
    store.setFieldGridSpacingMm(Number.NaN);
    expect(store.fieldGridSpacingMm()).toBeNull();
    store.setFieldGridSpacingMm(4);
    store.reset();
    expect([store.fieldGrid(), store.fieldArrows(), store.fieldGridSpacingMm()]).toEqual([
      false,
      false,
      null,
    ]);
  });

  it('fits a scale to a field: its largest displacement, up to the next whole millimetre', () => {
    const grid = (vectors: number[]) => ({
      dims: [vectors.length / 3, 1, 1] as const,
      origin: [0, 0, 0] as const,
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ] as const,
      spacing: [1, 1, 1] as const,
      vectors: Float32Array.from(vectors),
    });
    // (4, −3, 1): 5.1 mm.
    expect(fittingFieldScaleMm(grid([0, 0, 0, 4, -3, 1]))).toBe(6);
    // A whole number of millimetres is its own scale.
    expect(fittingFieldScaleMm(grid([3, 4, 0]))).toBe(5);
    // A field that moves little or nothing, or has no vector defined: 1 mm.
    expect(fittingFieldScaleMm(grid([0.2, 0, 0]))).toBe(1);
    expect(fittingFieldScaleMm(grid([0, 0, 0]))).toBe(1);
    expect(fittingFieldScaleMm(grid([NaN, NaN, NaN]))).toBe(1);
  });
});
