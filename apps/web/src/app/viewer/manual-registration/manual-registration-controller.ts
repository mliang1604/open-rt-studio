/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, inject, signal } from '@angular/core';
import {
  baseLayer,
  Orientation,
  shiftedBy,
  turnBetween,
  turnedAbout,
  type RigidParams,
  type Series,
  type Vec3,
} from '@open-rt-studio/dicom';
import { planeNormal, probeVoxel, type ObliqueRotation } from '@open-rt-studio/render';

import { DATA_SOURCE } from '../../data-source/data-source';
import { LayersController } from '../layers-controller';
import { LayersStore, type ByHandDrag } from '../layers-store';
import type { PanePlacement } from '../pane-placement';
import { registrationByHandFile } from './registration-export';

type MprPane = Extract<PanePlacement, { kind: 'mpr' }>;

export interface ManualRegistrationInit {
  /** The series of the base image, which a saved registration is filed with. */
  readonly baseSeries: () => Series | null;
  readonly notify: (message: string, problem: boolean) => void;
  /** Where the canvas is in the window, to read a pointer's place on it. */
  readonly canvasBounds: () => { readonly left: number; readonly top: number };
  readonly sagittalFlipped: () => boolean;
  readonly obliques: () => readonly [ObliqueRotation, ObliqueRotation, ObliqueRotation];
}

/** A drag of a layer by hand that is under way. */
interface DragUnderWay {
  readonly drag: ByHandDrag;
  readonly pane: MprPane;
  /** The registration as it was when the button went down. */
  readonly start: RigidParams;
  /** The point of the patient (in the base's frame) that was pressed on. */
  readonly from: Vec3;
  /** The way the pane's plane faces: what a turn in it turns about. */
  readonly normal: Vec3;
}

/**
 * Registering a layer by hand (#78): beginning, the numbers, and saving what
 * was made as a DICOM Spatial Registration object. The numbers themselves are
 * in the {@link LayersStore}, where the layers are composed.
 */
@Injectable()
export class ManualRegistrationController {
  private readonly store = inject(LayersStore);
  private readonly layersCtl = inject(LayersController);
  private readonly source = inject(DATA_SOURCE);
  private deps: ManualRegistrationInit | null = null;

  /** The layer whose registration is being saved, or null. */
  readonly saving = signal<string | null>(null);

  /** The layer a drag in the planes moves by hand, and how; null when none. */
  readonly drag = this.store.byHandDrag;

  /**
   * Whether a left drag on an MPR pane moves a layer by hand now: dragging is
   * switched on for a layer, and that layer is the overlay on screen. (With
   * the layer hidden, or another overlay drawn before it, a drag would move
   * what is not seen: it pans as always.)
   */
  readonly dragActive = computed(() => {
    const drag = this.drag();
    return drag !== null && this.layersCtl.selectedOverlay()?.id === drag.id;
  });

  private underWay: DragUnderWay | null = null;

  init(deps: ManualRegistrationInit): void {
    this.deps = deps;
  }

  /** Begin registering a layer by hand, from where it is now. */
  begin(id: string): void {
    const layers = this.layersCtl.layers();
    const layer = layers.find((one) => one.id === id);
    const base = baseLayer(layers);
    if (!layer || !base || layer === base) return;
    this.store.beginByHand(layer, base.volume);
  }

  set(id: string, params: RigidParams): void {
    this.store.setByHand(id, params);
  }

  reset(id: string): void {
    this.store.resetByHand(id);
  }

  discard(id: string): void {
    this.store.discardByHand(id);
  }

  /**
   * The point of the patient under a place of an MPR pane, in the base's
   * frame, as the probe has it. Null outside the image. Every column a layer
   * by hand is seen in is laid out on the base's planes, so this is the
   * base's frame in the Compare layout too.
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

  /**
   * Begin dragging the layer by hand at a press on an MPR pane. False when
   * there is nothing to drag by: no dragging is on, or the press is outside
   * the image.
   */
  beginDrag(pane: MprPane, event: PointerEvent): boolean {
    const d = this.deps;
    const drag = this.drag();
    const volume = this.layersCtl.groupVolume(pane.group);
    if (!d || !drag || !volume || !this.dragActive()) return false;
    const start = this.store.byHand().get(drag.id)?.params;
    const bounds = d.canvasBounds();
    const from = this.pointAt(pane, event.clientX - bounds.left, event.clientY - bounds.top);
    if (!start || !from) return false;
    const normal = planeNormal(volume, pane.orientation, d.obliques()[pane.orientation]);
    this.underWay = { drag, pane, start, from, normal };
    return true;
  }

  /**
   * Go on with the drag. A shift moves the image by what the pointer moved,
   * so the anatomy that was pressed on stays under it. A turn turns the image
   * about its middle, in the pane's plane, by the angle the pointer went
   * round that middle. Outside the image the layer stays where it last was.
   */
  moveDrag(event: PointerEvent): void {
    const d = this.deps;
    const now = this.underWay;
    if (!d || !now) return;
    const bounds = d.canvasBounds();
    const to = this.pointAt(now.pane, event.clientX - bounds.left, event.clientY - bounds.top);
    if (!to) return;
    const { start, from, normal } = now;
    if (now.drag.mode === 'shift') {
      this.store.setByHand(
        now.drag.id,
        shiftedBy(start, [to[0] - from[0], to[1] - from[1], to[2] - from[2]]),
      );
      return;
    }
    const middle: Vec3 = [
      start.centre[0] + start.translation[0],
      start.centre[1] + start.translation[1],
      start.centre[2] + start.translation[2],
    ];
    this.store.setByHand(
      now.drag.id,
      turnedAbout(start, normal, turnBetween(from, to, middle, normal)),
    );
  }

  endDrag(): void {
    this.underWay = null;
  }

  /**
   * Save a layer's registration by hand as a DICOM Spatial Registration
   * object. Where it goes is the data source's to say: a download for opened
   * files, an upload for a server. Each save is a new object; saving twice
   * leaves two, and neither replaces the other.
   */
  async save(id: string): Promise<void> {
    const hand = this.store.byHand().get(id);
    const placement = this.layersCtl.layers().find((one) => one.id === id)?.placement;
    if (!hand || !placement?.steps[0]?.byHand || this.saving() !== null) return;
    this.saving.set(id);
    let name = 'The registration';
    try {
      const file = registrationByHandFile(placement, this.deps?.baseSeries() ?? null, new Date());
      name = `“${file.name}”`;
      const outcome = await this.source.save({
        bytes: file.bytes,
        filename: file.filename,
        mediaType: 'application/dicom',
      });
      this.store.markByHandSaved(id, hand.params);
      this.deps?.notify(
        outcome.kind === 'stored'
          ? `Saved the registration ${name} (${outcome.where}). It comes with either series the next time one is loaded.`
          : `Saved the registration ${name} as a file. Open it with these images to place the series by it again.`,
        false,
      );
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.deps?.notify(`${name} was not saved. ${why}`, true);
    } finally {
      this.saving.set(null);
    }
  }
}
