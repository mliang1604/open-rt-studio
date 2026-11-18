# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# The tests of the native tools. Their data is made on the spot from a
# formula (synthetic_volume.h); no image file is in the repository.

# Writes the synthetic volume to a file. It uses nothing of ITK: what the
# tool reads was not written by the library that reads it.
add_executable(ors-make-test-volume make_test_volume.cxx)
ors_self_contained(ors-make-test-volume)
ors_warnings(ors-make-test-volume)

# The tool says what it is and what it was built on.
add_test(NAME volume-info-version COMMAND ors-volume-info --version)
set_tests_properties(volume-info-version PROPERTIES PASS_REGULAR_EXPRESSION
  "^{\"tool\":\"ors-volume-info\",\"version\":\"${PROJECT_VERSION}\",\"itk\":\"${ORS_ITK_VERSION}\",\"elastix\":\"${ORS_ELASTIX_VERSION}\"}")

# It reads the synthetic volume and prints the geometry it was written with,
# also from a folder whose name is not ASCII; and it refuses what is no volume.
add_test(NAME volume-info
  COMMAND ${CMAKE_COMMAND}
    -DTOOL=$<TARGET_FILE:ors-volume-info>
    -DMAKER=$<TARGET_FILE:ors-make-test-volume>
    -DWORK=${CMAKE_CURRENT_BINARY_DIR}/volume-info
    -P ${CMAKE_CURRENT_SOURCE_DIR}/volume_info_test.cmake)

# elastix itself, linked into a program of ours and run: it finds a known
# shift between two synthetic volumes. This is what says the libraries the
# registration tools will be made of work on this system.
add_executable(ors-toolchain-check toolchain_check.cxx)
target_include_directories(ors-toolchain-check PRIVATE
  "${PROJECT_BINARY_DIR}/generated"
  ${ELASTIX_INCLUDE_DIRS}
  ${ITK_INCLUDE_DIRS})
target_link_libraries(ors-toolchain-check PRIVATE elastix_lib ${ITK_LIBRARIES})
ors_self_contained(ors-toolchain-check)

add_test(NAME toolchain-elastix COMMAND ors-toolchain-check)
set_tests_properties(toolchain-elastix PROPERTIES TIMEOUT 600)
