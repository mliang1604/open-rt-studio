/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Orientation, type Volume, type VolumeGeometry } from '@open-rt-studio/dicom';
import type { PaneRect } from './layout.js';
import { focusPanePoint, focusPatientPoint, focusSliceIndex } from './crosshair.js';
import { probeVoxel } from './probe.js';

/** A dims[0]×dims[1]×dims[2] volume whose every voxel holds its flat index. */
function makeVolume(dims: [number, number, number], geometry?: VolumeGeometry): Volume {
  const [x, y, z] = dims;
  const data = new Float32Array(x * y * z);
  for (let i = 0; i < data.length; i++) data[i] = i;
  return {
    dims,
    spacing: [1, 1, 1],
    data,
    min: 0,
    max: data.length - 1,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry,
  };
}

const SQUARE: PaneRect = { x: 0, y: 0, width: 100, height: 100 };

describe('focusSliceIndex', () => {
  it('maps a voxel to the through-plane slice of each orientation', () => {
    const volume = makeVolume([4, 4, 4]);
    const voxel = [1, 2, 3] as const;

    expect(focusSliceIndex(volume, Orientation.Axial, voxel)).toBe(3); // walks +z
    expect(focusSliceIndex(volume, Orientation.Coronal, voxel)).toBe(2); // walks +y
    expect(focusSliceIndex(volume, Orientation.Sagittal, voxel)).toBe(1); // walks +x
  });

  it('round-trips the slice a probed voxel was sampled from', () => {
    const volume = makeVolume([4, 4, 4]);
    // probe.spec samples these voxels from these (orientation, slice) panes.
    const axial = probeVoxel(volume, Orientation.Axial, 2, 1, SQUARE, 50, 50);
    const coronal = probeVoxel(volume, Orientation.Coronal, 1, 1, SQUARE, 50, 0);

    expect(focusSliceIndex(volume, Orientation.Axial, axial!.voxel)).toBe(2);
    expect(focusSliceIndex(volume, Orientation.Coronal, coronal!.voxel)).toBe(1);
  });

  it('clamps voxels that map past the slice range', () => {
    const volume = makeVolume([4, 4, 4]);

    expect(focusSliceIndex(volume, Orientation.Axial, [0, 0, 0])).toBe(0);
    expect(focusSliceIndex(volume, Orientation.Axial, [3, 3, 3])).toBe(3);
  });

  it('reslices the through-plane index for an obliquely-acquired volume', () => {
    // Columns run +Y, rows run -Z, slices run +X (a permutation of patient axes).
    const geometry: VolumeGeometry = {
      iStep: [0, 1, 0],
      jStep: [0, 0, -1],
      kStep: [1, 0, 0],
      origin: [0, 0, 0],
    };
    const volume = makeVolume([4, 4, 4], geometry);
    // The axial pane walks patient +z, which is the acquisition's -j axis.
    const probe = probeVoxel(volume, Orientation.Axial, 2, 1, SQUARE, 0, 0);

    expect(focusSliceIndex(volume, Orientation.Axial, probe!.voxel)).toBe(2);
  });
});

describe('focusPanePoint', () => {
  // The crosshair is the exact inverse of the probe: a voxel projected to a pane
  // pixel must, when probed back from its own through-plane slice, return itself.
  function roundTrips(
    orientation: Orientation,
    voxel: readonly [number, number, number],
    zoom = 1,
    flipX = false,
    pan = { x: 0, y: 0 },
  ): readonly [number, number, number] | undefined {
    const volume = makeVolume([8, 8, 8]);
    const slice = focusSliceIndex(volume, orientation, voxel);
    const point = focusPanePoint(volume, orientation, voxel, zoom, SQUARE, flipX, pan)!;
    return probeVoxel(volume, orientation, slice, zoom, SQUARE, point.x, point.y, flipX, pan)
      ?.voxel;
  }

  it('lands on the pixel the probe samples the voxel from', () => {
    expect(roundTrips(Orientation.Axial, [5, 3, 4])).toEqual([5, 3, 4]);
    expect(roundTrips(Orientation.Coronal, [5, 3, 4])).toEqual([5, 3, 4]);
    expect(roundTrips(Orientation.Sagittal, [5, 3, 4])).toEqual([5, 3, 4]);
  });

  it('tracks the voxel through zoom, flip, and pan', () => {
    // A central voxel stays on-screen as the pane zooms in.
    expect(roundTrips(Orientation.Axial, [4, 4, 3], 2)).toEqual([4, 4, 3]);
    expect(roundTrips(Orientation.Sagittal, [4, 4, 3], 1, true)).toEqual([4, 4, 3]);
    expect(roundTrips(Orientation.Coronal, [4, 4, 3], 1, false, { x: 0.1, y: -0.15 })).toEqual([
      4, 4, 3,
    ]);
  });

  it('lands on the centre of the focused voxel', () => {
    const volume = makeVolume([8, 8, 8]);
    // The voxel centred at index 4 (centre = (4 + 0.5)/8 of the plane) projects to
    // 56.25% across a 100px square pane — its centre, not the pane centre.
    const point = focusPanePoint(volume, Orientation.Axial, [4, 4, 4], 1, SQUARE)!;

    expect(point.x).toBeCloseTo(56.25, 5);
    expect(point.y).toBeCloseTo(56.25, 5);
  });

  it('returns null for an empty pane', () => {
    const volume = makeVolume([4, 4, 4]);
    const empty: PaneRect = { x: 0, y: 0, width: 0, height: 0 };

    expect(focusPanePoint(volume, Orientation.Axial, [1, 1, 1], 1, empty)).toBeNull();
  });
});

describe('tilting a plane about the crosshair (focusPatientPoint as the pivot)', () => {
  const geometry: VolumeGeometry = {
    iStep: [2, 0, 0],
    jStep: [0, 1, 0],
    kStep: [0, 0, 3],
    origin: [10, -20, 5],
  };
  const volume = makeVolume([16, 24, 12], geometry);
  const voxel = [3, 17, 8] as const; // well off the centre (7.5, 11.5, 5.5)
  const PANE: PaneRect = { x: 40, y: 10, width: 300, height: 200 };
  const ORIENTATIONS = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal];
  const TILTS = [
    { tiltU: 0.35, tiltV: 0 },
    { tiltU: -0.2, tiltV: 0.45 },
  ];

  it('is the patient position of the voxel centre', () => {
    expect(focusPatientPoint(volume, voxel)).toEqual([10 + 2 * 3, -20 + 17, 5 + 3 * 8]);
    // Without recorded geometry the grid itself is the patient frame.
    expect(focusPatientPoint(makeVolume([4, 4, 4]), [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('keeps the crosshair on its slice and at its pixel while the plane tilts', () => {
    const pivot = focusPatientPoint(volume, voxel);
    for (const orientation of ORIENTATIONS) {
      const slice = focusSliceIndex(volume, orientation, voxel);
      const at = focusPanePoint(volume, orientation, voxel, 1.5, PANE, false, { x: 0.05, y: 0 })!;
      for (const tilt of TILTS) {
        const rotation = { ...tilt, pivot };
        expect(focusSliceIndex(volume, orientation, voxel, rotation)).toBe(slice);
        const tilted = focusPanePoint(
          volume,
          orientation,
          voxel,
          1.5,
          PANE,
          false,
          { x: 0.05, y: 0 },
          rotation,
        )!;
        expect(tilted.x).toBeCloseTo(at.x, 4);
        expect(tilted.y).toBeCloseTo(at.y, 4);
      }
    }
  });

  it('the probe under the crosshair still reads the crosshair voxel after the tilt', () => {
    const pivot = focusPatientPoint(volume, voxel);
    for (const orientation of ORIENTATIONS) {
      for (const tilt of TILTS) {
        const rotation = { ...tilt, pivot };
        const slice = focusSliceIndex(volume, orientation, voxel, rotation);
        const at = focusPanePoint(volume, orientation, voxel, 1, PANE, false, undefined, rotation)!;
        const probe = probeVoxel(
          volume,
          orientation,
          slice,
          1,
          PANE,
          at.x,
          at.y,
          false,
          undefined,
          rotation,
        );
        expect(probe?.voxel).toEqual([...voxel]);
      }
    }
  });

  it('about the volume centre instead, the same pixel reads another voxel', () => {
    const tilt = TILTS[0];
    const slice = focusSliceIndex(volume, Orientation.Axial, voxel);
    const at = focusPanePoint(volume, Orientation.Axial, voxel, 1, PANE)!;
    const probe = probeVoxel(
      volume,
      Orientation.Axial,
      slice,
      1,
      PANE,
      at.x,
      at.y,
      false,
      undefined,
      tilt,
    );
    expect(probe?.voxel).not.toEqual([...voxel]);
  });
});
