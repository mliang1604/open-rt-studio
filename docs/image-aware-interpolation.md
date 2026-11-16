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

### Since the spike: settling off the page's thread, the guess an undo away (#295)

- **In a web worker** (`settle.worker.ts`), slice by slice: the options say
  how far it is ("Settling slice 3 of 7…"), and Stop leaves the slices as
  filled.
- **An edit of its own**, after the fill: Undo shows the shape-based guess,
  Redo the settled. The slices settled are listed. A slice drawn on while it
  was being settled is left as drawn.
- **The band is at most three quarters of the guess's depth.** Settling a
  small disc drawn across a lung's edge first shrank it to a sliver: with the
  full 4-pixel band almost nothing of a guess 5 pixels deep was held as the
  object. Capped at half its depth, the sphere's interpolation fell from 0.993
  to 0.985; at three quarters it was 0.994 (the ellipsoid's 0.978, and the
  hulls' 1.000), as good as no cap, and the small disc kept its part within
  the lung.

### Since the spike: a surface fitted to the contours (#296)

"Fit from an outline in each plane" now fits an implicit surface through
the outlines in place of the hull (`surface-fit.ts`, Turk and O'Brien): a
function `f(x) = Σ wᵢ |x − cᵢ| + a·x + b`, solved exactly through points on
the outlines' edges (f = 0) and points 2 mm inside and outside them along
their normals (f = ∓2), the structure where f < 0. It runs in a web worker,
and is settled to the image afterwards if asked.

| Object, three sections                            | Hull  | Fitted surface |
| ------------------------------------------------- | ----- | -------------- |
| Sphere, sections through its middle               | 0.934 | 0.980          |
| Tilted ellipsoid, sections not through its middle | 0.903 | 0.973          |

- Both of the issue's targets are met: above 0.97 on the sphere, above 0.95
  on the ellipsoid.
- **Outlines that cross share points**, which made the system singular; the
  first fit missed its own constraints by 400 and gave Dice 0.22. Each point
  is now taken once.
- **Points were first thinned by taking every second in raster order**,
  which took only the left edge of each outline (most rows have two edge
  pixels): the sphere reached 0.952. They are now thinned by distance.
- **Normals were first taken per pixel**, wrong where pixels are not
  square (a coronal pane of thick slices); per mm, a sphere on 3 mm slices
  went from 0.974 to 0.978.
- 120 points on the edges: 240 gave 0.982 and 0.975, in twice the time.
  Points 0.5 to 4 mm off the surface all held with 120; 2 mm is used.
- A fit took about 1 s on a 48³ grid: the solve grows with the cube of the
  points, the sampling with the voxels in the structure's box.

### Since: every slice drawn, outlines on any plane, and speed (#302)

- **The fit takes every slice the structure was drawn on with the tools**
  (several on an axis too), and the slice it fills most on each axis only
  when fewer than two were drawn (a structure loaded). Every tool that draws
  on a slice draws across the grid axis of its pane's orientation, at the
  voxel under the pointer: on a tilted pane it paints grid slices, and those
  are what is kept.
- **Outlines on any plane** in the core (`PlaneOutline`, `sectionOf`): the
  tilted ellipsoid from three oblique sections near its middle gave 0.955.
  With the labs flag on, the disc brush on a tilted pane draws on its plane
  (#303), and so do the points and live-wire tools, which fill their curve
  there (`fillPlaneLoop`); the fit takes the structure's section on the
  plane. The ellipsoid's outline filled that way on three tilted planes and
  then fitted gave 0.950, against 0.955 from its own sections on them. The
  threshold brush, the push brush, the rubber band and quick select draw on
  the pane's plane too (#307).
- **More sections are not always better.** Axial 19, 25 and 31 with a
  sagittal and a coronal section gave 0.977, against 0.973 for the fullest
  of each axis; without the coronal, 0.968 against 0.975: beyond the
  outermost axial sections the surface bulges where one outline holds it.
- **Points off the surface are two of the grid's coarsest voxels off**, and
  2 mm at least. On the 4 mm voxels of the thorax phantom, five small discs
  drawn in the browser were fitted with a lobe far from them; 2 mm off was
  half a voxel.
- **`Math.sqrt` in place of `Math.hypot`** made a fit 7 to 9 times faster: a
  box of 150 × 150 × 100 voxels took 1.6 s. Sampling a coarse lattice first
  saved a third at most, and only with a margin nothing guarantees; dropped.

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
