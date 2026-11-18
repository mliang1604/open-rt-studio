# What the native tools are built on

The native tools are linked statically, so each program carries the
libraries below inside it. Their licence texts travel with the tools, in the
`licenses/` folder beside `bin/`.

None of it is GPL, AGPL or LGPL. What would have been is left out of the
build, and the build stops if it comes back (see "Left out").

## Pinned

| Library       | Licence    | From                                                                                          |
| ------------- | ---------- | --------------------------------------------------------------------------------------------- |
| ITK 5.4.7     | Apache 2.0 | The release archive, checked against the SHA-512 the release publishes                        |
| elastix 5.3.1 | Apache 2.0 | The archive of the commit its release tag names (`ef34ca99`), checked against a SHA-256 of it |

The versions, addresses and checksums are in
[`cmake/versions.cmake`](cmake/versions.cmake) and nowhere else. ITK's
`NOTICE` and elastix's `NOTICE` are carried with their licences, as Apache
2.0 asks.

## Inside ITK

ITK carries libraries of others. These are the ones in the modules the tools
are built with. The list is
[`cmake/itk_modules.cmake`](cmake/itk_modules.cmake); the build compares it
with what ITK says it was built with, and a test compares it with this table.

| ITK module            | Library                       | Licence                                         |
| --------------------- | ----------------------------- | ----------------------------------------------- |
| `ITKDoubleConversion` | double-conversion             | BSD 3-clause                                    |
| `ITKEigen3`           | Eigen                         | MPL 2.0 (built with `EIGEN_MPL2_ONLY`)          |
| `ITKExpat`            | Expat                         | MIT                                             |
| `ITKGDCM`             | GDCM (Grassroots DICOM)       | BSD 3-clause; see below for what it carries     |
| `ITKGIFTI`            | gifticlib                     | Public domain                                   |
| `ITKJPEG`             | libjpeg (IJG)                 | IJG licence                                     |
| `ITKKWSys`            | KWSys                         | BSD 3-clause                                    |
| `ITKMetaIO`           | MetaIO                        | Apache 2.0                                      |
| `ITKNIFTI`            | niftilib                      | Public domain                                   |
| `ITKNetlib`           | netlib (SLATEC routines)      | Public domain                                   |
| `ITKNrrdIO`           | NrrdIO                        | zlib-style (its own, not Teem's LGPL)           |
| `ITKPNG`              | libpng                        | PNG Reference Library License 2                 |
| `ITKTIFF`             | libtiff                       | libtiff licence (BSD-style)                     |
| `ITKVNL`              | VXL numerics (vnl, v3p)       | BSD 3-clause; v3p netlib routines public domain |
| `ITKVNLInstantiation` | (instantiations of the above) | BSD 3-clause                                    |
| `ITKZLIB`             | zlib-ng                       | zlib licence                                    |

GDCM in turn carries CharLS (BSD 3-clause), OpenJPEG (BSD 2-clause), libjpeg
(IJG), an MD5 routine and libuuid (BSD-style), an RLE codec (BSD) and
socket++ (a permissive notice of its own).

## Left out

- **FFTW** (GPL): ITK can use it; `ITK_USE_FFTWF` and `ITK_USE_FFTWD` are off.
- **ANN** (LGPL): elastix carries it for one metric,
  `KNNGraphAlphaMutualInformationMetric`, which is off, so ANN is not built.
- **LibTorch**: elastix's IMPACT metric needs it; the metric is off.
- **OpenCL**: off in both.
- **Anything fetched while building**: ITK is built with
  `ITK_FORBID_DOWNLOADS`, so no remote module comes in unseen.

A test (`scripts/native.spec.mjs`) fails when one of these settings is taken
out of the build.

## What was checked, and what was not

The licences above were read in ITK's and elastix's source archives for the
versions pinned here. The list of modules was worked out from ITK's module
descriptions and is checked against the real build by the build itself. No
lawyer has looked at any of this.
