/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The synthetic pair of the deformable registration tests, as formulas: a
// phantom, a smooth deformation of it, and a rigid transform into another
// frame. A test states what it expects from these and copies no number.
//
// The phantom P is a soft-edged ellipsoid of water in air, full of blobs of
// different heights on a jittered lattice, so that there is something to
// follow everywhere inside it.
//
//   fixed volume:   F(p) = P(p + u(p))        u, the deformation, in mm
//   moving volume:  M(q) = P(A⁻¹ · q)         A, a turn and a move
//
// so the same anatomy that is at p in the fixed volume is at
//
//   g(p) = A · (p + u(p))
//
// in the moving one: the map a registration has to find, with nothing to
// invert to write either volume.

#ifndef synthetic_deformation_h
#define synthetic_deformation_h

#include <cmath>

namespace deformed
{

constexpr double PI = 3.14159265358979323846;

struct Grid
{
  int    size[3];
  double spacing[3];
  double origin[3];
};

/** Where the centre of voxel (i, j, k) of a grid is: the grids are along the axes of their frames. */
inline void
positionOf(const Grid & grid, int i, int j, int k, double point[3])
{
  point[0] = grid.origin[0] + i * grid.spacing[0];
  point[1] = grid.origin[1] + j * grid.spacing[1];
  point[2] = grid.origin[2] + k * grid.spacing[2];
}

/** The fixed volume's grid, with the phantom in its middle. */
inline Grid
fixedGrid()
{
  return Grid{ { 64, 64, 48 }, { 3.0, 3.0, 3.5 }, { -94.5, -94.5, -82.25 } };
}

/**
 * The turn and the move, `fixedToMoving` without the deformation, row by
 * row: 4 degrees about z, then 2 about y, and (60, -35, 20) mm, so that the
 * two frames are well apart, as those of two scanners are.
 */
inline void
rigid(double matrix[16])
{
  const double cz = std::cos(4.0 * PI / 180.0), sz = std::sin(4.0 * PI / 180.0);
  const double cy = std::cos(2.0 * PI / 180.0), sy = std::sin(2.0 * PI / 180.0);
  // Ry · Rz
  const double turn[3][3] = { { cy * cz, -cy * sz, sy }, { sz, cz, 0.0 }, { -sy * cz, sy * sz, cy } };
  const double move[3] = { 60.0, -35.0, 20.0 };
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

/** A start that is near and not right: the same with a degree more about x and 2 mm off. */
inline void
rigidNearby(double matrix[16])
{
  double exact[16];
  rigid(exact);
  const double c = std::cos(PI / 180.0), s = std::sin(PI / 180.0);
  const double more[3][3] = { { 1.0, 0.0, 0.0 }, { 0.0, c, -s }, { 0.0, s, c } };
  for (int row = 0; row < 3; ++row)
  {
    for (int column = 0; column < 3; ++column)
    {
      matrix[4 * row + column] = 0.0;
      for (int k = 0; k < 3; ++k)
      {
        matrix[4 * row + column] += more[row][k] * exact[4 * k + column];
      }
    }
  }
  matrix[3] = exact[3] + 1.5;
  matrix[7] = exact[7] - 1.0;
  matrix[11] = exact[11] + 0.8;
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

/** A point brought back through a matrix that only turns and moves. */
inline void
applyInverse(const double matrix[16], const double point[3], double mapped[3])
{
  for (int row = 0; row < 3; ++row)
  {
    mapped[row] = 0.0;
    for (int column = 0; column < 3; ++column)
    {
      mapped[row] += matrix[4 * column + row] * (point[column] - matrix[4 * column + 3]);
    }
  }
}

/** The moving volume's grid: another size and other spacings, its middle where the phantom's middle goes. */
inline Grid
movingGrid()
{
  double matrix[16];
  rigid(matrix);
  Grid grid{ { 62, 66, 50 }, { 3.2, 3.0, 3.4 }, { 0, 0, 0 } };
  for (int axis = 0; axis < 3; ++axis)
  {
    grid.origin[axis] = matrix[4 * axis + 3] - 0.5 * (grid.size[axis] - 1) * grid.spacing[axis];
  }
  return grid;
}

/**
 * The deformation u at a point of the fixed volume, in mm: slow waves, a
 * different one along each axis, up to 5 mm. Smooth over tens of
 * millimetres, as a B-spline with control points 16 to 24 mm apart can be.
 */
inline void
deformationAt(const double p[3], double u[3])
{
  u[0] = 5.0 * std::sin(2.0 * PI * p[1] / 150.0 + 0.3) * std::cos(2.0 * PI * p[2] / 170.0);
  u[1] = 4.0 * std::sin(2.0 * PI * p[2] / 140.0 + 1.1) * std::cos(2.0 * PI * p[0] / 160.0);
  u[2] = 3.5 * std::sin(2.0 * PI * p[0] / 130.0 + 2.0) * std::cos(2.0 * PI * p[1] / 180.0);
}

/** Where a point of the fixed volume is in the moving one: g(p) = A · (p + u(p)). */
inline void
fixedToMoving(const double p[3], double q[3])
{
  double matrix[16], u[3];
  rigid(matrix);
  deformationAt(p, u);
  const double moved[3] = { p[0] + u[0], p[1] + u[1], p[2] + u[2] };
  apply(matrix, moved, q);
}

/** How far inside the phantom a point is: 0 at its middle, 1 at its edge. */
inline double
depth(const double r[3])
{
  const double radii[3] = { 78.0, 66.0, 64.0 };
  double       squared = 0.0;
  for (int c = 0; c < 3; ++c)
  {
    squared += (r[c] / radii[c]) * (r[c] / radii[c]);
  }
  return std::sqrt(squared);
}

/** A number from 0 to 1 that is always the same for the same three whole numbers and looks like chance. */
inline double
scattered(int a, int b, int c, int which)
{
  unsigned int h = static_cast<unsigned int>(a * 73856093) ^ static_cast<unsigned int>(b * 19349663) ^
                   static_cast<unsigned int>(c * 83492791) ^ static_cast<unsigned int>(which * 2654435761u);
  h ^= h >> 13;
  h *= 0x5bd1e995u;
  h ^= h >> 15;
  return (h & 0xffffu) / 65535.0;
}

/** What the phantom holds at a point of its own coordinates, like CT numbers. */
inline double
phantomAt(const double r[3])
{
  const double inside = 1.0 / (1.0 + std::exp((depth(r) - 1.0) * 20.0));
  const double pitch = 26.0;
  const double width = 8.0;
  int          cell[3];
  for (int c = 0; c < 3; ++c)
  {
    cell[c] = static_cast<int>(std::floor(r[c] / pitch + 0.5));
  }
  double value = 0.0;
  for (int a = cell[0] - 1; a <= cell[0] + 1; ++a)
  {
    for (int b = cell[1] - 1; b <= cell[1] + 1; ++b)
    {
      for (int c = cell[2] - 1; c <= cell[2] + 1; ++c)
      {
        // Each blob a little off its place on the lattice, and of its own height.
        const double centre[3] = { a * pitch + 10.0 * (scattered(a, b, c, 1) - 0.5),
                                   b * pitch + 10.0 * (scattered(a, b, c, 2) - 0.5),
                                   c * pitch + 10.0 * (scattered(a, b, c, 3) - 0.5) };
        const double height = -450.0 + 1100.0 * scattered(a, b, c, 4);
        double       squared = 0.0;
        for (int k = 0; k < 3; ++k)
        {
          squared += (r[k] - centre[k]) * (r[k] - centre[k]);
        }
        value += height * std::exp(-squared / (2.0 * width * width));
      }
    }
  }
  return -1000.0 + inside * (1000.0 + value);
}

} // namespace deformed

#endif
