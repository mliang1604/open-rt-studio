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
#include <exception>
#include <fstream>
#include <string>
#include <vector>

#include <itkElastixRegistrationMethod.h>
#include <elxParameterObject.h>
#include <itkMultiThreaderBase.h>
#include <itkVersion.h>

#include "ors_common.h"
#include "ors_registration.h"
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
  const ors::VolumeType::Pointer fixed =
    ors::volumeOrFail(options.fixed, "unreadable-fixed", options.verbose, status);
  if (fixed.IsNull())
  {
    return status;
  }
  ors::progress(0.07, "Reading the moving volume");
  const ors::VolumeType::Pointer moving =
    ors::volumeOrFail(options.moving, "unreadable-moving", options.verbose, status);
  if (moving.IsNull())
  {
    return status;
  }

  // Where to start from.
  ors::AffineType::Pointer start;
  if (!options.initial.empty())
  {
    const std::vector<double> matrix = ors::readMatrix(options.initial);
    if (!ors::isRigid(matrix))
    {
      return ors::fail(ors::STATUS_UNREADABLE, "bad-initial");
    }
    start = ors::affineOf(matrix);
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
    ors::LogWatcher watcher(
      RESOLUTIONS, options.iterations, REGISTERING_FROM, REGISTERING_TO, "Registering", options.verbose);
    {
      const ors::WatchedLog watched(watcher);
      registration->Update();
    }
    const auto * const found = registration->GetCombinationTransform();
    if (found == nullptr)
    {
      return ors::fail(ors::STATUS_FAILED, "registration-failed");
    }
    matrix = ors::matrixOf(*found);
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
  if (!ors::isRigid(matrix))
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
      options.roi = ors::numbers(value);
      if (options.roi.size() != 6)
      {
        return ors::fail(ors::STATUS_USAGE, "usage");
      }
    }
    else if (argument == "--seed" || argument == "--threads" || argument == "--iterations")
    {
      const long number = ors::wholeNumber(value, argument == "--seed" ? 2147483647L : 100000L);
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
