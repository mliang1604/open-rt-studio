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

#include "itkImage.h"
#include "itkImageFileReader.h"
#include "itkImageIOBase.h"
#include "itkImageIOFactory.h"
#include "itkMetaImageIOFactory.h"
#include "itkNiftiImageIOFactory.h"
#include "itkNrrdImageIOFactory.h"
#include "itkVersion.h"

#include "ors_version.h"

namespace
{

constexpr int STATUS_USAGE = 2;
constexpr int STATUS_UNREADABLE = 3;

/** A number as JSON has it: short, and the same on every system. */
std::string
number(double value)
{
  char text[32];
  std::snprintf(text, sizeof(text), "%.9g", value);
  const std::string written(text);
  // Minus zero is zero to whoever reads it.
  return written == "-0" ? "0" : written;
}

std::string
list(const std::vector<double> & values)
{
  std::string text = "[";
  for (std::size_t i = 0; i < values.size(); ++i)
  {
    text += (i == 0 ? "" : ",") + number(values[i]);
  }
  return text + "]";
}

/** Text between quotes, with what JSON does not take as it is escaped. */
std::string
quoted(const std::string & text)
{
  std::string out = "\"";
  for (const char c : text)
  {
    if (c == '"' || c == '\\')
    {
      out += '\\';
      out += c;
    }
    else if (static_cast<unsigned char>(c) < 0x20)
    {
      char escaped[8];
      std::snprintf(escaped, sizeof(escaped), "\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(c)));
      out += escaped;
    }
    else
    {
      out += c;
    }
  }
  return out + "\"";
}

int
fail(int status, const char * code, const std::string & detail = "")
{
  std::string line = std::string("{\"error\":") + quoted(code);
  if (!detail.empty())
  {
    line += ",\"detail\":" + quoted(detail);
  }
  std::fprintf(stderr, "%s}\n", line.c_str());
  return status;
}

int
version()
{
  std::printf("{\"tool\":\"ors-volume-info\",\"version\":%s,\"itk\":%s,\"elastix\":%s}\n",
              quoted(ORS_NATIVE_VERSION).c_str(),
              quoted(itk::Version::GetITKVersion()).c_str(),
              quoted(ORS_ELASTIX_VERSION).c_str());
  return 0;
}

int
describe(const std::string & path, bool verbose)
{
  // The formats the tools take, and no other that ITK happens to know.
  itk::MetaImageIOFactory::RegisterOneFactory();
  itk::NrrdImageIOFactory::RegisterOneFactory();
  itk::NiftiImageIOFactory::RegisterOneFactory();

  try
  {
    const itk::ImageIOBase::Pointer io =
      itk::ImageIOFactory::CreateImageIO(path.c_str(), itk::ImageIOFactory::IOFileModeEnum::ReadMode);
    if (io.IsNull())
    {
      return fail(STATUS_UNREADABLE, "unreadable");
    }
    io->SetFileName(path);
    io->ReadImageInformation();
    if (io->GetNumberOfDimensions() != 3)
    {
      return fail(STATUS_UNREADABLE, "not-three-dimensional");
    }
    if (io->GetNumberOfComponents() != 1)
    {
      return fail(STATUS_UNREADABLE, "not-scalar");
    }

    std::vector<double> size, spacing, origin;
    std::string         direction = "[";
    for (unsigned int axis = 0; axis < 3; ++axis)
    {
      size.push_back(static_cast<double>(io->GetDimensions(axis)));
      spacing.push_back(io->GetSpacing(axis));
      origin.push_back(io->GetOrigin(axis));
      direction += (axis == 0 ? "" : ",") + list(io->GetDirection(axis));
    }
    direction += "]";
    const std::string stored = itk::ImageIOBase::GetComponentTypeAsString(io->GetComponentType());

    // The voxels themselves, to know that they can be read and what they hold.
    using VolumeType = itk::Image<float, 3>;
    const auto reader = itk::ImageFileReader<VolumeType>::New();
    reader->SetImageIO(io);
    reader->SetFileName(path);
    reader->Update();
    const VolumeType::Pointer volume = reader->GetOutput();
    const std::size_t         count = volume->GetBufferedRegion().GetNumberOfPixels();
    const float *             values = volume->GetBufferPointer();
    if (count == 0 || values == nullptr)
    {
      return fail(STATUS_UNREADABLE, "empty");
    }
    float lowest = values[0];
    float highest = values[0];
    for (std::size_t i = 1; i < count; ++i)
    {
      lowest = values[i] < lowest ? values[i] : lowest;
      highest = values[i] > highest ? values[i] : highest;
    }

    std::printf("{\"size\":%s,\"spacing\":%s,\"origin\":%s,\"direction\":%s,\"stored\":%s,\"range\":%s}\n",
                list(size).c_str(),
                list(spacing).c_str(),
                list(origin).c_str(),
                direction.c_str(),
                quoted(stored).c_str(),
                list({ static_cast<double>(lowest), static_cast<double>(highest) }).c_str());
    return 0;
  }
  catch (const std::exception & problem)
  {
    return fail(STATUS_UNREADABLE, "unreadable", verbose ? problem.what() : "");
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
      return fail(STATUS_USAGE, "usage");
    }
    else
    {
      files.push_back(argument);
    }
  }
  if (files.size() != 1)
  {
    return fail(STATUS_USAGE, "usage");
  }
  return describe(files[0], verbose);
}
