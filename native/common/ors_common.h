/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What every native tool does the same way: how it writes JSON, how it
// fails, how it reports to the job that started it, and how it reads a
// volume.
//
// A tool talks on standard output in lines. A line that begins with `@` is
// for the server's job framework (services/server/src/jobs/job.ts):
//
//   @progress 0.25 Reading the fixed volume
//   @result {"output":"result.json"}
//
// A failure is one line of JSON on standard error and a status that is not
// zero. It carries a code and never a file name: a path can hold a
// patient's name.

#ifndef ors_common_h
#define ors_common_h

#include <cstdio>
#include <string>
#include <vector>

#include "itkImage.h"
#include "itkImageFileReader.h"
#include "itkImageIOBase.h"
#include "itkImageIOFactory.h"
#include "itkMetaImageIOFactory.h"
#include "itkNiftiImageIOFactory.h"
#include "itkNrrdImageIOFactory.h"

namespace ors
{

// Statuses a tool ends with, beside 0.
constexpr int STATUS_USAGE = 2;      // the command makes no sense
constexpr int STATUS_UNREADABLE = 3; // an input cannot be read as what it should be
constexpr int STATUS_FAILED = 4;     // the work itself did not succeed

/** A number as JSON has it: short, and the same on every system. */
inline std::string
number(double value, const char * format = "%.9g")
{
  char text[40];
  std::snprintf(text, sizeof(text), format, value);
  const std::string written(text);
  // Minus zero is zero to whoever reads it.
  return written == "-0" ? "0" : written;
}

inline std::string
list(const std::vector<double> & values, const char * format = "%.9g")
{
  std::string text = "[";
  for (std::size_t i = 0; i < values.size(); ++i)
  {
    text += (i == 0 ? "" : ",") + number(values[i], format);
  }
  return text + "]";
}

/** Text between quotes, with what JSON does not take as it is escaped. */
inline std::string
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

/** Say why the tool failed, in one line on standard error, and give the status back. */
inline int
fail(int status, const char * code, const std::string & detail = "")
{
  std::string line = std::string("{\"error\":") + quoted(code);
  if (!detail.empty())
  {
    line += ",\"detail\":" + quoted(detail);
  }
  std::fprintf(stderr, "%s}\n", line.c_str());
  std::fflush(stderr);
  return status;
}

/** Tell the job how far along the tool is, from 0 to 1, and what it is doing. */
inline void
progress(double fraction, const char * doing)
{
  const double within = fraction < 0.0 ? 0.0 : (fraction > 1.0 ? 1.0 : fraction);
  std::printf("@progress %.3f %s\n", within, doing);
  std::fflush(stdout);
}

/** Tell the job its result: one JSON object, given here as text. */
inline void
result(const std::string & json)
{
  std::printf("@result %s\n", json.c_str());
  std::fflush(stdout);
}

/** The formats the tools take, and no other that ITK happens to know. */
inline void
registerVolumeFormats()
{
  static bool registered = false;
  if (registered)
  {
    return;
  }
  registered = true;
  itk::MetaImageIOFactory::RegisterOneFactory();
  itk::NrrdImageIOFactory::RegisterOneFactory();
  itk::NiftiImageIOFactory::RegisterOneFactory();
}

using VolumeType = itk::Image<float, 3>;

/** Why a file is not a volume the tools take; `nullptr` when it is one. */
inline const char *
volumeProblem(const itk::ImageIOBase * io)
{
  if (io == nullptr)
  {
    return "unreadable";
  }
  if (io->GetNumberOfDimensions() != 3)
  {
    return "not-three-dimensional";
  }
  if (io->GetNumberOfComponents() != 1)
  {
    return "not-scalar";
  }
  return nullptr;
}

/**
 * Open a file as a volume and read what it says of itself. Gives a null
 * pointer, and the reason in `problem`, for what is no volume. Throws what
 * ITK throws for a file it cannot make sense of.
 */
inline itk::ImageIOBase::Pointer
openVolume(const std::string & path, const char *& problem)
{
  registerVolumeFormats();
  const itk::ImageIOBase::Pointer io =
    itk::ImageIOFactory::CreateImageIO(path.c_str(), itk::ImageIOFactory::IOFileModeEnum::ReadMode);
  if (io.IsNull())
  {
    problem = "unreadable";
    return nullptr;
  }
  io->SetFileName(path);
  io->ReadImageInformation();
  problem = volumeProblem(io);
  return problem == nullptr ? io : itk::ImageIOBase::Pointer();
}

/** The voxels of a volume that was opened, as floating point numbers. */
inline VolumeType::Pointer
readVolume(const std::string & path, itk::ImageIOBase * io)
{
  const auto reader = itk::ImageFileReader<VolumeType>::New();
  reader->SetImageIO(io);
  reader->SetFileName(path);
  reader->Update();
  return reader->GetOutput();
}

} // namespace ors

#endif
