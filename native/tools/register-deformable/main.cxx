/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ors-register-deformable: finds the deformation between two volumes.
//
//   ors-register-deformable --fixed <file> --moving <file> --preset <file>
//       --output <file> --field <file>
//       [--initial <file>] [--roi x0,y0,z0,x1,y1,z1] [--seed <n>]
//       [--threads <n>] [--field-spacing <mm>] [--set Key=value]... [--verbose]
//   ors-register-deformable --version
//
// The volumes are MetaImage, NRRD or NIfTI files of three dimensions, in
// millimetres and in the patient's coordinates (LPS). The preset is an
// elastix parameter file (native/presets/deformable): which measure, how
// many steps, how fine a grid, how stiff.
//
// **What comes out** is a field of vectors and a matrix. Together they map
// the coordinates of a point: given where something is in the fixed
// volume's coordinates, they say where the same anatomy is in the moving
// volume's.
//
//   moving = fixedToMovingAfterField · (fixed + field(fixed))
//
// The field is laid out in the fixed volume's coordinates, over the fixed
// volume, and its vectors are in millimetres along the patient's axes. It
// is added first; the matrix, which only turns and moves, comes after. That
// is the way a registration is computed (for each place of the fixed
// volume, where to look in the moving one), and the way a DICOM Deformable
// Spatial Registration object holds one.
//
// The matrix is the one the registration started from: --initial, a JSON
// file with a `fixedToMoving` matrix (what ors-register-rigid writes), or
// without it the move that puts the centre of the fixed volume on the
// centre of the moving one. Everything the registration found beyond that
// is in the field.
//
// The field is written to the --field file as a MetaImage of three values
// to a point, and the matrix to the --output file as JSON, which also goes
// to the job that started the tool:
//
//   @progress 0.42 Registering
//   @result {"fixedToMovingAfterField":[...],"size":[41,41,33],"largestMm":7.2,"largestInsideMm":4.1,...}
//
// `largestMm` is the longest vector of the field. `foldedPoints` is how
// many points of the field are where it folds space over itself (where
// what it does to a small box turns the box inside out), which no anatomy
// does: more than a few says the registration went wrong there. The tool
// reports it and judges nothing.
//
// The field covers the whole fixed volume, the air around what was imaged
// too, and there nothing in the images holds it: what it is there is what
// the grid and its stiffness carry out from where there is something. So
// the result also says what the field is where the fixed volume shows
// something (#351): `insidePoints` is how many points of the field lie
// inside the volume's outline, and `largestInsideMm` and `meanInsideMm` are
// the longest and the mean vector there (null when no point does). The
// outline is found on each slice of the volume: what is brighter than a
// threshold between the volume's dark and its bright (Otsu's), and what
// that encloses on the slice, as a chest wall encloses the lungs. It is a
// rough outline for a number, not a contour of the patient.
//
// --set       changes a parameter of the preset, for whoever knows elastix:
//             --set MaximumNumberOfIterations=500. What the tool decides
//             itself (the kind of transform, the seed, what is written
//             where) cannot be set.
// --field-spacing  how far apart the vectors of the field are, at most
//             (4 mm). Between them the field is taken to run straight.
// --seed, --threads, --roi, --verbose: as for ors-register-rigid.
//
// A failure is one line of JSON on standard error, with a code and no file
// name, and a status: 2 for a command that makes no sense, 3 for an input
// that cannot be read as what it should be, 4 for a registration that did
// not succeed.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <fstream>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

#include <itkElastixRegistrationMethod.h>
#include <elxParameterObject.h>
#include <itkContinuousIndex.h>
#include <itkMultiThreaderBase.h>
#include <itkPoint.h>
#include <itkVersion.h>

#include "ors_common.h"
#include "ors_registration.h"
#include "ors_version.h"

namespace
{

constexpr unsigned int DEFAULT_SEED = 121212;
constexpr double       DEFAULT_FIELD_SPACING = 4.0;

// Where each part sits between 0 and 1 of the whole run.
constexpr double REGISTERING_FROM = 0.10;
constexpr double REGISTERING_TO = 0.85;
constexpr double WRITING_FROM = 0.97;

struct Options
{
  std::string                                      fixed;
  std::string                                      moving;
  std::string                                      preset;
  std::string                                      output;
  std::string                                      field;
  std::string                                      initial;
  std::vector<double>                              roi;
  std::vector<std::pair<std::string, std::string>> set;
  unsigned int                                     seed = DEFAULT_SEED;
  unsigned int                                     threads = 0;
  double                                           fieldSpacing = DEFAULT_FIELD_SPACING;
  bool                                             verbose = false;
};

/**
 * Whether a parameter is the tool's own to decide: the kind of transform
 * and how it is combined, the seed, and everything that names a file or
 * has elastix write one.
 */
bool
isOurs(const std::string & key)
{
  for (const char * const own : { "Transform", "HowToCombineTransforms", "RandomSeed", "FixedImageDimension",
                                  "MovingImageDimension", "FixedInternalImagePixelType",
                                  "MovingInternalImagePixelType" })
  {
    if (key == own)
    {
      return true;
    }
  }
  for (const char * const part : { "FileName", "Write", "Result", "Directory", "CompressResultImage" })
  {
    if (key.find(part) != std::string::npos)
    {
      return true;
    }
  }
  return false;
}

/** A parameter's name: letters and digits, beginning with a letter. */
bool
isKey(const std::string & key)
{
  if (key.empty() || key.size() > 80 || !((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= 'a' && key[0] <= 'z')))
  {
    return false;
  }
  for (const char c : key)
  {
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')))
    {
      return false;
    }
  }
  return true;
}

/** A parameter's values, separated by spaces: words and numbers and nothing else. Empty when it is anything else. */
std::vector<std::string>
values(const std::string & text)
{
  std::vector<std::string> found;
  std::string              one;
  for (const char c : text + " ")
  {
    if (c == ' ')
    {
      if (!one.empty())
      {
        found.push_back(one);
        one.clear();
      }
    }
    else if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' ||
             c == '+' || c == '_')
    {
      one += c;
    }
    else
    {
      return {};
    }
  }
  return found.size() <= 64 ? found : std::vector<std::string>{};
}

/** The first value of a parameter as a whole number, or `otherwise`. */
unsigned int
firstWhole(const elx::ParameterObject::ParameterMapType & map, const char * key, unsigned int otherwise)
{
  const auto found = map.find(key);
  if (found == map.end() || found->second.empty())
  {
    return otherwise;
  }
  const long value = ors::wholeNumber(found->second.front(), 1000000);
  return value > 0 ? static_cast<unsigned int>(value) : otherwise;
}

/** Where the middle of a volume is. */
itk::Point<double, 3>
middleOf(const ors::VolumeType & volume)
{
  const auto                           size = volume.GetLargestPossibleRegion().GetSize();
  itk::ContinuousIndex<double, 3>      index;
  for (unsigned int axis = 0; axis < 3; ++axis)
  {
    index[axis] = 0.5 * (static_cast<double>(size[axis]) - 1.0);
  }
  itk::Point<double, 3> point;
  volume.TransformContinuousIndexToPhysicalPoint(index, point);
  return point;
}

/** The field: where its vectors are, and the vectors, the first index running fastest. */
struct Field
{
  unsigned int       size[3];
  double             spacing[3];
  double             origin[3];
  // The way each axis of the grid points.
  double             axes[3][3];
  std::vector<float> vectors;

  std::size_t
  at(unsigned int i, unsigned int j, unsigned int k) const
  {
    return 3 * ((static_cast<std::size_t>(k) * size[1] + j) * size[0] + i);
  }
};

/** A grid over the fixed volume, from its first voxel to its last, with vectors no further apart than `spacing`. */
Field
gridOver(const ors::VolumeType & fixed, double spacing)
{
  Field        field;
  const auto   size = fixed.GetLargestPossibleRegion().GetSize();
  const auto & direction = fixed.GetDirection();
  std::size_t  count = 1;
  for (unsigned int axis = 0; axis < 3; ++axis)
  {
    const double extent = (static_cast<double>(size[axis]) - 1.0) * fixed.GetSpacing()[axis];
    const double steps = std::ceil(extent / spacing - 1e-9);
    field.size[axis] = extent > 0.0 ? static_cast<unsigned int>(steps < 1.0 ? 1.0 : steps) + 1 : 1;
    field.spacing[axis] = field.size[axis] > 1 ? extent / (field.size[axis] - 1) : fixed.GetSpacing()[axis];
    field.origin[axis] = fixed.GetOrigin()[axis];
    for (unsigned int component = 0; component < 3; ++component)
    {
      field.axes[axis][component] = direction[component][axis];
    }
    count *= field.size[axis];
  }
  field.vectors.assign(3 * count, 0.0f);
  return field;
}

/**
 * Where a volume shows something: for each voxel, the first index running
 * fastest, whether it is inside the volume's outline. On each slice that is
 * what is at or above a threshold between the volume's dark and its bright
 * (Otsu's, of 256 steps), and what that encloses on the slice: whatever
 * cannot be reached from the slice's edge without crossing it. Nothing is
 * inside a volume of one value.
 */
std::vector<unsigned char>
outlineOf(const ors::VolumeType & volume)
{
  const auto          size = volume.GetLargestPossibleRegion().GetSize();
  const std::size_t   columns = size[0];
  const std::size_t   rows = size[1];
  const std::size_t   slices = size[2];
  const std::size_t   count = columns * rows * slices;
  const float * const values = volume.GetBufferPointer();
  std::vector<unsigned char> inside(count, 0);

  float lowest = 0.0f;
  float highest = 0.0f;
  bool  any = false;
  for (std::size_t at = 0; at < count; ++at)
  {
    if (std::isfinite(values[at]))
    {
      lowest = !any || values[at] < lowest ? values[at] : lowest;
      highest = !any || values[at] > highest ? values[at] : highest;
      any = true;
    }
  }
  if (!any || !(highest > lowest))
  {
    return inside;
  }

  // The threshold that parts the values into two groups most unlike each other.
  constexpr int       STEPS = 256;
  std::vector<double> histogram(STEPS, 0.0);
  const double        step = (static_cast<double>(highest) - lowest) / STEPS;
  double              counted = 0.0;
  const auto          stepOf = [&](float value) {
    const int found = static_cast<int>((static_cast<double>(value) - lowest) / step);
    return found < 0 ? 0 : (found >= STEPS ? STEPS - 1 : found);
  };
  for (std::size_t at = 0; at < count; ++at)
  {
    if (std::isfinite(values[at]))
    {
      histogram[stepOf(values[at])] += 1.0;
      counted += 1.0;
    }
  }
  double sum = 0.0;
  for (int at = 0; at < STEPS; ++at)
  {
    sum += at * histogram[at];
  }
  double below = 0.0;
  double sumBelow = 0.0;
  double best = -1.0;
  int    first = STEPS;
  for (int at = 0; at + 1 < STEPS; ++at)
  {
    below += histogram[at];
    sumBelow += at * histogram[at];
    const double above = counted - below;
    if (below <= 0.0 || above <= 0.0)
    {
      continue;
    }
    const double apart = sumBelow / below - (sum - sumBelow) / above;
    const double between = below * above * apart * apart;
    if (between > best)
    {
      best = between;
      first = at + 1;
    }
  }
  if (first >= STEPS)
  {
    return inside;
  }

  // On each slice: what is bright, and what cannot be reached from the
  // slice's edge through what is not.
  std::vector<unsigned char> reached(columns * rows);
  std::vector<std::size_t>   waiting;
  for (std::size_t slice = 0; slice < slices; ++slice)
  {
    const float * const of = values + slice * columns * rows;
    const auto          bright = [&](std::size_t at) { return std::isfinite(of[at]) && stepOf(of[at]) >= first; };
    std::fill(reached.begin(), reached.end(), static_cast<unsigned char>(0));
    waiting.clear();
    const auto reach = [&](std::size_t at) {
      if (reached[at] == 0 && !bright(at))
      {
        reached[at] = 1;
        waiting.push_back(at);
      }
    };
    for (std::size_t column = 0; column < columns; ++column)
    {
      reach(column);
      reach((rows - 1) * columns + column);
    }
    for (std::size_t row = 0; row < rows; ++row)
    {
      reach(row * columns);
      reach(row * columns + columns - 1);
    }
    while (!waiting.empty())
    {
      const std::size_t at = waiting.back();
      waiting.pop_back();
      const std::size_t column = at % columns;
      const std::size_t row = at / columns;
      if (column > 0)
      {
        reach(at - 1);
      }
      if (column + 1 < columns)
      {
        reach(at + 1);
      }
      if (row > 0)
      {
        reach(at - columns);
      }
      if (row + 1 < rows)
      {
        reach(at + columns);
      }
    }
    for (std::size_t at = 0; at < columns * rows; ++at)
    {
      inside[slice * columns * rows + at] = reached[at] == 0 ? 1 : 0;
    }
  }
  return inside;
}

/** How many points of the field are where it folds space over: where the map's Jacobian has no positive determinant. */
std::size_t
foldedPoints(const Field & field)
{
  std::size_t folded = 0;
  const double handed =
    field.axes[0][0] * (field.axes[1][1] * field.axes[2][2] - field.axes[1][2] * field.axes[2][1]) -
    field.axes[0][1] * (field.axes[1][0] * field.axes[2][2] - field.axes[1][2] * field.axes[2][0]) +
    field.axes[0][2] * (field.axes[1][0] * field.axes[2][1] - field.axes[1][1] * field.axes[2][0]);
  for (unsigned int k = 0; k < field.size[2]; ++k)
  {
    for (unsigned int j = 0; j < field.size[1]; ++j)
    {
      for (unsigned int i = 0; i < field.size[0]; ++i)
      {
        const unsigned int index[3] = { i, j, k };
        // What a step along each axis of the grid becomes: the step, and how the vectors change over it.
        double             columns[3][3];
        for (unsigned int axis = 0; axis < 3; ++axis)
        {
          unsigned int before[3] = { i, j, k };
          unsigned int after[3] = { i, j, k };
          if (index[axis] > 0)
          {
            before[axis] -= 1;
          }
          if (index[axis] + 1 < field.size[axis])
          {
            after[axis] += 1;
          }
          const double       apart = (after[axis] - before[axis]) * field.spacing[axis];
          const std::size_t  a = field.at(before[0], before[1], before[2]);
          const std::size_t  b = field.at(after[0], after[1], after[2]);
          for (unsigned int component = 0; component < 3; ++component)
          {
            const double change =
              apart > 0.0 ? (static_cast<double>(field.vectors[b + component]) - field.vectors[a + component]) / apart
                          : 0.0;
            columns[axis][component] = field.axes[axis][component] + change;
          }
        }
        const double determinant =
          columns[0][0] * (columns[1][1] * columns[2][2] - columns[1][2] * columns[2][1]) -
          columns[0][1] * (columns[1][0] * columns[2][2] - columns[1][2] * columns[2][0]) +
          columns[0][2] * (columns[1][0] * columns[2][1] - columns[1][1] * columns[2][0]);
        if (!(determinant * handed > 0.0))
        {
          ++folded;
        }
      }
    }
  }
  return folded;
}

/** The field as a MetaImage file of three values to a point, little-endian. */
bool
writeField(const std::string & path, const Field & field)
{
  std::ofstream file(path, std::ios::binary);
  if (!file)
  {
    return false;
  }
  std::string header = "ObjectType = Image\nNDims = 3\nBinaryData = True\nBinaryDataByteOrderMSB = False\n"
                       "CompressedData = False\nTransformMatrix =";
  for (unsigned int axis = 0; axis < 3; ++axis)
  {
    for (unsigned int component = 0; component < 3; ++component)
    {
      header += " " + ors::number(field.axes[axis][component], "%.17g");
    }
  }
  header += "\nOffset =";
  for (unsigned int axis = 0; axis < 3; ++axis)
  {
    header += " " + ors::number(field.origin[axis], "%.17g");
  }
  header += "\nCenterOfRotation = 0 0 0\nElementSpacing =";
  for (unsigned int axis = 0; axis < 3; ++axis)
  {
    header += " " + ors::number(field.spacing[axis], "%.17g");
  }
  header += "\nDimSize = " + std::to_string(field.size[0]) + " " + std::to_string(field.size[1]) + " " +
            std::to_string(field.size[2]) +
            "\nElementNumberOfChannels = 3\nElementType = MET_FLOAT\nElementDataFile = LOCAL\n";
  file << header;
  std::vector<char> bytes(field.vectors.size() * 4);
  for (std::size_t i = 0; i < field.vectors.size(); ++i)
  {
    // The same bytes whatever the machine: the number's bits, lowest first.
    std::uint32_t bits;
    static_assert(sizeof(bits) == sizeof(float), "a float is 32 bits");
    std::memcpy(&bits, &field.vectors[i], sizeof(bits));
    bytes[4 * i] = static_cast<char>(bits & 0xffu);
    bytes[4 * i + 1] = static_cast<char>((bits >> 8) & 0xffu);
    bytes[4 * i + 2] = static_cast<char>((bits >> 16) & 0xffu);
    bytes[4 * i + 3] = static_cast<char>((bits >> 24) & 0xffu);
  }
  file.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
  file.close();
  return static_cast<bool>(file);
}

int
version()
{
  std::printf("{\"tool\":\"ors-register-deformable\",\"version\":%s,\"itk\":%s,\"elastix\":%s}\n",
              ors::quoted(ORS_NATIVE_VERSION).c_str(),
              ors::quoted(itk::Version::GetITKVersion()).c_str(),
              ors::quoted(ORS_ELASTIX_VERSION).c_str());
  return 0;
}

int
registerDeformable(const Options & options)
{
  int status = 0;

  ors::progress(0.0, "Reading the fixed volume");
  const ors::VolumeType::Pointer fixed =
    ors::volumeOrFail(options.fixed, "unreadable-fixed", options.verbose, status);
  if (fixed.IsNull())
  {
    return status;
  }
  ors::progress(0.05, "Reading the moving volume");
  const ors::VolumeType::Pointer moving =
    ors::volumeOrFail(options.moving, "unreadable-moving", options.verbose, status);
  if (moving.IsNull())
  {
    return status;
  }

  // The matrix the registration starts from, and the one that stays in the
  // result: given, or else centre on centre.
  std::vector<double> start;
  if (!options.initial.empty())
  {
    start = ors::readMatrix(options.initial);
    if (!ors::isRigid(start))
    {
      return ors::fail(ors::STATUS_UNREADABLE, "bad-initial");
    }
  }
  else
  {
    const auto from = middleOf(*fixed);
    const auto to = middleOf(*moving);
    start = { 1, 0, 0, to[0] - from[0], 0, 1, 0, to[1] - from[1], 0, 0, 1, to[2] - from[2], 0, 0, 0, 1 };
  }

  ors::MaskType::Pointer mask;
  if (!options.roi.empty())
  {
    mask = ors::boxMask(*fixed, options.roi);
    if (mask.IsNull())
    {
      return ors::fail(ors::STATUS_UNREADABLE, "roi-empty");
    }
  }

  // The preset, with what was set on the command line over it, and what is
  // the tool's own over both.
  elx::ParameterObject::ParameterMapType map;
  try
  {
    const auto read = elx::ParameterObject::New();
    read->ReadParameterFile(options.preset);
    map = read->GetParameterMap(0);
  }
  catch (const std::exception & problem)
  {
    return ors::fail(ors::STATUS_UNREADABLE, "bad-preset", options.verbose ? problem.what() : "");
  }
  if (map.empty() || map.find("Metric") == map.end())
  {
    return ors::fail(ors::STATUS_UNREADABLE, "bad-preset");
  }
  for (const auto & [key, value] : options.set)
  {
    map[key] = values(value);
  }
  for (auto entry = map.begin(); entry != map.end();)
  {
    entry = isOurs(entry->first) ? map.erase(entry) : std::next(entry);
  }
  map["Transform"] = { "BSplineTransform" };
  map["HowToCombineTransforms"] = { "Compose" };
  map["RandomSeed"] = { std::to_string(options.seed) };
  map["WriteResultImage"] = { "false" };
  map["WriteIterationInfo"] = { "false" };
  const unsigned int resolutions = firstWhole(map, "NumberOfResolutions", 1);
  const unsigned int iterations = firstWhole(map, "MaximumNumberOfIterations", 1);

  if (options.threads > 0)
  {
    itk::MultiThreaderBase::SetGlobalDefaultNumberOfThreads(options.threads);
  }
  const auto parameters = elx::ParameterObject::New();
  parameters->SetParameterMap(map);

  const auto registration = itk::ElastixRegistrationMethod<ors::VolumeType, ors::VolumeType>::New();
  registration->SetFixedImage(fixed);
  registration->SetMovingImage(moving);
  registration->SetParameterObject(parameters);
  registration->SetInitialTransform(ors::affineOf(start));
  if (mask.IsNotNull())
  {
    registration->SetFixedMask(mask);
  }
  if (options.threads > 0)
  {
    registration->SetNumberOfThreads(static_cast<int>(options.threads));
  }
  // The log is what says how far along it is: it is watched, not shown.
  registration->SetLogToConsole(true);
  registration->SetLogToFile(false);

  ors::progress(REGISTERING_FROM, "Registering");
  Field  field = gridOver(*fixed, options.fieldSpacing);
  double largest = 0.0;
  // The same where the fixed volume shows something.
  const std::vector<unsigned char> outline = outlineOf(*fixed);
  const auto                       fixedSize = fixed->GetLargestPossibleRegion().GetSize();
  std::size_t                      insidePoints = 0;
  double                           largestInside = 0.0;
  double                           sumInside = 0.0;
  try
  {
    ors::LogWatcher watcher(resolutions, iterations, REGISTERING_FROM, REGISTERING_TO, "Registering", options.verbose);
    {
      const ors::WatchedLog watched(watcher);
      registration->Update();
    }
    const auto * const found = registration->GetCombinationTransform();
    if (found == nullptr)
    {
      return ors::fail(ors::STATUS_FAILED, "registration-failed");
    }

    // The whole of what was found, at each point of the field: where the
    // point goes, brought back by the matrix, less where it was.
    ors::progress(REGISTERING_TO, "Working out the field");
    for (unsigned int k = 0; k < field.size[2]; ++k)
    {
      for (unsigned int j = 0; j < field.size[1]; ++j)
      {
        for (unsigned int i = 0; i < field.size[0]; ++i)
        {
          const unsigned int    index[3] = { i, j, k };
          itk::Point<double, 3> point;
          for (unsigned int component = 0; component < 3; ++component)
          {
            point[component] = field.origin[component];
            for (unsigned int axis = 0; axis < 3; ++axis)
            {
              point[component] += index[axis] * field.spacing[axis] * field.axes[axis][component];
            }
          }
          const itk::Point<double, 3> mapped = found->TransformPoint(point);
          double                      squared = 0.0;
          for (unsigned int row = 0; row < 3; ++row)
          {
            // The inverse of a matrix that only turns and moves: its turn, turned back.
            double back = 0.0;
            for (unsigned int column = 0; column < 3; ++column)
            {
              back += start[4 * column + row] * (mapped[column] - start[4 * column + 3]);
            }
            const double vector = back - point[row];
            if (!std::isfinite(vector))
            {
              return ors::fail(ors::STATUS_FAILED, "registration-failed");
            }
            field.vectors[field.at(i, j, k) + row] = static_cast<float>(vector);
            squared += vector * vector;
          }
          largest = squared > largest ? squared : largest;
          // The voxel of the fixed volume the point is in, or the nearest at its edge.
          itk::ContinuousIndex<double, 3> where;
          fixed->TransformPhysicalPointToContinuousIndex(point, where);
          std::size_t voxel[3];
          for (unsigned int axis = 0; axis < 3; ++axis)
          {
            const double nearest = std::floor(where[axis] + 0.5);
            const double last = static_cast<double>(fixedSize[axis]) - 1.0;
            voxel[axis] = static_cast<std::size_t>(nearest < 0.0 ? 0.0 : (nearest > last ? last : nearest));
          }
          if (outline[(voxel[2] * fixedSize[1] + voxel[1]) * fixedSize[0] + voxel[0]] != 0)
          {
            ++insidePoints;
            sumInside += std::sqrt(squared);
            largestInside = squared > largestInside ? squared : largestInside;
          }
        }
      }
      ors::progress(REGISTERING_TO + (WRITING_FROM - REGISTERING_TO) * (k + 1.0) / field.size[2],
                    "Working out the field");
    }
  }
  catch (const std::exception & problem)
  {
    return ors::fail(ors::STATUS_FAILED, "registration-failed", options.verbose ? problem.what() : "");
  }
  largest = std::sqrt(largest);
  largestInside = std::sqrt(largestInside);

  ors::progress(WRITING_FROM, "Writing the result");
  if (!writeField(options.field, field))
  {
    return ors::fail(ors::STATUS_FAILED, "cannot-write-output");
  }
  const std::size_t points = field.vectors.size() / 3;
  const std::string json =
    "{\"fixedToMovingAfterField\":" + ors::list(start, "%.17g") + ",\"size\":[" + std::to_string(field.size[0]) +
    "," + std::to_string(field.size[1]) + "," + std::to_string(field.size[2]) +
    "],\"spacing\":" + ors::list({ field.spacing[0], field.spacing[1], field.spacing[2] }) +
    ",\"largestMm\":" + ors::number(largest, "%.4f") + ",\"points\":" + std::to_string(points) +
    ",\"insidePoints\":" + std::to_string(insidePoints) + ",\"largestInsideMm\":" +
    (insidePoints > 0 ? ors::number(largestInside, "%.4f") : std::string("null")) + ",\"meanInsideMm\":" +
    (insidePoints > 0 ? ors::number(sumInside / static_cast<double>(insidePoints), "%.4f") : std::string("null")) +
    ",\"foldedPoints\":" + std::to_string(foldedPoints(field)) + ",\"seed\":" + std::to_string(options.seed) +
    ",\"resolutions\":" + std::to_string(resolutions) + ",\"iterations\":" + std::to_string(iterations) + "}";
  {
    std::ofstream file(options.output, std::ios::binary);
    file << json << '\n';
    file.close();
    if (!file)
    {
      return ors::fail(ors::STATUS_FAILED, "cannot-write-output");
    }
  }
  ors::progress(1.0, "Done");
  ors::result(json);
  return 0;
}

} // namespace

int
main(int argc, char * argv[])
{
  Options options;
  for (int i = 1; i < argc; ++i)
  {
    const std::string argument = argv[i];
    if (argument == "--version")
    {
      return version();
    }
    if (argument == "--verbose")
    {
      options.verbose = true;
      continue;
    }
    // Everything else takes a value.
    if (i + 1 >= argc)
    {
      return ors::fail(ors::STATUS_USAGE, "usage");
    }
    const std::string value = argv[++i];
    if (argument == "--fixed")
    {
      options.fixed = value;
    }
    else if (argument == "--moving")
    {
      options.moving = value;
    }
    else if (argument == "--preset")
    {
      options.preset = value;
    }
    else if (argument == "--output")
    {
      options.output = value;
    }
    else if (argument == "--field")
    {
      options.field = value;
    }
    else if (argument == "--initial")
    {
      options.initial = value;
    }
    else if (argument == "--roi")
    {
      options.roi = ors::numbers(value);
      if (options.roi.size() != 6)
      {
        return ors::fail(ors::STATUS_USAGE, "usage");
      }
    }
    else if (argument == "--seed" || argument == "--threads")
    {
      const long number = ors::wholeNumber(value, argument == "--seed" ? 2147483647L : 100000L);
      if (number < 0 || (argument == "--threads" && number == 0))
      {
        return ors::fail(ors::STATUS_USAGE, "usage");
      }
      (argument == "--seed" ? options.seed : options.threads) = static_cast<unsigned int>(number);
    }
    else if (argument == "--field-spacing")
    {
      const std::vector<double> given = ors::numbers(value);
      if (given.size() != 1 || given[0] < 0.5 || given[0] > 100.0)
      {
        return ors::fail(ors::STATUS_USAGE, "usage");
      }
      options.fieldSpacing = given[0];
    }
    else if (argument == "--set")
    {
      const auto equals = value.find('=');
      if (equals == std::string::npos)
      {
        return ors::fail(ors::STATUS_USAGE, "usage");
      }
      const std::string key = value.substr(0, equals);
      const std::string text = value.substr(equals + 1);
      if (!isKey(key) || values(text).empty())
      {
        return ors::fail(ors::STATUS_USAGE, "bad-parameter");
      }
      if (isOurs(key))
      {
        return ors::fail(ors::STATUS_USAGE, "fixed-parameter");
      }
      options.set.emplace_back(key, text);
    }
    else
    {
      return ors::fail(ors::STATUS_USAGE, "usage");
    }
  }
  if (options.fixed.empty() || options.moving.empty() || options.preset.empty() || options.output.empty() ||
      options.field.empty())
  {
    return ors::fail(ors::STATUS_USAGE, "usage");
  }
  return registerDeformable(options);
}
