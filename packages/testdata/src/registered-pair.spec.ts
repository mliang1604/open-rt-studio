/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  buildVolume,
  findPlacement,
  mapPoint,
  parseFile,
  parseSpatialRegistration,
  pointBetweenLayers,
  readInstanceHeader,
  type Vec3,
  type Volume,
} from '@open-rt-studio/dicom';

import type { SyntheticFile } from './identity.js';
import { syntheticCtValue, syntheticMrValue } from './image-series.js';
import {
  SYNTHETIC_REGISTERED_PAIR as PAIR,
  registeredMrValueAtCtVoxel,
  syntheticRegisteredPair,
} from './registered-pair.js';

const buffer = (file: SyntheticFile): ArrayBuffer => file.bytes.slice().buffer;
const volumeOf = (files: readonly SyntheticFile[]): Volume =>
  buildVolume(files.flatMap((file) => parseFile(file.name, buffer(file))));

/** The value of a volume with 1 mm axis-aligned voxels at a position of its frame, or null outside. */
function valueAt(volume: Volume, position: Vec3): number | null {
  const { origin } = volume.geometry!;
  const [x, y, z] = position.map((value, axis) => Math.round(value - origin[axis]));
  const [nx, ny, nz] = volume.dims;
  if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return null;
  return volume.data[(z * ny + y) * nx + x];
}

describe('the synthetic registered pair', () => {
  const pair = syntheticRegisteredPair();
  const ct = volumeOf(pair.planningCt);
  const mr = volumeOf(pair.followUpMr);
  const registration = parseSpatialRegistration(buffer(pair.registration))!;

  it('is two images in two frames, the MR somewhere the CT is not', () => {
    const ctHeader = readInstanceHeader(pair.planningCt[0].bytes);
    const mrHeader = readInstanceHeader(pair.followUpMr[0].bytes);
    if (!ctHeader.ok || !mrHeader.ok) throw new Error('unreadable');
    expect(ctHeader.header.series.frameOfReferenceUid).toBe(PAIR.planningFrame);
    expect(mrHeader.header.series.frameOfReferenceUid).toBe(PAIR.followUpFrame);
    expect(ctHeader.header.series.uid).toBe(PAIR.ct);
    expect(mrHeader.header.series.uid).toBe(PAIR.mr);
    expect(PAIR.planningFrame).not.toBe(PAIR.followUpFrame);
    expect(ct.dims).toEqual([PAIR.size, PAIR.size, PAIR.count]);
    expect(mr.dims).toEqual([PAIR.size, PAIR.size, PAIR.count]);
    expect(ct.geometry!.origin).toEqual([0, 0, 0]);
    expect(mr.geometry!.origin).toEqual([...PAIR.mrOrigin]);
    // Taken for one frame, the two would not even overlap.
    expect(valueAt(mr, [10, 10, 5])).toBeNull();
  });

  it('has a registration that maps the follow-up frame into the planning frame', () => {
    expect(registration.registeredFrame).toBe(PAIR.planningFrame);
    expect(registration.unread).toEqual([]);
    expect(registration.registrations).toHaveLength(1);
    const { transform } = registration.registrations[0];
    expect(transform).toMatchObject({ from: PAIR.followUpFrame, to: PAIR.planningFrame });
    // The MR's first voxel lands on the CT's voxel (2, 3, 1).
    expect(
      mapPoint(transform, [...PAIR.mrOrigin], {
        from: PAIR.followUpFrame,
        to: PAIR.planningFrame,
      }),
    ).toEqual([...PAIR.shiftVoxels]);
    // It names the MR as the image it moves.
    const header = readInstanceHeader(pair.registration.bytes);
    if (!header.ok) throw new Error('unreadable');
    expect(header.header.references).toContainEqual({
      relation: 'registration.series',
      targetUid: PAIR.mr,
    });
  });

  it('puts each voxel of the MR on the CT’s voxel that the formula names', () => {
    const found = findPlacement(PAIR.planningFrame, PAIR.followUpFrame, [registration]);
    if (found.kind !== 'placed') throw new Error(found.kind);
    const voxels: Vec3[] = [
      [2, 3, 1],
      [12, 9, 4],
      [31, 31, 11],
      [0, 0, 0],
      [20, 2, 6],
    ];
    for (const [x, y, z] of voxels) {
      // The CT's voxel is at its index, in mm. Where is that in the MR's frame?
      const inMrFrame = pointBetweenLayers([x, y, z], undefined, found.placement);
      expect(valueAt(mr, inMrFrame), `CT voxel ${x}, ${y}, ${z}`).toBe(
        registeredMrValueAtCtVoxel(x, y, z),
      );
      expect(valueAt(ct, [x, y, z])).toBe(syntheticCtValue(x, z, PAIR.size));
    }
    // What the formula says: the MR's voxel two, three and one back; none before its first.
    expect(registeredMrValueAtCtVoxel(12, 9, 4)).toBe(syntheticMrValue(10, 6, 3, PAIR.size));
    expect(registeredMrValueAtCtVoxel(0, 0, 0)).toBeNull();
    expect(registeredMrValueAtCtVoxel(20, 2, 6)).toBeNull();
    // Applied the wrong way round, it would read elsewhere: the test would see it.
    expect(syntheticMrValue(10, 6, 3, PAIR.size)).not.toBe(syntheticMrValue(14, 12, 5, PAIR.size));
  });
});
