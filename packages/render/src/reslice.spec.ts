/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  IDENTITY_MAT4,
  Orientation,
  type Mat4,
  type Vec3,
  type Volume,
  type VolumeGeometry,
  dot,
  invertMat4,
  rigidMat4,
  sub,
  transformPoint,
} from '@open-rt-studio/dicom';
import {
  clipLineToUnitSquare,
  clipPlaneTex,
  clipTRange,
  isOblique,
  linkedSliceIndex,
  NO_OBLIQUE,
  orientTowardRay,
  overlayPlaneToTexMatrix,
  planeCoordsAt,
  planeExtentMm,
  planePixelDims,
  planeToTex,
  planeToTexMatrix,
  patientToTexMatrix,
  referenceLine,
  slabTRange,
  sliceClipPlaneTex,
  sliceCountFor,
  slicePlaneCorners,
  texCoordAt,
  viewClipHalfSpaces,
  type HalfSpace,
  type ObliqueRotation,
  type PatientPlane,
  type VolumeBounds,
} from './reslice.js';

function makeVolume(dims: [number, number, number], geometry?: VolumeGeometry): Volume {
  const [x, y, z] = dims;
  return {
    dims,
    spacing: [1, 1, 1],
    data: new Float32Array(x * y * z),
    min: 0,
    max: 0,
    windowCenter: 0,
    windowWidth: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    modality: 'CT',
    geometry,
  };
}

function expectVec(actual: readonly number[], expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
}

/** Apply a column-major 4×4 to a pane point (u, v, slicePos, 1), returning xyz. */
function applyMat4(m: Float32Array, u: number, v: number, s: number): [number, number, number] {
  return [
    m[0] * u + m[4] * v + m[8] * s + m[12],
    m[1] * u + m[5] * v + m[9] * s + m[13],
    m[2] * u + m[6] * v + m[10] * s + m[14],
  ];
}

describe('overlayPlaneToTexMatrix', () => {
  // Base: a 2×2×2 grid at patient 0..10 (bounds −5..15). Overlay: same spacing but
  // shifted to patient 10..20 (bounds 5..25) — a different field of view in the
  // same frame of reference, i.e. the case that breaks naive per-volume mapping.
  const base = makeVolume([2, 2, 2], {
    iStep: [10, 0, 0],
    jStep: [0, 10, 0],
    kStep: [0, 0, 10],
    origin: [0, 0, 0],
  });
  const overlay = makeVolume([2, 2, 2], {
    iStep: [10, 0, 0],
    jStep: [0, 10, 0],
    kStep: [0, 0, 10],
    origin: [10, 10, 10],
  });

  it('samples the overlay grid at the same patient point the base pane shows', () => {
    const m = overlayPlaneToTexMatrix(base, overlay, Orientation.Axial);
    // Base pane centre is patient [5,5,5] — the overlay's minimum corner → tex 0.
    expectVec(applyMat4(m, 0.5, 0.5, 0.5), [0, 0, 0]);
    // Base pane far corner is patient [15,15,15] — the overlay's centre → tex 0.5.
    expectVec(applyMat4(m, 1, 1, 1), [0.5, 0.5, 0.5]);
  });

  it('differs from mapping the overlay by its own bounds (the co-registration fix)', () => {
    // The naive overlay-own matrix maps the pane centre to the overlay's OWN
    // centre (tex 0.5) — a different patient point — which would mis-register.
    const naive = applyMat4(planeToTexMatrix(overlay, Orientation.Axial), 0.5, 0.5, 0.5);
    expect(naive[0]).toBeCloseTo(0.5);
    const correct = applyMat4(
      overlayPlaneToTexMatrix(base, overlay, Orientation.Axial),
      0.5,
      0.5,
      0.5,
    );
    expect(correct[0]).not.toBeCloseTo(naive[0]);
  });
});

describe('overlayPlaneToTexMatrix through a registration (#76)', () => {
  // Two images of one anatomy in two frames of reference. The overlay's frame
  // is the base's turned and moved: a point at `p` in the base's frame is at
  // `M · p` in the overlay's.
  const base = makeVolume([8, 6, 4], {
    iStep: [2, 0, 0],
    jStep: [0, 2, 0],
    kStep: [0, 0, 3],
    origin: [-7, -5, -4],
  });
  const overlay = makeVolume([5, 7, 6], {
    iStep: [1.5, 0, 0],
    jStep: [0, 1.5, 0],
    kStep: [0, 0, 2],
    origin: [20, 30, 40],
  });
  const baseToOverlay: Mat4 = rigidMat4([1, 2, -1], 25, [24, 33, 44]);

  /** The patient position a texture coordinate of a volume is at. */
  function patientAt(volume: Volume, tex: readonly number[]): Vec3 {
    const { iStep, jStep, kStep, origin } = volume.geometry!;
    const index = [0, 1, 2].map((axis) => tex[axis] * volume.dims[axis] - 0.5);
    return [0, 1, 2].map(
      (c) => origin[c] + index[0] * iStep[c] + index[1] * jStep[c] + index[2] * kStep[c],
    ) as unknown as Vec3;
  }

  const panePoints: [number, number, number][] = [
    [0, 0, 0],
    [0.5, 0.5, 0.5],
    [1, 0, 0.25],
    [0.2, 0.9, 1],
  ];
  const tilted: ObliqueRotation = { tiltU: 0.3, tiltV: -0.2 };

  it.each([
    ['axial', Orientation.Axial, undefined],
    ['coronal', Orientation.Coronal, undefined],
    ['sagittal', Orientation.Sagittal, undefined],
    ['an oblique plane', Orientation.Axial, tilted],
  ] as const)(
    'reads the overlay where the registration puts each point of the pane: %s',
    (_name, orientation, rotation) => {
      // Where the pane shows the base, in the base's own frame.
      const baseMatrix = overlayPlaneToTexMatrix(base, base, orientation, rotation);
      const registered = overlayPlaneToTexMatrix(
        base,
        overlay,
        orientation,
        rotation,
        baseToOverlay,
      );
      for (const [u, v, slicePos] of panePoints) {
        const inBase = patientAt(base, applyMat4(baseMatrix, u, v, slicePos));
        const read = patientAt(overlay, applyMat4(registered, u, v, slicePos));
        // The same anatomy: the base's point, carried into the overlay's frame.
        // To a ten-thousandth of a millimetre: the matrices are 32-bit, as the
        // shader takes them.
        const expected = transformPoint(baseToOverlay, inBase);
        read.forEach((value, i) => expect(value, `coordinate ${i}`).toBeCloseTo(expected[i], 4));
      }
    },
  );

  it('is as without one for the identity, and not for anything else', () => {
    const plain = overlayPlaneToTexMatrix(base, overlay, Orientation.Axial);
    expectVec(
      [...overlayPlaneToTexMatrix(base, overlay, Orientation.Axial, undefined, IDENTITY_MAT4)],
      [...plain],
    );
    const moved = overlayPlaneToTexMatrix(
      base,
      overlay,
      Orientation.Axial,
      undefined,
      baseToOverlay,
    );
    expect(Math.abs(moved[12] - plain[12])).toBeGreaterThan(0.1);
  });

  it('goes the way it is given: the inverse reads somewhere else', () => {
    // A move of 10 mm along x from the base's frame to the overlay's.
    const shift: Mat4 = rigidMat4([0, 0, 1], 0, [10, 0, 0]);
    const there = overlayPlaneToTexMatrix(base, base, Orientation.Axial, undefined, shift);
    const back = overlayPlaneToTexMatrix(
      base,
      base,
      Orientation.Axial,
      undefined,
      invertMat4(shift),
    );
    const plain = overlayPlaneToTexMatrix(base, base, Orientation.Axial);
    // The base is 16 mm wide: 10 mm is five eighths of its texture, one way or the other.
    expect(applyMat4(there, 0.5, 0.5, 0.5)[0] - applyMat4(plain, 0.5, 0.5, 0.5)[0]).toBeCloseTo(
      0.625,
    );
    expect(applyMat4(back, 0.5, 0.5, 0.5)[0] - applyMat4(plain, 0.5, 0.5, 0.5)[0]).toBeCloseTo(
      -0.625,
    );
  });
});

describe('planeToTex', () => {
  it('reproduces the legacy axis mapping when geometry is identity', () => {
    // No geometry → acquisition axes treated as patient axes (the old behaviour).
    const volume = makeVolume([4, 4, 4]);

    // Axial: coord = (u, v, slicePos).
    expectVec(texCoordAt(planeToTex(volume, Orientation.Axial), 0.2, 0.3, 0.7), [0.2, 0.3, 0.7]);
    // Coronal: coord = (u, slicePos, 1 - v) — superior up.
    expectVec(texCoordAt(planeToTex(volume, Orientation.Coronal), 0.2, 0.3, 0.7), [0.2, 0.7, 0.7]);
    // Sagittal: coord = (slicePos, u, 1 - v).
    expectVec(texCoordAt(planeToTex(volume, Orientation.Sagittal), 0.2, 0.3, 0.7), [0.7, 0.2, 0.7]);
  });

  it('reslices true anatomical planes for a sagittally-acquired volume', () => {
    // Columns run +Y (posterior), rows run -Z (inferior), slices run +X (left):
    // the acquisition axes are a permutation of the patient axes.
    const geometry: VolumeGeometry = {
      iStep: [0, 1, 0],
      jStep: [0, 0, -1],
      kStep: [1, 0, 0],
      origin: [0, 0, 0],
    };
    const volume = makeVolume([4, 4, 4], geometry);
    const axial = planeToTex(volume, Orientation.Axial);

    // The centre of the plane still samples the centre of the volume.
    expectVec(texCoordAt(axial, 0.5, 0.5, 0.5), [0.5, 0.5, 0.5]);
    // Moving right across the axial pane (+X, patient-left) walks the slice
    // axis (k runs +X), not the column axis as the naive mapping assumed.
    expectVec(texCoordAt(axial, 0, 0.5, 0.5), [0.5, 0.5, 0]);
    expectVec(texCoordAt(axial, 1, 0.5, 0.5), [0.5, 0.5, 1]);
    // Increasing slicePos (+Z, superior) walks the row axis (j runs -Z), so a
    // higher slice maps to a lower row coordinate.
    expectVec(texCoordAt(axial, 0.5, 0.5, 0), [0.5, 1, 0.5]);
    expectVec(texCoordAt(axial, 0.5, 0.5, 1), [0.5, 0, 0.5]);
  });
});

describe('planeToTex oblique rotation', () => {
  const volume = makeVolume([4, 4, 4]); // identity geom: tex = (index + 0.5) / 4

  it('is a no-op for a zero/absent rotation', () => {
    const base = planeToTex(volume, Orientation.Axial);
    const zero = planeToTex(volume, Orientation.Axial, NO_OBLIQUE);
    expectVec(zero.dU, base.dU);
    expectVec(zero.dV, base.dV);
    expectVec(zero.dS, base.dS);
    expectVec(zero.origin, base.origin);
    expect(isOblique(NO_OBLIQUE)).toBe(false);
    expect(isOblique({ tiltU: 0.1, tiltV: 0 })).toBe(true);
  });

  it('yaws the axial plane about its vertical axis (single oblique)', () => {
    // tiltV = +90° about v (patient +y) swings u from +x onto −z and the slice
    // axis from +z onto +x: the axial pane becomes a sagittal-like cut.
    const map = planeToTex(volume, Orientation.Axial, { tiltU: 0, tiltV: Math.PI / 2 });
    expectVec(map.dU, [0, 0, -1]); // u now walks −z in texture space
    expectVec(map.dV, [0, 1, 0]); // v (the pivot) is unchanged
    expectVec(map.dS, [1, 0, 0]); // the slice axis now walks +x
    // The plane still pivots about the volume centre.
    expectVec(texCoordAt(map, 0.5, 0.5, 0.5), [0.5, 0.5, 0.5]);
  });

  it('pitches the axial plane about its horizontal axis (double oblique)', () => {
    // tiltU = +90° about u (patient +x) swings v and the slice axis; u is the pivot.
    const map = planeToTex(volume, Orientation.Axial, { tiltU: Math.PI / 2, tiltV: 0 });
    expectVec(map.dU, [1, 0, 0]); // u (the pivot) is unchanged
    expectVec(map.dV, [0, 0, 1]); // v now walks +z
    expectVec(map.dS, [0, -1, 0]); // the slice axis now walks −y
    expectVec(texCoordAt(map, 0.5, 0.5, 0.5), [0.5, 0.5, 0.5]);
  });

  it('preserves in-plane spacing under an arbitrary tilt', () => {
    // A small double-oblique tilt keeps the centre fixed and the physical step
    // per unit u/v unchanged (the rotation is rigid), so spacing is preserved.
    const rotation: ObliqueRotation = { tiltU: 0.3, tiltV: -0.4 };
    const base = planeToTex(volume, Orientation.Axial);
    const tilted = planeToTex(volume, Orientation.Axial, rotation);
    const mmPerTex = 4; // identity geom, dims 4: one texel spans 4 mm here
    const len = (v: readonly number[]): number => Math.hypot(v[0], v[1], v[2]) * mmPerTex;
    expect(len(tilted.dU)).toBeCloseTo(len(base.dU), 6);
    expect(len(tilted.dV)).toBeCloseTo(len(base.dV), 6);
    // Centre stays put and the rotated axes stay orthonormal (dU ⟂ dV).
    expectVec(texCoordAt(tilted, 0.5, 0.5, 0.5), [0.5, 0.5, 0.5]);
    const cosUV =
      tilted.dU[0] * tilted.dV[0] + tilted.dU[1] * tilted.dV[1] + tilted.dU[2] * tilted.dV[2];
    expect(cosUV).toBeCloseTo(0, 6);
  });

  it('keeps the probe inverse consistent with the oblique forward map', () => {
    const rotation: ObliqueRotation = { tiltU: 0.2, tiltV: 0.5 };
    const map = planeToTex(volume, Orientation.Coronal, rotation);
    const coord = texCoordAt(map, 0.3, 0.6, 0.4);
    const back = planeCoordsAt(map, coord);
    expect(back.u).toBeCloseTo(0.3, 6);
    expect(back.v).toBeCloseTo(0.6, 6);
    expect(back.slicePos).toBeCloseTo(0.4, 6);
  });
});

describe('planeToTex oblique rotation about a pivot', () => {
  // Anisotropic, off-origin grid: 2 x 1 x 3 mm voxels, first voxel at (10, -20, 5).
  const geometry: VolumeGeometry = {
    iStep: [2, 0, 0],
    jStep: [0, 1, 0],
    kStep: [0, 0, 3],
    origin: [10, -20, 5],
  };
  const volume = makeVolume([8, 12, 6], geometry);
  const ORIENTATIONS = [Orientation.Axial, Orientation.Coronal, Orientation.Sagittal];
  const TILTS: ObliqueRotation[] = [
    { tiltU: 0.3, tiltV: 0 },
    { tiltU: 0, tiltV: -0.5 },
    { tiltU: -0.7, tiltV: 0.4 },
  ];
  /** Texture coordinate and patient point of a voxel centre on this grid. */
  const tex = (v: Vec3): Vec3 => [(v[0] + 0.5) / 8, (v[1] + 0.5) / 12, (v[2] + 0.5) / 6];
  const patient = (v: Vec3): Vec3 => [10 + 2 * v[0], -20 + v[1], 5 + 3 * v[2]];
  const offCentre: Vec3 = [1, 9, 4];

  it('leaves the pivot where it was in the plane, whatever the tilt', () => {
    for (const orientation of ORIENTATIONS) {
      const flat = planeCoordsAt(planeToTex(volume, orientation), tex(offCentre));
      for (const tilt of TILTS) {
        const rotation = { ...tilt, pivot: patient(offCentre) };
        const tilted = planeCoordsAt(planeToTex(volume, orientation, rotation), tex(offCentre));
        expect(tilted.u).toBeCloseTo(flat.u, 6);
        expect(tilted.v).toBeCloseTo(flat.v, 6);
        expect(tilted.slicePos).toBeCloseTo(flat.slicePos, 6);
      }
    }
  });

  it('without a pivot the same point does leave its slice', () => {
    const flat = planeCoordsAt(planeToTex(volume, Orientation.Axial), tex(offCentre));
    const tilted = planeCoordsAt(
      planeToTex(volume, Orientation.Axial, { tiltU: 0.3, tiltV: 0 }),
      tex(offCentre),
    );
    expect(Math.abs(tilted.slicePos - flat.slicePos)).toBeGreaterThan(0.05);
  });

  it('a pivot at the centre of the volume is the same as no pivot', () => {
    const centre: Vec3 = [3.5, 5.5, 2.5]; // the middle of 8 x 12 x 6 voxels
    for (const orientation of ORIENTATIONS) {
      for (const tilt of TILTS) {
        const about = planeToTex(volume, orientation, { ...tilt, pivot: patient(centre) });
        const plain = planeToTex(volume, orientation, tilt);
        expectVec(about.dU, plain.dU);
        expectVec(about.dV, plain.dV);
        expectVec(about.dS, plain.dS);
        expectVec(about.origin, plain.origin);
      }
    }
  });

  it('turns the plane by the same angles as without a pivot', () => {
    const tilt = TILTS[2];
    const about = planeToTex(volume, Orientation.Coronal, { ...tilt, pivot: patient(offCentre) });
    const plain = planeToTex(volume, Orientation.Coronal, tilt);
    // Same axes; only where the plane sits differs.
    expectVec(about.dU, plain.dU);
    expectVec(about.dV, plain.dV);
    expectVec(about.dS, plain.dS);
    expect(Math.hypot(...sub(about.origin, plain.origin))).toBeGreaterThan(0.01);
  });

  it('a pivot with no tilt changes nothing', () => {
    const rotation = { tiltU: 0, tiltV: 0, pivot: patient(offCentre) };
    expect(isOblique(rotation)).toBe(false);
    const map = planeToTex(volume, Orientation.Sagittal, rotation);
    const base = planeToTex(volume, Orientation.Sagittal);
    expect(map.origin).toEqual(base.origin);
    expect(map.dS).toEqual(base.dS);
  });

  it('keeps linked slices together across two grids that share the pivot', () => {
    // A coarser grid over the same patient box: 4 x 6 x 3 voxels of twice the size.
    const coarse = makeVolume([4, 6, 3], {
      iStep: [4, 0, 0],
      jStep: [0, 2, 0],
      kStep: [0, 0, 6],
      origin: [11, -19.5, 6.5],
    });
    const rotation = { tiltU: 0.25, tiltV: -0.2, pivot: patient(offCentre) };
    // Slice 4 of 6 on the fine grid covers z = 15.5..18.5; the coarse slice
    // covering that level through the pivot is index 2 (z = 15.5..21.5).
    expect(linkedSliceIndex(volume, coarse, Orientation.Axial, 4, rotation)).toBe(2);
    expect(linkedSliceIndex(volume, volume, Orientation.Axial, 4, rotation)).toBe(4);
  });
});

describe('referenceLine / clipLineToUnitSquare', () => {
  const volume = makeVolume([4, 4, 4]);

  it('draws an orthogonal coronal cut as a horizontal line in the axial pane', () => {
    // Coronal walks +y; on the axial pane (u=x, v=y) its plane is the line v = slicePos.
    const line = referenceLine(
      volume,
      { orientation: Orientation.Axial, sliceIndex: 1 },
      { orientation: Orientation.Coronal, sliceIndex: 2 },
    );
    expect(line).not.toBeNull();
    // a·u + b·v + c = 0 with a = 0 → horizontal; solving gives v = (2 + 0.5) / 4.
    expect(line!.a).toBeCloseTo(0, 6);
    expect(-line!.c / line!.b).toBeCloseTo(0.625, 6);

    const ends = clipLineToUnitSquare(line!);
    expect(ends).not.toBeNull();
    for (const p of ends!) expect(p.v).toBeCloseTo(0.625, 6);
    expect(ends![0].u).toBeCloseTo(0, 6);
    expect(ends![1].u).toBeCloseTo(1, 6);
  });

  it('returns null for parallel planes (a plane against itself)', () => {
    const plane = { orientation: Orientation.Axial, sliceIndex: 1 };
    expect(referenceLine(volume, plane, { ...plane, sliceIndex: 3 })).toBeNull();
  });

  it('tilts the reference line as the other plane goes oblique', () => {
    // A coronal plane yawed about its vertical axis crosses the axial pane on a
    // slanted (non-horizontal) line, so the drawn reference reflects the angle.
    const line = referenceLine(
      volume,
      { orientation: Orientation.Axial, sliceIndex: 1 },
      {
        orientation: Orientation.Coronal,
        sliceIndex: 1,
        rotation: { tiltU: 0, tiltV: 0.4 },
      },
    );
    expect(line).not.toBeNull();
    expect(Math.abs(line!.a)).toBeGreaterThan(1e-3); // no longer purely horizontal
  });

  it('returns null when the line misses the displayed square', () => {
    expect(clipLineToUnitSquare({ a: 0, b: 1, c: 5 })).toBeNull(); // v = -5, off-pane
  });
});

describe('sliceCountFor / planeExtentMm', () => {
  it('walks the expected acquisition axis for an identity volume', () => {
    const volume = makeVolume([5, 4, 3]); // x=5, y=4, z=3

    expect(sliceCountFor(volume, Orientation.Axial)).toBe(3); // walks z
    expect(sliceCountFor(volume, Orientation.Coronal)).toBe(4); // walks y
    expect(sliceCountFor(volume, Orientation.Sagittal)).toBe(5); // walks x

    expect(planeExtentMm(volume, Orientation.Axial)).toEqual([5, 4]);
    expect(planeExtentMm(volume, Orientation.Coronal)).toEqual([5, 3]);
    expect(planeExtentMm(volume, Orientation.Sagittal)).toEqual([4, 3]);
  });

  it('counts slices along the patient axis for a permuted volume', () => {
    // Slices run +X, so the *sagittal* view (walks +X) gets the 6 acquired
    // slices, while axial/coronal walk the 4-voxel in-plane axes.
    const geometry: VolumeGeometry = {
      iStep: [0, 1, 0],
      jStep: [0, 0, -1],
      kStep: [1, 0, 0],
      origin: [0, 0, 0],
    };
    const volume = makeVolume([4, 4, 6], geometry); // 6 slices along k (+X)

    expect(sliceCountFor(volume, Orientation.Sagittal)).toBe(6); // walks +X = k
    expect(sliceCountFor(volume, Orientation.Axial)).toBe(4); // walks +Z = -j
    expect(sliceCountFor(volume, Orientation.Coronal)).toBe(4); // walks +Y = i
  });
});

describe('planePixelDims', () => {
  it('gives each plane the through-plane counts of the other two orientations', () => {
    const volume = makeVolume([5, 4, 3]); // x=5, y=4, z=3
    // Axial spans x (5, sagittal's walk) × y (4, coronal's walk).
    expect(planePixelDims(volume, Orientation.Axial)).toEqual([5, 4]);
    // Coronal spans x (5) × z (3, axial's walk).
    expect(planePixelDims(volume, Orientation.Coronal)).toEqual([5, 3]);
    // Sagittal spans y (4) × z (3).
    expect(planePixelDims(volume, Orientation.Sagittal)).toEqual([4, 3]);
  });
});

describe('slabTRange', () => {
  // Centre at the origin, radius 10 → full depth (diameter) is 20.
  const bounds: VolumeBounds = {
    min: [-10, -10, -10],
    max: [10, 10, 10],
    center: [0, 0, 0],
    radius: 10,
  };
  // Eye 20 mm in front of the centre (depth0 = −20); the centre sits at t = 20.
  const eye: Vec3 = [0, 0, -20];
  const forward: Vec3 = [0, 0, 1];

  it('centres a thin slab on the volume centre along the view direction', () => {
    // 4 mm slab → t ∈ [18, 22], a 4 mm interval bracketing the centre at t = 20.
    expect(slabTRange(bounds, eye, forward, 4)).toEqual([18, 22]);
  });

  it('is unbounded at full thickness, leaving the march unclipped', () => {
    expect(slabTRange(bounds, eye, forward, 20)).toEqual([-Infinity, Infinity]);
    expect(slabTRange(bounds, eye, forward, 1000)).toEqual([-Infinity, Infinity]);
  });

  it('accounts for the eye offset so the slab tracks the actual view depth', () => {
    // Move the eye twice as far; depth0 = −40, so the centre (and slab) shift to t = 40.
    expect(slabTRange(bounds, [0, 0, -40], forward, 6)).toEqual([37, 43]);
  });
});

describe('slicePlaneCorners', () => {
  it('outlines the axial slice as a constant-z rectangle spanning the volume', () => {
    const volume = makeVolume([4, 4, 4]); // patient box [-0.5, 3.5] per axis, 4 slices
    // Slice 2 → slicePos (2 + 0.5) / 4 = 0.625 → z = -0.5 + 0.625·4 = 2.0.
    const corners = slicePlaneCorners(volume, Orientation.Axial, 2);

    expectVec(corners[0], [-0.5, -0.5, 2]);
    expectVec(corners[1], [3.5, -0.5, 2]);
    expectVec(corners[2], [3.5, 3.5, 2]);
    expectVec(corners[3], [-0.5, 3.5, 2]);
  });

  it('walks the sagittal plane along patient +x with the slice index', () => {
    const volume = makeVolume([4, 4, 4]);
    // Sagittal slicePos walks +x; slice 0 → x = -0.5 + 0.125·4 = 0.0.
    const corners = slicePlaneCorners(volume, Orientation.Sagittal, 0);

    for (const corner of corners) expect(corner[0]).toBeCloseTo(0, 6); // all share x
  });
});

describe('sliceClipPlaneTex', () => {
  it('is the signed field slicePos(tex) − slicePos₀ for the axial slice', () => {
    // Identity volume: axial slicePos maps straight to tex.z, so the plane is
    // tex.z − slicePos₀ with slicePos₀ = (2 + 0.5) / 4 = 0.625.
    const volume = makeVolume([4, 4, 4]);
    const plane = sliceClipPlaneTex(volume, Orientation.Axial, 2);

    expectVec(plane.normal, [0, 0, 1]);
    expect(plane.offset).toBeCloseTo(-0.625, 6);
    // Zero on the slice, positive on the +slicePos side, negative below it.
    expect(dot(plane.normal, [0.5, 0.5, 0.625]) + plane.offset).toBeCloseTo(0, 6);
    expect(dot(plane.normal, [0.5, 0.5, 0.8]) + plane.offset).toBeGreaterThan(0);
    expect(dot(plane.normal, [0.5, 0.5, 0.4]) + plane.offset).toBeLessThan(0);
  });

  it('places the sagittal plane along the tex.x (patient +x) axis', () => {
    const volume = makeVolume([4, 4, 4]);
    const plane = sliceClipPlaneTex(volume, Orientation.Sagittal, 1);
    // slicePos₀ = (1 + 0.5) / 4 = 0.375 along +x.
    expectVec(plane.normal, [1, 0, 0]);
    expect(plane.offset).toBeCloseTo(-0.375, 6);
  });
});

describe('clipPlaneTex', () => {
  // A permuted, non-unit geometry so the Bᵀ transform — not just an axis swap —
  // is exercised: a clip plane's coefficients don't transform like a direction.
  const geometry: VolumeGeometry = {
    iStep: [0, 2, 0],
    jStep: [0, 0, -1],
    kStep: [3, 0, 0],
    origin: [5, 6, 7],
  };
  const volume = makeVolume([4, 5, 6], geometry);
  const m = patientToTexMatrix(volume);

  // Texture coordinate of a patient point via the column-major affine.
  const toTex = (p: Vec3): Vec3 => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];

  it('matches the patient-space signed distance dot(normal, p − point) in texture space', () => {
    const plane: PatientPlane = { point: [6, 7, 9], normal: [0.3, -0.5, 0.8] };
    const hs = clipPlaneTex(volume, plane);
    const points: Vec3[] = [
      [5, 6, 7],
      [8, 9, 12],
      [6, 7, 9],
      [10, 4, 8],
    ];
    for (const p of points) {
      const valueTex = dot(hs.normal, toTex(p)) + hs.offset;
      const valuePatient = dot(plane.normal, sub(p, plane.point));
      expect(valueTex).toBeCloseTo(valuePatient, 6);
    }
  });

  it('keeps the half-space the normal points into', () => {
    const plane: PatientPlane = { point: [7, 7, 9], normal: [1, 0, 0] };
    const hs = clipPlaneTex(volume, plane);
    expect(dot(hs.normal, toTex([9, 7, 9])) + hs.offset).toBeGreaterThan(0); // +normal side kept
    expect(dot(hs.normal, toTex([5, 7, 9])) + hs.offset).toBeLessThan(0); // −normal side clipped
  });

  it('clips a march to where the plane cuts the ray, via clipTRange', () => {
    // Identity volume so the t-range is easy to reason about: a ray straight up +z.
    const id = makeVolume([4, 4, 4]);
    const plane: PatientPlane = { point: [1.5, 1.5, 1.5], normal: [0, 0, 1] }; // keep z ≥ 1.5 mm
    const hs = clipPlaneTex(id, plane);
    const ro: Vec3 = [0.5, 0.5, 0]; // tex-space ray up the central column, entering at z = 0
    const rd: Vec3 = [0, 0, 1];
    // The plane sits at tex.z = (1.5 + 0.5) / 4 = 0.5, so the kept entry is t = 0.5.
    const [lo, hi] = clipTRange([hs], ro, rd, 0, 1);
    expect(lo).toBeCloseTo(0.5, 6);
    expect(hi).toBeCloseTo(1, 6);
  });

  it('flips which half is kept when the normal is negated', () => {
    const id = makeVolume([4, 4, 4]);
    const hs = clipPlaneTex(id, { point: [1.5, 1.5, 1.5], normal: [0, 0, -1] }); // keep z ≤ 1.5 mm
    const [lo, hi] = clipTRange([hs], [0.5, 0.5, 0], [0, 0, 1], 0, 1);
    expect(lo).toBeCloseTo(0, 6);
    expect(hi).toBeCloseTo(0.5, 6);
  });
});

describe('orientTowardRay', () => {
  const plane: HalfSpace = { normal: [0, 0, 1], offset: -0.5 };

  it('leaves a plane whose normal already follows the ray', () => {
    expect(orientTowardRay(plane, [0, 0, 1])).toBe(plane);
  });

  it('flips a plane so its kept side is the far (large-t) half of the ray', () => {
    const flipped = orientTowardRay(plane, [0, 0, -1]);
    expectVec(flipped.normal, [0, 0, -1]);
    expect(flipped.offset).toBeCloseTo(0.5, 6);
  });
});

describe('clipTRange', () => {
  const ro: Vec3 = [0, 0, 0];
  const rd: Vec3 = [0, 0, 1];

  it('returns the interval unchanged with no half-spaces', () => {
    expect(clipTRange([], ro, rd, 0, 1)).toEqual([0, 1]);
  });

  it('clamps the entry to a plane that keeps the far side', () => {
    // Keep tex.z ≥ 0.5 → t ≥ 0.5 along this ray.
    expect(clipTRange([{ normal: [0, 0, 1], offset: -0.5 }], ro, rd, 0, 1)).toEqual([0.5, 1]);
  });

  it('intersects two opposing half-spaces into the band between them', () => {
    const planes: HalfSpace[] = [
      { normal: [0, 0, 1], offset: -0.3 }, // tex.z ≥ 0.3
      { normal: [0, 0, -1], offset: 0.7 }, // tex.z ≤ 0.7
    ];
    expect(clipTRange(planes, ro, rd, 0, 1)).toEqual([0.3, 0.7]);
  });

  it('collapses the interval when the ray runs parallel to and outside a plane', () => {
    // Keep tex.x ≥ 0.5, but the ray sits at tex.x = 0 with no x component.
    const [lo, hi] = clipTRange([{ normal: [1, 0, 0], offset: -0.5 }], ro, rd, 0, 1);
    expect(lo).toBeGreaterThan(hi); // empty → the caller reads a fully clipped ray
  });

  it('leaves the interval untouched when parallel and inside a plane', () => {
    // Keep tex.x ≥ −0.5; the ray at tex.x = 0 is inside it for all t.
    expect(clipTRange([{ normal: [1, 0, 0], offset: 0.5 }], ro, rd, 0, 1)).toEqual([0, 1]);
  });
});

describe('viewClipHalfSpaces', () => {
  it('orients all three cut-planes to keep the far side of the view ray', () => {
    const volume = makeVolume([4, 4, 4]);
    const rd: Vec3 = [0.2, -0.3, 1]; // an arbitrary texture-space view direction
    const planes = viewClipHalfSpaces(volume, [2, 2, 2], rd);

    expect(planes).toHaveLength(3);
    // Every kept-side normal points downstream of the ray (kept half is large t).
    for (const plane of planes) expect(dot(plane.normal, rd)).toBeGreaterThanOrEqual(0);
  });
});

describe('linkedSliceIndex', () => {
  // A fine grid (1 mm voxels) and a coarse one (4 mm slices, 2 mm in-plane) over
  // the SAME patient frame — the CT-vs-dose case. Both axis-aligned to LPS.
  // Fine: axial slice i sits at patient z = i. Coarse: axial slice i at z = 4·i.
  const fine = makeVolume([4, 4, 20], {
    iStep: [1, 0, 0],
    jStep: [0, 1, 0],
    kStep: [0, 0, 1],
    origin: [0, 0, 0],
  });
  const coarse = makeVolume([2, 2, 5], {
    iStep: [2, 0, 0],
    jStep: [0, 2, 0],
    kStep: [0, 0, 4],
    origin: [0, 0, 0],
  });

  it('maps a fine slice onto the coarse grid at the same patient level', () => {
    // z = 0, 4, 8, 16 land exactly on coarse slices 0, 1, 2, 4.
    expect(linkedSliceIndex(fine, coarse, Orientation.Axial, 0)).toBe(0);
    expect(linkedSliceIndex(fine, coarse, Orientation.Axial, 4)).toBe(1);
    expect(linkedSliceIndex(fine, coarse, Orientation.Axial, 8)).toBe(2);
    expect(linkedSliceIndex(fine, coarse, Orientation.Axial, 16)).toBe(4);
  });

  it('maps a coarse slice back onto the fine grid at the same patient level', () => {
    expect(linkedSliceIndex(coarse, fine, Orientation.Axial, 0)).toBe(0);
    expect(linkedSliceIndex(coarse, fine, Orientation.Axial, 1)).toBe(4);
    expect(linkedSliceIndex(coarse, fine, Orientation.Axial, 4)).toBe(16);
  });

  it('clamps to the target slice range', () => {
    // Fine z = 19 is past the coarse volume's last centre (z = 16); clamp to 4.
    expect(linkedSliceIndex(fine, coarse, Orientation.Axial, 19)).toBe(4);
  });

  it('round-trips a volume against itself (linking a layer to itself is a no-op)', () => {
    // An index in range for each axis: axial has 20 slices, coronal/sagittal 4.
    expect(linkedSliceIndex(fine, fine, Orientation.Axial, 7)).toBe(7);
    expect(linkedSliceIndex(fine, fine, Orientation.Coronal, 2)).toBe(2);
    expect(linkedSliceIndex(fine, fine, Orientation.Sagittal, 3)).toBe(3);
  });

  it('links across the coronal axis too (per-orientation through-plane axis)', () => {
    // Coronal walks +y: fine slice i at y = i, coarse slice i at y = 2·i.
    expect(linkedSliceIndex(fine, coarse, Orientation.Coronal, 2)).toBe(1);
    expect(linkedSliceIndex(coarse, fine, Orientation.Coronal, 1)).toBe(2);
  });
});
