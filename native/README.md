# native

C++ command-line tools built on ITK and elastix (registration and
resampling), which the server starts as jobs. They read and write files,
say what they did as JSON on standard output, and use no network.

This folder is not an npm workspace. See
[docs/architecture.md](../docs/architecture.md), "Native tools".

**Not for clinical use.**

## What is here

| Path                         | What it is                                                              |
| ---------------------------- | ----------------------------------------------------------------------- |
| `cmake/versions.cmake`       | The pinned versions: ITK 5.4.7 and elastix 5.3.1, each with a checksum  |
| `deps/`                      | The build of ITK and elastix themselves (long, and seldom needed again) |
| `CMakeLists.txt`             | The build of the tools, against what `deps/` built                      |
| `common/`                    | What every tool shares: reading a volume, and how a tool reports        |
| `tools/volume-info/`         | `ors-volume-info`: reads a volume and prints its geometry               |
| `tools/register-rigid/`      | `ors-register-rigid`: finds the rigid transform between two volumes     |
| `tools/register-deformable/` | `ors-register-deformable`: finds the deformation between two volumes    |
| `presets/deformable/`        | The presets of the deformable registration: elastix parameter files     |
| `tests/`                     | The tests, on volumes made from a formula                               |
| `THIRD-PARTY.md`             | What the tools are built on, with licences                              |

## Building

You need CMake 3.24 or newer and a C++17 compiler (Apple clang, GCC or
Visual Studio 2022). Ninja is used when it is installed. From the repository
root:

```sh
node scripts/native.mjs deps     # ITK and elastix: 15 to 30 minutes, once
node scripts/native.mjs build    # the tools, into native/build/dist
node scripts/native.mjs test     # their tests
```

`deps` fetches the two source archives named in `cmake/versions.cmake` from
GitHub, checks each against its checksum, and builds them as static
libraries into `native/build/prefix`. It runs their build scripts on your
machine. A second run finds them built and does nothing. Nothing is
installed outside `native/build`, which git ignores.

Settings, all optional:

| Variable               | What it does                                                                      |
| ---------------------- | --------------------------------------------------------------------------------- |
| `ORS_NATIVE_BUILD_DIR` | Where everything is built. On Windows use a short path (`C:\ors`): ITK needs one. |
| `ORS_NATIVE_ARCH`      | macOS: `arm64` or `x86_64`, to build for the other processor                      |
| `ORS_NATIVE_JOBS`      | How many compilations run at once                                                 |

Without the script, the same in CMake's own words:

```sh
cmake -S native/deps -B native/build/deps -DCMAKE_INSTALL_PREFIX=$PWD/native/build/prefix
cmake --build native/build/deps --config Release
cmake -S native -B native/build/tools -DORS_DEPS_PREFIX=$PWD/native/build/prefix
cmake --build native/build/tools --config Release
ctest --test-dir native/build/tools -C Release --output-on-failure
```

## What comes out

`native/build/dist/bin` holds the tools, `native/build/dist/presets` the
presets a tool is run with, and `native/build/dist/licenses` the licences of
what is inside the tools. Each tool is one file with nothing to
install beside it:

- **Linux**: the C++ runtime is linked in; the C library is the system's.
  Built on Ubuntu 22.04 in CI, the tools ask for glibc 2.34 or newer (the
  workflow prints the newest symbol they use).
- **macOS**: for macOS 12 or newer. CI builds for Apple silicon and for
  Intel separately and joins the two into universal programs.
- **Windows**: the C and C++ runtime is linked in, so no redistributable is
  needed: the only library a tool asks the system for is `KERNEL32.dll`.
  File names are taken as UTF-8.

## In CI

The `Native tools` workflow (`.github/workflows/native.yml`) runs when
something under `native/` or the script changes, or the server's job that
runs a tool (`services/server/src/registration`). It builds and tests on
Linux, macOS (both processors) and Windows, and uploads the tools of each
as an artifact, plus the universal macOS ones. On Linux it also runs the
server's registration job with the tool it has just built. The built ITK and elastix are
kept in the Actions cache, keyed by what they were built from, so a run
that changes only a tool builds in a minute or two. The tests then take
four to nine minutes, depending on the runner: they run a dozen whole
registrations.

## `ors-volume-info`

```sh
ors-volume-info volume.mha
```

```json
{
  "size": [12, 10, 8],
  "spacing": [0.9, 1.1, 2.5],
  "origin": [-12.5, 30.25, -100],
  "direction": [
    [0.866025404, 0.5, 0],
    [-0.5, 0.866025404, 0],
    [0, 0, 1]
  ],
  "stored": "short",
  "range": [-500, 301]
}
```

Millimetres, in the patient's coordinates as DICOM has them (LPS).
`direction` gives, for each axis of the volume, the way it points. It reads
MetaImage, NRRD and NIfTI volumes of three dimensions with one value to a
voxel.

A failure is one line of JSON on standard error and a status that is not
zero (2 for a command that makes no sense, 3 for a file that is no volume).
The line never names the file, because a path can hold a patient's name;
`--verbose` adds what ITK said, for someone at a terminal.

`ors-volume-info --version` prints the tool's version and the versions of
ITK and elastix it was built on.

## `ors-register-rigid`

```sh
ors-register-rigid --fixed planning.mha --moving follow-up.mha --output result.json
```

It registers the two volumes with elastix: mutual information on points
drawn at random, from coarse to fine in four steps, so the two need not
look alike (a CT and an MR, say). What it finds only turns and moves.

**What comes out** is a matrix, `fixedToMoving`: sixteen numbers, row by
row, in millimetres and the patient's coordinates (LPS). It maps the
coordinates of a point: given where something is in the fixed volume's
coordinates, it says where the same anatomy is in the moving volume's. That
is the way a registration is computed (for each place of the fixed volume,
where to look in the moving one); whoever wants the other way turns the
matrix round, as the server does when it stores the result.

The matrix is written to the `--output` file and reported on standard
output, with progress, in the lines the server's jobs read:

```
@progress 0.150 Registering
@progress 0.160 Registering
...
@progress 1.000 Done
@result {"fixedToMoving":[...],"seed":121212,"iterations":300,"resolutions":4}
```

Nothing else is written to standard output: what elastix logs is read for
progress and dropped.

| Option                    | What it does                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--initial <file>`        | A JSON file with a `fixedToMoving` matrix to start from; it must only turn and move. Without it, centre on centre |
| `--roi x0,y0,z0,x1,y1,z1` | A box in the fixed volume's coordinates, as two opposite corners in mm. Only what is inside it is compared        |
| `--seed <n>`              | The points are drawn at random. The same seed, with the same number of threads, gives the same matrix             |
| `--threads <n>`           | How many threads to use; all the processors without it                                                            |
| `--iterations <n>`        | Steps at each of the four resolutions; 300 without it                                                             |
| `--verbose`               | Passes on what elastix logs, and adds its words to a failure. For someone at a terminal                           |

A failure is one line of JSON on standard error with a code and no file
name: status 2 for a command that makes no sense (`usage`), 3 for an input
that cannot be used (`unreadable-fixed`, `unreadable-moving`, `bad-initial`,
`roi-empty`), 4 for a registration that did not succeed
(`registration-failed`, `not-rigid`, `cannot-write-output`).

It is a tool and no judge of its own answer: a registration that ends is
not thereby a good one. Nothing here measures how well two real images
were registered; someone has to look.

## `ors-register-deformable`

```sh
ors-register-deformable --fixed planning.mha --moving follow-up.mha \
  --preset presets/deformable/ct-ct.txt --initial rigid.json \
  --output result.json --field field.mha
```

It registers the two volumes with a B-spline in elastix, from coarse to
fine. How it compares the two, how far apart the B-spline's control points
are and how stiff it is come from the preset.

**What comes out** is a field of vectors and a matrix, which together map
the coordinates of a point: given where something is in the fixed volume's
coordinates, they say where the same anatomy is in the moving volume's.

    moving = fixedToMovingAfterField · (fixed + field(fixed))

- **The field** is laid out in the fixed volume's coordinates, over the
  fixed volume from its first voxel to its last, with vectors at most 4 mm
  apart (`--field-spacing`). The vectors are in millimetres along the
  patient's axes (LPS). It is written to the `--field` file as a MetaImage
  of three 32-bit values to a point. Between its vectors it is taken to
  run straight.
- **The matrix** only turns and moves, and is the one the registration
  started from: `--initial` (a JSON file with a `fixedToMoving` matrix, as
  `ors-register-rigid` writes one), or without it the move that puts the
  centre of the fixed volume on the centre of the moving one. Everything
  found beyond that is in the field. It is written to the `--output` file
  as JSON.
- That is the way a DICOM Deformable Spatial Registration object holds a
  registration, so the server stores it as it is.

It reports as `ors-register-rigid` does, and its result says a little about
the field:

```
@result {"fixedToMovingAfterField":[...],"size":[49,49,43],"spacing":[...],"largestMm":...,"points":103243,"insidePoints":23339,"largestInsideMm":...,"meanInsideMm":...,"foldedPoints":0,"seed":121212,"resolutions":4,"iterations":300}
```

`largestMm` is the longest vector. `foldedPoints` is how many points of the
field are where it folds space over itself (where what it does to a small
box turns the box inside out), which no anatomy does: more than a few says
the registration went wrong there. The tool counts them and judges nothing.

**Where the field means something.** The field covers the whole fixed
volume, the air around what was imaged too. There nothing in the images
holds it: what it is there is what the grid and its stiffness carry out
from where there is something, and its longest vector is usually there. So
the result also says what the field is inside the fixed volume's outline:
`insidePoints` of its points are, and `largestInsideMm` and `meanInsideMm`
are the longest and the mean vector at those (null when none is). The
outline is found on each slice: what is brighter than a threshold between
the volume's dark and its bright (Otsu's), and what that encloses on the
slice, as a chest wall encloses the lungs. It is a rough outline for a
number, not a contour of the patient, and it takes the bright for the
patient: of an image whose background is the brighter, it is everything.

| Option                                      | What it does                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--preset <file>`                           | An elastix parameter file: see below. Needed                                                    |
| `--initial <file>`                          | A JSON file with a `fixedToMoving` matrix to start from; it must only turn and move             |
| `--set Key=value`                           | Sets a parameter over the preset, for whoever knows elastix. Several values with spaces between |
| `--field-spacing <mm>`                      | How far apart the vectors of the field are, at most; 4 without it                               |
| `--roi`, `--seed`, `--threads`, `--verbose` | As for `ors-register-rigid`                                                                     |

**Presets** are in `presets/deformable`, one file each, with a title and a
description in its first lines:

| Preset    | For                     | Compares by                          | Control points | Stiffness |
| --------- | ----------------------- | ------------------------------------ | -------------- | --------- |
| `ct-ct`   | Two CTs of one patient  | Correlation of grey values           | 16 mm          | 1         |
| `cbct-ct` | A cone-beam CT and a CT | Mutual information, 64 steps of grey | 20 mm          | 5         |
| `mr-ct`   | An MR and a CT          | Mutual information, 64 steps of grey | 24 mm          | 10        |

Stiffness is the weight of elastix's bending energy penalty beside the
measure. **None of the three was tuned on real images**: the numbers are
elastix's usual ones for a B-spline registration, the differences between
them are what the three cases are generally held to need, and all were only
ever run on a synthetic phantom. Treat them as a place to start.

**What a preset does where nothing differs** (#351). Two series of one
smooth phantom, with nothing deformed between them and the rigid
registration to start from, should give a field of nothing. Inside the
phantom the two presets that go by mutual information gave 2.2 mm on
average (5.1 and 5.7 mm at most) with elastix's usual 32 steps of grey to
an image, and 0.8 and 0.9 mm (2.1 and 2.4 mm at most) with 64, which they
now have; the deformation of the tools' own test was found to 0.34 and
0.32 mm on average instead of 0.80 and 0.70. Where the image is smooth, a
step of grey is wider than what a millimetre changes, and the measure
cannot tell. A stiffer penalty (ten times), four times the samples and a
third of the step length each changed little. With noise in both images
(2 % and 5 % of their range) 64 steps were still the better: 1.0 and 1.4 mm
on average inside the smooth phantom, against 1.5 and 2.0. `ct-ct` on that
pair ends without a result (`registration-failed`): its moving series is
bright where the fixed one is dark, which is no pair of CTs, and a
correlation has nothing to find in it.

What the tool decides itself cannot be set, by a preset or by `--set`: that
the transform is a B-spline composed with the start, the seed, and
everything that names a file or has elastix write one. Such a line in a
preset is passed over; `--set` of one is refused (`fixed-parameter`).

A failure is as for `ors-register-rigid`, with `bad-preset` (status 3) for
a preset that is not there or is no parameter file, and `bad-parameter` or
`fixed-parameter` (status 2) for a `--set` that cannot be used.

Like the rigid tool it is no judge of its own answer.

## Tests

- `register-deformable`: a phantom full of blobs is deformed in the fixed
  volume by slow waves of up to 5 mm, and in the moving volume turned by 4
  and 2 degrees and moved by (60, -35, 20) mm into a frame of its own
  (`tests/synthetic_deformation.h`). At some 3300 points all through the
  inside of the phantom, what the tool found has to put a point within
  1 mm of where the formulas put it on average, and within 2 mm for 95 of
  a hundred; the voxels are 3 to 3.5 mm, and the deformation moves the
  points 3.6 mm on average. Each preset has to manage that from the exact
  turn and move. On the runners: 0.29 mm on average with `ct-ct` (0.60 mm
  at the 95th percentile), 0.32 mm with `cbct-ct`, 0.34 mm with `mr-ct`.
  What each result says of the field inside the outline has to be the
  deformation too: a little under a quarter of the field's points, moved
  3.3 to 3.5 mm on average and none more than 9.5 mm, while the longest
  vector of all, in the air around the phantom, is 10 mm.
  From a start that is 2 mm and a degree off, and from no start at all,
  `ct-ct` has to come within 1.5 mm on average (0.30 and 0.32 mm). The
  same seed has to give the same field twice, byte for byte; a parameter
  set over the preset, a region and a coarser field have to be used; and
  what it cannot use has to be refused with a code that names no file.
- `register-deformable-version`: the versions are the pinned ones.
- `register-rigid`: a phantom (an ellipsoid with four blobs, none placed
  symmetrically) is written on two different grids, in the second one
  turned by 6 and 3 degrees and moved by (7, -5, 4) mm
  (`tests/synthetic_pair.h`). The tool has to find that transform to within
  1 mm at the corners of the fixed volume, where a wrong turn shows most;
  the voxels are 3 to 4 mm. On the first runner that ran it the worst
  corner was 0.16 mm off. The same seed has to give the same matrix twice
  and another seed another; a region of interest and a matrix to start
  from have to be used; and what it cannot use has to be refused with a
  code that names no file. The pair and the measure are written by a small
  program that uses nothing of ITK or elastix.
- `register-rigid-version`: the versions are the pinned ones.
- `volume-info`: the tool reads a synthetic volume (oblique, with voxels
  that are not cubes) from a folder whose name is not ASCII, and prints the
  geometry it was written with. The volume is written by a small program
  that uses nothing of ITK.
- `volume-info-version`: the versions are the pinned ones.
- `toolchain-elastix`: elastix, linked into a program of ours, finds a known
  shift between two synthetic volumes to within half a millimetre. It says
  the libraries work on this system; it is no test of registration quality.

No image file is in the repository: test data is made from formulas
(`tests/synthetic_volume.h`, `tests/synthetic_pair.h`,
`tests/synthetic_deformation.h`).

## Moving to another version of ITK or elastix

Change the version, the address and the checksum together in
`cmake/versions.cmake`, build `deps`, build the tools (the build says if
ITK's set of modules changed), run the tests, and update `THIRD-PARTY.md`.
