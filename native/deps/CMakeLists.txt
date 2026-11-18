# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Builds what the native tools are made of, ITK and elastix, as static
# libraries into one folder (CMAKE_INSTALL_PREFIX). It takes long and seldom
# changes, so it is a build of its own: CI keeps the folder between runs, and
# the tools (../CMakeLists.txt) are built against it in a minute or two.
#
#   cmake -S native/deps -B <build>/deps -DCMAKE_INSTALL_PREFIX=<build>/prefix
#   cmake --build <build>/deps --config Release
#
# `node scripts/native.mjs deps` does this.
#
# In the folder afterwards:
#   lib/, include/           ITK, installed
#   elastix/src, elastix/build   elastix, used from where it was built, which
#                            is how elastix is meant to be used by a program
#   share/open-rt-studio/    the licences of both, and what was built (a
#                            stamp each, so that a second run builds nothing)

cmake_minimum_required(VERSION 3.24)
include(${CMAKE_CURRENT_LIST_DIR}/../cmake/platform.cmake)
project(OpenRtStudioNativeDependencies LANGUAGES C CXX)

include(ExternalProject)
include(${CMAKE_CURRENT_LIST_DIR}/../cmake/versions.cmake)

if(CMAKE_INSTALL_PREFIX_INITIALIZED_TO_DEFAULT)
  message(FATAL_ERROR
    "Say where the libraries go: -DCMAKE_INSTALL_PREFIX=<folder>. They are not installed into the system.")
endif()

set(ORS_SHARE_DIR "${CMAKE_INSTALL_PREFIX}/share/open-rt-studio")
set(ORS_LICENSES_DIR "${ORS_SHARE_DIR}/licenses")
set(ORS_ELASTIX_SOURCE_DIR "${CMAKE_INSTALL_PREFIX}/elastix/src")
set(ORS_ELASTIX_BINARY_DIR "${CMAKE_INSTALL_PREFIX}/elastix/build")

# Told to both builds alike. Through the cache and not the command line, so
# that a path with a space in it arrives whole.
set(common_args
  -DCMAKE_BUILD_TYPE:STRING=Release
  -DCMAKE_INSTALL_PREFIX:PATH=${CMAKE_INSTALL_PREFIX}
  -DBUILD_SHARED_LIBS:BOOL=OFF
  -DBUILD_TESTING:BOOL=OFF
  # Windows: the runtime inside each tool (cmake/platform.cmake). Only the
  # optimised kind is built here.
  -DCMAKE_POLICY_DEFAULT_CMP0091:STRING=NEW
  -DCMAKE_MSVC_RUNTIME_LIBRARY:STRING=MultiThreaded
)
if(NOT CMAKE_GENERATOR MATCHES "Visual Studio")
  # The same compiler throughout. Visual Studio chooses its own, the same
  # for every project it is given.
  list(APPEND common_args
    -DCMAKE_C_COMPILER:FILEPATH=${CMAKE_C_COMPILER}
    -DCMAKE_CXX_COMPILER:FILEPATH=${CMAKE_CXX_COMPILER})
endif()
if(APPLE)
  list(APPEND common_args -DCMAKE_OSX_DEPLOYMENT_TARGET:STRING=${CMAKE_OSX_DEPLOYMENT_TARGET})
  if(CMAKE_OSX_ARCHITECTURES)
    list(LENGTH CMAKE_OSX_ARCHITECTURES architectures)
    if(architectures GREATER 1)
      # ITK works out what the processor can do when it is configured, once.
      # A universal tool is made of two builds, joined afterwards (lipo).
      message(FATAL_ERROR "Build for one architecture at a time: ${CMAKE_OSX_ARCHITECTURES}")
    endif()
    list(APPEND common_args -DCMAKE_OSX_ARCHITECTURES:STRING=${CMAKE_OSX_ARCHITECTURES})
  endif()
endif()

# What a finished build leaves behind, to know it by: the version, the
# checksum of its source and how it was configured. The same text there
# already means there is nothing to do.
function(ors_is_built name text result)
  set(${result} FALSE PARENT_SCOPE)
  file(WRITE "${CMAKE_BINARY_DIR}/${name}.stamp" "${text}")
  if(EXISTS "${ORS_SHARE_DIR}/${name}.stamp")
    file(READ "${ORS_SHARE_DIR}/${name}.stamp" found)
    if(found STREQUAL text)
      set(${result} TRUE PARENT_SCOPE)
    endif()
  endif()
endfunction()

# --- ITK -------------------------------------------------------------------
#
# Not all of ITK: the modules elastix asks for, and the image formats the
# tools read and write. Nothing is fetched while it builds, and FFTW, which
# is GPL, stays off.
set(itk_modules
  # What elastix needs (the list in its CMakeLists.txt).
  ITKCommon
  ITKDisplacementField
  ITKDistanceMap
  ITKGDCM
  ITKImageCompose
  ITKImageFunction
  ITKImageGradient
  ITKImageGrid
  ITKImageIntensity
  ITKImageStatistics
  ITKMathematicalMorphology
  ITKMesh
  ITKOptimizers
  ITKRegistrationCommon
  ITKSmoothing
  ITKSpatialObjects
  ITKStatistics
  ITKTestKernel
  ITKThresholding
  ITKTransform
  ITKTransformFactory
  ITKIOImageBase
  ITKIOMeshBase
  ITKIOMeshOBJ
  ITKIOMeta
  ITKIOTransformBase
  ITKIOXML
  # Formats of the tools' own: volumes in and out, and a transform as text.
  ITKIONRRD
  ITKIONIFTI
  ITKIOTransformInsightLegacy
)
set(itk_args
  -DITK_BUILD_DEFAULT_MODULES:BOOL=OFF
  -DBUILD_EXAMPLES:BOOL=OFF
  -DITK_WRAPPING:BOOL=OFF
  -DITK_BUILD_DOCUMENTATION:BOOL=OFF
  -DITK_FORBID_DOWNLOADS:BOOL=ON
  -DITK_USE_KWSTYLE:BOOL=OFF
  -DITK_USE_GPU:BOOL=OFF
  -DITK_USE_FFTWF:BOOL=OFF
  -DITK_USE_FFTWD:BOOL=OFF
  # Eigen refuses to compile what of it is not under the MPL.
  -DITK_USE_EIGEN_MPL2_ONLY:BOOL=ON
  -DITK_MSVC_STATIC_RUNTIME_LIBRARY:BOOL=ON
)
foreach(module IN LISTS itk_modules)
  list(APPEND itk_args -DModule_${module}:BOOL=ON)
endforeach()

ors_is_built(itk "ITK ${ORS_ITK_VERSION} ${ORS_ITK_SHA512} ${common_args} ${itk_args}" itk_built)
if(itk_built)
  message(STATUS "ITK ${ORS_ITK_VERSION} is already in ${CMAKE_INSTALL_PREFIX}")
  add_custom_target(itk)
else()
  ExternalProject_Add(itk
    URL ${ORS_ITK_URL}
    URL_HASH SHA512=${ORS_ITK_SHA512}
    DOWNLOAD_EXTRACT_TIMESTAMP FALSE
    # Short names: ITK refuses a long path on Windows.
    PREFIX "${CMAKE_BINARY_DIR}/itk"
    SOURCE_DIR "${CMAKE_BINARY_DIR}/itk-src"
    BINARY_DIR "${CMAKE_BINARY_DIR}/itk-bld"
    CMAKE_CACHE_ARGS ${common_args} ${itk_args}
  )
  ExternalProject_Add_Step(itk record
    COMMAND ${CMAKE_COMMAND} -E make_directory "${ORS_LICENSES_DIR}/ITK"
    COMMAND ${CMAKE_COMMAND} -E copy <SOURCE_DIR>/LICENSE <SOURCE_DIR>/NOTICE "${ORS_LICENSES_DIR}/ITK"
    COMMAND ${CMAKE_COMMAND} -E copy "${CMAKE_BINARY_DIR}/itk.stamp" "${ORS_SHARE_DIR}/itk.stamp"
    DEPENDEES install
  )
endif()

# --- elastix ---------------------------------------------------------------
#
# The libraries only, for volumes of three dimensions and one pixel type.
# Left out: what needs OpenCL, what needs LibTorch (the IMPACT metric), and
# the one metric that would bring in ANN, which is LGPL. It is not
# installed: a program finds it where it was built (Elastix_DIR).
set(elastix_args
  -DCMAKE_PREFIX_PATH:PATH=${CMAKE_INSTALL_PREFIX}
  -DELASTIX_BUILD_EXECUTABLE:BOOL=OFF
  -DELASTIX_IMAGE_DIMENSIONS:STRING=3
  -DELASTIX_IMAGE_3D_PIXELTYPES:STRING=float
  -DELASTIX_USE_OPENCL:BOOL=OFF
  -DELASTIX_USE_EIGEN:BOOL=OFF
  -DELASTIX_USE_MEVISDICOMTIFF:BOOL=OFF
  -DELASTIX_USE_GTEST:BOOL=OFF
  -DBUILD_DOCUMENTATION:BOOL=OFF
  -DUSE_ALL_COMPONENTS:BOOL=OFF
  -DUSE_KNNGraphAlphaMutualInformationMetric:BOOL=OFF
  -DUSE_ImpactMetric:BOOL=OFF
)

ors_is_built(elastix
  "elastix ${ORS_ELASTIX_VERSION} ${ORS_ELASTIX_SHA256} on ITK ${ORS_ITK_SHA512} ${common_args} ${itk_args} ${elastix_args}"
  elastix_built)
if(elastix_built)
  message(STATUS "elastix ${ORS_ELASTIX_VERSION} is already in ${CMAKE_INSTALL_PREFIX}")
  add_custom_target(elastix)
else()
  ExternalProject_Add(elastix
    DEPENDS itk
    URL ${ORS_ELASTIX_URL}
    URL_HASH SHA256=${ORS_ELASTIX_SHA256}
    DOWNLOAD_NAME "elastix-${ORS_ELASTIX_VERSION}.tar.gz"
    DOWNLOAD_EXTRACT_TIMESTAMP FALSE
    PREFIX "${CMAKE_BINARY_DIR}/elx"
    SOURCE_DIR "${ORS_ELASTIX_SOURCE_DIR}"
    BINARY_DIR "${ORS_ELASTIX_BINARY_DIR}"
    CMAKE_CACHE_ARGS ${common_args} ${elastix_args}
    INSTALL_COMMAND ""
  )
  ExternalProject_Add_Step(elastix record
    COMMAND ${CMAKE_COMMAND} -E make_directory "${ORS_LICENSES_DIR}/elastix"
    COMMAND ${CMAKE_COMMAND} -E copy <SOURCE_DIR>/LICENSE <SOURCE_DIR>/NOTICE "${ORS_LICENSES_DIR}/elastix"
    COMMAND ${CMAKE_COMMAND} -E copy "${CMAKE_BINARY_DIR}/elastix.stamp" "${ORS_SHARE_DIR}/elastix.stamp"
    DEPENDEES build
  )
endif()
