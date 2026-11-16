# Image-aware interpolation and fitting from several planes: spike report (#120)

**Not for clinical use.** Everything here was measured on generated
synthetic images: a sphere and a tilted ellipsoid of 100 on 0 with noise σ 10
in a 48³ grid, and the synthetic thorax phantom. Nothing was measured on real
CT or MR, and nothing was compared with another program.

Two questions:

1. Shape-based interpolation (#115) mixes the drawn slices' shapes and does
   not look at the image. Does using the image between them help?
2. Can a structure be fitted from a few outlines drawn in different planes
   (one axial, one coronal, one sagittal), not only from parallel slices?

## What was tried

Both prototypes are in `packages/dicom/src/image-aware.ts`, and in the
Interpolate tool behind the labs flag.

- **Settling to the image** (`refineToImage`). A guess on a slice, from
  shape-based interpolation or from a fit, is taken as right more than a band
  (4 pixels) inside its edge, and more than the band outside it. The band
  itself is settled by the random walker of #119: what lies there goes to the
  object or not by the image's edges. The Interpolate tool's "Settle to the
  image" applies it to each slice it fills. A guess thinner than the band has
  nothing to settle between and is kept as it is; the first version erased
  such slices.
- **Fitting from outlines in several planes** (`visualHull`). Each outline,
  extruded along its axis, holds the structure, and the structure is taken as
  the intersection of all the extrusions, the "visual hull". It is then
  settled to the image if asked. The Interpolate tool's "Fit from an outline
  in each plane" takes, for each axis, the slice the structure fills most as
  the outline drawn there.
- **Not tried:** surface reconstruction from non-parallel contours by an
  implicit surface (radial basis functions, or a Poisson reconstruction from
  the contours' points and normals). It is the proper answer to the second
  question; it is larger work than a spike, and is a follow-up.

## Results

Dice against the object:

| Object           | Method                                     | Alone | Settled to the image |
| ---------------- | ------------------------------------------ | ----- | -------------------- |
| Sphere           | Shape-based, drawn every fifth axial slice | 0.963 | 0.993                |
| Sphere           | Hull of three central outlines             | 0.934 | 1.000                |
| Tilted ellipsoid | Shape-based, drawn every fifth axial slice | 0.943 | 0.971                |
| Tilted ellipsoid | Hull of three central outlines             | 0.903 | 0.990                |

The band was 4 pixels. At 2 pixels settling did slightly better on the
ellipsoid's interpolation (0.974) and worse elsewhere; at 6 pixels worse
everywhere (0.941 to 0.993).

Settling took 1 to 3 ms on a 48² slice, 70 ms on 256² and 143 ms on 512²
(single-threaded JavaScript on an Intel Core i7-8850H, Node 24). A hundred
256² slices would take about 7 s.

What the numbers mean, and what they do not:

- **Using the image helps where the image shows the edge.** It recovers what
  linear mixing misses near a structure's ends, and most of what the hull
  gets wrong.
- **These objects are the easy case:** a contrast of 100 against noise of 10,
  and nothing of similar value touching them. Where the structure's edge is
  not in the image (soft tissue against soft tissue, a target drawn by
  judgement), settling cannot help. On the thorax phantom a fit drawn in
  uniform soft tissue was left as the hull.
- **An outline is a section, not a silhouette.** Through the middle of a
  round object it is the widest section, and the hull holds the object. For
  an object off the middle, or tilted, a section is smaller than the object
  seen along that axis, so the hull cuts parts of it off. Settling recovers
  those only within its band. The tilted ellipsoid's 0.903 is mostly this.

## Recommendation

- **Offer settling to the image** as an option of interpolation, off by
  default. It helps on objects with a visible edge and should not be applied
  to ones without, which only the user knows. Show the guess and the settled
  result so the user can tell them apart.
- **Settle in a web worker**, for the same reason as quick selection (#291):
  a volume of slices takes seconds.
- **Do not build the visual hull into a tool beyond this prototype.** It is
  only right for outlines through a round object's middle. Fitting from
  outlines in several planes should be done by a surface fitted to the
  contours (an implicit surface through their points), which handles
  sections anywhere. That is a follow-up.

## Follow-up issues

- #295 Interpolation: settle to the image, off the page's thread, with the guess shown
- #296 Fit a structure from contours in any planes by an implicit surface
