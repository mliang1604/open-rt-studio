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

# --- ors-register-rigid (#80) -------------------------------------------------

# Writes the synthetic pair and says how near a result is to the transform
# the pair was made with. Nothing of ITK or elastix is in it.
add_executable(ors-make-registration-pair make_registration_pair.cxx)
ors_self_contained(ors-make-registration-pair)
ors_warnings(ors-make-registration-pair)

add_test(NAME register-rigid-version COMMAND ors-register-rigid --version)
set_tests_properties(register-rigid-version PROPERTIES PASS_REGULAR_EXPRESSION
  "^{\"tool\":\"ors-register-rigid\",\"version\":\"${PROJECT_VERSION}\",\"itk\":\"${ORS_ITK_VERSION}\",\"elastix\":\"${ORS_ELASTIX_VERSION}\"}")

# The tool finds the known transform of the synthetic pair, gives the same
# answer twice for one seed, takes a region of interest and a place to start
# from, reports as a job's worker does, and refuses what it cannot use.
add_test(NAME register-rigid
  COMMAND ${CMAKE_COMMAND}
    -DTOOL=$<TARGET_FILE:ors-register-rigid>
    -DPAIR=$<TARGET_FILE:ors-make-registration-pair>
    -DWORK=${CMAKE_CURRENT_BINARY_DIR}/register-rigid
    -P ${CMAKE_CURRENT_SOURCE_DIR}/register_rigid_test.cmake)
set_tests_properties(register-rigid PROPERTIES TIMEOUT 1200)

# --- ors-register-deformable (#81) --------------------------------------------

# Writes the synthetic deformed pair and says how near a result is to the
# deformation the pair was made with. Nothing of ITK or elastix is in it.
add_executable(ors-make-deformed-pair make_deformed_pair.cxx)
ors_self_contained(ors-make-deformed-pair)
ors_warnings(ors-make-deformed-pair)

add_test(NAME register-deformable-version COMMAND ors-register-deformable --version)
set_tests_properties(register-deformable-version PROPERTIES PASS_REGULAR_EXPRESSION
  "^{\"tool\":\"ors-register-deformable\",\"version\":\"${PROJECT_VERSION}\",\"itk\":\"${ORS_ITK_VERSION}\",\"elastix\":\"${ORS_ELASTIX_VERSION}\"}")

# The tool finds the known deformation of the synthetic pair with each of
# its presets, gives the same answer twice for one seed, starts from a
# matrix that is near and from none, takes a parameter set over the preset,
# and refuses what it cannot use.
add_test(NAME register-deformable
  COMMAND ${CMAKE_COMMAND}
    -DTOOL=$<TARGET_FILE:ors-register-deformable>
    -DPAIR=$<TARGET_FILE:ors-make-deformed-pair>
    -DPRESETS=${PROJECT_SOURCE_DIR}/presets/deformable
    -DWORK=${CMAKE_CURRENT_BINARY_DIR}/register-deformable
    -P ${CMAKE_CURRENT_SOURCE_DIR}/register_deformable_test.cmake)
set_tests_properties(register-deformable PROPERTIES TIMEOUT 3000)
