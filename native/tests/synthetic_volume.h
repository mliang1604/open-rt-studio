/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The synthetic volume of the tests, as a formula: its geometry and what
// each voxel holds. A test states what it expects from these and copies no
// number.

#ifndef synthetic_volume_h
#define synthetic_volume_h

namespace synthetic
{

// Voxels along each axis.
constexpr int SIZE[3] = { 12, 10, 8 };

// Millimetres between voxel centres: different along every axis.
constexpr double SPACING[3] = { 0.9, 1.1, 2.5 };

// Where the centre of the first voxel is, in millimetres.
constexpr double ORIGIN[3] = { -12.5, 30.25, -100.0 };

// The way each axis points: turned 30 degrees about the third, so that a
// reader that swaps rows and columns of the matrix is found out.
constexpr double COSINE = 0.866025403784438647;
constexpr double SINE = 0.5;
constexpr double DIRECTION[3][3] = { { COSINE, SINE, 0.0 }, { -SINE, COSINE, 0.0 }, { 0.0, 0.0, 1.0 } };

/** What the voxel at (i, j, k) holds: a signed 16-bit number. */
constexpr int
valueAt(int i, int j, int k)
{
  return i + 10 * j + 100 * k - 500;
}

constexpr int LOWEST = valueAt(0, 0, 0);
constexpr int HIGHEST = valueAt(SIZE[0] - 1, SIZE[1] - 1, SIZE[2] - 1);

} // namespace synthetic

#endif
