/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ors-toolchain-check: elastix, linked into a program of ours and run.
//
// Two synthetic volumes hold the same blob, in the second one moved by a
// known number of millimetres. elastix is asked for the translation between
// them, and the test passes when it finds the one they were made with. It is
// no test of registration quality: it says that ITK and elastix were built,
// linked and can run on this system, components and all.

#include <cmath>
#include <cstdio>
#include <exception>
#include <string>

#include <itkElastixRegistrationMethod.h>
#include <elxParameterObject.h>
#include <Core/elxVersionMacros.h>
#include <itkImage.h>
#include <itkImageRegionIteratorWithIndex.h>
#include <itkVersion.h>

#include "ors_version.h"

namespace
{

using VolumeType = itk::Image<float, 3>;

// The grid of both volumes: voxels that are not cubes.
constexpr unsigned int SIZE[3] = { 32, 32, 24 };
constexpr double       SPACING[3] = { 2.0, 2.0, 3.0 };

// The blob: where it is in the fixed volume and how wide, in millimetres.
constexpr double CENTRE[3] = { 31.0, 31.0, 34.5 };
constexpr double SIGMA = 8.0;

// How far the blob is moved in the moving volume. elastix finds the
// transform that takes a point of the fixed volume to the same place in the
// moving one, so this is the translation it should come back with.
constexpr double SHIFT[3] = { 3.0, -2.0, 4.5 };

// How near it has to come, in millimetres.
constexpr double TOLERANCE = 0.5;

VolumeType::Pointer
blobAt(const double centre[3])
{
  const auto            volume = VolumeType::New();
  VolumeType::SizeType  size;
  VolumeType::SpacingType spacing;
  for (unsigned int axis = 0; axis < 3; ++axis)
  {
    size[axis] = SIZE[axis];
    spacing[axis] = SPACING[axis];
  }
  volume->SetRegions(size);
  volume->SetSpacing(spacing);
  volume->Allocate();

  itk::ImageRegionIteratorWithIndex<VolumeType> voxel(volume, volume->GetBufferedRegion());
  for (voxel.GoToBegin(); !voxel.IsAtEnd(); ++voxel)
  {
    VolumeType::PointType point;
    volume->TransformIndexToPhysicalPoint(voxel.GetIndex(), point);
    double squared = 0.0;
    for (unsigned int axis = 0; axis < 3; ++axis)
    {
      const double away = point[axis] - centre[axis];
      squared += away * away;
    }
    voxel.Set(static_cast<float>(1000.0 * std::exp(-squared / (2.0 * SIGMA * SIGMA))));
  }
  return volume;
}

} // namespace

int
main()
{
  try
  {
    if (std::string(ELASTIX_VERSION_STRING) != ORS_ELASTIX_VERSION)
    {
      std::fprintf(stderr, "elastix is %s, not the pinned %s\n", ELASTIX_VERSION_STRING, ORS_ELASTIX_VERSION);
      return 1;
    }
    if (std::string(itk::Version::GetITKVersion()) != ORS_ITK_VERSION)
    {
      std::fprintf(stderr, "ITK is %s, not the pinned %s\n", itk::Version::GetITKVersion(), ORS_ITK_VERSION);
      return 1;
    }

    const double moved[3] = { CENTRE[0] + SHIFT[0], CENTRE[1] + SHIFT[1], CENTRE[2] + SHIFT[2] };
    const VolumeType::Pointer fixed = blobAt(CENTRE);
    const VolumeType::Pointer moving = blobAt(moved);

    const auto parameters = elx::ParameterObject::New();
    parameters->SetParameterMap(elx::ParameterObject::ParameterMapType{
      { "Registration", { "MultiResolutionRegistration" } },
      { "FixedImagePyramid", { "FixedSmoothingImagePyramid" } },
      { "MovingImagePyramid", { "MovingSmoothingImagePyramid" } },
      { "NumberOfResolutions", { "2" } },
      { "Transform", { "TranslationTransform" } },
      { "AutomaticTransformInitialization", { "false" } },
      { "Metric", { "AdvancedMeanSquares" } },
      { "ImageSampler", { "Full" } },
      { "Interpolator", { "LinearInterpolator" } },
      { "Optimizer", { "AdaptiveStochasticGradientDescent" } },
      { "MaximumNumberOfIterations", { "200" } },
      { "WriteResultImage", { "false" } },
    });

    const auto registration = itk::ElastixRegistrationMethod<VolumeType, VolumeType>::New();
    registration->SetFixedImage(fixed);
    registration->SetMovingImage(moving);
    registration->SetParameterObject(parameters);
    registration->SetLogToConsole(false);
    registration->SetLogToFile(false);
    registration->Update();

    const auto * const found = registration->GetTransformParameterObject();
    if (found == nullptr || found->GetParameterMaps().empty())
    {
      std::fprintf(stderr, "elastix gave no transform\n");
      return 1;
    }
    const auto & map = found->GetParameterMaps().front();
    const auto   values = map.find("TransformParameters");
    if (values == map.cend() || values->second.size() != 3)
    {
      std::fprintf(stderr, "elastix gave no translation\n");
      return 1;
    }

    double translation[3];
    double worst = 0.0;
    for (unsigned int axis = 0; axis < 3; ++axis)
    {
      translation[axis] = std::stod(values->second[axis]);
      worst = std::fmax(worst, std::fabs(translation[axis] - SHIFT[axis]));
    }
    std::printf("{\"itk\":\"%s\",\"elastix\":\"%s\",\"translation\":[%.4f,%.4f,%.4f],"
                "\"expected\":[%.4f,%.4f,%.4f],\"worstMm\":%.4f,\"toleranceMm\":%.2f}\n",
                itk::Version::GetITKVersion(),
                ELASTIX_VERSION_STRING,
                translation[0],
                translation[1],
                translation[2],
                SHIFT[0],
                SHIFT[1],
                SHIFT[2],
                worst,
                TOLERANCE);
    if (!(worst <= TOLERANCE))
    {
      std::fprintf(stderr, "elastix found another translation than the volumes were made with\n");
      return 1;
    }
    return 0;
  }
  catch (const std::exception & problem)
  {
    std::fprintf(stderr, "the toolchain check failed: %s\n", problem.what());
    return 1;
  }
}
