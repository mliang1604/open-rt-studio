# @open-rt-studio/dicom

The framework-free DICOM core: parsing, series grouping, volume building,
pixel decoding and structure sets. It runs in a browser, in a web worker and
in Node, so it uses no Angular, DOM-only or Node-only APIs and imports nothing
else from this repository.

Import from the package name; `src/index.ts` is the only entry point.

```
npm run build -w @open-rt-studio/dicom
npm test -w @open-rt-studio/dicom
```
