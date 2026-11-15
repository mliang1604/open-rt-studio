/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, signal } from '@angular/core';
import {
  clamp,
  clamp01,
  applyLayerOverrides,
  baseLayer,
  doseSumName,
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
  summarizeDisplacement,
  type DeformationGrid,
} from '@open-rt-studio/dicom';
import {
  DEFAULT_CHECKER_CELLS,
  NO_FIELD_VIEW,
  type FieldViewKind,
  type WindowLevel,
} from '@open-rt-studio/render';

import { dosePart, doseSaid } from './viewer-format';

/** Checkerboard density bounds (cells across the image), shared by the slider. */
const CHECKER_CELLS_MIN = 2;
const CHECKER_CELLS_MAX = 30;

/** The least and the most the top of the displacement wash's scale may be set to, in mm. */
export const FIELD_VIEW_MAX_MM_MIN = 0.1;
export const FIELD_VIEW_MAX_MM_MAX = 500;

/**
 * The scale that fits a field: its largest displacement, taken up to the
 * next whole millimetre, and 1 mm for a field that moves less or nothing.
 */
export function fittingFieldScaleMm(grid: DeformationGrid): number {
  const largest = summarizeDisplacement(grid)?.maxMm ?? 0;
  return Math.min(FIELD_VIEW_MAX_MM_MAX, Math.max(1, Math.ceil(largest - 1e-6)));
}

/** One layer listed in the layers panel, with its display controls. */
export interface LayerLegendEntry {
  /** The layer's id (see {@link Layer.id}); the `@for` track and override key. */
  readonly id: string;
  /** Human label: the modality, or a fallback when the layer has none. */
  readonly label: string;
  /** What more there is to say of it on pointing at its name: for a dose, what it says of itself. */
  readonly said: string;
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
  /**
   * For a layer whose registration goes through a deformation field: whether
   * the field is applied (`on`) or left out, so that only the registration's
   * matrices place the layer (`off`). Null for any other layer.
   */
  readonly deformation: 'on' | 'off' | null;
}

/**
 * What a drag in the planes does to a layer that is being registered by
 * hand: shifts it along the plane, or turns it in the plane about its middle.
 */
export interface ByHandDrag {
  /** The layer's id. */
  readonly id: string;
  readonly mode: 'shift' | 'turn';
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
export function registrationName(step: PlacementStep): string {
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
    const kind = step.deformable ? 'deformable registration' : 'registration';
    return `Placed by ${kind} “${registrationName(step)}” (written ${written})${fieldLeftOut(placement)}`;
  }
  const names = steps.map(stepName).join(', then ');
  return `Placed by ${steps.length} registrations in a row: ${names}${fieldLeftOut(placement)}`;
}

/** A step's name, and that it is by a deformation field when it is. */
function stepName(step: PlacementStep): string {
  return `“${registrationName(step)}”${step.deformable ? ' (deformable)' : ''}`;
}

/** The registrations of a placement by name, in the order they are gone through. */
export function placementNames(placement: LayerPlacement): string {
  return placement.steps.map(stepName).join(', then ');
}

/** Whether a placement has a registration by a deformation field among its steps. */
export function isDeformable(placement: LayerPlacement): boolean {
  return placement.steps.some((step) => step.deformable);
}

/** What is said of a deformable registration whose field is left out. */
function fieldLeftOut(placement: LayerPlacement): string {
  return isDeformable(placement) && !placement.field
    ? '. Its deformation is left out: placed by its matrices only'
    : '';
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
  const names = steps.map(stepName).join(', then ');
  const written =
    steps.length === 1
      ? ` (written ${steps[0].inverted ? 'this image → base' : 'base → this image'})`
      : '';
  const { shiftMm, turnDeg } = placementSize(placement);
  // For a deformable registration these are of its matrices, not of its field.
  const of = isDeformable(placement) ? 'its matrices: ' : '';
  return `${names}${written} · ${of}translation ${shiftMm.toFixed(1)} mm, rotation ${turnDeg.toFixed(1)}°`;
}

/**
 * Project the composed layers into panel rows (base first), each with its
 * controls. A layer that is being registered by hand (`byHand`, by layer id)
 * says so, and offers no choice among registrations while it is: the hand
 * goes before them.
 */
/** A layer's name in the list: its modality, and for a dose that is less than a plan's, what it is of. */
function layerName(layer: Layer): string {
  const modality = layer.modality ?? 'Image';
  const part = layer.volume.dose ? dosePart(layer.volume.dose) : null;
  return part ? `${modality} (${part})` : modality;
}

export function layerLegend(
  layers: readonly Layer[],
  byHand: ReadonlyMap<string, ByHand> = new Map(),
): LayerLegendEntry[] {
  return layers.map((layer) => {
    const hand = byHand.get(layer.id) ?? null;
    const choices = hand ? undefined : layer.placementChoices;
    return {
      id: layer.id,
      // A dose that was made here goes by what it is (#99): `EQD2 (α/β 3 Gy)`.
      // One read from a file that is less than a plan's says what it is the
      // dose of (#257): `RTDOSE (beam 2)`, beside the `RTDOSE` of its plan.
      label: layer.volume.dose?.sum ? doseSumName(layer.volume.dose.sum) : layerName(layer),
      said: layer.volume.dose ? doseSaid(layer.volume.dose) : (layer.modality ?? 'Image'),
      roleBadge: layer.role === 'base' ? 'BASE' : 'OVERLAY',
      isBase: layer.role === 'base',
      visible: layer.visible,
      opacityPercent: Math.round(layer.opacity * 100),
      displayValue: layer.display.kind === 'grayscale' ? 'grayscale' : layer.display.name,
      placement: layer.placement && !choices ? placementText(layer.placement) : null,
      placementChoices: choices?.map(placementChoiceText) ?? null,
      // A placement with its field left out is another object of the same steps.
      placementChosen: chosenAmong(choices, layer.placement),
      unplaced: !!layer.frames && !layer.placement,
      canRegisterByHand: layer.role === 'overlay' && layerFrames(layer) !== null,
      byHand: hand,
      deformation:
        layer.placement && isDeformable(layer.placement)
          ? layer.placement.field
            ? 'on'
            : 'off'
          : null,
    };
  });
}

/**
 * A layer that was made here of the layers on screen (a summed dose, #102),
 * with what it was made of. It is a layer only while that is what is on
 * screen: {@link madeStill}.
 */
export interface MadeLayer {
  readonly layer: Layer;
  /** The base image it was made on. It is shown over no other. */
  readonly base: Volume;
  /** The layers it was made of, each as it was placed then. */
  readonly of: readonly MadeOfLayer[];
}

export interface MadeOfLayer {
  readonly id: string;
  readonly volume: Volume;
  readonly placement: LayerPlacement | undefined;
}

/**
 * Whether two placements put a layer in the same place: the same matrix,
 * through the same field or none. (A placement made by hand is a new object
 * each time the layers are composed, so the objects are not compared.)
 */
export function samePlacement(
  a: LayerPlacement | undefined,
  b: LayerPlacement | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.field?.grid === b.field?.grid &&
    a.baseToLayer.length === b.baseToLayer.length &&
    a.baseToLayer.every((value, index) => value === b.baseToLayer[index])
  );
}

/**
 * Whether what a layer was made of is still what is on screen: the same
 * base image, and each layer it was made of still there and placed as it
 * was. Once it is not, the layer is of something else, and is not shown.
 */
export function madeStill(made: MadeLayer, layers: readonly Layer[]): boolean {
  if (baseLayer(layers)?.volume !== made.base) return false;
  return made.of.every((one) => {
    const now = layers.find((layer) => layer.id === one.id);
    return !!now && now.volume === one.volume && samePlacement(now.placement, one.placement);
  });
}

/** Which of a layer's choices places it, or null when none of them does. */
function chosenAmong(
  choices: readonly LayerPlacement[] | undefined,
  placement: LayerPlacement | undefined,
): number | null {
  if (!choices || !placement) return null;
  const index = choices.findIndex((one) => one === placement || one.steps === placement.steps);
  return index < 0 ? null : index;
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

  /**
   * The layers whose registration goes through a deformation field that is
   * left out for now (#77): they are placed by the registration's matrices
   * alone, to see what the field adds.
   */
  private readonly _rigidOnly = signal<ReadonlySet<string>>(new Set());

  /**
   * The layer that was made here of the layers on screen, if any: a summed
   * dose (#102). There is one at a time, and it is a layer only while what
   * it was made of is what is on screen.
   */
  private readonly _made = signal<MadeLayer | null>(null);
  readonly made = this._made.asReadonly();

  /** Take a layer that was made of the layers on screen, in place of any before it; null for none. */
  setMade(made: MadeLayer | null): void {
    this._made.set(made);
  }

  /**
   * Show one overlay and hide every other, so that it is the one that is
   * drawn. Gives back what was hidden before, for {@link setHidden} to put back.
   */
  showOnly(id: string, layers: readonly Layer[]): ReadonlySet<string> {
    const before = this._hidden();
    this._hidden.set(
      new Set(
        layers.filter((layer) => layer.role === 'overlay' && layer.id !== id).map((one) => one.id),
      ),
    );
    return before;
  }

  /** Hide these layers and show every other. */
  setHidden(ids: ReadonlySet<string>): void {
    this._hidden.set(new Set(ids));
  }

  /** Leave a layer's deformation field out, or put it back. */
  toggleDeformation(id: string): void {
    this._rigidOnly.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** The registrations being made by hand, by layer id. */
  readonly byHand = this._byHand.asReadonly();

  private readonly _byHandDrag = signal<ByHandDrag | null>(null);

  /**
   * The layer a left drag in the planes moves by hand, and how. Null when a
   * drag does what it always does. It is a tool like the brush: one at a time.
   */
  readonly byHandDrag = this._byHandDrag.asReadonly();

  /**
   * Switch dragging a layer by hand on in a mode, or off when it is on in
   * that mode already. Only for a layer that is being registered by hand.
   */
  toggleByHandDrag(id: string, mode: ByHandDrag['mode']): void {
    const current = this._byHandDrag();
    if (current?.id === id && current.mode === mode) this._byHandDrag.set(null);
    else if (this._byHand().has(id)) this._byHandDrag.set({ id, mode });
  }

  /** Put the dragging by hand down. */
  stopByHandDrag(): void {
    this._byHandDrag.set(null);
  }

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

  /** What of a deformation field is washed over the image (#83): nothing, until asked. */
  readonly fieldViewKind = signal<FieldViewKind>(NO_FIELD_VIEW.kind);
  /** How strongly the wash is laid over the image, 0 to 1. */
  readonly fieldViewOpacity = signal(NO_FIELD_VIEW.opacity);
  /**
   * The displacement at the top of the displacement wash's scale, in mm, when
   * the user has set one; null for the scale that fits the field in use.
   */
  readonly fieldViewMaxMm = signal<number | null>(null);
  /** Draw the deformed grid: the compared image's regular grid where the field puts it. */
  readonly fieldGrid = signal(false);
  /** The distance between the grid's lines in mm when the user has set one; null for the one that fits the image. */
  readonly fieldGridSpacingMm = signal<number | null>(null);
  /** Draw the field as arrows over the panes. */
  readonly fieldArrows = signal(false);

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
    const [hidden, opacities, displays] = [this._hidden(), this._opacities(), this._displays()];
    const applied = applyLayerOverrides(
      rawLayers,
      hidden,
      opacities,
      displays,
      this._placements(),
      byHand,
      this._rigidOnly(),
    );
    // A layer that was made of these is one of them, last, while it is still of them.
    const made = this._made();
    if (!made || !madeStill(made, applied)) return applied;
    return [...applied, ...applyLayerOverrides([made.layer], hidden, opacities, displays)];
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
    if (this._byHandDrag()?.id === id) this._byHandDrag.set(null);
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

  /** Wash the field's displacement or its Jacobian determinant over the image, or nothing. */
  setFieldViewKind(kind: FieldViewKind): void {
    this.fieldViewKind.set(kind);
  }

  /** How strongly the field's wash is laid over the image, held between 0 and 1. */
  setFieldViewOpacity(opacity: number): void {
    if (Number.isFinite(opacity)) this.fieldViewOpacity.set(clamp(opacity, 0, 1));
  }

  toggleFieldGrid(): void {
    this.fieldGrid.update((on) => !on);
  }

  /**
   * The distance between the deformed grid's lines in mm, held to the bounds
   * a scale has; null, or what is no number, for the one that fits the image.
   */
  setFieldGridSpacingMm(mm: number | null): void {
    this.fieldGridSpacingMm.set(
      mm === null || !Number.isFinite(mm)
        ? null
        : clamp(mm, FIELD_VIEW_MAX_MM_MIN, FIELD_VIEW_MAX_MM_MAX),
    );
  }

  toggleFieldArrows(): void {
    this.fieldArrows.update((on) => !on);
  }

  /**
   * The top of the displacement wash's scale in mm, held between
   * {@link FIELD_VIEW_MAX_MM_MIN} and {@link FIELD_VIEW_MAX_MM_MAX}; null, or
   * what is no number, for the scale that fits the field.
   */
  setFieldViewMaxMm(maxMm: number | null): void {
    this.fieldViewMaxMm.set(
      maxMm === null || !Number.isFinite(maxMm)
        ? null
        : clamp(maxMm, FIELD_VIEW_MAX_MM_MIN, FIELD_VIEW_MAX_MM_MAX),
    );
  }

  /**
   * Reset the fusion/layers state on a fresh base load: the per-layer overrides (an
   * added overlay starts visible, fully opaque, at its default display and window)
   * and the checkerboard blend back off — the latter the omission the consolidated
   * load reset (#206) fixed, so a stale checkerboard no longer carries into a new
   * series.
   */
  reset(): void {
    this._made.set(null);
    this._hidden.set(new Set());
    this._opacities.set(new Map());
    this._displays.set(new Map());
    this._windows.set(new Map());
    this._placements.set(new Map());
    this._byHand.set(new Map());
    this._byHandDrag.set(null);
    this._rigidOnly.set(new Set());
    this.checkerboardEnabled.set(false);
    this.fieldViewKind.set(NO_FIELD_VIEW.kind);
    this.fieldViewOpacity.set(NO_FIELD_VIEW.opacity);
    this.fieldViewMaxMm.set(null);
    this.fieldGrid.set(false);
    this.fieldGridSpacingMm.set(null);
    this.fieldArrows.set(false);
  }
}
