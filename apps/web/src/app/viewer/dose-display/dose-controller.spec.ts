/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { baseImageLayer, overlayImageLayer, type Layer, type Volume } from '@open-rt-studio/dicom';

import { DATA_SOURCE } from '../../data-source/data-source';
import { FakeDataSource } from '../../data-source/testing';
import { LayersController } from '../layers-controller';
import { DoseController } from './dose-controller';
import { DoseDisplayStore } from './dose-display-store';

const volume = (modality: string, dose = false): Volume => ({
  dims: [2, 2, 2],
  spacing: [1, 1, 1],
  data: new Float32Array(8),
  min: 0,
  max: 60,
  windowCenter: 30,
  windowWidth: 60,
  rescaleSlope: 1,
  rescaleIntercept: 0,
  modality,
  ...(dose
    ? {
        dose: {
          units: 'GY' as const,
          type: 'PHYSICAL' as const,
          summationType: 'PLAN',
          scaling: 1,
          sopInstanceUid: null,
          frameOffsets: 'relative' as const,
          interpolatedPlanes: 0,
        },
      }
    : {}),
});

function setup(initial: readonly Layer[]) {
  const layers = signal(initial);
  TestBed.configureTestingModule({
    providers: [
      DoseController,
      DoseDisplayStore,
      { provide: DATA_SOURCE, useValue: new FakeDataSource() },
      { provide: LayersController, useValue: { layers } },
    ],
  });
  return { controller: TestBed.inject(DoseController), layers };
}

describe('the dose that is shown', () => {
  afterEach(() => TestBed.resetTestingModule());

  const ct = baseImageLayer('ct', volume('CT'));
  const mr = overlayImageLayer('mr', volume('MR'));
  const one = overlayImageLayer('one', volume('RTDOSE', true));
  const two = overlayImageLayer('two', volume('RTDOSE', true));
  const hidden = (layer: Layer): Layer => ({ ...layer, visible: false });

  it('is the dose laid over the image, and none when there is no dose', () => {
    const { controller, layers } = setup([ct, mr]);
    expect(controller.layer()).toBeNull();
    layers.set([ct, mr, one]);
    expect(controller.layer()!.id).toBe('one');
  });

  it('is, of several doses, the first that is drawn (#102)', () => {
    const { controller, layers } = setup([ct, one, two]);
    expect(controller.layer()!.id).toBe('one');
    // The first is hidden: the dose on screen is the second.
    layers.set([ct, hidden(one), two]);
    expect(controller.layer()!.id).toBe('two');
    // None is drawn: it is the first still, so that its panel stays.
    layers.set([ct, hidden(one), hidden(two)]);
    expect(controller.layer()!.id).toBe('one');
  });

  it('is the image itself when that is a dose and nothing is laid over it', () => {
    const base = baseImageLayer('dose', volume('RTDOSE', true));
    const { controller, layers } = setup([base]);
    expect(controller.layer()!.id).toBe('dose');
    layers.set([base, one]);
    expect(controller.layer()!.id).toBe('one');
  });
});
