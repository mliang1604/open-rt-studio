# Registration quality metrics: what to offer first

The spike in [#72](https://github.com/mliang1604/open-rt-studio/issues/72):
which measures of a deformable registration's quality the application should
offer, in what order, and how to word what they mean in a tool that is not
for clinical use.

**Recommendation.** Three first, each answering a different question:

1. **The Jacobian determinant of the field**, as a map and as numbers: is
   the deformation physically plausible?
2. **Target registration error** at landmarks the user places: how far off
   is it, where it can be measured?
3. **Surface distance between contours**, with Dice beside it: do the
   structures land where they were drawn?

Then inverse consistency, when a registration exists both ways. The rest
later or not at all. No measure is shown as passed or failed.

## How this was done, and what it is worth

Desk research on 2026-11-14. Two open-access papers were read, through a
tool that summarises a page, so what is given here as their content is a
paraphrase and **not checked against their text line by line**:

- Bosma et al., _Tools and recommendations for commissioning and quality
  assurance of deformable image registration in radiotherapy_ (Physics and
  Imaging in Radiation Oncology, 2024), which came out of an ESTRO physics
  workshop. Called "the consensus paper" below.
- _Practical quantification of image registration accuracy following the
  AAPM TG-132 report framework_ (Journal of Applied Clinical Medical
  Physics, 2018). Called "the TG-132 practice paper" below.

**The AAPM TG-132 report itself was not read.** Its numbers are given here
as these two papers report them, and the two do not report them alike (see
"Numbers from the literature"). Nothing was computed or tried. No commercial
system was examined; what they offer is as the consensus paper says, which
is that many of these measures are missing from commercial software.

## The candidates

| Measure                                  | What it tells                                                                                                  | What it needs                              | Cost, and where                                                          | Its limits                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jacobian determinant                     | Local change of volume: 1 is none, below 1 compression, above 1 expansion. At or below 0 the field folds.      | The field alone                            | Differences between neighbouring vectors: cheap. CPU; the map on the GPU | Plausibility, not accuracy: a smooth field can be smoothly wrong. Where tissue truly expands, compresses or slides, values far from 1 may be right. |
| Target registration error                | The distance, in mm, between where a landmark was mapped to and where it is.                                   | Landmark pairs placed by the user          | Trivial. CPU                                                             | Only where landmarks are. Includes the error of placing them. The consensus paper calls it the benchmark for commissioning.                         |
| Distance to agreement (surface distance) | How far a mapped contour lies from the one drawn on the other image: mean, a high percentile, the maximum.     | The same structure on both images          | A distance map of a label volume: moderate. CPU, in a worker             | Includes how differently two people draw. Implementations differ, so ours must say exactly what it measures.                                        |
| Dice coefficient                         | Overlap of the two volumes, 0 to 1.                                                                            | The same structure on both images          | Counting voxels: cheap. CPU                                              | Depends on the structure's size and shape: a large organ scores well with a poor boundary. The consensus paper prefers distances.                   |
| Hausdorff distance                       | The largest surface distance.                                                                                  | As distance to agreement                   | As distance to agreement                                                 | One stray voxel decides it. A percentile (the 95th) is steadier.                                                                                    |
| Inverse consistency error                | How far a point is from where it began after going there and back.                                             | A registration each way                    | Two field look-ups for each point: cheap. CPU or GPU                     | Needs the second registration. Consistent is not accurate: both can be wrong together.                                                              |
| Harmonic or bending energy               | How smooth the field is.                                                                                       | The field alone                            | First or second differences: cheap. CPU or GPU                           | The value has no scale anyone can read; useful only to compare, or as a map to see where the field is rough.                                        |
| Image similarity after registration      | Whether intensities agree: correlation or structural similarity for like images, mutual information for unlike | Both images and the field                  | A resampling of the moving image, then a pass over it: moderate. GPU     | Biased when it is what the registration optimised. Hard to read as a number. Correlation and structural similarity are for one modality only.       |
| Transitivity, distance to discordance    | Whether going round three or more images returns to the start.                                                 | Three or more images, registered every way | Many registrations                                                       | Says how the algorithm behaves on a set, not how good one registration is.                                                                          |
| Curl                                     | Vortices in the field.                                                                                         | The field alone                            | Cheap                                                                    | Experimental, by the consensus paper's account.                                                                                                     |

## The order, and why

**First: the Jacobian determinant.** It needs nothing from the user, so it
can be shown for every deformable registration there is. It catches the one
thing that is wrong whatever the anatomy: a field that folds space over
itself. Show the map (#83), and beside it the smallest and largest value,
the 1st and 99th percentiles, and the fraction of the field at or below 0
and above 2. For a field between two matrices (`pre` and `post` of the
model), the determinant is that of `I + ∇field`, times the determinants of
the two matrices, which are 1 when they are rigid.

**Second: target registration error.** It is the only measure here of
accuracy that does not lean on someone's contours, and the landmark tool is
planned anyway (#85). Give each landmark's error and direction, then the
mean, the standard deviation and the maximum, and how many landmarks there
were: three landmarks say little, and the table should make that plain.

**Third: contour distances, with Dice.** Structures are what a radiotherapy
user has already drawn, so this costs them nothing new (#86). Lead with the
mean surface distance and the 95th percentile, in millimetres; give the
maximum and Dice after them. State with the numbers how they were measured:
between the surfaces of the two label volumes, both ways and averaged, at
the voxel size of the grid they were compared on.

**Fourth: inverse consistency**, once there is a registration each way. The
model does not invert a field (`docs/architecture.md`, "Registrations"), so
this exists only when both were computed. As a map and as a mean and
maximum.

**Later:** harmonic or bending energy as a map, for seeing where a field is
rough. Image similarity as a number: the viewer's fusion and checkerboard
views already let the eye judge whether the images agree, and a look at the
registered image is what the consensus paper names as the least to do.

**Not planned:** transitivity and distance to discordance (they judge an
algorithm over a set of images, and need many registrations), and curl.

## How to word it

The application is not for clinical use, and these measures do not make a
registration fit for anything. So:

- **A value, its unit, and what it was measured on.** Never "passed",
  "failed", "acceptable", a tick or a colour that means one.
- **A range from the literature may be shown beside a value, as what it
  is**: "Published guidance commonly cites …", with the source named. Not
  as a limit the application applies.
- **Each measure says what it cannot tell**, in a line, where it is shown.
  For the Jacobian determinant: "Shows whether the deformation is physically
  plausible, not whether it is right." For landmarks: "Measured at N
  landmarks only." For contours: "Includes the difference between the two
  delineations." For inverse consistency: "Consistent is not the same as
  accurate."
- **Folding is said in words**: "The field folds in 0.3 % of its volume",
  not only as a minimum below zero.
- The report (#87) carries the same sentences and the notice that the
  application is not for clinical use.

## Numbers from the literature

For the wording above, and to show why none of them should be built in as a
limit. As the two papers report them:

| Measure                    | The consensus paper (its Table 1)                        | The TG-132 practice paper, of TG-132  |
| -------------------------- | -------------------------------------------------------- | ------------------------------------- |
| Target registration error  | 2 to 3 mm                                                | Mean under 2 mm, maximum under 5 mm   |
| Distance to agreement      | 2 to 3 mm; suggests a 90th to 99th percentile            | Named as recommended; no number given |
| Dice                       | 0.75 to 0.90                                             | 0.8 to 0.9                            |
| Jacobian determinant       | 0 to 2, near 1 but for expansion, compression or sliding | Not discussed                         |
| Inverse consistency        | Twice the voxel size                                     | No number given                       |
| Structural similarity, NCC | 0.8 to 0.9                                               | Not discussed                         |

The two do not agree on what TG-132 says for target registration error or
for Dice. **Before any of these numbers is shown in the application, TG-132
itself has to be read**, and the wording checked by someone who works with
it.

## What follows for the issues

- #83 (field visualisation): the Jacobian determinant map comes first of
  its views. Built with the displacement wash; see "A registration by a
  deformation field in the viewer" in `architecture.md`. The map has no
  limits drawn on it either: its legend says compression, no change,
  expansion, and that stripes are a fold.
- #84 (field-based metrics): the Jacobian determinant's numbers first;
  inverse consistency second, only when both directions exist; harmonic
  energy last. The first is built: see "Field measures as built".
- #85 (landmarks): as planned; add the count of landmarks and the
  per-landmark table.
- #86 (contour metrics): lead with surface distances (mean, 95th
  percentile, maximum); Dice beside them, not instead.
- #87 (report): the wording rules above.

## Contour metrics as built

What #86 measures is stated in `packages/dicom/src/contour-metrics.ts`, and
with the numbers where they are shown. In short:

- The two structures are filled into voxels of the image they are shown on,
  as a structure is when it is taken up for editing: a voxel is in when its
  centre is inside a contour on its slice.
- A surface voxel is one with a face neighbour outside. The distance from it
  to the other surface is between voxel centres, in mm, to the nearest
  surface voxel of the other. It is exact for the voxels (a distance
  transform, checked against trying every pair), and so in steps of the
  grid.
- Each direction has its mean, 95th percentile (nearest rank) and maximum.
  The mean that is shown is over both directions' distances together; the
  95th percentile and the maximum are the larger of the two directions'.
  Both directions are shown beside them.
- Dice is twice the voxels in both over the voxels in the one plus the
  other.

Other programs choose otherwise at each of these points (how a surface is
taken, whether the two directions are pooled or averaged, how a percentile
is read), and their numbers will differ from these by about a voxel. That
was not measured against another program here.

Not done: a grid whose slices are tilted is refused. Painted structures are
not offered, only those of the structure sets. The work is done in the
page, which does not answer meanwhile: about a second and a half for a
lung, four for a body outline, on a grid of 512 × 512 × 200 (#237).

## Target registration error as built

What #85 measures is stated in `packages/dicom/src/landmarks.ts`, and with
the numbers where they are shown. In short:

- A landmark is one place of the anatomy, pointed at in the base image and
  in the image compared with it. Its point in the base image is kept in the
  base image's frame of reference, its point in the other image in that
  image's own frame, each in mm. So the landmarks do not depend on a
  registration, and the same landmarks can be held against one registration
  after another.
- The error at a landmark is from its point in the base image to where the
  registration puts its point of the other image: its length in mm, and how
  far along the patient's left, back and head.
- Over the landmarks that have both points: how many, the mean, the standard
  deviation (over n − 1; none for one landmark) and the maximum. The count
  comes first, and "Measured at N landmarks only. Includes the error of
  placing them." is under the numbers.
- The registration is the one that places the compared image at that moment:
  one from a file, one chosen among several, or one being made by hand, whose
  numbers the errors follow as they change. The panel says which. With both
  images in one frame of reference there is none, and the two points are
  compared as they are.

A point is placed by a click in the Compare layout: the base image's column
gives the base image's point, the other column the other image's. That
column shows the other image through the registration in use, so two clicks
at the same place of the screen make a landmark with no error under that
registration. A landmark says something about a registration only when each
point was put on the anatomy in its own image.

Landmarks are saved as a JSON file (`open-rt-studio.landmarks`, version 1)
that names the two frames of reference, each landmark's name and its two
points, and nothing else of the patient. A file of other frames of
reference is refused. Landmarks are not kept by the server, and are let go
of when another base image is shown.

Not done: a point is where the click was on the slice on screen, to no
finer than the picture; nothing snaps to an edge or a centre. Under a
deformation field the error is measured in the compared image's frame, not
the base image's, since a field maps one way (#77; the panel says so). The
numbers were not compared with another program's.

## Field measures as built

What #84 measures is stated in `packages/dicom/src/field-metrics.ts`, and
with the numbers where they are shown. In short:

- **The Jacobian determinant** is worked out at each vector of the field's
  grid. The change of the field along each of the grid's three directions is
  taken from the vector's neighbours: half the difference of the two on
  either side, or at a face of the grid the difference to the one neighbour
  there is. The determinant is that of `I + ∇field`, times the determinants
  of the matrices before and after the field. That is the gradient at the
  grid's points, not of what is read between them.
- Its numbers: the smallest and largest, the mean, the 1st and 99th
  percentiles (by nearest rank), and the part above 2. Whether the field
  folds is said in a sentence: "The field folds in 0.3 % of its volume: the
  determinant is at or below 0 at N of M vectors", or that it does not fold.
  A part that is there is never rounded to nothing ("under 0.1 %").
- **The displacement** is the length of each vector in mm: the mean, the
  95th percentile and the largest. It is of the field alone; the
  registration's matrices move the image besides, and the panel says so.
- A percentage is of the grid's vectors, each standing for the same volume.
  A vector that is undefined, or that needs an undefined neighbour, has no
  determinant, and how many there are is said.
- **Inside a structure** of the base image the same numbers are of the
  vectors that lie in it: those whose place falls in a voxel of the image
  that the structure fills (filled as for a comparison of structures). The
  panel says how many vectors that is, of how many. A field coarser than a
  structure may have few vectors in it or none, and then the panel says that
  there is nothing to measure there.
- "Shows whether the deformation is physically plausible, not whether it is
  right." is under the numbers. No value is shown as passed or failed, and no
  range from the literature is shown beside one.

The numbers are worked out when asked for, of the field that places the
image on screen, and are shown only for that field and that structure. With
the field left out ("Deformation off") no field is in use and the panel is
not shown.

Tested against fields with a known determinant: nothing moved, everything
moved alike, a field `A · p` (det(I + A), also on a grid tilted in the
patient), a squeeze along one axis, a sine swell, a field that turns back on
itself, and the synthetic field of `packages/testdata`, whose determinant is
a formula (`syntheticDeformationJacobian`): the grid's numbers are within
0.02 of it inside the grid.

Not done: inverse consistency, which needs a registration each way; harmonic
or bending energy. A structure of the
compared image is not offered, only those of the base image. The numbers
were not compared with another program's. A large field is measured in the
page's own thread, as structures are compared (#237).

## Sources

- [Tools and recommendations for commissioning and quality assurance of deformable image registration in radiotherapy](https://pmc.ncbi.nlm.nih.gov/articles/PMC11424976/)
  (Bosma et al., 2024)
- [Practical quantification of image registration accuracy following the AAPM TG-132 report framework](https://pmc.ncbi.nlm.nih.gov/articles/PMC6036411/)
  (2018)
- Search results that led to them, and that mention a 2024 comparison of two
  commercial systems against the TG-132 phantoms and a thoracic study that
  found negative Jacobian determinants where its other measures were within
  tolerance; neither was read.
