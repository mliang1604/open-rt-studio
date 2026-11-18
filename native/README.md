# native

C++ command-line tools built on ITK and elastix (registration and
resampling), which the server starts as jobs. They read and write files,
say what they did as JSON on standard output, and use no network.

This folder is not an npm workspace. See
[docs/architecture.md](../docs/architecture.md), "Native tools".

**Not for clinical use.**

## What is here

| Path                   | What it is                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `cmake/versions.cmake` | The pinned versions: ITK 5.4.7 and elastix 5.3.1, each with a checksum  |
| `deps/`                | The build of ITK and elastix themselves (long, and seldom needed again) |
| `CMakeLists.txt`       | The build of the tools, against what `deps/` built                      |
| `tools/volume-info/`   | `ors-volume-info`: reads a volume and prints its geometry               |
| `tests/`               | The tests, on volumes made from a formula                               |
| `THIRD-PARTY.md`       | What the tools are built on, with licences                              |

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

- **Linux**: the C++ runtime is linked in; the C library is the system's
  (built on Ubuntu 22.04 in CI, so glibc 2.35 or newer).
- **macOS**: for macOS 12 or newer. CI builds for Apple silicon and for
  Intel separately and joins the two into universal programs.
- **Windows**: the C and C++ runtime is linked in, so no redistributable is
  needed. File names are taken as UTF-8.

## In CI

The `Native tools` workflow (`.github/workflows/native.yml`) runs when
something under `native/` or the script changes. It builds and tests on
Linux, macOS (both processors) and Windows, and uploads the tools of each
as an artifact, plus the universal macOS ones. The built ITK and elastix are
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

## Tests

- `volume-info`: the tool reads a synthetic volume (oblique, with voxels
  that are not cubes) from a folder whose name is not ASCII, and prints the
  geometry it was written with. The volume is written by a small program
  that uses nothing of ITK.
- `volume-info-version`: the versions are the pinned ones.
- `toolchain-elastix`: elastix, linked into a program of ours, finds a known
  shift between two synthetic volumes to within half a millimetre. It says
  the libraries work on this system; it is no test of registration quality.

No image file is in the repository: test data is made from a formula
(`tests/synthetic_volume.h`).

## Moving to another version of ITK or elastix

Change the version, the address and the checksum together in
`cmake/versions.cmake`, build `deps`, build the tools (the build says if
ITK's set of modules changed), run the tests, and update `THIRD-PARTY.md`.
