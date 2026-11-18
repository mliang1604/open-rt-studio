/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The synthetic pair of the registration tests, as formulas: a phantom, the
// two grids it is sampled on, and the rigid transform between them. A test
// states what it expects from these and copies no number.
//
// The phantom is a soft-edged ellipsoid of water in air with four blobs in
// it, none of them placed symmetrically, so that only one pose fits.

#ifndef synthetic_pair_h
#define synthetic_pair_h

#include <cmath>

namespace pair
{

constexpr double PI = 3.14159265358979323846;

inline double
degrees(double angle)
{
  return angle * PI / 180.0;
}

struct Grid
{
  int    size[3];
  double spacing[3];
  double origin[3];
  // The way each axis points.
  double direction[3][3];
};

/** Where the centre of voxel (i, j, k) of a grid is, in millimetres. */
inline void
positionOf(const Grid & grid, int i, int j, int k, double point[3])
{
  const int index[3] = { i, j, k };
  for (int c = 0; c < 3; ++c)
  {
    point[c] = grid.origin[c];
    for (int axis = 0; axis < 3; ++axis)
    {
      point[c] += index[axis] * grid.spacing[axis] * grid.direction[axis][c];
    }
  }
}

/** The fixed volume's grid: along the patient's axes. */
inline Grid
fixedGrid()
{
  return Grid{ { 64, 64, 40 }, { 3.0, 3.0, 4.0 }, { -94.5, -94.5, -78.0 }, { { 1, 0, 0 }, { 0, 1, 0 }, { 0, 0, 1 } } };
}

/**
 * The moving volume's grid: another size, other spacings, and turned 5
 * degrees about the third axis, so that a tool that takes a grid for the
 * patient's axes is found out.
 */
inline Grid
movingGrid()
{
  const double c = std::cos(degrees(5.0));
  const double s = std::sin(degrees(5.0));
  Grid         grid{ { 60, 64, 44 }, { 3.2, 3.0, 3.6 }, { 0, 0, 0 }, { { c, s, 0 }, { -s, c, 0 }, { 0, 0, 1 } } };
  // Its middle is where the phantom's middle is in the moving volume.
  const double middle[3] = { 7.0, -5.0, 4.0 };
  for (int component = 0; component < 3; ++component)
  {
    grid.origin[component] = middle[component];
    for (int axis = 0; axis < 3; ++axis)
    {
      grid.origin[component] -= 0.5 * (grid.size[axis] - 1) * grid.spacing[axis] * grid.direction[axis][component];
    }
  }
  return grid;
}

/**
 * The transform between the two, `fixedToMoving`, row by row: where a point
 * of the fixed volume is in the moving one. A turn of 6 degrees about z,
 * then 3 about x, and a move of (7, -5, 4) mm.
 */
inline void
fixedToMoving(double matrix[16])
{
  const double cz = std::cos(degrees(6.0)), sz = std::sin(degrees(6.0));
  const double cx = std::cos(degrees(3.0)), sx = std::sin(degrees(3.0));
  // Rx · Rz
  const double turn[3][3] = { { cz, -sz, 0.0 }, { cx * sz, cx * cz, -sx }, { sx * sz, sx * cz, cx } };
  const double move[3] = { 7.0, -5.0, 4.0 };
  for (int row = 0; row < 3; ++row)
  {
    for (int column = 0; column < 3; ++column)
    {
      matrix[4 * row + column] = turn[row][column];
    }
    matrix[4 * row + 3] = move[row];
  }
  matrix[12] = matrix[13] = matrix[14] = 0.0;
  matrix[15] = 1.0;
}

inline void
apply(const double matrix[16], const double point[3], double mapped[3])
{
  for (int row = 0; row < 3; ++row)
  {
    mapped[row] = matrix[4 * row + 3];
    for (int column = 0; column < 3; ++column)
    {
      mapped[row] += matrix[4 * row + column] * point[column];
    }
  }
}

/** A point of the moving volume back in the fixed one: the transform turned round. */
inline void
movingToFixedPoint(const double matrix[16], const double point[3], double mapped[3])
{
  for (int row = 0; row < 3; ++row)
  {
    mapped[row] = 0.0;
    for (int column = 0; column < 3; ++column)
    {
      // The inverse of a turn is its transpose.
      mapped[row] += matrix[4 * column + row] * (point[column] - matrix[4 * column + 3]);
    }
  }
}

/** What the phantom holds at a point of its own (the fixed volume's) coordinates, like CT numbers. */
inline double
phantomAt(const double point[3])
{
  const double radii[3] = { 70.0, 55.0, 60.0 };
  double       r = 0.0;
  for (int c = 0; c < 3; ++c)
  {
    r += (point[c] / radii[c]) * (point[c] / radii[c]);
  }
  r = std::sqrt(r);
  const double inside = 1.0 / (1.0 + std::exp((r - 1.0) * 20.0));

  struct Blob
  {
    double height, width, centre[3];
  };
  const Blob blobs[4] = { { 800.0, 12.0, { 20.0, 10.0, 5.0 } },
                          { -600.0, 15.0, { -30.0, -15.0, -20.0 } },
                          { 500.0, 9.0, { 5.0, -35.0, 25.0 } },
                          { 300.0, 20.0, { -10.0, 30.0, -30.0 } } };
  double       value = 0.0;
  for (const Blob & blob : blobs)
  {
    double squared = 0.0;
    for (int c = 0; c < 3; ++c)
    {
      squared += (point[c] - blob.centre[c]) * (point[c] - blob.centre[c]);
    }
    value += blob.height * std::exp(-squared / (2.0 * blob.width * blob.width));
  }
  return -1000.0 + inside * (1000.0 + value);
}

} // namespace pair

#endif
