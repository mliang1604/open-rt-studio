/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, signal } from '@angular/core';
import {
  clamp,
  clamp01,
  applyLayerOverrides,
  layerFrames,
  manualPlacement,
  matrixKind,
  placementSize,
  rigidParamsMatrix,
  rigidParamsOf,
  startingRigidParams,
  volumeCentre,
  type Layer,
  type LayerDisplay,
  type LayerPlacement,
  type Mat4,
  type PlacementStep,
  type RigidParams,
  type Volume,
} from '@open-rt-studio/dicom';
import { DEFAULT_CHECKER_CELLS, type WindowLevel } from '@open-rt-studio/render';

/** Checkerboard density bounds (cells across the image), shared by the slider. */
const CHECKER_CELLS_MIN = 2;
const CHECKER_CELLS_MAX = 30;

/** One layer listed in the layers panel, with its display controls. */
export interface LayerLegendEntry {
  /** The layer's id (see {@link Layer.id}); the `@for` track and override key. */
  readonly id: string;
  /** Human label: the modality, or a fallback when the layer has none. */
  readonly label: string;
  /** Role badge text: 'BASE' or 'OVERLAY'. */
  readonly roleBadge: string;
  /** Whether this is the base underlay (shown without overlay-only controls). */
  readonly isBase: boolean;
  /** Whether the layer is currently composited. */
  readonly visible: boolean;
  /** Composite opacity as a whole percent `[0, 100]`, for the opacity slider. */
  readonly opacityPercent: number;
  /** Selected display: `'grayscale'` or a colormap name, for the `<select>`. */
  readonly displayValue: string;
  /**
   * For a layer in another frame of reference: which registration places it
   * over the base, and which way that registration was written. Null for a
   * layer in the base's frame, and for one that has registrations to choose
   * among ({@link placementChoices}).
   */
  readonly placement: string | null;
  /**
   * The registrations to choose among, each in words, when more than one
   * could place the layer. Null otherwise.
   */
  readonly placementChoices: readonly string[] | null;
  /** Which of {@link placementChoices} is in use; null while none was chosen. */
  readonly placementChosen: number | null;
  /**
   * True for a layer in another frame of reference that nothing places yet:
   * no registration, and none made by hand. It is not drawn.
   */
  readonly unplaced: boolean;
  /**
   * Whether the layer can be registered by hand: it is in another frame of
   * reference than the base's. (Within one frame there is nothing to
   * register.)
   */
  readonly canRegisterByHand: boolean;
  /** The registration being made by hand for the layer, or null. */
  readonly byHand: ByHand | null;
}

/** A registration that is being made by hand for a layer. */
export interface ByHand {
  /** As it is set now. */
  readonly params: RigidParams;
  /** As it was when the user began: what Reset goes back to. */
  readonly start: RigidParams;
  /** Whether it was saved as it is now. */
  readonly saved: boolean;
}

/** The name a registration goes by: its description, else its label. */
function registrationName(step: PlacementStep): string {
  return step.description?.trim() || step.label?.trim() || 'unnamed';
}

/**
 * A placement in words: the registration's name, and the direction it was
 * written in. A file usually registers a secondary image to the primary:
 * from this image's frame to the base's.
 */
export function placementText(placement: LayerPlacement): string {
  const { steps } = placement;
  if (steps.length === 1) {
    const [step] = steps;
    if (step.byHand) return 'Placed by hand';
    const written = step.inverted ? 'this image → base' : 'base → this image';
    return `Placed by registration “${registrationName(step)}” (written ${written})`;
  }
  const names = steps.map((step) => `“${registrationName(step)}”`).join(', then ');
  return `Placed by ${steps.length} registrations in a row: ${names}`;
}

/**
 * One of several placements in words, for choosing among them: the
 * registration's name and direction, and the length of its matrix's
 * translation and the angle of its rotation, which tell apart two that go by
 * the same name. The translation is between the two frames' coordinates, so
 * it is large when their origins are far apart, however little the patient
 * moved: it is named for what it is, not as how far the image moves.
 */
export function placementChoiceText(placement: LayerPlacement): string {
  const { steps } = placement;
  const names = steps.map((step) => `“${registrationName(step)}”`).join(', then ');
  const written =
    steps.length === 1
      ? ` (written ${steps[0].inverted ? 'this image → base' : 'base → this image'})`
      : '';
  const { shiftMm, turnDeg } = placementSize(placement);
  return `${names}${written} · translation ${shiftMm.toFixed(1)} mm, rotation ${turnDeg.toFixed(1)}°`;
}

/**
 * Project the composed layers into panel rows (base first), each with its
 * controls. A layer that is being registered by hand (`byHand`, by layer id)
 * says so, and offers no choice among registrations while it is: the hand
 * goes before them.
 */
export function layerLegend(
  layers: readonly Layer[],
  byHand: ReadonlyMap<string, ByHand> = new Map(),
): LayerLegendEntry[] {
  return layers.map((layer) => {
    const hand = byHand.get(layer.id) ?? null;
    const choices = hand ? undefined : layer.placementChoices;
    return {
      id: layer.id,
      label: layer.modality ?? 'Image',
      roleBadge: layer.role === 'base' ? 'BASE' : 'OVERLAY',
      isBase: layer.role === 'base',
      visible: layer.visible,
      opacityPercent: Math.round(layer.opacity * 100),
      displayValue: layer.display.kind === 'grayscale' ? 'grayscale' : layer.display.name,
      placement: layer.placement && !choices ? placementText(layer.placement) : null,
      placementChoices: choices?.map(placementChoiceText) ?? null,
      placementChosen:
        layer.placement && choices?.includes(layer.placement)
          ? choices.indexOf(layer.placement)
          : null,
      unplaced: !!layer.frames && !layer.placement,
      canRegisterByHand: layer.role === 'overlay' && layerFrames(layer) !== null,
      byHand: hand,
    };
  });
}

/**
 * Owns the fusion / layers domain: the per-layer override maps the layers panel
 * and blend bar edit (visibility, composite opacity, display colormap, and the
 * Compare layout's per-column window/level), plus the checkerboard blend state.
 *
 * The store is the single home for these overrides; the viewer feeds it the
 * loaded layer registry through {@link apply} and delegates the panel/blend-bar
 * handlers here. Provided at the component so its lifetime tracks the viewer.
 */
@Injectable()
export class LayersStore {
  /**
   * Layer ids hidden from the layers panel. The base never appears here (it's the
   * underlay); an overlay listed here is dropped from compositing.
   */
  private readonly _hidden = signal<ReadonlySet<string>>(new Set());

  /**
   * Per-layer composite opacity in `[0, 1]` keyed by {@link Layer.id}. A layer
   * absent keeps its registry default; the layers-panel slider and the in-pane
   * blend bar both write here (they edit the same value).
   */
  private readonly _opacities = signal<ReadonlyMap<string, number>>(new Map());

  /**
   * Per-layer display-transform overrides keyed by {@link Layer.id}: the colormap
   * (or grayscale) the layers panel picks for an overlay, overriding the load-time
   * default (RTDOSE → jet).
   */
  private readonly _displays = signal<ReadonlyMap<string, LayerDisplay>>(new Map());

  /**
   * Per-layer window/level overrides keyed by {@link Layer.id}, for the Compare
   * layout's independent per-column windowing. The base layer is never keyed here;
   * an overlay column absent from the map falls back to its volume's default.
   */
  private readonly _windows = signal<ReadonlyMap<string, WindowLevel>>(new Map());

  /**
   * For a layer that several registrations could place, the one the user
   * chose, by its index among the layer's choices, keyed by {@link Layer.id}.
   * A layer absent from the map awaits the choice and is not drawn.
   */
  private readonly _placements = signal<ReadonlyMap<string, number>>(new Map());

  /**
   * The registrations being made by hand (#78), keyed by {@link Layer.id}. A
   * layer listed here is placed by its numbers, whatever a file says, until
   * the user discards them. They are in the viewer only until they are saved.
   */
  private readonly _byHand = signal<ReadonlyMap<string, ByHand>>(new Map());

  /** The registrations being made by hand, by layer id. */
  readonly byHand = this._byHand.asReadonly();

  /**
   * The placement each of them gives its layer. Kept apart from
   * {@link apply}, so that a matrix is made when the numbers change and not
   * each time the layers are composed.
   */
  private readonly handMatrices = computed<ReadonlyMap<string, Mat4>>(
    () =>
      new Map(
        [...this._byHand()].map(([id, { params }]) => [id, rigidParamsMatrix(params)] as const),
      ),
  );

  /** Checkerboard the overlay (alternating cells) instead of a uniform blend. */
  readonly checkerboardEnabled = signal(false);

  /** Checkerboard density in cells across the image (at zoom 1); the slider's value. */
  readonly checkerCells = signal(DEFAULT_CHECKER_CELLS);

  /**
   * Apply the current visibility / opacity / display overrides to the loaded layer
   * registry, producing the composed layers every consumer reads.
   */
  apply(rawLayers: readonly Layer[]): readonly Layer[] {
    const matrices = this.handMatrices();
    const byHand = new Map<string, LayerPlacement>();
    for (const layer of rawLayers) {
      const matrix = matrices.get(layer.id);
      const frames = matrix ? layerFrames(layer) : null;
      if (matrix && frames) {
        byHand.set(layer.id, manualPlacement(frames.baseFrame, frames.layerFrame, matrix));
      }
    }
    return applyLayerOverrides(
      rawLayers,
      this._hidden(),
      this._opacities(),
      this._displays(),
      this._placements(),
      byHand,
    );
  }

  /**
   * Begin registering a layer by hand over the base. It starts from where the
   * layer is: at the registration that places it now, when that one only
   * moves and turns; else with the layer's middle on the base's and nothing
   * turned, which is a place to start from and no more. Does nothing for a
   * layer that is already being registered, one in the base's own frame, or
   * when either image does not say where it is.
   */
  beginByHand(layer: Layer, base: Volume): void {
    if (this._byHand().has(layer.id) || !layerFrames(layer)) return;
    const centre = volumeCentre(layer.volume);
    const placed = layer.placement?.layerToBase;
    const start =
      centre && placed && matrixKind(placed) === 'rigid'
        ? rigidParamsOf(placed, centre)
        : startingRigidParams(base, layer.volume);
    if (!start) return;
    this._byHand.update((map) =>
      new Map(map).set(layer.id, { params: start, start, saved: false }),
    );
  }

  /** Set the numbers of a registration that is being made by hand. */
  setByHand(id: string, params: RigidParams): void {
    const all = [...params.translation, ...params.rotation, ...params.centre];
    if (!all.every(Number.isFinite)) return;
    this._byHand.update((map) => {
      const current = map.get(id);
      return current ? new Map(map).set(id, { ...current, params, saved: false }) : map;
    });
  }

  /** Put a registration by hand back to where it began. */
  resetByHand(id: string): void {
    this._byHand.update((map) => {
      const current = map.get(id);
      if (!current || current.params === current.start) return map;
      return new Map(map).set(id, { ...current, params: current.start, saved: false });
    });
  }

  /**
   * Let go of a registration by hand: the layer is again as the files have
   * it, placed by their registration or not drawn.
   */
  discardByHand(id: string): void {
    this._byHand.update((map) => {
      if (!map.has(id)) return map;
      const next = new Map(map);
      next.delete(id);
      return next;
    });
  }

  /** Note that a registration by hand was saved, if it is still as `params` has it. */
  markByHandSaved(id: string, params: RigidParams): void {
    this._byHand.update((map) => {
      const current = map.get(id);
      if (!current || current.params !== params) return map;
      return new Map(map).set(id, { ...current, saved: true });
    });
  }

  /** Choose which of a layer's registrations places it, by its index among the choices. */
  choosePlacement(id: string, index: number): void {
    if (!Number.isInteger(index) || index < 0) return;
    this._placements.update((map) => new Map(map).set(id, index));
  }

  /** Toggle an overlay layer's visibility (the base underlay is never hidden). */
  toggleVisible(id: string): void {
    this._hidden.update((hidden) => {
      const next = new Set(hidden);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Set a layer's composite opacity from a 0..100 slider value. */
  setOpacity(id: string, percent: number): void {
    const opacity = clamp01(percent / 100);
    this._opacities.update((map) => new Map(map).set(id, opacity));
  }

  /** Set a layer's display transform: grayscale or a named colormap. */
  setDisplay(id: string, display: LayerDisplay): void {
    this._displays.update((map) => new Map(map).set(id, display));
  }

  /**
   * An overlay layer's effective window/level: its per-layer override, or the
   * layer volume's default when none is set. (The base reads the shared window.)
   */
  windowFor(layer: Layer): WindowLevel {
    return (
      this._windows().get(layer.id) ?? {
        center: layer.volume.windowCenter,
        width: layer.volume.windowWidth,
      }
    );
  }

  /** Override an overlay layer's window/level (per Compare column). */
  setWindow(id: string, next: WindowLevel): void {
    this._windows.update((map) => new Map(map).set(id, next));
  }

  /** Toggle compositing the fusion overlay as a checkerboard. */
  toggleCheckerboard(): void {
    this.checkerboardEnabled.update((on) => !on);
  }

  /** Set the checkerboard density (cells across the image), clamped to its bounds. */
  setCheckerCells(cells: number): void {
    this.checkerCells.set(clamp(cells, CHECKER_CELLS_MIN, CHECKER_CELLS_MAX));
  }

  /**
   * Reset the fusion/layers state on a fresh base load: the per-layer overrides (an
   * added overlay starts visible, fully opaque, at its default display and window)
   * and the checkerboard blend back off — the latter the omission the consolidated
   * load reset (#206) fixed, so a stale checkerboard no longer carries into a new
   * series.
   */
  reset(): void {
    this._hidden.set(new Set());
    this._opacities.set(new Map());
    this._displays.set(new Map());
    this._windows.set(new Map());
    this._placements.set(new Map());
    this._byHand.set(new Map());
    this.checkerboardEnabled.set(false);
  }
}
