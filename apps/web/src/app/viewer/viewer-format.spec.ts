/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Layer, Volume } from '@open-rt-studio/dicom';
import type { VoxelProbe } from '@open-rt-studio/render';

import { formatProbe } from './viewer-format';

function volume(overrides: Partial<Volume> = {}): Volume {
  return {
    dims: [4, 4, 4],
    spacing: [1, 1, 1],
    data: new Float32Array(64),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: -1024,
    modality: 'CT',
    geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1], origin: [0, 0, 0] },
    ...overrides,
  };
}

const PROBE: VoxelProbe = {
  voxel: [33, 58, 32],
  value: -784,
  rawValue: 240,
  patient: [-91.52, 17.96, -0.04],
};

describe('formatProbe', () => {
  it('gives the pane, the voxel, the patient position in mm, the value and the stored value', () => {
    expect(formatProbe('Axial', PROBE, volume())).toBe(
      'Axial · voxel (33, 58, 32) · LPS (-91.5, 18.0, 0.0) mm · value -784 HU · stored 240',
    );
  });

  it('writes a position that rounds to zero without a minus sign', () => {
    const text = formatProbe('Axial', { ...PROBE, patient: [-0.04, 0.04, -0.049] }, volume());
    expect(text).toContain('LPS (0.0, 0.0, 0.0) mm');
  });

  it('leaves the position out when the volume has no recorded geometry', () => {
    expect(formatProbe('Coronal', PROBE, volume({ geometry: undefined }))).toBe(
      'Coronal · voxel (33, 58, 32) · value -784 HU · stored 240',
    );
  });

  it('leaves the stored value out when it equals the value', () => {
    const text = formatProbe('Axial', PROBE, volume({ rescaleIntercept: 0 }));
    expect(text).toBe('Axial · voxel (33, 58, 32) · LPS (-91.5, 18.0, 0.0) mm · value -784 HU');
  });

  it('adds the other layers read at the same point, after the value', () => {
    const dose = { modality: 'RTDOSE' } as Layer;
    const sample: VoxelProbe = {
      voxel: [1, 2, 3],
      value: 35.72,
      rawValue: 0,
      patient: PROBE.patient,
    };
    expect(formatProbe('Axial', PROBE, volume(), [{ layer: dose, sample }])).toBe(
      'Axial · voxel (33, 58, 32) · LPS (-91.5, 18.0, 0.0) mm · value -784 HU · stored 240 · RTDOSE 35.7 Gy',
    );
  });
});
