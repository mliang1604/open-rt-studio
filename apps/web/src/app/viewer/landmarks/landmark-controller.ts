/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, inject } from '@angular/core';
import {
  IDENTITY_MAT4,
  LandmarkFileError,
  Orientation,
  baseLayer,
  layerFrames,
  parseLandmarks,
  patientToVoxel,
  pointBetweenLayers,
  pointToLayer,
  targetRegistrationErrorFromFixed,
  targetRegistrationErrorOfMatrix,
  writeLandmarks,
  type Layer,
  type TargetRegistrationError,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';
import {
  focusPanePoint,
  focusSliceIndex,
  probeVoxel,
  resolveGeometry,
  type ObliqueRotation,
  type PaneRect,
} from '@open-rt-studio/render';

import { timestampSlug } from '../capture';
import { LayersController } from '../layers-controller';
import { placementText } from '../layers-store';
import { paneKeyOf, type PanePlacement } from '../pane-placement';
import { LandmarkStore, type Landmark, type LandmarkSide } from './landmark-store';

type MprPane = Extract<PanePlacement, { kind: 'mpr' }>;

export interface LandmarkInit {
  readonly panes: () => readonly PanePlacement[];
  /** Where the canvas is in the window, to read a pointer's place on it. */
  readonly canvasBounds: () => { readonly left: number; readonly top: number };
  readonly sagittalFlipped: () => boolean;
  readonly obliques: () => readonly [ObliqueRotation, ObliqueRotation, ObliqueRotation];
  /** The base image's frame of reference, or null when its files name none. */
  readonly baseFrame: () => string | null;
  /** Take the views to a point of the base image's frame. */
  readonly goTo: (point: Vec3) => void;
  readonly notify: (message: string, problem: boolean) => void;
  /** Hand a file to the browser as a download. */
  readonly download: (blob: Blob, filename: string) => void;
}

/** A landmark's point drawn in a pane. */
export interface LandmarkMarker {
  /** Unique among the markers on screen. */
  readonly key: string;
  readonly id: number;
  readonly side: LandmarkSide;
  readonly name: string;
  readonly paneKey: string;
  readonly rect: PaneRect;
  /** In the same pixels as `rect`. */
  readonly x: number;
  readonly y: number;
  readonly active: boolean;
}

/** One landmark as the panel lists it. */
export interface LandmarkRow {
  readonly id: number;
  readonly name: string;
  readonly hasFixed: boolean;
  readonly hasMoving: boolean;
  readonly active: boolean;
  /** Its target registration error in mm, or null while it has no number. */
  readonly distanceMm: number | null;
  /** The error along the patient's left, back and head, mm. */
  readonly error: Vec3 | null;
}

/**
 * Landmarks between the base image and the image compared with it, and the
 * target registration error at them (#85): placing and moving points, where
 * they are drawn, the numbers, and the landmark file.
 *
 * A fixed point is in the base image's frame, a moving point in the other
 * image's own. What is drawn and measured goes through the registration that
 * places the other image now, whichever that is: one from a file, one chosen
 * among several, or one being made by hand. With both images in one frame of
 * reference there is none, and the points are compared as they are.
 */
@Injectable()
export class LandmarkController {
  private readonly store = inject(LandmarkStore);
  private readonly layersCtl = inject(LayersController);
  private deps: LandmarkInit | null = null;

  init(deps: LandmarkInit): void {
    this.deps = deps;
  }

  readonly placing = this.store.placing;

  /** The image landmarks are placed against the base: the overlay on screen. */
  private readonly moving = computed<Layer | null>(() => this.layersCtl.selectedOverlay());

  /** Whether there are two images to place landmarks between. */
  readonly available = computed(() => this.moving() !== null);

  /** The name of the pair of images on screen, which landmarks are kept for. */
  private readonly pair = computed<string | null>(() => {
    const base = baseLayer(this.layersCtl.layers());
    const moving = this.moving();
    return base && moving ? `${base.id}|${moving.id}` : null;
  });

  /** The landmarks of the pair of images on screen. Those of another pair are not shown. */
  readonly landmarks = computed<readonly Landmark[]>(() =>
    this.pair() !== null && this.store.pair() === this.pair() ? this.store.landmarks() : [],
  );

  /** The registration the moving image is placed by, from its frame to the base's. */
  private readonly movingToFixed = computed(
    () => this.moving()?.placement?.layerToBase ?? IDENTITY_MAT4,
  );

  /** What the errors are measured against, in words. */
  readonly registration = computed<string>(() => {
    const placement = this.moving()?.placement;
    return placement
      ? placementText(placement)
      : 'No registration: both images are in one frame of reference';
  });

  /**
   * The frame the errors are measured in. A registration by a matrix takes
   * the compared image's point into the base's frame. One by a deformation
   * field goes one way only, from the base's frame: the base's point is
   * taken into the compared image's frame, and the error is there.
   */
  readonly measuredIn = computed<'fixed' | 'moving'>(() =>
    this.moving()?.placement?.field ? 'moving' : 'fixed',
  );

  /** The target registration error of the registration in use at some landmarks. */
  private errorOf(landmarks: readonly Landmark[]): TargetRegistrationError {
    const placement = this.moving()?.placement;
    return placement?.field
      ? targetRegistrationErrorFromFixed(landmarks, (fixed) => pointToLayer(placement, fixed))
      : targetRegistrationErrorOfMatrix(landmarks, this.movingToFixed());
  }

  /** The target registration error of that registration at the landmarks. */
  readonly error = computed<TargetRegistrationError>(() => this.errorOf(this.landmarks()));

  /** The landmarks as the panel lists them, each with its error when it has one. */
  readonly rows = computed<LandmarkRow[]>(() => {
    return this.landmarks().map((one) => {
      // Each by itself, so that a row's number is its own landmark's whatever its name.
      const found = this.errorOf([one]).landmarks.at(0);
      return {
        id: one.id,
        name: one.name,
        hasFixed: one.fixed !== null,
        hasMoving: one.moving !== null,
        active: one.id === this.store.activeId(),
        distanceMm: found?.distanceMm ?? null,
        error: found?.error ?? null,
      };
    });
  });

  /** Switch placing on or off. Switched on, the Compare layout is opened: that is where both images are. */
  togglePlacing(): void {
    if (!this.available()) return;
    const on = !this.store.placing();
    this.store.placing.set(on);
    if (on && !this.layersCtl.isCompare()) this.layersCtl.setViewMode('compare');
  }

  /** Whether a click on an MPR pane places a landmark's point now. */
  readonly placingActive = computed(() => this.store.placing() && this.available());

  /**
   * The point of the patient under a place of a pane, in the frame of the
   * volume that pane is laid out on. Null outside the image.
   */
  private pointAt(pane: MprPane, x: number, y: number): Vec3 | null {
    const d = this.deps;
    const volume = this.layersCtl.groupVolume(pane.group);
    if (!d || !volume) return null;
    const { orientation, group } = pane;
    const sample = probeVoxel(
      volume,
      orientation,
      this.layersCtl.paneSliceIndex(group, orientation),
      this.layersCtl.paneZoom(group, orientation),
      pane.rect,
      x,
      y,
      orientation === Orientation.Sagittal && d.sagittalFlipped(),
      this.layersCtl.panePan(group, orientation),
      d.obliques()[orientation],
    );
    return sample?.patient ?? null;
  }

  /** Which side a pane is of: the base's column is the fixed image, any other the moving one. */
  private sideOf(pane: MprPane): LandmarkSide {
    return pane.group === 0 ? 'fixed' : 'moving';
  }

  /**
   * A point read in a pane, as the landmark keeps it. A fixed point is kept
   * as read. A moving point is kept in the moving image's own frame: read in
   * a column laid out on the base's planes, it goes through the registration
   * to there. Null where the registration does not map the point.
   */
  private kept(pane: MprPane, point: Vec3): Vec3 | null {
    const moving = this.moving();
    if (this.sideOf(pane) === 'fixed' || !moving) return point;
    const readOn = this.layersCtl.groupVolume(pane.group);
    return readOn === moving.volume
      ? point
      : pointBetweenLayers(point, undefined, moving.placement);
  }

  /**
   * Where a kept point is in the frame of the volume a pane is laid out on.
   * Null where the registration does not lead back there.
   */
  private drawnIn(pane: MprPane, side: LandmarkSide, point: Vec3): Vec3 | null {
    const moving = this.moving();
    if (side === 'fixed' || !moving) return point;
    const readOn = this.layersCtl.groupVolume(pane.group);
    return readOn === moving.volume
      ? point
      : pointBetweenLayers(point, moving.placement, undefined);
  }

  /** Place a point of a landmark at a press on an MPR pane. */
  place(pane: MprPane, event: PointerEvent): void {
    const d = this.deps;
    const pair = this.pair();
    if (!d || pair === null || !this.placingActive()) return;
    const bounds = d.canvasBounds();
    const point = this.pointAt(pane, event.clientX - bounds.left, event.clientY - bounds.top);
    if (!point) return; // outside the image
    // Landmarks are of one pair of images: those of another are let go of.
    if (this.store.pair() !== pair) {
      const wasPlacing = this.store.placing();
      this.store.reset();
      this.store.placing.set(wasPlacing);
      this.store.pair.set(pair);
    }
    const kept = this.kept(pane, point);
    if (kept) this.store.place(this.sideOf(pane), kept);
  }

  /** Move a landmark's point to where the pointer is on the pane its marker is in. */
  moveMarker(
    id: number,
    side: LandmarkSide,
    paneKey: string,
    clientX: number,
    clientY: number,
  ): void {
    const d = this.deps;
    if (!d) return;
    const pane = d
      .panes()
      .find((one): one is MprPane => one.kind === 'mpr' && paneKeyOf(one) === paneKey);
    if (!pane || this.sideOf(pane) !== side) return;
    const bounds = d.canvasBounds();
    const point = this.pointAt(pane, clientX - bounds.left, clientY - bounds.top);
    const kept = point ? this.kept(pane, point) : null;
    if (kept) this.store.setPoint(id, side, kept);
  }

  /** The landmarks' points that lie on the slices on screen, each where it is in its pane. */
  readonly markers = computed<LandmarkMarker[]>(() => {
    const d = this.deps;
    if (!d) return [];
    const landmarks = this.landmarks();
    if (landmarks.length === 0) return [];
    const markers: LandmarkMarker[] = [];
    for (const pane of d.panes()) {
      if (pane.kind !== 'mpr') continue;
      const volume = this.layersCtl.groupVolume(pane.group);
      if (!volume) continue;
      const side = this.sideOf(pane);
      const { orientation, group } = pane;
      const oblique = d.obliques()[orientation];
      const slice = this.layersCtl.paneSliceIndex(group, orientation);
      for (const one of landmarks) {
        const kept = one[side];
        if (!kept) continue;
        const drawn = this.drawnIn(pane, side, kept);
        const voxel = drawn ? voxelOf(volume, drawn) : null;
        if (!voxel || focusSliceIndex(volume, orientation, voxel, oblique) !== slice) continue;
        const at = focusPanePoint(
          volume,
          orientation,
          voxel,
          this.layersCtl.paneZoom(group, orientation),
          pane.rect,
          orientation === Orientation.Sagittal && d.sagittalFlipped(),
          this.layersCtl.panePan(group, orientation),
          oblique,
        );
        if (!at || !within(pane.rect, at.x, at.y)) continue;
        markers.push({
          key: `${paneKeyOf(pane)}:${one.id}`,
          id: one.id,
          side,
          name: one.name,
          paneKey: paneKeyOf(pane),
          rect: pane.rect,
          x: at.x,
          y: at.y,
          active: one.id === this.store.activeId(),
        });
      }
    }
    return markers;
  });

  /** Make a landmark the active one, and take the views to it. */
  select(id: number): void {
    const one = this.landmarks().find((landmark) => landmark.id === id);
    if (!one) return;
    this.store.activeId.set(id);
    // In the base's frame: its fixed point, or where its moving point is put.
    const at =
      one.fixed ??
      (one.moving ? pointBetweenLayers(one.moving, this.moving()?.placement, undefined) : null);
    if (at) this.deps?.goTo(at);
  }

  rename(id: number, name: string): void {
    this.store.rename(id, name);
  }

  remove(id: number): void {
    this.store.remove(id);
  }

  /** Take a point away, to place it again with the next click in that image. */
  clearPoint(id: number, side: LandmarkSide): void {
    this.store.clearPoint(id, side);
  }

  /** The frames of reference the landmarks are between, or null when an image names none. */
  private frames(): { readonly fixedFrame: string; readonly movingFrame: string } | null {
    const moving = this.moving();
    const between = moving ? layerFrames(moving) : null;
    if (between) return { fixedFrame: between.baseFrame, movingFrame: between.layerFrame };
    const frame = this.deps?.baseFrame() ?? null;
    return moving && frame ? { fixedFrame: frame, movingFrame: frame } : null;
  }

  /** Whether the landmarks can be saved to a file, or read from one. */
  readonly canExchange = computed(() => this.available() && this.frames() !== null);

  /** Save the landmarks as a file: a download. */
  exportFile(now: Date = new Date()): void {
    const frames = this.frames();
    const landmarks = this.landmarks();
    if (!this.deps || !frames || landmarks.length === 0) return;
    const text = writeLandmarks({
      ...frames,
      landmarks: landmarks.map(({ name, fixed, moving }) => ({ name, fixed, moving })),
    });
    this.deps.download(
      new Blob([text], { type: 'application/json' }),
      `landmarks-${timestampSlug(now)}.json`,
    );
  }

  /**
   * Read landmarks from the text of a file, in place of those there are. A
   * file of other images (other frames of reference) is refused: its points
   * would mean nothing here.
   */
  importText(text: string): void {
    const d = this.deps;
    const frames = this.frames();
    const pair = this.pair();
    if (!d || !frames || pair === null) return;
    try {
      const read = parseLandmarks(text);
      if (read.fixedFrame !== frames.fixedFrame || read.movingFrame !== frames.movingFrame) {
        throw new LandmarkFileError(
          'These landmarks are of other images: their frames of reference are not those of the two on screen.',
        );
      }
      const wasPlacing = this.store.placing();
      this.store.reset();
      this.store.placing.set(wasPlacing);
      this.store.pair.set(pair);
      this.store.replace(read.landmarks);
      const count = read.landmarks.length;
      d.notify(`Read ${count} ${count === 1 ? 'landmark' : 'landmarks'}.`, false);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      d.notify(`The landmarks were not read. ${why}`, true);
    }
  }
}

/** The voxel (not rounded) of a point in a volume, or null when it is outside the grid. */
function voxelOf(volume: Volume, point: Vec3): [number, number, number] | null {
  const voxel = patientToVoxel(resolveGeometry(volume), point);
  if (!voxel) return null;
  const inside = voxel.every((c, axis) => c >= -0.5 && c <= volume.dims[axis] - 0.5);
  return inside ? [voxel[0], voxel[1], voxel[2]] : null;
}

function within(rect: PaneRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
