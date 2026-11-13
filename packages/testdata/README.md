# @open-rt-studio/testdata

Synthetic DICOM objects for tests, generated in memory. **Every byte is
fabricated; there is no patient data here and there never may be.** See the
[test data policy](../../docs/test-data.md).

```ts
import { syntheticCtSeries, syntheticRtStruct } from '@open-rt-studio/testdata';

const files = [...syntheticCtSeries(12, 32), syntheticRtStruct(12)];
// Each file is { name, mimeType, bytes: Uint8Array }.
```

| Generator           | Produces                                                                             |
| ------------------- | ------------------------------------------------------------------------------------ |
| `syntheticCtSeries` | Axial CT stack, 1 mm voxels. Voxel value is `syntheticCtValue(x, z, size)`.          |
| `syntheticMrSeries` | MR stack with the CT's geometry and Frame of Reference, so the two fuse.             |
| `syntheticRtStruct` | RTSTRUCT on the CT: stacked circles, described by `syntheticRois`.                   |
| `syntheticRtDose`   | Multi-frame RTDOSE in Gy inside the CT. Value is `syntheticDoseGy(col, row, frame)`. |
| `syntheticPatient`  | One patient, two studies: CT, MR, RTSTRUCT and RTDOSE, then a follow-up CT.          |

`syntheticThoraxPatient` is the one made for looking at: a geometric thorax
phantom (body, lungs, heart, spine, a target) with a planning CT in Hounsfield
units, an MR, a matching structure set, a dose on the target and a follow-up
CT. The web client loads it as its demo patient. `thoraxTissueAt`,
`thoraxRois` and `thoraxDoseGy` say what is at any position in millimetres.

The package has no runtime dependencies and uses no Node-only or DOM-only
APIs, so the same generators run in Vitest, in Playwright and in a browser.

## Using it

- **Vitest**: pass `file.bytes.slice().buffer` to `parseFile` or
  `parseStructureSet` from `@open-rt-studio/dicom`.
- **Playwright**: `setInputFiles` wants Node buffers, so map each file to
  `{ name, mimeType, buffer: Buffer.from(file.bytes) }`.
- **Looking at it by hand**: write the bytes to `/data` or `/sample-data`,
  which git ignores. Do not write them anywhere else in the repository; the CI
  guard rejects any committed file that looks like DICOM.

## Rules for generators

- **Deterministic.** No random numbers, no clock. UIDs come from the helpers in
  `identity.ts`, under one fixed synthetic root, so two calls give identical
  bytes.
- **Obviously fake identity.** Patient `SYNTHETIC^PHANTOM`, ID `SYN-0001`.
- **Known values.** Voxel values and geometry follow a formula that is exported
  next to the generator, so a test can state what the probe, a statistic or a
  contour should be instead of copying numbers.
- **Small.** A few dozen slices of 32 by 32 is enough for almost every test.

## Adding a fixture

1. Write a generator in `src/` that returns `SyntheticFile` or
   `SyntheticFile[]`. Build elements with `el`, `sequence` and `part10` from
   `dicom-writer.ts`; they sort elements by tag and add the file meta group.
2. Take UIDs from `studyUid`, `seriesUid`, `instanceUid` and
   `frameOfReferenceUid`. Give the object its own series index within the
   study so its UIDs cannot collide with another generator's.
3. Export the generator, and the formula or description of what it contains,
   from `src/index.ts`.
4. Add a spec that parses the output with `@open-rt-studio/dicom` and checks
   the values against the formula. A generator is only useful if the DICOM
   core reads back what it meant to write.
5. If the object needs something the writer cannot express yet (another VR,
   undefined-length sequences, a compressed transfer syntax), extend
   `dicom-writer.ts` and cover the new piece with a spec.

Do not check generated files in, and do not base a fixture on a real file.

Ported from the dicom-workspace e2e fixtures (MIT, same author) and relicensed
to MPL 2.0.
