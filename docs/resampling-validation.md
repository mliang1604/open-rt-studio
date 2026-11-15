# Resampling validation

What the resampling of images and the propagation of structures are held to,
and what they measured. The suite is
`packages/testdata/src/resampling-validation.spec.ts`; it runs with the unit
tests (`npm test`), so in CI on every change. Its last test reads this
document and fails when a case or its tolerance is not here as the suite has
it.

**Not for clinical use.** These numbers say how the code does on shapes
that are formulas. They say nothing of how a registration of two real images
does, and nothing here was compared with another program.

## The phantom

`packages/testdata/src/resampling-phantom.ts`. Everything in it is a
formula, so what should come out is known at every place and is not another
run of the same code.

- **Two grids.** The source image has voxels of 1 × 1 × 2 mm (72 × 72 × 44);
  the other image has voxels of 1.5 mm each way (52 × 52 × 52), set off from
  the first by parts of a voxel.
- **Two images.** A linear image, which reading between voxels loses nothing
  of, so that any error is the code's. A wavy image (three sine waves 40, 50
  and 60 mm long; values from −100 to 2100), which reading between voxels
  must be off, by a known most.
- **A ball** of 12 mm radius, its centre on no voxel centre, contoured as a
  circle on each slice of the source that cuts it.
- **Transforms**, each saying where a place of the reference image is read
  in the source, each with its inverse:
  - _in-plane_: a turn of 25° about the slice axis and a shift of whole
    slices, which keeps contours on slices;
  - _rigid_: a turn of 12° about a skew axis and a shift that is no whole
    voxel;
  - _stretch_: a stretch and shear of up to 8 % with a shift, as a
    deformation field. A field that goes evenly with the place is read
    between its vectors without error;
  - _swell_: a deformation field that moves places by up to 4 mm along one
    direction, dying away over about 10 mm: a bent field;
  - _swell, then rigid_: the field with a matrix after it, as a Deformable
    Spatial Registration object has them.

  Fields are given to the code as a grid of 32-bit vectors 2 mm apart.

## Images

The largest difference between a resampled voxel and the formula read where
the transform says, in the image's own units, over every voxel whose place
is at least a voxel inside the source. Linear interpolation. The suite also
checks that voxels clearly beyond the source get the outside value and are
counted.

Where the tolerances come from:

- The linear image: 0.001, which is what 32-bit values leave.
- The wavy image: what linear interpolation of it can be off at most, an
  eighth of the voxel spacing squared times how sharply the image bends,
  over the three axes. That is 3.67 on the source's voxels and 5.48 on the
  other's.
- Through the swell: in addition, how far the field read between its
  vectors can be off the swell itself (0.06 mm), times how fast the image
  changes (6.16 a millimetre for the linear image, 86.4 for the wavy one).
- There and back: the two ways added. The way back through the inverse of
  the swell is allowed twice the swell's grid error, as the inverse bends
  more sharply than the swell; that bound is loose.

| Case                                                   | Tolerance | Largest | Root mean square | Voxels compared |
| ------------------------------------------------------ | --------- | ------- | ---------------- | --------------- |
| Linear image onto its own grid                         | 0.001     | 0.000   | 0.000            | 205800          |
| Linear image through the rigid transform               | 0.001     | 1.5e-5  | 4.3e-6           | 106709          |
| Linear image through the stretch field                 | 0.001     | 1.5e-5  | 4.3e-6           | 105025          |
| Linear image through the swell                         | 0.37      | 0.312   | 0.018            | 110032          |
| Wavy image onto its own grid                           | 0.001     | 0.000   | 2.4e-5           | 205800          |
| Wavy image through the rigid transform                 | 3.67      | 3.562   | 1.195            | 106709          |
| Wavy image through the swell                           | 8.85      | 4.031   | 1.198            | 110032          |
| Wavy image through the swell, then the rigid transform | 8.85      | 4.334   | 1.197            | 106695          |
| Wavy image there and back, rigid                       | 9.15      | 8.268   | 2.812            | 152402          |
| Wavy image there and back, the swell                   | 24.7      | 8.983   | 2.871            | 166464          |

The wavy image spans 2200, so the largest one-way error is 0.2 % of its
range and the largest there and back 0.4 %.

## Labels

An image of the ball as 0 and 1, resampled with the nearest voxel. Every
value that comes out is 0 or 1. A voxel may have the wrong one only near the
surface: no further from it than half the diagonal of a source voxel
(1.22 mm), which is as far as a place can be from the centre of the voxel it
is in.

| Case                                              | Tolerance | Furthest wrong voxel | Wrong                          |
| ------------------------------------------------- | --------- | -------------------- | ------------------------------ |
| Labels through the rigid transform, nearest voxel | 1.22      | 0.977                | 194 of 2134 voxels of the ball |

## Structures

How far the points of a propagated outline are from the ball's surface, in
mm, once the formula has taken each to the source image. By points the
tolerance is what the arithmetic leaves. By a label volume it is half the
diagonal of a source voxel (1.22 mm): the outlines start from the source's
voxels. Three further limits hold for every label-volume case: the mean
distance is at most 0.3 mm; the volume is within 5 % of the formula's (the
places whose place in the source is in the ball, counted on a lattice of
0.5 mm); and every outline is on a slice of the image it was taken to.

| Case                                       | Tolerance | Furthest | Mean  | Volume against the formula |
| ------------------------------------------ | --------- | -------- | ----- | -------------------------- |
| Ball by its points, in-plane transform     | 0.000001  | 5.0e-15  | —     | —                          |
| Ball by label volume, rigid transform      | 1.22      | 0.492    | 0.147 | −1.8 %                     |
| Ball by label volume, stretch field        | 1.22      | 0.514    | 0.144 | −0.7 %                     |
| Ball by label volume, the swell            | 1.22      | 0.451    | 0.129 | −1.3 %                     |
| Ball by label volume, the swell then rigid | 1.22      | 0.584    | 0.143 | −1.7 %                     |

The volume comes out a little small every time: between two slices an
outline is midway between the two shapes, and a ball bulges more than that.

## Structures there and back

The ball taken to the other image and back to its own through the transform
turned round, then held against itself. The tolerance on the furthest
outline point is half a voxel's diagonal of each image, added (2.52 mm).
The overlap (Dice) with the ball as it was drawn must be at least 0.95. The
last four columns are what the viewer's own comparison of two structures
says of the two (`compareRois`), on the source image's voxels, where
distances come in steps of a voxel.

| Case                           | Tolerance | Furthest | Mean  | Dice  | Surface distance, mean | 95th percentile | Largest |
| ------------------------------ | --------- | -------- | ----- | ----- | ---------------------- | --------------- | ------- |
| Ball there and back, rigid     | 2.52      | 0.926    | 0.245 | 0.978 | 0.152                  | 1.000           | 2.000   |
| Ball there and back, the swell | 2.52      | 1.111    | 0.214 | 0.979 | 0.135                  | 1.000           | 1.000   |

## Reading the results

The measured columns are of 14 November 2026. To measure again:

```bash
cd packages/testdata
RESAMPLING_VALIDATION_REPORT=1 npx vitest run src/resampling-validation.spec.ts --silent=false
```

which prints the rows above. The suite fails when a measurement is over its
tolerance, not when it differs from what is written here.

## What this does not cover

- **The WebGPU path.** The suite runs the reference in plain arithmetic
  (`resampleVolume`). The WebGPU path is tested with stand-ins for the
  device (`packages/render/src/resample-gpu.spec.ts`), and end to end
  `apps/web/e2e/derived-series.spec.ts` holds every voxel of a series
  resampled on a real or software GPU to the synthetic pair's formula, for
  one registration by a matrix.
- **Files.** Nothing here is written to or read from DICOM. That the written
  objects say what was done is tested where they are written.
- **Other shapes.** One ball. Thin, branching or very small structures, and
  structures with holes, are tested in `packages/dicom` for what comes out,
  not held to a tolerance here.
- **Other fields.** One bent field, smooth and without folds. A field that
  folds, or one coarser than what it describes, is not measured.
- **Real images, and other programs.** No image of a patient or a scanner
  phantom was used, and no result was compared with another system's.
