# Dose validation

What the mapping of a dose onto an image, the summing of doses and their
conversion to BED and EQDx are held to, and what they measured. The suite is
`packages/testdata/src/dose-validation.spec.ts`; it runs with the unit tests
(`npm test`), so in CI on every change. Its last test reads this document
and fails when a case or its tolerance is not here as the suite has it.

**Not for clinical use.** These numbers say how the code does on doses that
are formulas. They say nothing of how a sum of real doses through a real
registration does, nothing of whether the linear-quadratic model fits a
tissue, and nothing here was compared with another program.

## The phantom

`packages/testdata/src/dose-phantom.ts`, on the image and the transforms of
the resampling phantom (`resampling-phantom.ts`,
[resampling validation](resampling-validation.md)). Everything is a
formula, so what should come out is known at every place and is not another
run of the same code.

- **The image** the doses are summed on has voxels of 1 × 1 × 2 mm
  (72 × 72 × 44).
- **Two dose grids**, each smaller than the image, as a planning system's
  is: one in the image's own frame of reference with voxels of 2.5 mm
  (25 × 25 × 31), set off from the image's voxels, and one in another frame
  of reference with voxels of 3 mm (24 × 24 × 24).
- **Three doses**, in gray:
  - _uniform_: 50 Gy everywhere, and another of 20 Gy;
  - _linear_: 40 Gy at the origin, rising by 0.54 Gy a millimetre along a
    skew direction. Reading it between voxels loses nothing, so any error
    is the code's;
  - _the hill_: 2 Gy rising to 62 Gy at a top that is on no voxel centre,
    as a Gaussian 20 mm wide. It is bent, as a real dose is, so reading it
    between voxels must be off, by a known most.
- **Transforms**, each saying where a place of the image is read in the
  dose's frame, as in the resampling validation: _rigid_ (a turn of 12°
  about a skew axis and a shift), _stretch_ (a stretch and shear of up to
  8 %, as a deformation field), _swell_ (a bent field that moves places by
  up to 4 mm), and _swell, then rigid_. Fields are given to the code as a
  grid of 32-bit vectors 2 mm apart.

## What is compared

The largest difference between the sum at a voxel of the image and the
formulas read where the transforms say, in gray, over every voxel whose
place is at least a voxel inside the grid of every dose. A case with one
dose is that dose mapped onto the image.

Every case also holds the sum to what it must say where a dose does not
reach. At a voxel whose place is clearly beyond a dose's grid (more than a
voxel and a half past its outermost voxel centre) the sum must be marked not
known and hold 0. At a voxel well inside every dose it must be marked
known. A single voxel that fails either fails the case.

Where the tolerances come from:

- A uniform dose: 0.0001 Gy, which is what 32-bit values leave of some tens
  of gray.
- The linear dose: 0.001 Gy, the same for a dose read between the voxels of
  a grid that lies askew.
- The hill: what linear interpolation of it can be off at most, an eighth
  of the voxel spacing squared times how sharply the hill bends (its height
  over its width squared, at its top), over the three axes. That is 0.352 Gy
  on the 2.5 mm grid and 0.506 Gy on the 3 mm grid: 0.6 % and 0.8 % of the
  hill's top. The measured errors are close to these because the bound is
  met at the top of the hill.
- Through the swell: in addition, how far the field read between its
  vectors can be off the swell itself (0.06 mm), times how fast the dose
  changes (0.54 Gy a millimetre for the linear dose, 1.82 at most for the
  hill).
- A sum: the tolerance of each dose times its weight, added.
- A conversion: the tolerance of the dose times how fast the converted dose
  rises with the dose at the greatest dose there is. BED rises by
  1 + 2D / (n · α/β) for each gray of D, and EQDx by that over
  1 + x / (α/β).

## Mapping

One dose taken to the image's grid.

| Case                                             | Tolerance | Largest | Root mean square | Voxels compared |
| ------------------------------------------------ | --------- | ------- | ---------------- | --------------- |
| Uniform dose in the image’s own frame            | 0.0001    | 0.0000  | 0.0000           | 105875          |
| Uniform dose through the rigid transform         | 0.0001    | 0.0000  | 0.0000           | 123447          |
| Uniform dose through the swell                   | 0.0001    | 0.0000  | 0.0000           | 127008          |
| Linear dose in the image’s own frame             | 0.001     | 6.1e-6  | 9.9e-7           | 105875          |
| Linear dose through the rigid transform          | 0.001     | 6.2e-6  | 1.1e-6           | 123447          |
| Linear dose through the stretch field            | 0.001     | 5.4e-6  | 1.1e-6           | 115243          |
| Linear dose through the swell                    | 0.0323    | 0.0196  | 0.0014           | 127008          |
| Hill in the image’s own frame                    | 0.352     | 0.3326  | 0.0699           | 105875          |
| Hill through the rigid transform                 | 0.506     | 0.4877  | 0.0933           | 123447          |
| Hill through the swell                           | 0.615     | 0.4776  | 0.0912           | 127008          |
| Hill through the swell, then the rigid transform | 0.615     | 0.4840  | 0.0907           | 123396          |

## Summation

Several doses, each through its own transform, each times a weight. In the
last case the second dose is said to be nothing beyond its own grid
(`beyondGrid: 'nothing'`): the suite checks that the sum is then known
where only that dose is missing, that it is the first dose alone there, and
that without those words the same voxels are not known.

| Case                                                                              | Tolerance | Largest | Root mean square | Voxels compared |
| --------------------------------------------------------------------------------- | --------- | ------- | ---------------- | --------------- |
| Two uniform doses, the second through the rigid transform                         | 0.0001    | 0.0000  | 0.0000           | 94162           |
| Linear dose, and half the hill through the rigid transform                        | 0.254     | 0.2438  | 0.0531           | 94162           |
| Linear dose, the hill through the rigid transform, and the hill through the swell | 1.12      | 0.9139  | 0.2085           | 91607           |
| Linear dose, and a uniform dose taken for nothing beyond its grid                 | 0.001     | 6.1e-6  | 1.5e-6           | 94163           |

## Conversion

Each dose converted at every voxel before it is added, by the
linear-quadratic model: a dose of 25 fractions with an α/β of 3 Gy unless
the case says otherwise. What is expected is the model's formula applied to
the dose's formula at the voxel's place.

- A dose of 50 Gy in 25 fractions is 2 Gy a fraction, so its EQD2 is itself
  whatever the α/β: held for ratios of 1.5, 3 and 10 Gy.
- An α/β to each voxel: 10 Gy at the voxels in the phantom's ball, 3 Gy at
  the others.
- Two courses: the linear dose in 25 fractions and, through the rigid
  transform, 20 Gy in 5 fractions.
- Two values are also worked out by hand in the suite: 50 Gy in 25
  fractions has a BED of 83.33 Gy, and 20 Gy in 5 fractions an EQD2 of
  28 Gy.

| Case                                                | Tolerance | Largest | Root mean square | Voxels compared |
| --------------------------------------------------- | --------- | ------- | ---------------- | --------------- |
| BED of a uniform dose                               | 0.0001    | 2.5e-6  | 2.5e-6           | 105875          |
| EQD2 of a uniform dose given in fractions of 2 Gy   | 0.0001    | 0.0000  | 0.0000           | 105875          |
| EQD2 of the linear dose through the rigid transform | 0.00175   | 1.1e-5  | 1.8e-6           | 123447          |
| BED of the hill through the rigid transform         | 1.35      | 1.2793  | 0.2060           | 123447          |
| EQD in fractions of 1.8 Gy of the linear dose       | 0.00179   | 1.4e-5  | 1.7e-6           | 105875          |
| EQD2 of the linear dose with an α/β to each voxel   | 0.00171   | 1.3e-5  | 1.6e-6           | 105875          |
| EQD2 of two courses, each with its own fractions    | 0.00181   | 1.1e-5  | 2.6e-6           | 94162           |

The BED of the hill is off by more than the hill is: at its top the BED is
113 Gy and rises by 2.7 Gy for each gray of dose, so the 0.5 Gy that reading
between 3 mm voxels loses becomes 1.3 Gy, which is 1.1 % of that BED. A
coarse dose grid costs a converted dose more than it costs the dose.

## Reading the results

The measured columns are of 15 November 2026. To measure again:

```bash
cd packages/testdata
DOSE_VALIDATION_REPORT=1 npx vitest run src/dose-validation.spec.ts --silent=false
```

which prints the rows above. The suite fails when a measurement is over its
tolerance, not when it differs from what is written here.

## What this does not cover

- **The WebGPU path.** The suite runs the reference in plain arithmetic
  (`sumDoses`). With a GPU only the resampling of each dose is done
  differently; what is done where a dose is not known, the adding and the
  conversion are the reference's own code. That path is tested with
  stand-ins for the device (`packages/render/src/dose-sum.spec.ts`). On a
  real or software GPU `apps/web/e2e/resample-gpu.spec.ts` holds its sums
  to the reference's voxel for voxel, through a matrix and through a field,
  and `apps/web/e2e/dose-sum.spec.ts` holds sums made in the application to
  the synthetic doses' formulas at places read with the probe. Neither uses
  this phantom.
- **Files.** Nothing here is written to or read from DICOM. That a saved
  sum reads back as the sum is tested where it is written
  (`packages/dicom/src/rt-dose-writer.spec.ts`).
- **Histograms, isodose lines and the α/β of structures.** Each has tests
  of its own against shapes that are formulas; none is held to a tolerance
  here.
- **Other doses and fields.** One bent dose, smooth and with one top. One
  bent field, smooth and without folds. A dose with a sharp edge, a field
  that folds, and a dose grid much coarser than what it describes are not
  measured.
- **The model.** That BED and EQDx are worked out as the linear-quadratic
  model says is tested. Whether that model, an α/β or equal fractions are
  right for a tissue is not something a test can say. There is no term for
  the time a course takes or the time between courses.
- **Real doses, and other programs.** No dose from a planning system was
  used, and no result was compared with another system's.
