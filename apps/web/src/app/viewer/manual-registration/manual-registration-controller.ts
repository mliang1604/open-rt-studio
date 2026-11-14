/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, inject, signal } from '@angular/core';
import { baseLayer, type RigidParams, type Series } from '@open-rt-studio/dicom';

import { DATA_SOURCE } from '../../data-source/data-source';
import { LayersController } from '../layers-controller';
import { LayersStore } from '../layers-store';
import { registrationByHandFile } from './registration-export';

export interface ManualRegistrationInit {
  /** The series of the base image, which a saved registration is filed with. */
  readonly baseSeries: () => Series | null;
  readonly notify: (message: string, problem: boolean) => void;
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
