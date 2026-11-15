/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import dicomParser from 'dicom-parser';

import {
  DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS,
  deformableRegistrationParts,
  parseDeformableRegistration,
  writeDeformableRegistration,
} from './deformable-registration.js';
import { IDENTITY_MAT4, rigidMat4, transformPoint, type Mat4 } from './mat4.js';
import { ascii, concat, element, p10File, p10Head, sequence, text, uid } from './p10-encode.js';
import {
  deformableTransform,
  mapPoint,
  type DeformableTransform,
  type DeformationGrid,
} from './registration.js';
import { SPATIAL_REGISTRATION_SOP_CLASS } from './spatial-registration.js';
import type { Vec3 } from './types.js';

// Frames of reference: a planning CT's, which the objects here are in, and a
// follow-up CT's and an MR's, which their fields map into.
const [PLANNING, FOLLOW_UP, MR] = ['1.2.826.0.1.1', '1.2.826.0.1.2', '1.2.826.0.1.3'];
const SOP = '1.2.826.0.1.99';

const DIMS = [5, 4, 3] as const;
const ORIGIN: Vec3 = [-20, 10, 5];
const SPACING: Vec3 = [10, 8, 6];
const STRAIGHT: DeformationGrid['axes'] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * A displacement that is known everywhere, in mm. Each part goes with the
 * place along each axis by itself and with their products, which is what
 * taking it between the grid's vectors gives back exactly.
 */
const known = ([x, y, z]: Vec3): Vec3 => [
  1 + 0.02 * x - 0.01 * y * z * 0.1,
  -2 + 0.03 * y + 0.001 * x * z,
  0.5 - 0.04 * z + 0.002 * x * y,
];

/** Where grid point (i, j, k) is. */
function pointOf(grid: Pick<DeformationGrid, 'origin' | 'axes' | 'spacing'>, ijk: Vec3): Vec3 {
  const at: [number, number, number] = [grid.origin[0], grid.origin[1], grid.origin[2]];
  for (let axis = 0; axis < 3; axis++) {
    for (let c = 0; c < 3; c++) at[c] += ijk[axis] * grid.spacing[axis] * grid.axes[axis][c];
  }
  return at;
}

/** A grid with a vector of `field` at each of its points. */
function gridOf(
  field: (point: Vec3) => Vec3,
  axes: DeformationGrid['axes'] = STRAIGHT,
): DeformationGrid {
  const [nx, ny, nz] = DIMS;
  const vectors = new Float32Array(nx * ny * nz * 3);
  const grid = { dims: DIMS, origin: ORIGIN, axes, spacing: SPACING, vectors };
  for (let k = 0, at = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, at += 3) vectors.set(field(pointOf(grid, [i, j, k])), at);
    }
  }
  return grid;
}

/** Every point of the grid, and some between them. */
function places(grid: DeformationGrid): Vec3[] {
  const out: Vec3[] = [];
  for (let k = 0; k < DIMS[2]; k++) {
    for (let j = 0; j < DIMS[1]; j++) {
      for (let i = 0; i < DIMS[0]; i++) out.push(pointOf(grid, [i, j, k]));
    }
  }
  out.push(pointOf(grid, [0.5, 0.5, 0.5]), pointOf(grid, [3.25, 2.5, 1.75]));
  return out;
}

const close = (actual: Vec3 | null, expected: Vec3, digits = 4): void => {
  expect(actual).not.toBeNull();
  actual!.forEach((value, i) => expect(value, `coordinate ${i}`).toBeCloseTo(expected[i], digits));
};

const planningTo = (
  to: string,
  grid: DeformationGrid,
  post: Mat4 = IDENTITY_MAT4,
): DeformableTransform => deformableTransform({ id: 't', from: PLANNING, to, grid, post });

describe('a deformable registration, written and read back', () => {
  const post = rigidMat4([0, 0, 1], 20, [100, -50, 30]);
  const grid = gridOf(known);
  const written = writeDeformableRegistration(
    { registeredFrame: PLANNING, transforms: [planningTo(MR, grid, post)] },
    {
      sopInstanceUid: SOP,
      patientId: 'SYN-0001',
      label: 'deformed',
      description: 'Planning to MR',
    },
  );
  const read = parseDeformableRegistration(written)!;

  it('is the object that was written, in the frame it was written in', () => {
    expect(read).toMatchObject({
      sopInstanceUid: SOP,
      registeredFrame: PLANNING,
      patientId: 'SYN-0001',
      label: 'DEFORMED',
      description: 'Planning to MR',
      identityItems: [],
      unread: [],
    });
    expect(read.registrations).toHaveLength(1);
    expect(read.registrations[0]).toMatchObject({ item: 0, vectorsTurned: false, comment: null });
  });

  it('maps from the frame the object is in to the frame its item names', () => {
    const { transform } = read.registrations[0];
    expect(transform).toMatchObject({
      kind: 'deformable',
      id: `${SOP}#0`,
      from: PLANNING,
      to: MR,
    });
    // And not the other way: asked from the MR's frame, nothing is given.
    expect(() => mapPoint(transform, [0, 0, 0], { from: MR, to: PLANNING })).toThrow();
  });

  it('has every vector as it was written, to the last bit, and the grid where it was', () => {
    const { transform } = read.registrations[0];
    if (transform.kind !== 'deformable') throw new Error('not a field');
    expect(transform.grid.dims).toEqual(DIMS);
    expect(Array.from(transform.grid.vectors)).toEqual(Array.from(grid.vectors));
    close(transform.grid.origin, ORIGIN, 9);
    close(transform.grid.spacing, SPACING, 12);
    transform.grid.axes.forEach((axis, i) => close(axis, STRAIGHT[i], 12));
    expect(transform.pre).toEqual(IDENTITY_MAT4);
    transform.post.forEach((value, i) => expect(value).toBeCloseTo(post[i], 12));
  });

  it('maps each place as the field that was written does: post · (p + D(p))', () => {
    const { transform } = read.registrations[0];
    for (const p of places(grid)) {
      const d = known(p);
      close(
        mapPoint(transform, p, { from: PLANNING, to: MR }),
        transformPoint(post, [p[0] + d[0], p[1] + d[1], p[2] + d[2]]),
      );
    }
    // Outside the grid the field says nothing.
    expect(mapPoint(transform, [-21, 10, 5], { from: PLANNING, to: MR })).toBeNull();
  });

  it('is a Part 10 file with what the standard requires of the object', () => {
    const dataSet = dicomParser.parseDicom(new Uint8Array(written));
    const value = (tag: string): string | undefined => dataSet.string(tag);
    expect(value('x00020002')).toBe(DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS);
    expect(value('x00080016')).toBe(DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS);
    expect(value('x00080060')).toBe('REG');
    expect(value('x00200052')).toBe(PLANNING);
    // The Enhanced General Equipment module: each with a value.
    for (const tag of ['x00080070', 'x00081090', 'x00181000', 'x00181020']) {
      expect(value(tag), tag).toBeTruthy();
    }
    // Elements in ascending order of tag, also inside the item and its grid.
    const ascending = (set: dicomParser.DataSet): void => {
      const tags = Object.values(set.elements)
        .sort((a, b) => a.dataOffset - b.dataOffset)
        .map((one) => one.tag);
      expect(tags).toEqual([...tags].sort());
    };
    ascending(dataSet);
    const item = dataSet.elements['x00640002'].items![0].dataSet!;
    ascending(item);
    expect(item.string('x00640003')).toBe(MR);
    const gridSet = item.elements['x00640005'].items![0].dataSet!;
    ascending(gridSet);
    expect([0, 1, 2].map((i) => gridSet.uint32('x00640007', i))).toEqual([...DIMS]);
    expect([0, 1, 2].map((i) => gridSet.double('x00640008', i))).toEqual([...SPACING]);
    expect(gridSet.elements['x00640009'].length).toBe(DIMS[0] * DIMS[1] * DIMS[2] * 12);
    // No matrix before the field, one after it, and the type code sequence there and empty.
    expect(item.elements['x0064000f']).toBeUndefined();
    const after = item.elements['x00640010'].items![0].dataSet!;
    expect(after.string('x0070030c')).toBe('RIGID');
    expect(item.elements['x0070030d'].items ?? []).toHaveLength(0);
    // What follows the vectors is read too.
    expect(value('x00700080')).toBe('DEFORMED');
  });

  it('writes no matrix after the field when there is none', () => {
    const plain = writeDeformableRegistration({
      registeredFrame: PLANNING,
      transforms: [planningTo(MR, grid)],
    });
    const item = dicomParser.parseDicom(new Uint8Array(plain)).elements['x00640002'].items![0];
    expect(item.dataSet!.elements['x00640010']).toBeUndefined();
    const back = parseDeformableRegistration(plain)!.registrations[0].transform;
    if (back.kind !== 'deformable') throw new Error('not a field');
    expect(back.post).toEqual(IDENTITY_MAT4);
  });

  it('holds a field to each of several frames, each read as its own', () => {
    const both = parseDeformableRegistration(
      writeDeformableRegistration({
        registeredFrame: PLANNING,
        transforms: [
          planningTo(MR, grid, post),
          planningTo(
            FOLLOW_UP,
            gridOf(() => [1, 2, 3]),
          ),
        ],
      }),
    )!;
    expect(both.unread).toEqual([]);
    expect(both.registrations.map((one) => [one.item, one.transform.to])).toEqual([
      [0, MR],
      [1, FOLLOW_UP],
    ]);
    close(
      mapPoint(both.registrations[1].transform, [0, 20, 10], { from: PLANNING, to: FOLLOW_UP }),
      [1, 22, 13],
    );
  });

  it('keeps a grid that is turned in the patient', () => {
    const turned: DeformationGrid['axes'] = [
      [0, 1, 0],
      [-1, 0, 0],
      [0, 0, 1],
    ];
    const turnedGrid = gridOf(known, turned);
    const back = parseDeformableRegistration(
      writeDeformableRegistration({
        registeredFrame: PLANNING,
        transforms: [planningTo(MR, turnedGrid)],
      }),
    )!.registrations[0].transform;
    if (back.kind !== 'deformable') throw new Error('not a field');
    back.grid.axes.forEach((axis, i) => close(axis, turned[i], 12));
    for (const p of places(turnedGrid)) {
      const d = known(p);
      close(mapPoint(back, p, { from: PLANNING, to: MR }), [p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
    }
  });

  it('keeps a point where the field is undefined as undefined', () => {
    const holed = gridOf(known);
    holed.vectors.fill(NaN, 0, 3);
    const back = parseDeformableRegistration(
      writeDeformableRegistration({
        registeredFrame: PLANNING,
        transforms: [planningTo(MR, holed)],
      }),
    )!.registrations[0].transform;
    if (back.kind !== 'deformable') throw new Error('not a field');
    expect(Array.from(back.grid.vectors.subarray(0, 3))).toEqual([NaN, NaN, NaN]);
    expect(mapPoint(back, ORIGIN, { from: PLANNING, to: MR })).toBeNull();
    close(mapPoint(back, pointOf(holed, [2, 2, 2]), { from: PLANNING, to: MR }), [
      ...pointOf(holed, [2, 2, 2]).map((c, i) => c + known(pointOf(holed, [2, 2, 2]))[i]),
    ] as unknown as Vec3);
  });
});

describe('a large field is in memory once', () => {
  const grid = gridOf(known);
  const content = { registeredFrame: PLANNING, transforms: [planningTo(MR, grid)] };

  it('is written in pieces, the vectors’ piece a window on the grid’s own array', () => {
    const parts = deformableRegistrationParts(content, { sopInstanceUid: SOP });
    const windows = parts.filter((part) => part.buffer === grid.vectors.buffer);
    expect(windows).toHaveLength(1);
    expect(windows[0].byteLength).toBe(grid.vectors.byteLength);
    // Put together, the pieces are the file.
    const whole = writeDeformableRegistration(content, {
      sopInstanceUid: SOP,
      seriesInstanceUid: '1.2.3',
      studyInstanceUid: '1.2.4',
      createdAt: new Date(2026, 0, 5),
    });
    const pieces = concat(
      deformableRegistrationParts(content, {
        sopInstanceUid: SOP,
        seriesInstanceUid: '1.2.3',
        studyInstanceUid: '1.2.4',
        createdAt: new Date(2026, 0, 5),
      }),
    );
    expect(new Uint8Array(whole)).toEqual(pieces);
  });

  it('is read as a window on the file where the vectors lie on a multiple of four bytes, and copied once where not', () => {
    // A patient ID two characters longer moves the vectors by two bytes.
    const files = ['SYN-01', 'SYN-0001'].map((patientId) =>
      writeDeformableRegistration(content, { sopInstanceUid: SOP, patientId }),
    );
    const read = files.map((file) => {
      const { transform } = parseDeformableRegistration(file)!.registrations[0];
      if (transform.kind !== 'deformable') throw new Error('not a field');
      return transform.grid.vectors;
    });
    const windowed = read.map((vectors, i) => vectors.buffer === files[i]);
    expect([...windowed].sort()).toEqual([false, true]);
    for (const vectors of read) expect(Array.from(vectors)).toEqual(Array.from(grid.vectors));
  });
});

// Files as another system may write them, put together by hand.

const matrixItem = (matrix: readonly number[], type = 'RIGID'): Uint8Array =>
  concat([
    element(0x0070, 0x030c, 'CS', text(type)),
    element(0x3006, 0x00c6, 'DS', text(matrix.join('\\'))),
  ]);

function binary(values: readonly number[], kind: 'u32' | 'f64' | 'f32'): Uint8Array {
  const width = kind === 'f64' ? 8 : 4;
  const out = new Uint8Array(values.length * width);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => {
    if (kind === 'u32') view.setUint32(i * 4, value, true);
    else if (kind === 'f64') view.setFloat64(i * 8, value, true);
    else view.setFloat32(i * 4, value, true);
  });
  return out;
}

interface GridParts {
  readonly position?: readonly number[] | null;
  readonly orientation?: readonly number[];
  readonly dims?: readonly number[];
  readonly resolution?: readonly number[];
  readonly vectors?: Float32Array;
}

function gridItem(grid: DeformationGrid, change: GridParts = {}): Uint8Array {
  const position = change.position === undefined ? grid.origin : change.position;
  return concat([
    ...(position === null ? [] : [element(0x0020, 0x0032, 'DS', text(position.join('\\')))]),
    element(
      0x0020,
      0x0037,
      'DS',
      text((change.orientation ?? [...grid.axes[0], ...grid.axes[1]]).join('\\')),
    ),
    element(0x0064, 0x0007, 'UL', binary(change.dims ?? grid.dims, 'u32')),
    element(0x0064, 0x0008, 'FD', binary(change.resolution ?? grid.spacing, 'f64')),
    element(0x0064, 0x0009, 'OF', binary(Array.from(change.vectors ?? grid.vectors), 'f32')),
  ]);
}

interface ItemParts {
  readonly frame?: string | null;
  readonly grids?: readonly Uint8Array[];
  readonly pre?: readonly (readonly number[])[];
  readonly post?: readonly (readonly number[])[];
  readonly comment?: string;
}

function item({ frame = MR, grids = [], pre = [], post = [], comment }: ItemParts): Uint8Array {
  return concat([
    ...(frame === null ? [] : [element(0x0064, 0x0003, 'UI', uid(frame))]),
    ...(grids.length > 0 ? [sequence(0x0064, 0x0005, [...grids])] : []),
    ...(pre.length > 0
      ? [
          sequence(
            0x0064,
            0x000f,
            pre.map((m) => matrixItem(m)),
          ),
        ]
      : []),
    ...(post.length > 0
      ? [
          sequence(
            0x0064,
            0x0010,
            post.map((m) => matrixItem(m)),
          ),
        ]
      : []),
    sequence(0x0070, 0x030d, []),
    ...(comment === undefined ? [] : [element(0x3006, 0x00c8, 'LO', text(comment))]),
  ]);
}

function file(
  itemsOf: readonly Uint8Array[],
  more: { sopClass?: string; frame?: string | null } = {},
): ArrayBuffer {
  const sopClass = more.sopClass ?? DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS;
  const frame = more.frame === undefined ? PLANNING : more.frame;
  return p10File(
    concat([
      element(0x0008, 0x0016, 'UI', uid(sopClass)),
      element(0x0008, 0x0018, 'UI', uid(SOP)),
      element(0x0008, 0x0060, 'CS', text('REG')),
      element(0x0010, 0x0020, 'LO', text('SYN-0001')),
      ...(frame === null ? [] : [element(0x0020, 0x0052, 'UI', uid(frame))]),
      sequence(0x0064, 0x0002, [...itemsOf]),
      element(0x0070, 0x0080, 'CS', text('DEFORMED')),
    ]),
    sopClass,
    SOP,
  );
}

describe('a deformable registration with a matrix before the field', () => {
  // The standard's equation (PS3.3 C.20.3-1): source = Post · (Pre · p + D(p)),
  // with D(p) the vector written for the grid point p of the registered frame.
  const standard = (pre: Mat4, post: Mat4, p: Vec3): Vec3 => {
    const q = transformPoint(pre, p);
    const d = known(p);
    return transformPoint(post, [q[0] + d[0], q[1] + d[1], q[2] + d[2]]);
  };
  const grid = gridOf(known);
  const post = rigidMat4([1, 0, 0], -15, [7, 8, 9]);

  it('maps as the standard’s equation says when that matrix turns', () => {
    const pre = rigidMat4([1, 2, 3], 30, [4, -5, 6]);
    const read = parseDeformableRegistration(
      file([item({ grids: [gridItem(grid)], pre: [pre], post: [post], comment: 'By hand' })]),
    )!;
    expect(read.unread).toEqual([]);
    const [{ transform, vectorsTurned, comment }] = read.registrations;
    expect(vectorsTurned).toBe(true);
    expect(comment).toBe('By hand');
    expect(transform).toMatchObject({ kind: 'deformable', from: PLANNING, to: MR });
    for (const p of places(grid)) {
      close(mapPoint(transform, p, { from: PLANNING, to: MR }), standard(pre, post, p), 3);
    }
    // The vectors are not those of the file: each was turned back by the matrix.
    if (transform.kind !== 'deformable') throw new Error('not a field');
    expect(Array.from(transform.grid.vectors)).not.toEqual(Array.from(grid.vectors));
    expect(transform.pre).toEqual(IDENTITY_MAT4);
  });

  it('keeps the vectors as written when that matrix only moves', () => {
    const pre = rigidMat4([0, 0, 1], 0, [4, -5, 6]);
    const [{ transform, vectorsTurned }] = parseDeformableRegistration(
      file([item({ grids: [gridItem(grid)], pre: [pre], post: [post] })]),
    )!.registrations;
    expect(vectorsTurned).toBe(false);
    if (transform.kind !== 'deformable') throw new Error('not a field');
    expect(Array.from(transform.grid.vectors)).toEqual(Array.from(grid.vectors));
    for (const p of places(grid)) {
      close(mapPoint(transform, p, { from: PLANNING, to: MR }), standard(pre, post, p));
    }
  });

  it('is the two matrices as one where there is no grid: no deformation', () => {
    const pre = rigidMat4([0, 0, 1], 90, [1, 0, 0]);
    const read = parseDeformableRegistration(file([item({ pre: [pre], post: [post] })]))!;
    const [{ transform }] = read.registrations;
    expect(transform).toMatchObject({ kind: 'matrix', from: PLANNING, to: MR });
    const p: Vec3 = [3, -4, 5];
    close(
      mapPoint(transform, p, { from: PLANNING, to: MR }),
      transformPoint(post, transformPoint(pre, p)),
      9,
    );
  });
});

describe('what is not read of a deformable registration', () => {
  const grid = gridOf(known);
  const problems = (buffer: ArrayBuffer) => parseDeformableRegistration(buffer)!.unread;

  it('is not one: another object, no frame, not DICOM', () => {
    expect(parseDeformableRegistration(new ArrayBuffer(16))).toBeNull();
    expect(
      parseDeformableRegistration(file([], { sopClass: SPATIAL_REGISTRATION_SOP_CLASS })),
    ).toBeNull();
    expect(parseDeformableRegistration(file([], { frame: null }))).toBeNull();
    expect(parseDeformableRegistration(file([]))).toMatchObject({
      registrations: [],
      unread: [],
    });
  });

  it('lists an item it cannot read with the reason, and reads the others', () => {
    const read = parseDeformableRegistration(
      file([
        item({ frame: null, grids: [gridItem(grid)] }),
        item({ frame: FOLLOW_UP, grids: [gridItem(grid)] }),
        item({ grids: [gridItem(grid), gridItem(grid)] }),
        item({ grids: [gridItem(grid)], pre: [IDENTITY_MAT4, IDENTITY_MAT4] }),
        item({ grids: [gridItem(grid)], post: [IDENTITY_MAT4, IDENTITY_MAT4] }),
      ]),
    )!;
    expect(read.registrations.map((one) => [one.item, one.transform.to])).toEqual([[1, FOLLOW_UP]]);
    expect(read.unread).toEqual([
      { item: 0, problem: 'no-frame' },
      { item: 2, problem: 'several' },
      { item: 3, problem: 'several' },
      { item: 4, problem: 'several' },
    ]);
  });

  it('does not take a matrix that does not place a patient', () => {
    const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(problems(file([item({ grids: [gridItem(grid)], pre: [mirror] })]))).toEqual([
      {
        item: 0,
        problem: 'invalid-matrix',
        detail: expect.stringMatching(/^The matrix before the field: /) as string,
      },
    ]);
    expect(problems(file([item({ grids: [gridItem(grid)], post: [[1, 2, 3]] })]))).toEqual([
      {
        item: 0,
        problem: 'invalid-matrix',
        detail: expect.stringMatching(/^The matrix after the field: .*16 numbers/) as string,
      },
    ]);
  });

  it('does not take a grid that is not one', () => {
    const one = (change: GridParts) =>
      problems(file([item({ grids: [gridItem(grid, change)] })]))[0];
    // More vectors promised than are there: found before anything is read by the size.
    expect(one({ dims: [5, 4, 4] })).toEqual({
      item: 0,
      problem: 'invalid-grid',
      detail: 'A grid of 5 × 4 × 4 has 960 bytes of vectors; this one has 720.',
    });
    expect(one({ dims: [4000000000, 4000000000, 4000000000] }).problem).toBe('invalid-grid');
    expect(one({ dims: [0, 4, 3], vectors: new Float32Array(0) }).problem).toBe('invalid-grid');
    expect(one({ position: null }).detail).toMatch(/one of them is missing/);
    expect(one({ resolution: [10, 0, 6] }).detail).toMatch(/positive distance/);
    expect(one({ orientation: [1, 0, 0, 1, 0, 0] }).detail).toMatch(/right angles/);
    const endless = new Float32Array(grid.vectors);
    endless[4] = Infinity;
    expect(one({ vectors: endless }).detail).toMatch(/infinite/);
  });

  it('does not take a field within the object’s own frame, and passes over an item that does nothing there', () => {
    const read = parseDeformableRegistration(
      file([
        item({ frame: PLANNING }),
        item({ frame: PLANNING, pre: [IDENTITY_MAT4], post: [IDENTITY_MAT4] }),
        item({ frame: PLANNING, grids: [gridItem(grid)] }),
        item({ frame: PLANNING, post: [rigidMat4([0, 0, 1], 0, [1, 0, 0])] }),
      ]),
    )!;
    expect(read.identityItems).toEqual([0, 1]);
    expect(read.registrations).toEqual([]);
    expect(read.unread).toEqual([
      { item: 2, problem: 'within-one-frame' },
      { item: 3, problem: 'within-one-frame' },
    ]);
  });

  it('does not read a file whose numbers are stored most significant byte first', () => {
    // Explicit VR Big Endian, by hand: tags and lengths the other way round.
    const big = (group: number, el: number, vr: string, value: Uint8Array): Uint8Array => {
      const long = vr === 'SQ';
      const head = new Uint8Array(long ? 12 : 8);
      const view = new DataView(head.buffer);
      view.setUint16(0, group, false);
      view.setUint16(2, el, false);
      head.set(ascii(vr), 4);
      if (long) view.setUint32(8, value.length, false);
      else view.setUint16(6, value.length, false);
      return concat([head, value]);
    };
    const itemHead = new Uint8Array(8);
    const body = big(0x0064, 0x0003, 'UI', uid(MR));
    new DataView(itemHead.buffer).setUint16(0, 0xfffe, false);
    new DataView(itemHead.buffer).setUint16(2, 0xe000, false);
    new DataView(itemHead.buffer).setUint32(4, body.length, false);
    const dataSet = concat([
      big(0x0008, 0x0016, 'UI', uid(DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS)),
      big(0x0008, 0x0018, 'UI', uid(SOP)),
      big(0x0020, 0x0052, 'UI', uid(PLANNING)),
      big(0x0064, 0x0002, 'SQ', concat([itemHead, body])),
    ]);
    // The file meta group is always little endian; it names the transfer syntax.
    const little = p10Head(DEFORMABLE_SPATIAL_REGISTRATION_SOP_CLASS, SOP);
    const syntax = ascii('1.2.840.10008.1.2.1');
    const at = little.findIndex((_, i) => syntax.every((c, j) => little[i + j] === c));
    expect(at).toBeGreaterThan(0);
    little[at + syntax.length - 1] = '2'.charCodeAt(0);
    const read = parseDeformableRegistration(concat([little, dataSet]).buffer as ArrayBuffer)!;
    expect(read.registeredFrame).toBe(PLANNING);
    expect(read.registrations).toEqual([]);
    expect(read.unread).toEqual([{ item: 0, problem: 'big-endian' }]);
  });
});

describe('what is not written as a deformable registration', () => {
  const grid = gridOf(known);
  const write = (transforms: DeformableTransform[], label?: string) =>
    writeDeformableRegistration({ registeredFrame: PLANNING, transforms }, { label });

  it('is in a frame, and holds a registration', () => {
    expect(() =>
      writeDeformableRegistration({ registeredFrame: '', transforms: [planningTo(MR, grid)] }),
    ).toThrow(/in a frame of reference/);
    expect(() => write([])).toThrow(/at least one/);
  });

  it('maps out of the frame the object is in, and is not turned round', () => {
    const into = deformableTransform({ id: 'd', from: MR, to: PLANNING, grid });
    expect(() => write([into])).toThrow(/maps into it, and a field is not turned round/);
    const elsewhere = deformableTransform({ id: 'd', from: MR, to: FOLLOW_UP, grid });
    expect(() => write([elsewhere])).toThrow(/maps out of another/);
    expect(() => write([planningTo(MR, grid), planningTo(MR, grid)])).toThrow(
      /one registration to each frame/,
    );
  });

  it('has no matrix before the field', () => {
    const before = deformableTransform({
      id: 'd',
      from: PLANNING,
      to: MR,
      grid,
      pre: rigidMat4([0, 0, 1], 0, [1, 0, 0]),
    });
    expect(() => write([before])).toThrow(/no matrix before it/);
  });

  it('has a grid whose third direction is the cross product of its first two', () => {
    const leftHanded = gridOf(known, [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, -1],
    ]);
    expect(() => write([planningTo(MR, leftHanded)])).toThrow(/cross product/);
  });

  it('has a content label that DICOM takes', () => {
    expect(() => write([planningTo(MR, grid)], 'much too long a label')).toThrow(/content label/);
  });
});
