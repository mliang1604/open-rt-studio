# @open-rt-studio/render

WebGPU device setup, WGSL shaders and the pure geometry helpers they share
with the CPU side. It depends only on `@open-rt-studio/dicom` and the WebGPU
types. Its tests run without a GPU.

Import from the package name; `src/index.ts` is the only entry point and lists
every public name.

```
npm run build -w @open-rt-studio/render
npm test -w @open-rt-studio/render
```

## What is in it

- Device setup (`device.ts`), pane layout, the slice renderer with its
  pipelines, resources and WGSL shaders
- Pure geometry shared by the GPU and the CPU: reslice, plane basis, pane
  coordinates, pan and zoom, window/level, probe, pick, camera, projection
- 3D: raycast shader, direct volume rendering, transfer functions, surfaces,
  curved planar reformat
- Overlays: colormaps, masks, crosshair, reference lines, pane annotations,
  axis indicator, contours, ROI overlay, brush, measurements

## Rules

- **The slice shader and the probe implement the same geometry** from opposite
  directions (plane to texture, cursor to voxel). Change one and you must
  change the other. Shared math lives in pure helpers that both call.
- **Tests never need a GPU.** Specs run in plain Node. Code that talks to the
  device is tested against small hand-written fakes of the WebGPU objects, and
  everything else is pure math. Do not add a test that calls
  `navigator.gpu.requestAdapter()` for real.
- WGSL lives in this package as TypeScript strings; the Angular layer holds
  none.

Ported from dicom-workspace `src/render` (MIT, same author) and relicensed to
MPL 2.0.
