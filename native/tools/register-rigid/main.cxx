/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ors-register-rigid: finds the rigid transform between two volumes.
//
//   ors-register-rigid --fixed <file> --moving <file> --output <file>
//       [--initial <file>] [--roi x0,y0,z0,x1,y1,z1] [--seed <n>]
//       [--threads <n>] [--iterations <n>] [--verbose]
//   ors-register-rigid --version
//
// The volumes are MetaImage, NRRD or NIfTI files of three dimensions, in
// millimetres and in the patient's coordinates (LPS).
//
// **What comes out** is a matrix, `fixedToMoving`: sixteen numbers, row by
// row. It maps the coordinates of a point. Given where something is in the
// fixed volume's coordinates, it says where the same anatomy is in the
// moving volume's. (That is the way a registration is computed: for each
// place in the fixed volume, where to look in the moving one. Whoever wants
// the other way turns the matrix round.) It only turns and moves.
//
// The matrix is written to the --output file as JSON, and the same object
// goes to the job that started the tool, on standard output:
//
//   @progress 0.42 Registering
//   @result {"fixedToMoving":[...],"seed":121212,"iterations":300,"resolutions":4}
//
// --initial   a JSON file with a `fixedToMoving` matrix to start from. It
//             must only turn and move. Without it the two volumes start
//             with their centres on each other.
// --roi       a box in the fixed volume's coordinates, as two opposite
//             corners in millimetres. Only what is inside it is compared.
// --seed      the registration draws its sample points at random. The same
//             seed, with the same number of threads, gives the same matrix.
// --threads   how many threads to use (all the processors without it).
// --iterations how many steps at each of the four resolutions (300).
//
// A failure is one line of JSON on standard error, with a code and no file
// name, and a status: 2 for a command that makes no sense, 3 for an input
// that cannot be read as what it should be, 4 for a registration that did
// not succeed. --verbose passes on what elastix logs, for someone at a
// terminal.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <streambuf>
#include <string>
#include <vector>

#include <itkElastixRegistrationMethod.h>
#include <elxParameterObject.h>
#include <itkAffineTransform.h>
#include <itkImage.h>
#include <itkImageRegionIteratorWithIndex.h>
#include <itkMultiThreaderBase.h>
#include <itkVersion.h>

#include "ors_common.h"
#include "ors_version.h"

namespace
{

constexpr unsigned int RESOLUTIONS = 4;
constexpr unsigned int DEFAULT_ITERATIONS = 300;
constexpr unsigned int DEFAULT_SEED = 121212;

// Where the registration itself sits between 0 and 1 of the whole run.
constexpr double REGISTERING_FROM = 0.15;
constexpr double REGISTERING_TO = 0.95;

struct Options
{
  std::string         fixed;
  std::string         moving;
  std::string         output;
  std::string         initial;
  std::vector<double> roi;
  unsigned int        seed = DEFAULT_SEED;
  unsigned int        threads = 0;
  unsigned int        iterations = DEFAULT_ITERATIONS;
  bool                verbose = false;
};

/** A whole number that is not negative and not absurd, or -1. */
long
wholeNumber(const std::string & text, long atMost)
{
  if (text.empty() || text.size() > 10)
  {
    return -1;
  }
  for (const char c : text)
  {
    if (c < '0' || c > '9')
    {
      return -1;
    }
  }
  const long value = std::strtol(text.c_str(), nullptr, 10);
  return value <= atMost ? value : -1;
}

/** Numbers separated by commas; empty when one of them is no number. */
std::vector<double>
numbers(const std::string & text)
{
  std::vector<double> values;
  std::stringstream   stream(text);
  std::string         item;
  while (std::getline(stream, item, ','))
  {
    char *       end = nullptr;
    const double value = std::strtod(item.c_str(), &end);
    if (item.empty() || end == item.c_str() || *end != '\0' || !std::isfinite(value))
    {
      return {};
    }
    values.push_back(value);
  }
  return values;
}

/**
 * The sixteen numbers of `fixedToMoving` in a JSON file, or nothing. Only
 * as much of JSON is read as the tools themselves write.
 */
std::vector<double>
readMatrix(const std::string & path)
{
  std::ifstream file(path, std::ios::binary);
  if (!file)
  {
    return {};
  }
  std::stringstream held;
  held << file.rdbuf();
  const std::string text = held.str();
  const auto        name = text.find("\"fixedToMoving\"");
  if (name == std::string::npos)
  {
    return {};
  }
  const auto open = text.find('[', name);
  const auto close = text.find(']', name);
  if (open == std::string::npos || close == std::string::npos || close < open)
  {
    return {};
  }
  std::string inside = text.substr(open + 1, close - open - 1);
  std::string compact;
  for (const char c : inside)
  {
    if (c != ' ' && c != '\n' && c != '\r' && c != '\t')
    {
      compact += c;
    }
  }
  const std::vector<double> values = numbers(compact);
  return values.size() == 16 ? values : std::vector<double>{};
}

/** Whether a matrix only turns and moves: its rows are unit vectors at right angles, turning the right way. */
bool
isRigid(const std::vector<double> & m)
{
  const double tolerance = 1e-4;
  if (std::fabs(m[12]) > tolerance || std::fabs(m[13]) > tolerance || std::fabs(m[14]) > tolerance ||
      std::fabs(m[15] - 1.0) > tolerance)
  {
    return false;
  }
  for (int a = 0; a < 3; ++a)
  {
    for (int b = 0; b < 3; ++b)
    {
      double dot = 0.0;
      for (int k = 0; k < 3; ++k)
      {
        dot += m[4 * a + k] * m[4 * b + k];
      }
      if (std::fabs(dot - (a == b ? 1.0 : 0.0)) > tolerance)
      {
        return false;
      }
    }
  }
  const double determinant = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) +
                             m[2] * (m[4] * m[9] - m[5] * m[8]);
  return determinant > 0.0;
}

/**
 * What elastix logs goes through here in place of standard output. Its
 * lines say which resolution and which iteration it is at, and that is
 * turned into progress for the job. The lines themselves are dropped,
 * unless they were asked for.
 */
class LogWatcher : public std::streambuf
{
public:
  LogWatcher(unsigned int iterations, bool passOn)
    : m_Iterations(iterations)
    , m_PassOn(passOn)
  {}

protected:
  int_type
  overflow(int_type c) override
  {
    if (c == traits_type::eof())
    {
      return traits_type::not_eof(c);
    }
    if (c == '\n')
    {
      this->line();
      m_Line.clear();
    }
    else if (m_Line.size() < 4096)
    {
      m_Line += static_cast<char>(c);
    }
    return c;
  }

  std::streamsize
  xsputn(const char * text, std::streamsize count) override
  {
    for (std::streamsize i = 0; i < count; ++i)
    {
      this->overflow(traits_type::to_int_type(text[i]));
    }
    return count;
  }

private:
  void
  line()
  {
    if (m_PassOn && !m_Line.empty())
    {
      // Never a line the job would take for a report of ours.
      std::printf("%s%s\n", m_Line[0] == '@' ? " " : "", m_Line.c_str());
    }
    const std::string resolution = "Resolution: ";
    if (m_Line.compare(0, resolution.size(), resolution) == 0)
    {
      const long level = wholeNumber(m_Line.substr(resolution.size()), RESOLUTIONS);
      if (level >= 0)
      {
        m_Resolution = static_cast<unsigned int>(level);
        this->report(0);
      }
      return;
    }
    // A row of the iteration table begins with the iteration's number.
    const auto tab = m_Line.find('\t');
    if (tab != std::string::npos && tab > 0)
    {
      const long iteration = wholeNumber(m_Line.substr(0, tab), 1000000);
      if (iteration >= 0)
      {
        this->report(static_cast<unsigned int>(iteration) + 1);
      }
    }
  }

  void
  report(unsigned int iterationsDone)
  {
    const double steps = static_cast<double>(RESOLUTIONS) * static_cast<double>(m_Iterations > 0 ? m_Iterations : 1);
    const double done = static_cast<double>(m_Resolution) * static_cast<double>(m_Iterations) + iterationsDone;
    const double fraction = REGISTERING_FROM + (REGISTERING_TO - REGISTERING_FROM) * (done / steps);
    // Not every iteration: a line for each hundredth of the way.
    if (fraction >= m_Reported + 0.01)
    {
      m_Reported = fraction;
      ors::progress(fraction, "Registering");
    }
  }

  std::string  m_Line;
  unsigned int m_Iterations;
  bool         m_PassOn;
  unsigned int m_Resolution = 0;
  double       m_Reported = REGISTERING_FROM;
};

/** Puts std::cout through a watcher for as long as it lives. */
class WatchedLog
{
public:
  explicit WatchedLog(LogWatcher & watcher)
    : m_Before(std::cout.rdbuf(&watcher))
  {}
  ~WatchedLog() { std::cout.rdbuf(m_Before); }
  WatchedLog(const WatchedLog &) = delete;
  WatchedLog &
  operator=(const WatchedLog &) = delete;

private:
  std::streambuf * m_Before;
};

/** A volume the tool can read, or a null pointer and the failure said. */
ors::VolumeType::Pointer
volume(const std::string & path, const char * code, bool verbose, int & status)
{
  try
  {
    const char *                    problem = nullptr;
    const itk::ImageIOBase::Pointer io = ors::openVolume(path, problem);
    if (io.IsNull())
    {
      status = ors::fail(ors::STATUS_UNREADABLE, code, problem);
      return nullptr;
    }
    return ors::readVolume(path, io);
  }
  catch (const std::exception & problem)
  {
    status = ors::fail(ors::STATUS_UNREADABLE, code, verbose ? problem.what() : "");
    return nullptr;
  }
}

/** The box of --roi as a mask on the fixed volume's grid; null when nothing of the volume is inside. */
itk::Image<unsigned char, 3>::Pointer
boxMask(const ors::VolumeType & fixed, const std::vector<double> & roi)
{
  using MaskType = itk::Image<unsigned char, 3>;
  double low[3], high[3];
  for (int axis = 0; axis < 3; ++axis)
  {
    low[axis] = roi[axis] < roi[axis + 3] ? roi[axis] : roi[axis + 3];
    high[axis] = roi[axis] < roi[axis + 3] ? roi[axis + 3] : roi[axis];
  }
  const auto mask = MaskType::New();
  mask->SetRegions(fixed.GetLargestPossibleRegion());
  mask->SetSpacing(fixed.GetSpacing());
  mask->SetOrigin(fixed.GetOrigin());
  mask->SetDirection(fixed.GetDirection());
  mask->Allocate();

  std::size_t                             inside = 0;
  itk::ImageRegionIteratorWithIndex<MaskType> voxel(mask, mask->GetLargestPossibleRegion());
  for (voxel.GoToBegin(); !voxel.IsAtEnd(); ++voxel)
  {
    MaskType::PointType point;
    mask->TransformIndexToPhysicalPoint(voxel.GetIndex(), point);
    const bool within = point[0] >= low[0] && point[0] <= high[0] && point[1] >= low[1] && point[1] <= high[1] &&
                        point[2] >= low[2] && point[2] <= high[2];
    voxel.Set(within ? 1 : 0);
    inside += within ? 1 : 0;
  }
  // A handful of voxels is nothing to register on.
  return inside >= 1000 ? mask : nullptr;
}

int
version()
{
  std::printf("{\"tool\":\"ors-register-rigid\",\"version\":%s,\"itk\":%s,\"elastix\":%s}\n",
              ors::quoted(ORS_NATIVE_VERSION).c_str(),
              ors::quoted(itk::Version::GetITKVersion()).c_str(),
              ors::quoted(ORS_ELASTIX_VERSION).c_str());
  return 0;
}

int
registerRigid(const Options & options)
{
  int status = 0;

  ors::progress(0.0, "Reading the fixed volume");
  const ors::VolumeType::Pointer fixed = volume(options.fixed, "unreadable-fixed", options.verbose, status);
  if (fixed.IsNull())
  {
    return status;
  }
  ors::progress(0.07, "Reading the moving volume");
  const ors::VolumeType::Pointer moving = volume(options.moving, "unreadable-moving", options.verbose, status);
  if (moving.IsNull())
  {
    return status;
  }

  // Where to start from.
  using AffineType = itk::AffineTransform<double, 3>;
  AffineType::Pointer start;
  if (!options.initial.empty())
  {
    const std::vector<double> matrix = readMatrix(options.initial);
    if (matrix.size() != 16 || !isRigid(matrix))
    {
      return ors::fail(ors::STATUS_UNREADABLE, "bad-initial");
    }
    AffineType::MatrixType       turn;
    AffineType::OutputVectorType move;
    for (unsigned int row = 0; row < 3; ++row)
    {
      for (unsigned int column = 0; column < 3; ++column)
      {
        turn[row][column] = matrix[4 * row + column];
      }
      move[row] = matrix[4 * row + 3];
    }
    start = AffineType::New();
    start->SetMatrix(turn);
    start->SetTranslation(move);
  }

  itk::Image<unsigned char, 3>::Pointer mask;
  if (!options.roi.empty())
  {
    mask = boxMask(*fixed, options.roi);
    if (mask.IsNull())
    {
      return ors::fail(ors::STATUS_UNREADABLE, "roi-empty");
    }
  }

  if (options.threads > 0)
  {
    itk::MultiThreaderBase::SetGlobalDefaultNumberOfThreads(options.threads);
  }

  // A rigid registration of two volumes that need not look alike (CT and
  // MR, say): mutual information, on points drawn at random, from coarse to
  // fine.
  const auto parameters = elx::ParameterObject::New();
  parameters->SetParameterMap(elx::ParameterObject::ParameterMapType{
    { "Registration", { "MultiResolutionRegistration" } },
    { "FixedImagePyramid", { "FixedSmoothingImagePyramid" } },
    { "MovingImagePyramid", { "MovingSmoothingImagePyramid" } },
    { "NumberOfResolutions", { std::to_string(RESOLUTIONS) } },
    { "Transform", { "EulerTransform" } },
    { "AutomaticScalesEstimation", { "true" } },
    // With somewhere to start from, start there; otherwise centre on centre.
    { "AutomaticTransformInitialization", { start.IsNull() ? "true" : "false" } },
    { "AutomaticTransformInitializationMethod", { "GeometricalCenter" } },
    { "HowToCombineTransforms", { "Compose" } },
    { "Metric", { "AdvancedMattesMutualInformation" } },
    { "NumberOfHistogramBins", { "32" } },
    { "ImageSampler", { "RandomCoordinate" } },
    { "NumberOfSpatialSamples", { "4096" } },
    { "NewSamplesEveryIteration", { "true" } },
    { "CheckNumberOfSamples", { "true" } },
    { "RandomSeed", { std::to_string(options.seed) } },
    { "Interpolator", { "LinearInterpolator" } },
    { "Optimizer", { "AdaptiveStochasticGradientDescent" } },
    { "AutomaticParameterEstimation", { "true" } },
    { "MaximumNumberOfIterations", { std::to_string(options.iterations) } },
    { "ErodeMask", { "false" } },
    { "WriteResultImage", { "false" } },
    { "WriteIterationInfo", { "false" } },
  });

  const auto registration = itk::ElastixRegistrationMethod<ors::VolumeType, ors::VolumeType>::New();
  registration->SetFixedImage(fixed);
  registration->SetMovingImage(moving);
  registration->SetParameterObject(parameters);
  if (start.IsNotNull())
  {
    registration->SetInitialTransform(start);
  }
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
  std::vector<double> matrix(16, 0.0);
  try
  {
    LogWatcher watcher(options.iterations, options.verbose);
    {
      const WatchedLog watched(watcher);
      registration->Update();
    }

    // The transform as a matrix, read off what it does to four points: no
    // convention of angles or of a centre of rotation is taken on trust.
    const auto * const found = registration->GetCombinationTransform();
    if (found == nullptr)
    {
      return ors::fail(ors::STATUS_FAILED, "registration-failed");
    }
    using PointType = itk::Point<double, 3>;
    const double reach = 100.0;
    PointType    zero;
    zero.Fill(0.0);
    const PointType origin = found->TransformPoint(zero);
    for (unsigned int column = 0; column < 3; ++column)
    {
      PointType along = zero;
      along[column] = reach;
      const PointType mapped = found->TransformPoint(along);
      for (unsigned int row = 0; row < 3; ++row)
      {
        matrix[4 * row + column] = (mapped[row] - origin[row]) / reach;
      }
    }
    for (unsigned int row = 0; row < 3; ++row)
    {
      matrix[4 * row + 3] = origin[row];
    }
    matrix[15] = 1.0;
  }
  catch (const std::exception & problem)
  {
    return ors::fail(ors::STATUS_FAILED, "registration-failed", options.verbose ? problem.what() : "");
  }
  for (const double value : matrix)
  {
    if (!std::isfinite(value))
    {
      return ors::fail(ors::STATUS_FAILED, "registration-failed");
    }
  }
  if (!isRigid(matrix))
  {
    return ors::fail(ors::STATUS_FAILED, "not-rigid");
  }

  ors::progress(REGISTERING_TO, "Writing the result");
  const std::string json = "{\"fixedToMoving\":" + ors::list(matrix, "%.17g") +
                           ",\"seed\":" + std::to_string(options.seed) +
                           ",\"iterations\":" + std::to_string(options.iterations) +
                           ",\"resolutions\":" + std::to_string(RESOLUTIONS) + "}";
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
    else if (argument == "--output")
    {
      options.output = value;
    }
    else if (argument == "--initial")
    {
      options.initial = value;
    }
    else if (argument == "--roi")
    {
      options.roi = numbers(value);
      if (options.roi.size() != 6)
      {
        return ors::fail(ors::STATUS_USAGE, "usage");
      }
    }
    else if (argument == "--seed" || argument == "--threads" || argument == "--iterations")
    {
      const long number = wholeNumber(value, argument == "--seed" ? 2147483647L : 100000L);
      if (number < 0 || (argument != "--seed" && number == 0))
      {
        return ors::fail(ors::STATUS_USAGE, "usage");
      }
      (argument == "--seed" ? options.seed : argument == "--threads" ? options.threads : options.iterations) =
        static_cast<unsigned int>(number);
    }
    else
    {
      return ors::fail(ors::STATUS_USAGE, "usage");
    }
  }
  if (options.fixed.empty() || options.moving.empty() || options.output.empty())
  {
    return ors::fail(ors::STATUS_USAGE, "usage");
  }
  return registerRigid(options);
}
