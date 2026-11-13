# @open-rt-studio/render

WebGPU device setup, WGSL shaders and the pure geometry helpers they share
with the CPU side. It depends only on `@open-rt-studio/dicom` and the WebGPU
types. Its tests run without a GPU.

Import from the package name; `src/index.ts` is the only entry point.

```
npm run build -w @open-rt-studio/render
npm test -w @open-rt-studio/render
```
