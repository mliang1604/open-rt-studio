/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ors-volume-info: reads a volume and prints its geometry as one line of JSON.
//
//   ors-volume-info <file>      the geometry of the volume in the file
//   ors-volume-info --version   what the tool is and what it was built on
//
// The file is a MetaImage (.mha, .mhd), NRRD (.nrrd, .nhdr) or NIfTI (.nii,
// .nii.gz) volume of three dimensions with one value to a voxel.
//
// What it prints, in millimetres and in the patient's coordinates (LPS, as
// DICOM has them):
//
//   size       voxels along each axis of the volume
//   spacing    the distance between voxel centres along each axis
//   origin     where the centre of the first voxel is
//   direction  for each axis of the volume, the way it points
//   range      the smallest and the largest value in the volume
//
// On standard output there is the answer and nothing else. A failure is one
// line of JSON on standard error and a status that is not zero: 2 for a
// command that makes no sense, 3 for a file that cannot be read as a volume.
// The line names no file: a path can hold a patient's name. --verbose adds
// what ITK said, which may name the file, for someone at a terminal.

#include <cstdio>
#include <exception>
#include <string>
#include <vector>

#include "itkVersion.h"

#include "ors_common.h"
#include "ors_version.h"

namespace
{

int
version()
{
  std::printf("{\"tool\":\"ors-volume-info\",\"version\":%s,\"itk\":%s,\"elastix\":%s}\n",
              ors::quoted(ORS_NATIVE_VERSION).c_str(),
              ors::quoted(itk::Version::GetITKVersion()).c_str(),
              ors::quoted(ORS_ELASTIX_VERSION).c_str());
  return 0;
}

int
describe(const std::string & path, bool verbose)
{
  try
  {
    const char *                    problem = nullptr;
    const itk::ImageIOBase::Pointer io = ors::openVolume(path, problem);
    if (io.IsNull())
    {
      return ors::fail(ors::STATUS_UNREADABLE, problem);
    }

    std::vector<double> size, spacing, origin;
    std::string         direction = "[";
    for (unsigned int axis = 0; axis < 3; ++axis)
    {
      size.push_back(static_cast<double>(io->GetDimensions(axis)));
      spacing.push_back(io->GetSpacing(axis));
      origin.push_back(io->GetOrigin(axis));
      direction += (axis == 0 ? "" : ",") + ors::list(io->GetDirection(axis));
    }
    direction += "]";
    const std::string stored = itk::ImageIOBase::GetComponentTypeAsString(io->GetComponentType());

    // The voxels themselves, to know that they can be read and what they hold.
    const ors::VolumeType::Pointer volume = ors::readVolume(path, io);
    const std::size_t              count = volume->GetBufferedRegion().GetNumberOfPixels();
    const float *                  values = volume->GetBufferPointer();
    if (count == 0 || values == nullptr)
    {
      return ors::fail(ors::STATUS_UNREADABLE, "empty");
    }
    float lowest = values[0];
    float highest = values[0];
    for (std::size_t i = 1; i < count; ++i)
    {
      lowest = values[i] < lowest ? values[i] : lowest;
      highest = values[i] > highest ? values[i] : highest;
    }

    std::printf("{\"size\":%s,\"spacing\":%s,\"origin\":%s,\"direction\":%s,\"stored\":%s,\"range\":%s}\n",
                ors::list(size).c_str(),
                ors::list(spacing).c_str(),
                ors::list(origin).c_str(),
                direction.c_str(),
                ors::quoted(stored).c_str(),
                ors::list({ static_cast<double>(lowest), static_cast<double>(highest) }).c_str());
    return 0;
  }
  catch (const std::exception & problem)
  {
    return ors::fail(ors::STATUS_UNREADABLE, "unreadable", verbose ? problem.what() : "");
  }
}

} // namespace

int
main(int argc, char * argv[])
{
  bool                     verbose = false;
  std::vector<std::string> files;
  for (int i = 1; i < argc; ++i)
  {
    const std::string argument = argv[i];
    if (argument == "--version")
    {
      return version();
    }
    if (argument == "--verbose")
    {
      verbose = true;
    }
    else if (argument.rfind("--", 0) == 0)
    {
      return ors::fail(ors::STATUS_USAGE, "usage");
    }
    else
    {
      files.push_back(argument);
    }
  }
  if (files.size() != 1)
  {
    return ors::fail(ors::STATUS_USAGE, "usage");
  }
  return describe(files[0], verbose);
}
