# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# The versions of what the native tools are built on, and the one place they
# are named. Each is fetched as an archive and checked against a checksum
# before anything of it is used: a different archive stops the build.
#
# To move to another version: change the version, the address and the
# checksum together, build, run the tests, and update native/THIRD-PARTY.md.

# ITK (Apache 2.0). The release archive, with the SHA-512 its release
# publishes beside it (SHA512SUMS).
set(ORS_ITK_VERSION 5.4.7)
set(ORS_ITK_URL
    "https://github.com/InsightSoftwareConsortium/ITK/releases/download/v${ORS_ITK_VERSION}/InsightToolkit-${ORS_ITK_VERSION}.tar.gz"
)
set(ORS_ITK_SHA512
    "5642b736fb209687d69e7064d96c9193589a8a862831627a66f7d169f3d7d9284637578c60785b4df967f0671b963b4ae465edf38d95b77b6bff01d16178d70a"
)

# elastix (Apache 2.0). Its releases carry no source archive of their own, so
# this is the archive of the commit the release tag names. The SHA-256 is of
# that archive as GitHub served it when this was written.
set(ORS_ELASTIX_VERSION 5.3.1)
set(ORS_ELASTIX_COMMIT ef34ca99d84c226d1bb72d534c8a201526a5c034)
set(ORS_ELASTIX_URL
    "https://github.com/SuperElastix/elastix/archive/${ORS_ELASTIX_COMMIT}.tar.gz"
)
set(ORS_ELASTIX_SHA256
    "ff17ecc4c4c4b2f4359c50c8b471ee8458b42c8cbbe14e9e90b16899e1d9c5d2"
)
