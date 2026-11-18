# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# The native tools: small command-line programs on ITK and elastix that the
# server starts as jobs. They read and write files, say what they did on
# standard output as JSON, and use no network.
#
# ITK and elastix are built first, by deps/CMakeLists.txt, into a folder
# that is named here with ORS_DEPS_PREFIX:
#
#   cmake -S native -B <build>/tools -DORS_DEPS_PREFIX=<build>/prefix
#   cmake --build <build>/tools --config Release
#   ctest --test-dir <build>/tools -C Release --output-on-failure
#
# `node scripts/native.mjs build` and `... test` do this. See README.md.

cmake_minimum_required(VERSION 3.24)
include(${CMAKE_CURRENT_LIST_DIR}/cmake/platform.cmake)
project(OpenRtStudioNative VERSION 0.1.0 LANGUAGES CXX)

include(${CMAKE_CURRENT_LIST_DIR}/cmake/versions.cmake)

set(ORS_DEPS_PREFIX "" CACHE PATH "The folder deps/CMakeLists.txt built ITK and elastix into")
if(NOT ORS_DEPS_PREFIX)
  message(FATAL_ERROR
    "Say where ITK and elastix were built: -DORS_DEPS_PREFIX=<folder>. See native/README.md.")
endif()
get_filename_component(ORS_DEPS_PREFIX "${ORS_DEPS_PREFIX}" ABSOLUTE)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# The versions that are pinned, and no other that happens to be installed.
find_package(ITK ${ORS_ITK_VERSION} EXACT REQUIRED
  PATHS "${ORS_DEPS_PREFIX}" NO_DEFAULT_PATH)
find_package(Elastix ${ORS_ELASTIX_VERSION} EXACT REQUIRED
  PATHS "${ORS_DEPS_PREFIX}/elastix/build" NO_DEFAULT_PATH)

# Nothing of ITK that is not written down, with its licence.
include(${CMAKE_CURRENT_LIST_DIR}/cmake/itk_modules.cmake)
ors_check_itk_modules()

# The licences of what the tools are made of go wherever the tools go.
set(ORS_LICENSES_DIR "${ORS_DEPS_PREFIX}/share/open-rt-studio/licenses")
foreach(license ITK/LICENSE ITK/NOTICE elastix/LICENSE elastix/NOTICE)
  if(NOT EXISTS "${ORS_LICENSES_DIR}/${license}")
    message(FATAL_ERROR "A licence is missing from the dependencies: ${license}")
  endif()
endforeach()

# How every tool is linked: nothing to install beside it.
function(ors_self_contained target)
  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    # The C++ runtime inside the program; the C library is the system's.
    target_link_options(${target} PRIVATE -static-libstdc++ -static-libgcc)
  endif()
  if(MSVC)
    # File names as UTF-8, so that a folder with an accent in its name opens.
    target_sources(${target} PRIVATE "${PROJECT_SOURCE_DIR}/cmake/utf8.manifest")
  endif()
endfunction()

function(ors_warnings target)
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4)
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra)
  endif()
endfunction()

configure_file(cmake/ors_version.h.in generated/ors_version.h @ONLY)

add_subdirectory(tools/volume-info)
add_subdirectory(tools/register-rigid)

install(DIRECTORY "${ORS_LICENSES_DIR}/" DESTINATION licenses)
install(FILES THIRD-PARTY.md DESTINATION licenses)
install(FILES ../LICENSE DESTINATION licenses RENAME open-rt-studio-LICENSE)

include(CTest)
if(BUILD_TESTING)
  add_subdirectory(tests)
endif()
