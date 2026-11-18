# native

C++ command-line tools built on ITK and elastix (registration and
resampling), which the server starts as jobs. They read and write files,
say what they did as JSON on standard output, and use no network.

This folder is not an npm workspace. See
[docs/architecture.md](../docs/architecture.md), "Native tools".

**Not for clinical use.**

## What is here

| Path                    | What it is                                                              |
| ----------------------- | ----------------------------------------------------------------------- |
| `cmake/versions.cmake`  | The pinned versions: ITK 5.4.7 and elastix 5.3.1, each with a checksum  |
| `deps/`                 | The build of ITK and elastix themselves (long, and seldom needed again) |
| `CMakeLists.txt`        | The build of the tools, against what `deps/` built                      |
| `common/`               | What every tool shares: reading a volume, and how a tool reports        |
| `tools/volume-info/`    | `ors-volume-info`: reads a volume and prints its geometry               |
| `tools/register-rigid/` | `ors-register-rigid`: finds the rigid transform between two volumes     |
| `tests/`                | The tests, on volumes made from a formula                               |
| `THIRD-PARTY.md`        | What the tools are built on, with licences                              |

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

`native/build/dist/bin` holds the tools and `native/build/dist/licenses` the
licences of what is inside them. Each tool is one file with nothing to
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
that changes only a tool takes a few minutes.

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

## Tests

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
(`tests/synthetic_volume.h`, `tests/synthetic_pair.h`).

## Moving to another version of ITK or elastix

Change the version, the address and the checksum together in
`cmake/versions.cmake`, build `deps`, build the tools (the build says if
ITK's set of modules changed), run the tests, and update `THIRD-PARTY.md`.
