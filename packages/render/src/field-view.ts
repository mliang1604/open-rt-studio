/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { f32ToF16 } from '@open-rt-studio/dicom';

// What a deformation field is doing, as a colour wash over the image (#83).
//
// Two washes, one at a time:
//
// - **Displacement**: how far the field moves each place, in mm. A magnitude,
//   so one hue: orange, from dark to light as the displacement grows, and
//   fading out towards nothing so that where little moves the image shows.
// - **Jacobian determinant**: the factor by which the field changes a small
//   volume. It has two sides about 1, so two hues with nothing between them:
//   blue for compression (below 1), red for expansion (above 1), each
//   stronger the further from 1 and gone at 1. **At or below 0 the field
//   folds**, which is another kind of thing and not more compression: it is
//   magenta with dark stripes, at full strength whatever the wash's opacity,
//   so that it is not told by its hue alone and is not faded away.
//
// And over either wash or none, **the deformed grid**: a regular grid of the
// compared image, drawn where the field puts it in the base image's planes.
// A place of the base is on a line when the place it is read from in the
// compared image is a whole number of spacings along one of that image's
// axes, counted from the image's corner. Where the field moves nothing the
// lines are straight and evenly apart; where it squeezes they crowd, where
// it stretches they part, and where it folds they cross. Only the two axes
// that lie most in the pane's plane are drawn: the third would paint whole
// regions, not lines.
//
// The colours are worked out by the slice shader. The functions here do the
// same arithmetic on the CPU, for the legends and the tests; the shader's
// text is made from the same constants ({@link FIELD_VIEW_WGSL}), so the two
// cannot drift apart in their numbers.

/** What of the field is washed over the image. */
export type FieldViewKind = 'none' | 'displacement' | 'jacobian';

/** How the field is shown. */
export interface FieldView {
  readonly kind: FieldViewKind;
  /** The displacement at which the displacement wash is at the top of its scale, in mm. */
  readonly maxMm: number;
  /** How strongly the wash is laid over the image, 0 to 1. */
  readonly opacity: number;
}

export const NO_FIELD_VIEW: FieldView = { kind: 'none', maxMm: 10, opacity: 0.6 };

/** The shader's code for a kind of view. */
export function fieldViewCode(kind: FieldViewKind): number {
  switch (kind) {
    case 'none':
      return 0;
    case 'displacement':
      return 1;
    case 'jacobian':
      return 2;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

type Rgb = readonly [number, number, number];

/** The displacement wash at nothing and at the top of its scale: one hue, dark to light. */
export const DISPLACEMENT_LOW: Rgb = [0.5, 0.2, 0.02];
export const DISPLACEMENT_HIGH: Rgb = [1, 0.87, 0.55];
/** The part of the scale over which the displacement wash comes in from nothing. */
export const DISPLACEMENT_FADE = 0.2;
/** Compression, expansion, and a fold. */
export const JACOBIAN_COMPRESSION: Rgb = [0.22, 0.53, 0.9];
export const JACOBIAN_EXPANSION: Rgb = [0.84, 0.23, 0.23];
export const JACOBIAN_FOLD: Rgb = [0.93, 0.2, 0.85];
/** A fold's stripes: their width in framebuffer pixels, and how dark the dark ones are. */
export const FOLD_STRIPE_PIXELS = 4;
export const FOLD_STRIPE_SHADE = 0.45;
/** The largest determinant a texel holds, either way: a half float has no more to give. */
const DETERMINANT_LIMIT = 1000;

/** The deformed grid's lines: their colour, how much of it, and their width in framebuffer pixels. */
export const GRID_COLOUR: Rgb = [0.4, 0.95, 0.85];
export const GRID_STRENGTH = 0.85;
export const GRID_LINE_PIXELS = 1.5;

/** A colour and how much of it is laid over what is beneath, before the wash's own opacity. */
export interface Wash {
  readonly rgb: Rgb;
  readonly alpha: number;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The displacement wash for a displacement of `mm` on a scale that tops out at `maxMm`. */
export function displacementWash(mm: number, maxMm: number): Wash {
  const t = clamp01(mm / Math.max(maxMm, 1e-6));
  return {
    rgb: mix(DISPLACEMENT_LOW, DISPLACEMENT_HIGH, t),
    alpha: clamp01(t / DISPLACEMENT_FADE),
  };
}

/** The Jacobian wash for a determinant; `fold` when it is at or below 0. */
export function jacobianWash(determinant: number): Wash & { readonly fold: boolean } {
  if (determinant <= 0) return { rgb: JACOBIAN_FOLD, alpha: 1, fold: true };
  if (determinant < 1) return { rgb: JACOBIAN_COMPRESSION, alpha: 1 - determinant, fold: false };
  return { rgb: JACOBIAN_EXPANSION, alpha: clamp01(determinant - 1), fold: false };
}

/** A colour over another: what the shader's `mix` gives. */
export function washOver(beneath: Rgb, wash: Wash, opacity: number): Rgb {
  return mix(beneath, wash.rgb, clamp01(wash.alpha * opacity));
}

/** A colour as CSS writes it back: `rgb()` when all of it is there, so that a style reads as it was set. */
const css = (rgb: Rgb, alpha: number): string => {
  const parts = rgb.map((part) => Math.round(part * 255)).join(', ');
  return alpha >= 1 ? `rgb(${parts})` : `rgba(${parts}, ${Number(alpha.toFixed(3))})`;
};

/** The displacement wash from nothing to the top of its scale, as a CSS gradient for a legend. */
export function displacementLegendGradient(): string {
  const stops = [0, DISPLACEMENT_FADE / 2, DISPLACEMENT_FADE, 0.4, 0.6, 0.8, 1].map((t) => {
    const { rgb, alpha } = displacementWash(t, 1);
    return `${css(rgb, alpha)} ${Math.round(t * 100)}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** The Jacobian wash from just above 0 to 2, as a CSS gradient for a legend. */
export function jacobianLegendGradient(): string {
  const stops = [0.001, 0.5, 0.999, 1.001, 1.5, 2].map((value) => {
    const { rgb, alpha } = jacobianWash(value);
    return `${css(rgb, alpha)} ${Math.round(value * 50)}%`;
  });
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** A fold as a legend's swatch shows it: striped, as the shader stripes it. */
export function foldLegendBackground(): string {
  const dark = JACOBIAN_FOLD.map((part) => part * FOLD_STRIPE_SHADE) as unknown as Rgb;
  const [w, w2] = [FOLD_STRIPE_PIXELS, FOLD_STRIPE_PIXELS * 2];
  return `repeating-linear-gradient(135deg, ${css(JACOBIAN_FOLD, 1)} 0 ${w}px, ${css(dark, 1)} ${w}px ${w2}px)`;
}

/**
 * A spacing for the deformed grid that fits an image: about an eighth of its
 * longest side, as 1, 2 or 5 times a power of ten millimetres.
 */
export function fittingGridSpacingMm(extentMm: readonly number[]): number {
  const longest = Math.max(...extentMm.map(Math.abs));
  if (!(longest > 0) || !Number.isFinite(longest)) return 1;
  const rough = longest / 8;
  const power = 10 ** Math.floor(Math.log10(rough));
  const steps = [1, 2, 5, 10].map((step) => step * power);
  return steps.reduce((best, step) =>
    Math.abs(step - rough) < Math.abs(best - rough) ? step : best,
  );
}

/**
 * Which of the compared image's three axes the deformed grid draws lines
 * for in a pane: the two that lie most in the pane's plane. `throughPlaneMm`
 * is how far a step through the pane's plane goes along each of the image's
 * axes, in mm; the axis it goes furthest along is the one left out.
 */
export function gridAxesInPlane(throughPlaneMm: readonly number[]): [number, number, number] {
  const sizes = throughPlaneMm.map(Math.abs);
  const out = sizes.indexOf(Math.max(...sizes));
  return [out === 0 ? 0 : 1, out === 1 ? 0 : 1, out === 2 ? 0 : 1];
}

/**
 * Whether a place is on a line of the deformed grid: `mm` is where it is
 * read from in the compared image, in mm from that image's corner along its
 * axes; `axes` says which axes have lines (see {@link gridAxesInPlane}). On a
 * line when within `halfWidthMm` of a whole number of spacings along one of
 * them. The shader's `onGridLine` is the same arithmetic.
 */
export function onGridLine(
  mm: readonly number[],
  axes: readonly number[],
  spacingMm: number,
  halfWidthMm: number,
): boolean {
  if (!(spacingMm > 0)) return false;
  return mm.some((along, axis) => {
    if (axes[axis] === 0) return false;
    const cell = along / spacingMm;
    return Math.abs(cell - Math.round(cell)) * spacingMm < halfWidthMm;
  });
}

const vec3 = (rgb: Rgb): string => `vec3<f32>(${rgb.map((part) => part.toFixed(4)).join(', ')})`;

/**
 * The washes as the slice shader works them out: a colour in `rgb` and how
 * much of it in `a`, before the wash's opacity. `fieldFold` gives a fold's
 * colour at a framebuffer position, striped.
 */
export const FIELD_VIEW_WGSL = /* wgsl */ `
fn displacementWash(mm : f32, maxMm : f32) -> vec4<f32> {
  let t = clamp(mm / max(maxMm, 1e-6), 0.0, 1.0);
  let rgb = mix(${vec3(DISPLACEMENT_LOW)}, ${vec3(DISPLACEMENT_HIGH)}, t);
  return vec4<f32>(rgb, clamp(t / ${DISPLACEMENT_FADE.toFixed(4)}, 0.0, 1.0));
}

fn jacobianWash(determinant : f32) -> vec4<f32> {
  if (determinant < 1.0) {
    return vec4<f32>(${vec3(JACOBIAN_COMPRESSION)}, 1.0 - determinant);
  }
  return vec4<f32>(${vec3(JACOBIAN_EXPANSION)}, clamp(determinant - 1.0, 0.0, 1.0));
}

fn fieldFold(pos : vec2<f32>) -> vec3<f32> {
  let stripe = floor((pos.x + pos.y) / ${FOLD_STRIPE_PIXELS.toFixed(1)}) % 2.0;
  return ${vec3(JACOBIAN_FOLD)} * select(1.0, ${FOLD_STRIPE_SHADE.toFixed(4)}, stripe >= 1.0);
}

// Whether a place read from mm of the compared image (from its corner, along
// its axes) is on a line of the grid; an axis with 0 in axes has none.
fn onGridLine(mm : vec3<f32>, axes : vec3<f32>, spacing : f32, halfWidth : f32) -> bool {
  let cell = mm / spacing;
  let off = abs(cell - round(cell)) * spacing;
  return any((off < vec3<f32>(halfWidth)) & (axes > vec3<f32>(0.5)));
}

fn gridOver(rgb : vec3<f32>) -> vec3<f32> {
  return mix(rgb, ${vec3(GRID_COLOUR)}, ${GRID_STRENGTH.toFixed(4)});
}
`;

/** Floats to a texel of a determinant texture: the determinant and whether there is one. */
export const JACOBIAN_CHANNELS = 2;

/**
 * The texels of a field's Jacobian determinant texture: for each vector of
 * the grid its determinant as a half float, and 1 in the second channel. A
 * vector with no determinant (NaN) is written as nothing with 0 in the
 * second channel, so that read between texels the second channel is below 1
 * wherever such a vector has a part in what is read. A determinant beyond
 * ±1000 is held at that.
 */
export function jacobianTexels(determinants: Float32Array): Uint16Array {
  const texels = new Uint16Array(determinants.length * JACOBIAN_CHANNELS);
  const one = f32ToF16(1);
  for (let i = 0; i < determinants.length; i++) {
    const value = determinants[i];
    if (Number.isNaN(value)) continue; // left as zeros
    texels[i * 2] = f32ToF16(Math.min(DETERMINANT_LIMIT, Math.max(-DETERMINANT_LIMIT, value)));
    texels[i * 2 + 1] = one;
  }
  return texels;
}
