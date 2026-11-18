/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ors-make-deformed-pair: the synthetic pair of the deformable registration
// tests (synthetic_deformation.h).
//
//   ors-make-deformed-pair write <fixed.mha> <moving.mha>
//       writes the two volumes
//   ors-make-deformed-pair rigid <file.json>
//       writes the turn and move between the two frames, as a file to start from
//   ors-make-deformed-pair nearby <file.json>
//       writes a start that is near and not right
//   ors-make-deformed-pair check <result.json> <field.mha> <mean mm> <95th percentile mm>
//       compares a result with the truth: at points all through the inside
//       of the phantom, how far what was found puts a point from where the
//       formulas put it
//
// Written by hand, with nothing of ITK or elastix in it.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "synthetic_deformation.h"

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
writeVolume(const std::string & path, const deformed::Grid & grid, bool moving)
{
  double matrix[16];
  deformed::rigid(matrix);

  std::ofstream file(path, std::ios::binary);
  if (!file)
  {
    return false;
  }
  file << "ObjectType = Image\nNDims = 3\nBinaryData = True\nBinaryDataByteOrderMSB = False\n"
       << "CompressedData = False\nTransformMatrix = 1 0 0 0 1 0 0 0 1\nOffset = " << exact(grid.origin[0]) << ' '
       << exact(grid.origin[1]) << ' ' << exact(grid.origin[2])
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
        deformed::positionOf(grid, i, j, k, here);
        if (moving)
        {
          // M(q) = P(A⁻¹ · q)
          deformed::applyInverse(matrix, here, inPhantom);
        }
        else
        {
          // F(p) = P(p + u(p))
          double u[3];
          deformed::deformationAt(here, u);
          for (int c = 0; c < 3; ++c)
          {
            inPhantom[c] = here[c] + u[c];
          }
        }
        const long     rounded = std::lround(deformed::phantomAt(inPhantom));
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
writeMatrix(const std::string & path, const double matrix[16])
{
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

/** The numbers after a name in a JSON file the tool wrote. */
bool
readNumbers(const std::string & text, const std::string & name, double * values, int count)
{
  const auto at = text.find("\"" + name + "\"");
  const auto open = at == std::string::npos ? at : text.find('[', at);
  if (open == std::string::npos)
  {
    return false;
  }
  const char * from = text.c_str() + open + 1;
  for (int i = 0; i < count; ++i)
  {
    char * end = nullptr;
    values[i] = std::strtod(from, &end);
    if (end == from)
    {
      return false;
    }
    from = end;
    while (*from == ',' || *from == ' ')
    {
      ++from;
    }
  }
  return true;
}

struct Field
{
  int                size[3];
  double             spacing[3];
  double             origin[3];
  double             axes[3][3];
  std::vector<float> vectors;
};

/** The numbers of one line of a MetaImage header. */
bool
headerLine(const std::string & header, const std::string & name, double * values, int count)
{
  const auto at = header.find(name + " = ");
  if (at == std::string::npos || (at != 0 && header[at - 1] != '\n'))
  {
    return false;
  }
  const char * from = header.c_str() + at + name.size() + 3;
  for (int i = 0; i < count; ++i)
  {
    char * end = nullptr;
    values[i] = std::strtod(from, &end);
    if (end == from)
    {
      return false;
    }
    from = end;
  }
  return true;
}

bool
readField(const std::string & path, Field & field)
{
  std::ifstream file(path, std::ios::binary);
  if (!file)
  {
    return false;
  }
  std::stringstream held;
  held << file.rdbuf();
  const std::string bytes = held.str();
  const std::string last = "ElementDataFile = LOCAL\n";
  const auto        end = bytes.find(last);
  if (end == std::string::npos)
  {
    return false;
  }
  const std::string header = bytes.substr(0, end + last.size());
  double            size[3], axes[9], channels[1];
  if (!headerLine(header, "DimSize", size, 3) || !headerLine(header, "ElementSpacing", field.spacing, 3) ||
      !headerLine(header, "Offset", field.origin, 3) || !headerLine(header, "TransformMatrix", axes, 9) ||
      !headerLine(header, "ElementNumberOfChannels", channels, 1) || channels[0] != 3.0 ||
      header.find("ElementType = MET_FLOAT\n") == std::string::npos)
  {
    return false;
  }
  std::size_t count = 3;
  for (int axis = 0; axis < 3; ++axis)
  {
    field.size[axis] = static_cast<int>(size[axis]);
    count *= static_cast<std::size_t>(field.size[axis]);
    for (int c = 0; c < 3; ++c)
    {
      field.axes[axis][c] = axes[3 * axis + c];
    }
  }
  if (bytes.size() != header.size() + 4 * count)
  {
    return false;
  }
  field.vectors.resize(count);
  for (std::size_t i = 0; i < count; ++i)
  {
    const auto *  at = reinterpret_cast<const unsigned char *>(bytes.data() + header.size() + 4 * i);
    std::uint32_t bits = at[0] | (at[1] << 8) | (at[2] << 16) | (static_cast<std::uint32_t>(at[3]) << 24);
    std::memcpy(&field.vectors[i], &bits, 4);
  }
  return true;
}

/** The field at a point, between its vectors in straight lines; false outside it. */
bool
fieldAt(const Field & field, const double p[3], double vector[3])
{
  int    base[3];
  double part[3];
  for (int axis = 0; axis < 3; ++axis)
  {
    double along = 0.0;
    for (int c = 0; c < 3; ++c)
    {
      along += (p[c] - field.origin[c]) * field.axes[axis][c];
    }
    along /= field.spacing[axis];
    if (along < -1e-6 || along > field.size[axis] - 1 + 1e-6)
    {
      return false;
    }
    base[axis] = std::min(std::max(static_cast<int>(std::floor(along)), 0), std::max(field.size[axis] - 2, 0));
    part[axis] = field.size[axis] > 1 ? along - base[axis] : 0.0;
  }
  vector[0] = vector[1] = vector[2] = 0.0;
  for (int corner = 0; corner < 8; ++corner)
  {
    int    index[3];
    double weight = 1.0;
    for (int axis = 0; axis < 3; ++axis)
    {
      const int step = (corner >> axis) & 1;
      index[axis] = std::min(base[axis] + step, field.size[axis] - 1);
      weight *= step ? part[axis] : 1.0 - part[axis];
    }
    const std::size_t at =
      3 * ((static_cast<std::size_t>(index[2]) * field.size[1] + index[1]) * field.size[0] + index[0]);
    for (int c = 0; c < 3; ++c)
    {
      vector[c] += weight * field.vectors[at + c];
    }
  }
  return true;
}

int
check(const std::string & resultPath, const std::string & fieldPath, double meanAtMost, double mostAtMost)
{
  std::ifstream     file(resultPath, std::ios::binary);
  std::stringstream held;
  held << file.rdbuf();
  double after[16];
  Field  field;
  if (!file || !readNumbers(held.str(), "fixedToMovingAfterField", after, 16))
  {
    std::fprintf(stderr, "no matrix in the result\n");
    return 1;
  }
  if (!readField(fieldPath, field))
  {
    std::fprintf(stderr, "the field file is not one\n");
    return 1;
  }

  // Points 6 mm apart, well inside the phantom: at its edge and outside it
  // there is nothing to register on, and nothing is claimed there.
  std::vector<double> errors;
  double              without = 0.0;
  for (double z = -60.0; z <= 60.0; z += 6.0)
  {
    for (double y = -60.0; y <= 60.0; y += 6.0)
    {
      for (double x = -72.0; x <= 72.0; x += 6.0)
      {
        const double p[3] = { x, y, z };
        if (deformed::depth(p) > 0.8)
        {
          continue;
        }
        double vector[3], truth[3], found[3], u[3];
        if (!fieldAt(field, p, vector))
        {
          std::fprintf(stderr, "the field does not reach a point of the phantom\n");
          return 1;
        }
        const double moved[3] = { p[0] + vector[0], p[1] + vector[1], p[2] + vector[2] };
        deformed::apply(after, moved, found);
        deformed::fixedToMoving(p, truth);
        errors.push_back(std::sqrt((found[0] - truth[0]) * (found[0] - truth[0]) +
                                   (found[1] - truth[1]) * (found[1] - truth[1]) +
                                   (found[2] - truth[2]) * (found[2] - truth[2])));
        deformed::deformationAt(p, u);
        without += std::sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
      }
    }
  }
  std::sort(errors.begin(), errors.end());
  double sum = 0.0;
  for (const double error : errors)
  {
    sum += error;
  }
  const double count = static_cast<double>(errors.size());
  const double mean = sum / count;
  const double most = errors[static_cast<std::size_t>(0.95 * (count - 1.0))];
  // `deformationMeanMm` is how far the points are moved by the deformation
  // alone: what the error would be had the exact turn and move been used
  // and no field.
  std::printf("{\"points\":%zu,\"meanMm\":%.3f,\"p95Mm\":%.3f,\"worstMm\":%.3f,\"deformationMeanMm\":%.3f,"
              "\"meanAtMostMm\":%.2f,\"p95AtMostMm\":%.2f}\n",
              errors.size(),
              mean,
              most,
              errors.back(),
              without / count,
              meanAtMost,
              mostAtMost);
  return mean <= meanAtMost && most <= mostAtMost ? 0 : 1;
}

} // namespace

int
main(int argc, char * argv[])
{
  const std::string command = argc > 1 ? argv[1] : "";
  double            matrix[16];
  if (command == "write" && argc == 4)
  {
    return writeVolume(argv[2], deformed::fixedGrid(), false) && writeVolume(argv[3], deformed::movingGrid(), true)
             ? 0
             : 1;
  }
  if (command == "rigid" && argc == 3)
  {
    deformed::rigid(matrix);
    return writeMatrix(argv[2], matrix);
  }
  if (command == "nearby" && argc == 3)
  {
    deformed::rigidNearby(matrix);
    return writeMatrix(argv[2], matrix);
  }
  if (command == "check" && argc == 6)
  {
    return check(argv[2], argv[3], std::strtod(argv[4], nullptr), std::strtod(argv[5], nullptr));
  }
  std::fprintf(stderr, "usage: ors-make-deformed-pair write <fixed> <moving> | rigid <file> | nearby <file> | "
                       "check <result> <field> <mean mm> <p95 mm>\n");
  return 2;
}
