/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  IDENTITY_MAT4,
  Orientation,
  f32ToF16,
  jacobianDeterminants,
  type DeformationGrid,
  type PlacementField,
  type Volume,
} from '@open-rt-studio/dicom';

import type { GpuContext } from './device.js';
import {
  DISPLACEMENT_FADE,
  DISPLACEMENT_HIGH,
  DISPLACEMENT_LOW,
  FIELD_VIEW_WGSL,
  GRID_LINE_PIXELS,
  JACOBIAN_COMPRESSION,
  JACOBIAN_EXPANSION,
  JACOBIAN_FOLD,
  displacementLegendGradient,
  displacementWash,
  fieldViewCode,
  fittingGridSpacingMm,
  foldLegendBackground,
  gridAxesInPlane,
  jacobianLegendGradient,
  jacobianTexels,
  jacobianWash,
  onGridLine,
  washOver,
} from './field-view.js';
import { PARAMS_SIZE, packSliceParams } from './slice-params.js';
import { SliceRenderer, type PaneView } from './slice-renderer.js';
import { SLICE_SHADER } from './slice-shader.js';

// What a deformation field is doing, as a wash over the image (#83): the
// colours, what the shader is told, and the determinant's texture.

/** How light a colour is: its relative luminance, the parts taken as they are shown. */
const lightness = ([r, g, b]: readonly number[]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const close = (actual: readonly number[], expected: readonly number[], digits = 6): void =>
  actual.forEach((value, i) => expect(value, `part ${i}`).toBeCloseTo(expected[i], digits));

describe('the displacement wash', () => {
  it('is nothing where nothing moves, and comes in over the first fifth of its scale', () => {
    expect(displacementWash(0, 10).alpha).toBe(0);
    expect(displacementWash(1, 10).alpha).toBeCloseTo(0.5, 9);
    expect(displacementWash(10 * DISPLACEMENT_FADE, 10).alpha).toBeCloseTo(1, 9);
    expect(displacementWash(5, 10).alpha).toBe(1);
  });

  it('is one hue from dark to light: lighter the further a place is moved', () => {
    close(displacementWash(0, 10).rgb, DISPLACEMENT_LOW);
    close(displacementWash(10, 10).rgb, DISPLACEMENT_HIGH);
    close(
      displacementWash(5, 10).rgb,
      DISPLACEMENT_LOW.map((low, i) => (low + DISPLACEMENT_HIGH[i]) / 2),
    );
    let before = -1;
    for (let mm = 0; mm <= 10; mm += 0.5) {
      const now = lightness(displacementWash(mm, 10).rgb);
      expect(now).toBeGreaterThan(before);
      before = now;
    }
  });

  it('stays at the top of its scale beyond it, and is on the scale it is given', () => {
    expect(displacementWash(25, 10)).toEqual(displacementWash(10, 10));
    expect(displacementWash(2, 4)).toEqual(displacementWash(5, 10));
    // No scale at all does not divide by nothing.
    expect(displacementWash(1, 0).alpha).toBe(1);
  });
});

describe('the Jacobian determinant wash', () => {
  it('is nothing at 1, where no volume changes', () => {
    expect(jacobianWash(1).alpha).toBe(0);
    expect(jacobianWash(1).fold).toBe(false);
  });

  it('is one colour below 1 and another above, each stronger the further from 1', () => {
    expect(jacobianWash(0.75)).toEqual({ rgb: JACOBIAN_COMPRESSION, alpha: 0.25, fold: false });
    expect(jacobianWash(0.25)).toEqual({ rgb: JACOBIAN_COMPRESSION, alpha: 0.75, fold: false });
    expect(jacobianWash(1.25)).toEqual({ rgb: JACOBIAN_EXPANSION, alpha: 0.25, fold: false });
    expect(jacobianWash(2)).toEqual({ rgb: JACOBIAN_EXPANSION, alpha: 1, fold: false });
    expect(jacobianWash(7)).toEqual({ rgb: JACOBIAN_EXPANSION, alpha: 1, fold: false });
    // As far either side of 1, as strong.
    expect(jacobianWash(0.6).alpha).toBeCloseTo(jacobianWash(1.4).alpha, 9);
  });

  it('is a third colour at full strength at or below 0, where the field folds', () => {
    expect(jacobianWash(0)).toEqual({ rgb: JACOBIAN_FOLD, alpha: 1, fold: true });
    expect(jacobianWash(-0.5)).toEqual({ rgb: JACOBIAN_FOLD, alpha: 1, fold: true });
    expect(jacobianWash(1e-6).fold).toBe(false);
    expect(JACOBIAN_FOLD).not.toEqual(JACOBIAN_COMPRESSION);
  });
});

describe('a wash over the image', () => {
  it('is the image where the wash is nothing, and the wash where it is all there', () => {
    const grey = [0.4, 0.4, 0.4] as const;
    close(washOver(grey, jacobianWash(1), 0.8), grey);
    close(washOver(grey, jacobianWash(2), 1), JACOBIAN_EXPANSION);
    // Half of a quarter: an eighth of the way to the colour.
    close(
      washOver(grey, jacobianWash(0.75), 0.5),
      grey.map((part, i) => part + (JACOBIAN_COMPRESSION[i] - part) / 8),
    );
  });
});

describe('the legends', () => {
  it('are the washes from end to end', () => {
    expect(displacementLegendGradient()).toMatch(
      /^linear-gradient\(to right, rgba\(128, 51, 5, 0\) 0%, .* rgb\(255, 222, 140\) 100%\)$/,
    );
    const jacobian = jacobianLegendGradient();
    expect(jacobian).toMatch(/^linear-gradient\(to right, rgba\(56, 135, 230, 0\.999\) 0%/);
    // Nothing in the middle, at 1.
    expect(jacobian).toContain('rgba(56, 135, 230, 0.001) 50%, rgba(214, 59, 59, 0.001) 50%');
    expect(jacobian).toMatch(/rgb\(214, 59, 59\) 100%\)$/);
    expect(foldLegendBackground()).toMatch(
      /^repeating-linear-gradient\(135deg, rgb\(237, 51, 217\) 0 4px/,
    );
  });
});

describe('the deformed grid', () => {
  it('has a line where a place is read from a whole number of spacings along an axis', () => {
    const both = [1, 1, 0];
    // 5 mm apart, lines 0.1 mm to either side.
    expect(onGridLine([10, 3, 7], both, 5, 0.1)).toBe(true);
    expect(onGridLine([10.09, 3, 7], both, 5, 0.1)).toBe(true);
    expect(onGridLine([9.91, 3, 7], both, 5, 0.1)).toBe(true);
    expect(onGridLine([10.11, 3, 7], both, 5, 0.1)).toBe(false);
    expect(onGridLine([12.5, 3, 7], both, 5, 0.1)).toBe(false);
    // Along the second axis too; at the image's corner; and before it.
    expect(onGridLine([12.5, 15, 7], both, 5, 0.1)).toBe(true);
    expect(onGridLine([0.05, 2, 7], both, 5, 0.1)).toBe(true);
    expect(onGridLine([-5.05, 2, 7], both, 5, 0.1)).toBe(true);
  });

  it('has no lines for the axis through the pane’s plane, and none without a spacing', () => {
    // 20 mm along the third axis would be a line, were that axis drawn.
    expect(onGridLine([12.5, 3, 20], [1, 1, 0], 5, 0.1)).toBe(false);
    expect(onGridLine([12.5, 3, 20], [1, 0, 1], 5, 0.1)).toBe(true);
    expect(onGridLine([10, 15, 20], [1, 1, 1], 0, 0.1)).toBe(false);
  });

  it('draws the two axes that lie most in a pane’s plane', () => {
    // An axial pane of an image that lies straight: a step through it goes along the third axis.
    expect(gridAxesInPlane([0, 0, 24])).toEqual([1, 1, 0]);
    expect(gridAxesInPlane([0, -32, 0])).toEqual([1, 0, 1]);
    expect(gridAxesInPlane([32, 0, 0])).toEqual([0, 1, 1]);
    // Tilted: the axis the step goes furthest along is the one left out.
    expect(gridAxesInPlane([3, -20, 9])).toEqual([1, 0, 1]);
  });

  it('fits a spacing to an image: about an eighth of its longest side, as 1, 2 or 5 times a power of ten', () => {
    expect(fittingGridSpacingMm([32, 32, 12])).toBe(5);
    expect(fittingGridSpacingMm([400, 400, 300])).toBe(50);
    expect(fittingGridSpacingMm([150, 100, 80])).toBe(20);
    expect(fittingGridSpacingMm([14, 9, 3])).toBe(2);
    // As near one as the other: the finer.
    expect(fittingGridSpacingMm([12, 9, 3])).toBe(1);
    expect(fittingGridSpacingMm([6, 6, 6])).toBeCloseTo(0.5, 9);
    expect(fittingGridSpacingMm([0, 0, 0])).toBe(1);
    expect(fittingGridSpacingMm([Number.NaN, 1, 1])).toBe(1);
  });

  it('is the same arithmetic in the shader, drawn where the field has a vector', () => {
    expect(FIELD_VIEW_WGSL).toContain('let cell = mm / spacing;');
    expect(FIELD_VIEW_WGSL).toContain('let off = abs(cell - round(cell)) * spacing;');
    expect(FIELD_VIEW_WGSL).toContain(
      'return any((off < vec3<f32>(halfWidth)) & (axes > vec3<f32>(0.5)));',
    );
    expect(FIELD_VIEW_WGSL).toContain('mix(rgb, vec3<f32>(0.4000, 0.9500, 0.8500), 0.8500)');
    expect(SLICE_SHADER).toContain('if (P.fieldOn != 0u && P.fieldGridSpacing > 0.0 && mapped) {');
    // Read where the overlay is read: its own matrix, and the field's displacement.
    expect(SLICE_SHADER).toMatch(
      /let read = \(P\.overlayToTex \* vec4<f32>\(u, plane\.y, P\.slicePos, 1\.0\)\)\.xyz\s+\+ \(P\.fieldToOverlay \* vec4<f32>\(moved\.xyz, 0\.0\)\)\.xyz;/,
    );
  });
});

describe('the shader’s washes', () => {
  it('are made from the same numbers as the functions here', () => {
    expect(FIELD_VIEW_WGSL).toContain(
      'mix(vec3<f32>(0.5000, 0.2000, 0.0200), vec3<f32>(1.0000, 0.8700, 0.5500), t)',
    );
    expect(FIELD_VIEW_WGSL).toContain('clamp(t / 0.2000, 0.0, 1.0)');
    expect(FIELD_VIEW_WGSL).toContain(
      'vec4<f32>(vec3<f32>(0.2200, 0.5300, 0.9000), 1.0 - determinant)',
    );
    expect(FIELD_VIEW_WGSL).toContain(
      'vec4<f32>(vec3<f32>(0.8400, 0.2300, 0.2300), clamp(determinant - 1.0, 0.0, 1.0))',
    );
    expect(FIELD_VIEW_WGSL).toContain(
      'vec3<f32>(0.9300, 0.2000, 0.8500) * select(1.0, 0.4500, stripe >= 1.0)',
    );
  });

  it('are in the slice shader, which reads the determinant only where the field has a vector', () => {
    expect(SLICE_SHADER).toContain(FIELD_VIEW_WGSL);
    expect(SLICE_SHADER).toContain('@group(0) @binding(9) var jacobianTex : texture_3d<f32>;');
    expect(SLICE_SHADER).toContain('if (P.fieldOn != 0u && P.fieldView != 0u && mapped) {');
    // A fold is drawn as it is, not mixed in by the wash's opacity.
    expect(SLICE_SHADER).toMatch(/if \(jacobian\.r <= 0\.0\) \{\s+rgb = fieldFold\(in\.pos\.xy\);/);
  });

  it('have a code each', () => {
    expect(
      ['none', 'displacement', 'jacobian'].map((kind) => fieldViewCode(kind as 'none')),
    ).toEqual([0, 1, 2]);
  });
});

describe('the texels of a determinant texture', () => {
  it('are each determinant and 1, as half floats, and nothing with 0 where there is none', () => {
    const texels = jacobianTexels(Float32Array.from([1, 0.5, NaN, -0.25]));
    const [one, half, minus] = [f32ToF16(1), f32ToF16(0.5), f32ToF16(-0.25)];
    expect([...texels]).toEqual([one, one, half, one, 0, 0, minus, one]);
  });

  it('hold a determinant no half float can at ±1000', () => {
    const texels = jacobianTexels(Float32Array.from([1e9, -1e9, Infinity]));
    expect([texels[0], texels[2], texels[4]]).toEqual([
      f32ToF16(1000),
      f32ToF16(-1000),
      f32ToF16(1000),
    ]);
  });
});

describe('packSliceParams with a field view', () => {
  const field = {
    toTex: new Array<number>(16).fill(0),
    toOverlay: new Array<number>(16).fill(0),
    low: [0, 0, 0] as const,
    high: [1, 1, 1] as const,
  };
  const pane = {
    matrix: new Array<number>(16).fill(0),
    scaleX: 1,
    scaleY: 1,
    pan: { x: 0, y: 0 },
    windowCenter: 40,
    windowWidth: 400,
    slicePos: 0.5,
    flipX: false,
    invert: false,
    colormapBase: false,
    mask: null,
  };
  const overlay = {
    matrix: new Array<number>(16).fill(0),
    windowCenter: 0,
    windowWidth: 1,
    opacity: 0.5,
    colormap: false,
    checkerboard: false,
    checkerSize: 8,
  };

  it('packs the view after the field’s bounds: its code at float 107, then its scale and opacity', () => {
    const buffer = packSliceParams({
      ...pane,
      overlay: { ...overlay, field: { ...field, view: { code: 2, scaleMm: 12.5, opacity: 0.75 } } },
    });
    expect(buffer.byteLength).toBe(PARAMS_SIZE);
    expect(new Uint32Array(buffer)[107]).toBe(2);
    expect([...new Float32Array(buffer).slice(108, 112)]).toEqual([12.5, 0.75, 0, 0]);
  });

  it('packs the grid after the view: its spacing and half width, then the overlay’s size and its axes', () => {
    const buffer = packSliceParams({
      ...pane,
      overlay: {
        ...overlay,
        field: {
          ...field,
          grid: { spacingMm: 5, halfWidthMm: 0.25, sizeMm: [32, 30, 12], axes: [1, 0, 1] },
        },
      },
    });
    const floats = new Float32Array(buffer);
    expect([...floats.slice(110, 112)]).toEqual([5, 0.25]);
    expect([...floats.slice(112, 115)]).toEqual([32, 30, 12]);
    expect([...floats.slice(116, 119)]).toEqual([1, 0, 1]);
    // No view with it: the view's code stays off.
    expect(new Uint32Array(buffer)[107]).toBe(0);
    // And no grid without one.
    const none = new Float32Array(packSliceParams({ ...pane, overlay: { ...overlay, field } }));
    expect([...none.slice(110, 120)]).toEqual(new Array(10).fill(0));
  });

  it('leaves the view off without one, and without a field', () => {
    for (const given of [{ ...field, view: null }, field, null]) {
      const buffer = packSliceParams({ ...pane, overlay: { ...overlay, field: given } });
      expect(new Uint32Array(buffer)[107]).toBe(0);
      expect([...new Float32Array(buffer).slice(108, 112)]).toEqual([0, 0, 0, 0]);
    }
  });
});

describe('SliceRenderer with a field view', () => {
  beforeAll(() => {
    vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 });
    vi.stubGlobal('GPUTextureUsage', { COPY_DST: 2, TEXTURE_BINDING: 4 });
  });
  afterAll(() => vi.unstubAllGlobals());

  interface Made {
    readonly format: string;
    readonly size: unknown;
    destroyed: boolean;
    written: ArrayBufferView | null;
  }

  function fakeGpu() {
    /** Of each pane drawn: `fieldView` (u32 at float 107), its scale and its opacity. */
    const panes: { view: number; scaleMm: number; opacity: number }[] = [];
    /** Of each pane drawn: the grid's spacing and half width, the overlay's size and the axes drawn. */
    const grids: { spacingMm: number; halfWidthMm: number; sizeMm: number[]; axes: number[] }[] =
      [];
    const textures: Made[] = [];
    /** What is bound at binding 9 by each bind group made, newest last. */
    const bound: { of: Made }[] = [];
    const pass = {
      setPipeline: () => undefined,
      setViewport: () => undefined,
      setScissorRect: () => undefined,
      setBindGroup: () => undefined,
      setVertexBuffer: () => undefined,
      setIndexBuffer: () => undefined,
      draw: () => undefined,
      drawIndexed: () => undefined,
      end: () => undefined,
    };
    const device = {
      limits: { maxTextureDimension3D: 2048 },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createSampler: () => ({}),
      createBindGroup: (given: { entries: { binding: number; resource: unknown }[] }) => {
        const entry = given.entries.find((one) => one.binding === 9);
        if (entry) bound.push(entry.resource as { of: Made });
        return {};
      },
      createBuffer: () => ({ destroy: () => undefined }),
      createTexture: (given: { format: string; size: unknown }) => {
        const made: Made = {
          format: given.format,
          size: given.size,
          destroyed: false,
          written: null,
        };
        textures.push(made);
        return {
          made,
          createView: () => ({ of: made }),
          destroy: () => {
            made.destroyed = true;
          },
        };
      },
      queue: {
        writeBuffer: (_buffer: unknown, _offset: number, data: ArrayBuffer | ArrayBufferView) => {
          if (data.byteLength !== PARAMS_SIZE) return;
          const bytes = ArrayBuffer.isView(data)
            ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            : data;
          const floats = new Float32Array(bytes);
          panes.push({
            view: new Uint32Array(bytes)[107],
            scaleMm: floats[108],
            opacity: floats[109],
          });
          grids.push({
            spacingMm: floats[110],
            halfWidthMm: floats[111],
            sizeMm: [...floats.slice(112, 115)],
            axes: [...floats.slice(116, 119)],
          });
        },
        writeTexture: (to: { texture: { made: Made } }, data: ArrayBufferView) => {
          to.texture.made.written = data;
        },
        submit: () => undefined,
      },
      createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
    };
    const gpu = {
      device,
      format: 'bgra8unorm',
      canvas: { width: 200, height: 100 },
      context: { getCurrentTexture: () => ({ createView: () => ({}) }) },
    } as unknown as GpuContext;
    const jacobians = (): Made[] => textures.filter((one) => one.format === 'rg16float');
    return { gpu, panes, grids, jacobians, bound };
  }

  function volume(dims: [number, number, number]): Volume {
    return {
      dims,
      spacing: [1, 1, 1],
      data: new Float32Array(dims[0] * dims[1] * dims[2]),
      min: 0,
      max: 0,
      windowCenter: 0,
      windowWidth: 1,
      rescaleSlope: 1,
      rescaleIntercept: 0,
      modality: 'CT',
      geometry: { iStep: [1, 0, 0], jStep: [0, 1, 0], kStep: [0, 0, 1], origin: [0, 0, 0] },
    };
  }

  /** A field that squeezes to a half along x: its determinant is 0.5 at every vector. */
  function squeeze(): DeformationGrid {
    const dims = [3, 2, 2] as const;
    const vectors = new Float32Array(3 * 2 * 2 * 3);
    for (let n = 0; n < 12; n++) vectors[n * 3] = -0.5 * (n % 3) * 4;
    return {
      dims,
      origin: [0, 0, 0],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      spacing: [4, 4, 2],
      vectors,
    };
  }

  const AXIAL: PaneView = {
    kind: 'mpr',
    orientation: Orientation.Axial,
    sliceIndex: 1,
    windowCenter: 0,
    windowWidth: 1,
    zoom: 1,
    rect: { x: 0, y: 0, width: 100, height: 100 },
  };
  const base = volume([8, 8, 4]);
  const overlay = volume([6, 6, 2]);
  const field: PlacementField = { pre: IDENTITY_MAT4, grid: squeeze(), post: IDENTITY_MAT4 };

  function setup() {
    const fake = fakeGpu();
    const renderer = new SliceRenderer(fake.gpu);
    renderer.setVolume(base);
    renderer.setOverlay(overlay, 0.5, undefined, IDENTITY_MAT4, field);
    const drawn = () => {
      fake.panes.length = 0;
      renderer.renderPanes([AXIAL]);
      expect(fake.panes).toHaveLength(1);
      return fake.panes[0];
    };
    return { ...fake, renderer, drawn };
  }

  const determinants = jacobianDeterminants(field.grid, field.pre, field.post);
  const jacobianView = { kind: 'jacobian', maxMm: 8, opacity: 0.5 } as const;

  it('shows nothing of the field until asked', () => {
    const { drawn, jacobians } = setup();
    expect(drawn().view).toBe(0);
    expect(jacobians()).toHaveLength(0);
  });

  it('tells the shader the displacement wash, its scale and its opacity, with no determinant made', () => {
    const { renderer, drawn, jacobians } = setup();
    renderer.setFieldView({ kind: 'displacement', maxMm: 8, opacity: 0.25 });
    expect(drawn()).toEqual({ view: 1, scaleMm: 8, opacity: 0.25 });
    expect(jacobians()).toHaveLength(0);
  });

  it('uploads the field’s determinant as it is given with the wash, and binds it', () => {
    const { renderer, drawn, jacobians, bound } = setup();
    renderer.setFieldView(jacobianView, determinants);
    const [made] = jacobians();
    expect(made.size).toEqual({ width: 3, height: 2, depthOrArrayLayers: 2 });
    const expected = jacobianTexels(determinants);
    expect([...(made.written as Uint16Array)]).toEqual([...expected]);
    expect(expected[0]).toBe(f32ToF16(0.5));
    expect(bound.at(-1)!.of).toBe(made);
    expect(drawn()).toEqual({ view: 2, scaleMm: 8, opacity: 0.5 });

    // The same numbers with another opacity: not uploaded again.
    renderer.setFieldView({ ...jacobianView, opacity: 0.9 }, determinants);
    expect(jacobians()).toHaveLength(1);
    expect(made.destroyed).toBe(false);
    expect(drawn().opacity).toBeCloseTo(0.9, 6);
  });

  it('shows no determinant wash without the numbers, or with those of another grid', () => {
    const { renderer, drawn, jacobians } = setup();
    renderer.setFieldView(jacobianView);
    expect(jacobians()).toHaveLength(0);
    expect(drawn().view).toBe(0);
    renderer.setFieldView(jacobianView, new Float32Array(5));
    expect(jacobians()).toHaveLength(0);
    expect(drawn().view).toBe(0);
  });

  it('lets go of the determinant when another wash is shown', () => {
    const { renderer, drawn, jacobians, bound } = setup();
    renderer.setFieldView(jacobianView, determinants);
    const [made] = jacobians();
    renderer.setFieldView({ kind: 'displacement', maxMm: 8, opacity: 0.5 }, determinants);
    expect(made.destroyed).toBe(true);
    expect(bound.at(-1)!.of).not.toBe(made);
    expect(drawn().view).toBe(1);
  });

  it('takes another field’s determinant in whichever order the two arrive', () => {
    // A field of another grid, and its numbers.
    const wider: DeformationGrid = {
      ...squeeze(),
      dims: [3, 2, 1],
      vectors: squeeze().vectors.slice(0, 18),
    };
    const other: PlacementField = { ...field, grid: wider };
    const otherDeterminants = jacobianDeterminants(wider);

    // The field first: the old numbers are not its own, and are let go of.
    const one = setup();
    one.renderer.setFieldView(jacobianView, determinants);
    one.renderer.setOverlay(overlay, 0.5, undefined, IDENTITY_MAT4, other);
    expect(one.jacobians()[0].destroyed).toBe(true);
    expect(one.drawn().view).toBe(0);
    one.renderer.setFieldView(jacobianView, otherDeterminants);
    expect(one.jacobians()).toHaveLength(2);
    expect(one.jacobians()[1].size).toEqual({ width: 3, height: 2, depthOrArrayLayers: 1 });
    expect(one.bound.at(-1)!.of).toBe(one.jacobians()[1]);
    expect(one.drawn().view).toBe(2);

    // The numbers first: kept until the field they are of is there.
    const two = setup();
    two.renderer.setFieldView(jacobianView, determinants);
    two.renderer.setFieldView(jacobianView, otherDeterminants);
    expect(two.jacobians()[0].destroyed).toBe(true);
    expect(two.drawn().view).toBe(0);
    two.renderer.setOverlay(overlay, 0.5, undefined, IDENTITY_MAT4, other);
    expect(two.jacobians()).toHaveLength(2);
    expect(two.bound.at(-1)!.of).toBe(two.jacobians()[1]);
    expect(two.drawn().view).toBe(2);
  });

  it('draws the deformed grid when given a spacing: lines a set number of pixels wide, for the axes in the pane', () => {
    const { renderer, grids } = setup();
    const gridOf = (view: PaneView) => {
      grids.length = 0;
      renderer.renderPanes([view]);
      return grids[0];
    };
    expect(gridOf(AXIAL).spacingMm).toBe(0);

    renderer.setFieldGrid(5);
    const axial = gridOf(AXIAL);
    expect(axial.spacingMm).toBe(5);
    // The overlay is 6 × 6 × 2 voxels of 1 mm.
    expect(axial.sizeMm).toEqual([6, 6, 2]);
    expect(axial.axes).toEqual([1, 1, 0]);
    // The base's 8 mm across 100 pixels: a line of 1.5 pixels is 0.06 mm to either side.
    expect(axial.halfWidthMm).toBeCloseTo((GRID_LINE_PIXELS / 2) * 0.08, 6);
    // Zoomed in twice, a pixel is half as much of the image.
    expect(gridOf({ ...AXIAL, zoom: 2 } as PaneView).halfWidthMm).toBeCloseTo(
      (GRID_LINE_PIXELS / 2) * 0.04,
      6,
    );
    expect(gridOf({ ...AXIAL, orientation: Orientation.Coronal } as PaneView).axes).toEqual([
      1, 0, 1,
    ]);
    expect(gridOf({ ...AXIAL, orientation: Orientation.Sagittal } as PaneView).axes).toEqual([
      0, 1, 1,
    ]);

    // No length is no grid; and there is none without a field.
    renderer.setFieldGrid(0);
    expect(gridOf(AXIAL).spacingMm).toBe(0);
    renderer.setFieldGrid(5);
    renderer.setOverlay(overlay, 0.5, undefined, IDENTITY_MAT4, null);
    expect(gridOf(AXIAL).spacingMm).toBe(0);
  });

  it('lets go of the determinant with the field, and shows it again with the field', () => {
    const { renderer, drawn, jacobians, bound } = setup();
    renderer.setFieldView(jacobianView, determinants);
    const [made] = jacobians();
    // The same image by its matrices alone.
    renderer.setOverlay(overlay, 0.5, undefined, IDENTITY_MAT4, null);
    expect(made.destroyed).toBe(true);
    expect(bound.at(-1)!.of).not.toBe(made);
    expect(drawn().view).toBe(0);
    // The field again: its wash is back, from the numbers that were given.
    renderer.setOverlay(overlay, 0.5, undefined, IDENTITY_MAT4, field);
    expect(jacobians()).toHaveLength(2);
    expect(drawn().view).toBe(2);
  });
});
