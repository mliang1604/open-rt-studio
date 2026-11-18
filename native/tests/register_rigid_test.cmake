# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# The test of ors-register-rigid, run by CTest:
#
#   cmake -DTOOL=<ors-register-rigid> -DPAIR=<ors-make-registration-pair> -DWORK=<folder> -P register_rigid_test.cmake
#
# The pair is a phantom on two different grids, in the second one turned and
# moved by a known transform (synthetic_pair.h). How near a result is, is
# measured at the eight corners of the fixed volume, where a wrong turn
# shows most.

foreach(needed TOOL PAIR WORK)
  if(NOT DEFINED ${needed})
    message(FATAL_ERROR "${needed} is not given")
  endif()
endforeach()

# How near the found transform has to come, at worst, in millimetres. The
# voxels of the pair are 3 to 4 mm.
set(TOLERANCE_MM 1.0)
# From a start that is the answer already, with one step taken at each
# resolution. The steps are drawn from random points, so it does not stay
# exactly there; were the start not taken at all, the corners would be more
# than 10 mm off, by the turn that one step cannot find.
set(TOLERANCE_FROM_TRUTH_MM 3.0)

# A folder whose name is not ASCII, as a user's folder may be.
set(folder "${WORK}/régistration-登録")
file(REMOVE_RECURSE "${WORK}")
file(MAKE_DIRECTORY "${folder}")
set(fixed "${folder}/fixed.mha")
set(moving "${folder}/moving.mha")

function(run result_variable output_variable error_variable)
  execute_process(
    COMMAND ${ARGN}
    RESULT_VARIABLE result
    OUTPUT_VARIABLE output
    ERROR_VARIABLE error)
  string(STRIP "${output}" output)
  string(STRIP "${error}" error)
  set(${result_variable} "${result}" PARENT_SCOPE)
  set(${output_variable} "${output}" PARENT_SCOPE)
  set(${error_variable} "${error}" PARENT_SCOPE)
endfunction()

# Run the tool and expect it to fail with a status and a code, naming no file.
function(refused status code)
  run(result output error "${TOOL}" ${ARGN})
  if(NOT result EQUAL ${status})
    message(FATAL_ERROR "Expected status ${status} (${code}), got ${result}: ${error}")
  endif()
  if(NOT error MATCHES "^{\"error\":\"${code}\"")
    message(FATAL_ERROR "Expected the code ${code}: ${error}")
  endif()
  if(error MATCHES "登録" OR error MATCHES "\\.mha" OR error MATCHES "\\.json")
    message(FATAL_ERROR "A failure names a file: ${error}")
  endif()
  if(output MATCHES "@result")
    message(FATAL_ERROR "A failure reported a result: ${output}")
  endif()
endfunction()

run(result output error "${PAIR}" write "${fixed}" "${moving}")
if(NOT result EQUAL 0)
  message(FATAL_ERROR "The pair was not written (${result}): ${error}")
endif()

# --- The known transform is found --------------------------------------------

run(result output error "${TOOL}" --fixed "${fixed}" --moving "${moving}" --output "${folder}/first.json" --seed 7 --threads 2)
if(NOT result EQUAL 0)
  message(FATAL_ERROR "The registration failed (${result}): ${error}\n${output}")
endif()
if(NOT error STREQUAL "")
  message(FATAL_ERROR "The tool wrote to standard error on success: ${error}")
endif()
run(result measured error "${PAIR}" check "${folder}/first.json" ${TOLERANCE_MM})
message(STATUS "found: ${measured}")
if(NOT result EQUAL 0)
  message(FATAL_ERROR "The transform found is not the one the pair was made with: ${measured} ${error}")
endif()

# --- It reports as a job's worker does ----------------------------------------

# Every line is a report: nothing of elastix's own log comes through.
string(REPLACE "\r" "" lines "${output}")
string(REPLACE ";" "," lines "${lines}")
string(REPLACE "\n" ";" lines "${lines}")
set(results 0)
set(steps 0)
foreach(line IN LISTS lines)
  if(line MATCHES "^@result {\"fixedToMoving\":\\[")
    math(EXPR results "${results} + 1")
  elseif(line MATCHES "^@progress [01]\\.[0-9][0-9][0-9] [A-Z]")
    math(EXPR steps "${steps} + 1")
  else()
    message(FATAL_ERROR "A line of standard output is no report: ${line}")
  endif()
endforeach()
if(NOT results EQUAL 1)
  message(FATAL_ERROR "Expected one @result line, found ${results}")
endif()
# Progress came from the registration itself, step by step, and not only
# from before and after it.
if(steps LESS 20)
  message(FATAL_ERROR "Expected progress all the way through, found ${steps} lines:\n${output}")
endif()
if(NOT output MATCHES "@progress 1\\.000 Done")
  message(FATAL_ERROR "The last progress is not 1: ${output}")
endif()
message(STATUS "progress lines: ${steps}")

# What it wrote to the file is what it reported.
file(READ "${folder}/first.json" written)
string(STRIP "${written}" written)
if(NOT output MATCHES "@result ")
  message(FATAL_ERROR "No result line")
endif()
string(FIND "${output}" "@result ${written}" same)
if(same EQUAL -1)
  message(FATAL_ERROR "The file and the result line differ.\n  file: ${written}")
endif()

# --- The same seed gives the same matrix --------------------------------------

run(result output error "${TOOL}" --fixed "${fixed}" --moving "${moving}" --output "${folder}/second.json" --seed 7 --threads 2)
if(NOT result EQUAL 0)
  message(FATAL_ERROR "The second registration failed (${result}): ${error}")
endif()
file(READ "${folder}/second.json" again)
string(STRIP "${again}" again)
if(NOT again STREQUAL written)
  message(FATAL_ERROR "The same seed gave another matrix.\n  first:  ${written}\n  second: ${again}")
endif()

# Another seed draws other points: another matrix, as near.
run(result output error "${TOOL}" --fixed "${fixed}" --moving "${moving}" --output "${folder}/other.json" --seed 8 --threads 2)
if(NOT result EQUAL 0)
  message(FATAL_ERROR "The registration with another seed failed (${result}): ${error}")
endif()
file(READ "${folder}/other.json" other)
string(STRIP "${other}" other)
if(other STREQUAL written)
  message(FATAL_ERROR "Another seed gave the very same matrix: the seed is not used")
endif()
run(result measured error "${PAIR}" check "${folder}/other.json" ${TOLERANCE_MM})
message(STATUS "another seed: ${measured}")
if(NOT result EQUAL 0)
  message(FATAL_ERROR "With another seed the transform is not found: ${measured}")
endif()

# --- A region of interest -----------------------------------------------------

# The middle of the phantom, which holds three of its four blobs.
run(result output error "${TOOL}" --fixed "${fixed}" --moving "${moving}" --output "${folder}/roi.json" --roi -50,-50,-45,50,50,45)
if(NOT result EQUAL 0)
  message(FATAL_ERROR "The registration in a region failed (${result}): ${error}")
endif()
run(result measured error "${PAIR}" check "${folder}/roi.json" ${TOLERANCE_MM})
message(STATUS "in a region: ${measured}")
if(NOT result EQUAL 0)
  message(FATAL_ERROR "In a region the transform is not found: ${measured}")
endif()
file(READ "${folder}/roi.json" in_region)
string(STRIP "${in_region}" in_region)
run(result output error "${TOOL}" --fixed "${fixed}" --moving "${moving}" --output "${folder}/whole.json")
file(READ "${folder}/whole.json" whole)
string(STRIP "${whole}" whole)
if(in_region STREQUAL whole)
  message(FATAL_ERROR "The region changed nothing: it is not used")
endif()

# --- A place to start from ----------------------------------------------------

# From the answer itself, one step at each resolution: it stays near.
run(result output error "${PAIR}" truth "${folder}/truth.json")
run(result output error "${TOOL}" --fixed "${fixed}" --moving "${moving}" --output "${folder}/started.json" --initial "${folder}/truth.json" --iterations 1)
if(NOT result EQUAL 0)
  message(FATAL_ERROR "The registration from a start failed (${result}): ${error}")
endif()
run(result measured error "${PAIR}" check "${folder}/started.json" ${TOLERANCE_FROM_TRUTH_MM})
message(STATUS "from the truth, one step: ${measured}")
if(NOT result EQUAL 0)
  message(FATAL_ERROR "The start was not taken: ${measured}")
endif()

# --- What it cannot use is refused, and no file is named -----------------------

file(WRITE "${folder}/text.mha" "This is not a volume.\n")
file(WRITE "${folder}/sheared.json" "{\"fixedToMoving\":[1,0.3,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}\n")
file(WRITE "${folder}/short.json" "{\"fixedToMoving\":[1,0,0,0]}\n")

refused(3 unreadable-fixed --fixed "${folder}/text.mha" --moving "${moving}" --output "${folder}/no.json")
refused(3 unreadable-moving --fixed "${fixed}" --moving "${folder}/missing.mha" --output "${folder}/no.json")
refused(3 bad-initial --fixed "${fixed}" --moving "${moving}" --output "${folder}/no.json" --initial "${folder}/sheared.json")
refused(3 bad-initial --fixed "${fixed}" --moving "${moving}" --output "${folder}/no.json" --initial "${folder}/short.json")
refused(3 bad-initial --fixed "${fixed}" --moving "${moving}" --output "${folder}/no.json" --initial "${folder}/missing.json")
refused(3 roi-empty --fixed "${fixed}" --moving "${moving}" --output "${folder}/no.json" --roi 900,900,900,950,950,950)
refused(2 usage --fixed "${fixed}" --moving "${moving}")
refused(2 usage --fixed "${fixed}" --moving "${moving}" --output "${folder}/no.json" --roi 1,2,3)
refused(2 usage --fixed "${fixed}" --moving "${moving}" --output "${folder}/no.json" --seed minus-one)
refused(2 usage --fixed "${fixed}" --moving "${moving}" --output "${folder}/no.json" --threads 0)
refused(2 usage --fixed "${fixed}" --moving "${moving}" --output "${folder}/no.json" --no-such-option 1)
if(EXISTS "${folder}/no.json")
  message(FATAL_ERROR "A refused run wrote an output file")
endif()

message(STATUS "ors-register-rigid: passed")
