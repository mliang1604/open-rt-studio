/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FIELD_VIEW_WGSL } from './field-view.js';

/**
 * WGSL for rendering a single planar slice out of a 3D volume texture, with a
 * DICOM window/level transform. The same shader serves axial, coronal and
 * sagittal views: a per-pane `planeToTex` affine (built in `reslice.ts` from the
 * volume's patient-space geometry) maps the pane's (u, v, slicePos) to texture
 * coordinates, so the anatomical plane is correct regardless of how the series
 * was acquired (axial, sagittal, coronal, or oblique/gantry-tilted).
 *
 * Kept as a string constant (rather than a `.wgsl` asset) because Angular's
 * esbuild-based builder has no `?raw` text loader. The `language=wgsl` hint
 * lets editors syntax-highlight the literal.
 */
/**
 * What a texel holds for a voxel whose value is not known (`Volume.known`:
 * a summed dose, #98): a number far below anything an image or a dose has,
 * and within a half float's reach. Read between voxels, a sample with any
 * share of it worth the name is far below every window's low end.
 */
export const UNKNOWN_TEXEL = -65000;

/**
 * Below this, a sample of an overlay is of a voxel that is not known, more
 * than of any other: the shader draws nothing there. Lower than any stored
 * value a CT has, its padding included.
 */
export const UNKNOWN_TEXEL_BELOW = -40000;

// language=wgsl
export const SLICE_SHADER = /* wgsl */ `
struct Params {
  planeToTex : mat4x4<f32>, // (u, v, slicePos, 1) -> texture coord, patient-aware
  scale : vec2<f32>,        // aspect-fit: centered uv is multiplied by this
  pan : vec2<f32>,          // screen-uv translation of the slice (drag-to-pan)
  windowCenter : f32,
  windowWidth : f32,
  slicePos : f32,           // normalized position along the slicing axis, 0..1
  flipX : u32,              // non-zero mirrors the in-plane horizontal axis
  invert : u32,             // non-zero inverts the windowed gray (display inversion)
  // Filling the mat4x4-alignment padding before overlayToTex (floats 25..27):
  overlayMode : u32,         // 0: blend the overlay over the base by its opacity;
                             // 1: alternate base/overlay per checker cell;
                             // 2: the overlay by itself, the base not shown (the
                             //    Compare column of an overlay placed by a registration)
  checkerSize : f32,         // checker cell size in framebuffer pixels
  colormapBase : u32,        // non-zero: map the windowed BASE value through overlayLut
                             // (the standalone Compare overlay column; no compositing)
  // Fusion overlay: a second volume sharing the patient frame but its own grid.
  // overlayToTex maps the SAME pane (u, v, slicePos) into the overlay's texture
  // coords; the overlay is windowed and composited over the base by overlayOpacity
  // (0 = no overlay). mat4x4 alignment lands this block at byte 112.
  overlayToTex : mat4x4<f32>,
  overlayWindowCenter : f32,
  overlayWindowWidth : f32,
  overlayOpacity : f32,
  overlayColormap : u32,    // non-zero: map the windowed overlay through overlayLut
  // Label mask: an authored-segmentation volume aligned to the BASE grid (same
  // dims/spacing/geometry), so maskToTex equals the base reslice affine. Sampled
  // NEAREST (ids must not be interpolated) and coloured per-ROI through maskLut;
  // a SEPARATE binding from the fusion overlay so the label colouring never fights
  // the overlay's windowing/colormap path. id 0 = background (transparent);
  // maskOpacity 0 disables the layer. mat4x4 alignment lands this block at byte 192.
  maskToTex : mat4x4<f32>,
  maskOpacity : f32,
  maskLutSize : f32,        // texel count of maskLut, to map an id to its LUT coord
  // Deformation field of the registration that places the overlay (fieldOn 0:
  // none). fieldToTex maps the SAME pane (u, v, slicePos) into the field's grid;
  // what is read there is a displacement in mm, which fieldToOverlay turns into
  // a change of the overlay's texture coordinate. The field has vectors between
  // fieldLow and fieldHigh (the centres of its first and last texels); outside
  // them it says nothing and the overlay is not drawn. mat4x4 alignment lands
  // this block at byte 272.
  fieldToTex : mat4x4<f32>,
  fieldToOverlay : mat4x4<f32>,
  fieldLow : vec3<f32>,
  fieldOn : u32,
  fieldHigh : vec3<f32>,
  // What of the field is washed over the image (field-view.ts): 0 nothing,
  // 1 how far it moves each place, 2 its Jacobian determinant. Read where the
  // field is read, and drawn only where the field has a vector to go by.
  fieldView : u32,
  fieldViewScale : f32,      // the displacement at the top of wash 1's scale, in mm
  fieldViewOpacity : f32,    // how strongly a wash is laid over the image
  // The deformed grid (field-view.ts): lines every fieldGridSpacing mm of the
  // overlay, 0 for none, each fieldGridHalfWidth mm to either side. fieldGridMm
  // is the overlay's size in mm along its three texture axes, which turns a
  // texture coordinate into mm from its corner; fieldGridAxes has 1 for the two
  // axes that have lines in this pane.
  fieldGridSpacing : f32,
  fieldGridHalfWidth : f32,
  fieldGridMm : vec3<f32>,
  fieldGridAxes : vec3<f32>,
};

@group(0) @binding(0) var volTex : texture_3d<f32>;
@group(0) @binding(1) var volSamp : sampler;
@group(0) @binding(2) var<uniform> P : Params;
@group(0) @binding(3) var overlayTex : texture_3d<f32>;
@group(0) @binding(4) var overlayLut : texture_1d<f32>; // RGBA colormap ramp
@group(0) @binding(5) var maskTex : texture_3d<f32>;    // label ids (r16float)
@group(0) @binding(6) var maskSamp : sampler;           // nearest, for label ids
@group(0) @binding(7) var maskLut : texture_1d<f32>;    // id -> RGBA display colour
@group(0) @binding(8) var fieldTex : texture_3d<f32>;   // displacement xyz in mm, a: 1 where defined
@group(0) @binding(9) var jacobianTex : texture_3d<f32>; // the field's determinant, g: 1 where it has one
${FIELD_VIEW_WGSL}
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  // Oversized fullscreen triangle.
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let xy = corners[vi];
  var out : VSOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  // uv in [0,1], with v = 0 at the top of the canvas.
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, (1.0 - xy.y) * 0.5);
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  // Pan shifts the slice within the pane (screen-uv), then letterbox to
  // preserve the slice's physical aspect ratio.
  let plane = (in.uv - vec2<f32>(0.5) - P.pan) * P.scale + vec2<f32>(0.5);
  if (plane.x < 0.0 || plane.x > 1.0 || plane.y < 0.0 || plane.y > 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  // Optionally mirror the in-plane horizontal axis (e.g. flip sagittal L/R).
  let u = select(plane.x, 1.0 - plane.x, P.flipX != 0u);

  // Reslice: pane plane -> patient plane -> texture coord, via the affine.
  let coord = (P.planeToTex * vec4<f32>(u, plane.y, P.slicePos, 1.0)).xyz;
  // Outside the (possibly rotated) volume the plane has no data: paint black.
  if (any(coord < vec3<f32>(0.0)) || any(coord > vec3<f32>(1.0))) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let raw = textureSampleLevel(volTex, volSamp, coord, 0.0).r;

  // DICOM windowing (PS3.3 C.11.2.1.2 linear form).
  let lo = P.windowCenter - 0.5 - (P.windowWidth - 1.0) * 0.5;
  let g = clamp((raw - lo) / max(P.windowWidth - 1.0, 1.0), 0.0, 1.0);
  let shade = select(g, 1.0 - g, P.invert != 0u);
  var rgb = vec3<f32>(shade, shade, shade);

  // Standalone colormapped layer (the Compare overlay column): map the windowed
  // value through overlayLut so a dose draws in its colormap (jet / hot) instead
  // of grayscale. There's nothing composited behind it, so the LUT's per-value
  // alpha is ignored and its colour shown directly.
  if (P.colormapBase != 0u) {
    rgb = textureSampleLevel(overlayLut, volSamp, shade, 0.0).rgb;
  }

  // The overlay by itself (mode 2): the pane is the base's plane, and what it
  // shows of the base is nothing. Where the overlay does not reach stays black.
  let alone = P.overlayMode == 2u;
  if (alone) {
    rgb = vec3<f32>(0.0);
  }

  // The deformation field at this place of the pane: what it moves the place
  // by, and whether it has a vector to go by here at all.
  var mapped = true;
  var moved = vec4<f32>(0.0);
  var fcoord = vec3<f32>(0.0);
  if (P.fieldOn != 0u) {
    let at = (P.fieldToTex * vec4<f32>(u, plane.y, P.slicePos, 1.0)).xyz;
    fcoord = clamp(at, P.fieldLow, P.fieldHigh);
    moved = textureSampleLevel(fieldTex, volSamp, fcoord, 0.0);
    mapped = all(at >= P.fieldLow) && all(at <= P.fieldHigh) && moved.a > 0.999;
  }

  // Fusion overlay: sample the second volume at the same pane point via its own
  // affine, window it, and blend over the base. A colormap overlay (e.g. a dose
  // wash) maps the windowed value through overlayLut to colour; a grayscale one
  // uses the value directly. Outside the overlay's grid (or opacity 0) the base
  // shows through unchanged.
  if (P.overlayOpacity > 0.0) {
    var ocoord = (P.overlayToTex * vec4<f32>(u, plane.y, P.slicePos, 1.0)).xyz;
    // A registration by a deformation field: the overlay is read where the
    // field moves the point to. Where the field has no vector to go by (outside
    // its grid, or beside an undefined vector) the overlay is not drawn. The
    // probe does the same on the CPU (pointToLayer / sampleDeformation).
    if (P.fieldOn != 0u) {
      ocoord = ocoord + (P.fieldToOverlay * vec4<f32>(moved.xyz, 0.0)).xyz;
    }
    if (mapped && all(ocoord >= vec3<f32>(0.0)) && all(ocoord <= vec3<f32>(1.0))) {
      let oraw = textureSampleLevel(overlayTex, volSamp, ocoord, 0.0).r;
      // A voxel that is not known (a summed dose, where a dose was not: its
      // texel is UNKNOWN_TEXEL) is not drawn. Beside one, the sample is far
      // below any window, and a colour wash has nothing to show for it; the
      // probe says "not known" over the same voxels (volumeInterpolator).
      let oknown = oraw > ${UNKNOWN_TEXEL_BELOW}.0;
      let olo = P.overlayWindowCenter - 0.5 - (P.overlayWindowWidth - 1.0) * 0.5;
      var og = clamp((oraw - olo) / max(P.overlayWindowWidth - 1.0, 1.0), 0.0, 1.0);
      // By itself it is the pane's image, and inverted with the display as one.
      if (alone && P.invert != 0u) {
        og = 1.0 - og;
      }
      var orgb = vec3<f32>(og, og, og);
      // Grayscale overlay contributes fully; a colormap carries a per-value alpha
      // ramp (≈0 at the low end) so low/background dose lets the base show through.
      var oalpha = 1.0;
      if (P.overlayColormap != 0u) {
        let lut = textureSampleLevel(overlayLut, volSamp, og, 0.0);
        orgb = lut.rgb;
        oalpha = lut.a;
      }
      // Checkerboard mode (a registration QA tool) shows whole cells from one
      // image or the other, never a blend: overlay cells show the overlay at full
      // strength and base cells show the base, ignoring overlayOpacity. Otherwise
      // it's a uniform opacity blend.
      var amount = P.overlayOpacity * oalpha;
      if (P.overlayMode == 1u) {
        let cell = (floor(in.pos.x / P.checkerSize) + floor(in.pos.y / P.checkerSize)) % 2.0;
        amount = oalpha * cell;
      }
      // By itself there is nothing behind it to show through: its colour as it
      // is, as the standalone column draws a colour-mapped layer.
      if (alone) {
        amount = 1.0;
      }
      if (!oknown) {
        amount = 0.0;
      }
      rgb = mix(rgb, orgb, amount);
    }
  }

  // What the field is doing, washed over the picture so far (field-view.ts).
  // Only where the field has a vector to go by; a determinant only where it
  // has one. A fold is drawn at full strength whatever the wash's opacity.
  if (P.fieldOn != 0u && P.fieldView != 0u && mapped) {
    if (P.fieldView == 1u) {
      let wash = displacementWash(length(moved.xyz), P.fieldViewScale);
      rgb = mix(rgb, wash.rgb, clamp(wash.a * P.fieldViewOpacity, 0.0, 1.0));
    } else {
      let jacobian = textureSampleLevel(jacobianTex, volSamp, fcoord, 0.0);
      if (jacobian.g > 0.999) {
        if (jacobian.r <= 0.0) {
          rgb = fieldFold(in.pos.xy);
        } else {
          let wash = jacobianWash(jacobian.r);
          rgb = mix(rgb, wash.rgb, clamp(wash.a * P.fieldViewOpacity, 0.0, 1.0));
        }
      }
    }
  }

  // The deformed grid, over the wash: the overlay's regular grid where the
  // field puts it in this plane.
  if (P.fieldOn != 0u && P.fieldGridSpacing > 0.0 && mapped) {
    let read = (P.overlayToTex * vec4<f32>(u, plane.y, P.slicePos, 1.0)).xyz
      + (P.fieldToOverlay * vec4<f32>(moved.xyz, 0.0)).xyz;
    if (onGridLine(read * P.fieldGridMm, P.fieldGridAxes, P.fieldGridSpacing, P.fieldGridHalfWidth)) {
      rgb = gridOver(rgb);
    }
  }

  // Label mask: an authored segmentation aligned to the base grid, drawn ON TOP of
  // any fusion overlay. Sample NEAREST so ids aren't blended into nonexistent
  // values, then colour the id through maskLut (a per-ROI ramp; texel 0 is the
  // transparent background). id 0 → background, so nothing is drawn there.
  if (P.maskOpacity > 0.0) {
    let mcoord = (P.maskToTex * vec4<f32>(u, plane.y, P.slicePos, 1.0)).xyz;
    if (all(mcoord >= vec3<f32>(0.0)) && all(mcoord <= vec3<f32>(1.0))) {
      let id = textureSampleLevel(maskTex, maskSamp, mcoord, 0.0).r;
      if (id >= 0.5) { // ≥ 0.5 rounds to id ≥ 1; below it is background
        // Index the LUT at the id's texel centre ((id + 0.5) / size), nearest-
        // sampled so neighbouring ids never bleed into one another.
        let lut = textureSampleLevel(maskLut, maskSamp, (id + 0.5) / P.maskLutSize, 0.0);
        rgb = mix(rgb, lut.rgb, P.maskOpacity * lut.a);
      }
    }
  }
  return vec4<f32>(rgb, 1.0);
}
`;
