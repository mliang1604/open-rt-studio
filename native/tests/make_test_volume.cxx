/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ors-make-test-volume: writes the synthetic volume of the tests as a
// MetaImage file (.mha), or prints what a reader should say of it.
//
//   ors-make-test-volume <file.mha>   write the volume
//   ors-make-test-volume --expected   print the line ors-volume-info prints
//
// It is written by hand and uses nothing of ITK, so that the tool under
// test reads a file its own library did not write.

#include <cstdio>
#include <fstream>
#include <string>

#include "synthetic_volume.h"

namespace
{

std::string
number(double value)
{
  char text[32];
  std::snprintf(text, sizeof(text), "%.9g", value);
  return text;
}

std::string
triple(const double values[3], const char * separator)
{
  return number(values[0]) + separator + number(values[1]) + separator + number(values[2]);
}

/** As exactly as a double can be written, for the file. */
std::string
exact(const double values[3])
{
  char text[96];
  std::snprintf(text, sizeof(text), "%.17g %.17g %.17g", values[0], values[1], values[2]);
  return text;
}

int
expected()
{
  using namespace synthetic;
  const double size[3] = { static_cast<double>(SIZE[0]), static_cast<double>(SIZE[1]), static_cast<double>(SIZE[2]) };
  std::printf("{\"size\":[%s],\"spacing\":[%s],\"origin\":[%s],\"direction\":[[%s],[%s],[%s]],"
              "\"stored\":\"short\",\"range\":[%d,%d]}\n",
              triple(size, ",").c_str(),
              triple(SPACING, ",").c_str(),
              triple(ORIGIN, ",").c_str(),
              triple(DIRECTION[0], ",").c_str(),
              triple(DIRECTION[1], ",").c_str(),
              triple(DIRECTION[2], ",").c_str(),
              LOWEST,
              HIGHEST);
  return 0;
}

int
write(const std::string & path)
{
  using namespace synthetic;
  std::ofstream file(path, std::ios::binary);
  if (!file)
  {
    std::fprintf(stderr, "cannot write the test volume\n");
    return 1;
  }
  // A MetaImage header: text, then the voxels. TransformMatrix holds the
  // direction of the first axis, then of the second, then of the third.
  file << "ObjectType = Image\n"
       << "NDims = 3\n"
       << "BinaryData = True\n"
       << "BinaryDataByteOrderMSB = False\n"
       << "CompressedData = False\n"
       << "TransformMatrix = " << exact(DIRECTION[0]) << ' ' << exact(DIRECTION[1]) << ' ' << exact(DIRECTION[2])
       << '\n'
       << "Offset = " << exact(ORIGIN) << '\n'
       << "CenterOfRotation = 0 0 0\n"
       << "ElementSpacing = " << exact(SPACING) << '\n'
       << "DimSize = " << SIZE[0] << ' ' << SIZE[1] << ' ' << SIZE[2] << '\n'
       << "ElementType = MET_SHORT\n"
       << "ElementDataFile = LOCAL\n";
  // Little-endian, whatever the machine: the first axis runs fastest.
  for (int k = 0; k < SIZE[2]; ++k)
  {
    for (int j = 0; j < SIZE[1]; ++j)
    {
      for (int i = 0; i < SIZE[0]; ++i)
      {
        const unsigned value = static_cast<unsigned>(valueAt(i, j, k)) & 0xffffu;
        file.put(static_cast<char>(value & 0xffu));
        file.put(static_cast<char>((value >> 8) & 0xffu));
      }
    }
  }
  file.close();
  return file ? 0 : 1;
}

} // namespace

int
main(int argc, char * argv[])
{
  if (argc != 2)
  {
    std::fprintf(stderr, "usage: ors-make-test-volume <file.mha> | --expected\n");
    return 2;
  }
  const std::string argument = argv[1];
  return argument == "--expected" ? expected() : write(argument);
}
