# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# What every part of the native build agrees on, so that the tools and the
# libraries under them are built the same way. Included before project().

# macOS: the oldest system the tools run on. The desktop application's own
# floor is no lower.
if(CMAKE_HOST_APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0" CACHE STRING "The oldest macOS the tools run on")
endif()

# Windows: the C and C++ runtime is linked into each tool, so that a tool
# needs no redistributable installed beside it.
cmake_policy(SET CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# One kind of build: optimised, without debugging information.
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "The kind of build" FORCE)
endif()
