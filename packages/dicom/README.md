# @open-rt-studio/dicom

The framework-free DICOM core: parsing, series grouping, volume building,
pixel decoding and structure sets. It runs in a browser, in a web worker and
in Node, so it uses no Angular, DOM-only or Node-only APIs and imports nothing
else from this repository.

Import from the package name; `src/index.ts` is the only entry point and lists
every public name.

```
npm run build -w @open-rt-studio/dicom
npm test -w @open-rt-studio/dicom
```

`npm test` type-checks the specs, runs them with Vitest in plain Node (no DOM),
then builds the package and runs `test/*.test.mjs` against the built output
with Node's own test runner, to prove that Node can import it.

## What is in it

- Parsing (`parseFile`, `parseFileAsync`) on top of `dicom-parser`, with pixel
  decoding for uncompressed data, RLE, and JPEG, JPEG-LS and JPEG 2000 through
  WebAssembly codecs that load on first use
- Metadata and a tag dictionary, series grouping, slice ordering, volume
  building, photometric handling, the patient catalog
- RT structure sets: reading, contour rasterization, label volumes, marching
  squares and RTSTRUCT writing
- RTDOSE as a volume in Gy

Ported from dicom-workspace `src/dicom` (MIT, same author) and relicensed to
MPL 2.0.
