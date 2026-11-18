/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ors-make-registration-pair: the synthetic pair of the registration tests.
//
//   ors-make-registration-pair write <fixed.mha> <moving.mha>
//       writes the two volumes
//   ors-make-registration-pair truth <file.json>
//       writes the transform they were made with, as the tool writes one
//   ors-make-registration-pair check <result.json> <tolerance in mm>
//       compares a result with the truth: how far apart the two put the
//       eight corners of the fixed volume, at worst
//
// Written by hand, with nothing of ITK or elastix in it.

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "synthetic_pair.h"

namespace
{

/** As exactly as a double can be written. */
std::string
exact(double value)
{
  char text[32];
  std::snprintf(text, sizeof(text), "%.17g", value);
  return text;
}

bool
writeVolume(const std::string & path, const pair::Grid & grid, bool moving)
{
  double truth[16];
  pair::fixedToMoving(truth);

  std::ofstream file(path, std::ios::binary);
  if (!file)
  {
    return false;
  }
  file << "ObjectType = Image\nNDims = 3\nBinaryData = True\nBinaryDataByteOrderMSB = False\n"
       << "CompressedData = False\nTransformMatrix =";
  for (int axis = 0; axis < 3; ++axis)
  {
    for (int c = 0; c < 3; ++c)
    {
      file << ' ' << exact(grid.direction[axis][c]);
    }
  }
  file << "\nOffset = " << exact(grid.origin[0]) << ' ' << exact(grid.origin[1]) << ' ' << exact(grid.origin[2])
       << "\nCenterOfRotation = 0 0 0\nElementSpacing = " << exact(grid.spacing[0]) << ' ' << exact(grid.spacing[1])
       << ' ' << exact(grid.spacing[2]) << "\nDimSize = " << grid.size[0] << ' ' << grid.size[1] << ' ' << grid.size[2]
       << "\nElementType = MET_SHORT\nElementDataFile = LOCAL\n";
  for (int k = 0; k < grid.size[2]; ++k)
  {
    for (int j = 0; j < grid.size[1]; ++j)
    {
      for (int i = 0; i < grid.size[0]; ++i)
      {
        double here[3], inPhantom[3];
        pair::positionOf(grid, i, j, k, here);
        if (moving)
        {
          // The moving volume shows the phantom where the transform puts it.
          pair::movingToFixedPoint(truth, here, inPhantom);
        }
        else
        {
          inPhantom[0] = here[0];
          inPhantom[1] = here[1];
          inPhantom[2] = here[2];
        }
        const long     rounded = std::lround(pair::phantomAt(inPhantom));
        const unsigned value = static_cast<unsigned>(rounded) & 0xffffu;
        file.put(static_cast<char>(value & 0xffu));
        file.put(static_cast<char>((value >> 8) & 0xffu));
      }
    }
  }
  file.close();
  return static_cast<bool>(file);
}

int
truth(const std::string & path)
{
  double matrix[16];
  pair::fixedToMoving(matrix);
  std::ofstream file(path, std::ios::binary);
  file << "{\"fixedToMoving\":[";
  for (int i = 0; i < 16; ++i)
  {
    file << (i == 0 ? "" : ",") << exact(matrix[i]);
  }
  file << "]}\n";
  file.close();
  return file ? 0 : 1;
}

/** The sixteen numbers after "fixedToMoving" in a file the tool wrote. */
bool
readMatrix(const std::string & path, double matrix[16])
{
  std::ifstream file(path, std::ios::binary);
  if (!file)
  {
    return false;
  }
  std::stringstream held;
  held << file.rdbuf();
  const std::string text = held.str();
  const auto        name = text.find("\"fixedToMoving\"");
  const auto        open = name == std::string::npos ? name : text.find('[', name);
  if (open == std::string::npos)
  {
    return false;
  }
  const char * at = text.c_str() + open + 1;
  for (int i = 0; i < 16; ++i)
  {
    char * end = nullptr;
    matrix[i] = std::strtod(at, &end);
    if (end == at)
    {
      return false;
    }
    at = end;
    while (*at == ',' || *at == ' ')
    {
      ++at;
    }
  }
  return true;
}

int
check(const std::string & path, double tolerance)
{
  double found[16], expected[16];
  if (!readMatrix(path, found))
  {
    std::fprintf(stderr, "no matrix in the result\n");
    return 1;
  }
  pair::fixedToMoving(expected);
  const pair::Grid grid = pair::fixedGrid();
  double           worst = 0.0;
  for (int corner = 0; corner < 8; ++corner)
  {
    double at[3], a[3], b[3];
    pair::positionOf(grid,
                     (corner & 1) ? grid.size[0] - 1 : 0,
                     (corner & 2) ? grid.size[1] - 1 : 0,
                     (corner & 4) ? grid.size[2] - 1 : 0,
                     at);
    pair::apply(found, at, a);
    pair::apply(expected, at, b);
    const double apart =
      std::sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]));
    worst = apart > worst ? apart : worst;
  }
  std::printf("{\"worstCornerMm\":%.4f,\"toleranceMm\":%.2f}\n", worst, tolerance);
  return worst <= tolerance ? 0 : 1;
}

} // namespace

int
main(int argc, char * argv[])
{
  const std::string command = argc > 1 ? argv[1] : "";
  if (command == "write" && argc == 4)
  {
    return writeVolume(argv[2], pair::fixedGrid(), false) && writeVolume(argv[3], pair::movingGrid(), true) ? 0 : 1;
  }
  if (command == "truth" && argc == 3)
  {
    return truth(argv[2]);
  }
  if (command == "check" && argc == 4)
  {
    return check(argv[2], std::strtod(argv[3], nullptr));
  }
  std::fprintf(stderr, "usage: ors-make-registration-pair write <fixed> <moving> | truth <file> | check <result> <mm>\n");
  return 2;
}
