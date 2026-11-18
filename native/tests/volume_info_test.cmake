# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# The test of ors-volume-info, run by CTest:
#
#   cmake -DTOOL=<ors-volume-info> -DMAKER=<ors-make-test-volume> -DWORK=<folder> -P volume_info_test.cmake
#
# The volume is written into a folder whose name is not ASCII, as a user's
# folder may be.

foreach(needed TOOL MAKER WORK)
  if(NOT DEFINED ${needed})
    message(FATAL_ERROR "${needed} is not given")
  endif()
endforeach()

set(folder "${WORK}/données-データ")
file(REMOVE_RECURSE "${WORK}")
file(MAKE_DIRECTORY "${folder}")
set(volume "${folder}/volume.mha")

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

# --- The volume, and what a reader should say of it -------------------------

run(result output error "${MAKER}" "${volume}")
if(NOT result EQUAL 0 OR NOT EXISTS "${volume}")
  message(FATAL_ERROR "The test volume was not written (${result}): ${error}")
endif()

run(result expected error "${MAKER}" --expected)
if(NOT result EQUAL 0 OR expected STREQUAL "")
  message(FATAL_ERROR "The expected line was not printed (${result}): ${error}")
endif()

run(result output error "${TOOL}" "${volume}")
if(NOT result EQUAL 0)
  message(FATAL_ERROR "ors-volume-info failed on the test volume (${result}): ${error}")
endif()
if(NOT output STREQUAL expected)
  message(FATAL_ERROR "The geometry differs.\n  printed:  ${output}\n  expected: ${expected}")
endif()
if(NOT error STREQUAL "")
  message(FATAL_ERROR "ors-volume-info wrote to standard error on success: ${error}")
endif()
message(STATUS "geometry: ${output}")

# --- What is no volume is refused, and no file is named ---------------------

set(text "${folder}/patient-name.mha")
file(WRITE "${text}" "This is not a volume.\n")
run(result output error "${TOOL}" "${text}")
if(NOT result EQUAL 3)
  message(FATAL_ERROR "A file that is no volume gave status ${result}, not 3")
endif()
if(NOT output STREQUAL "")
  message(FATAL_ERROR "A failure printed to standard output: ${output}")
endif()
if(NOT error MATCHES "^{\"error\":\"[a-z-]+\"}$")
  message(FATAL_ERROR "A failure is not one line of JSON with a code: ${error}")
endif()
if(error MATCHES "patient-name" OR error MATCHES "donn")
  message(FATAL_ERROR "A failure names the file: ${error}")
endif()

run(result output error "${TOOL}" "${folder}/missing.mha")
if(NOT result EQUAL 3)
  message(FATAL_ERROR "A missing file gave status ${result}, not 3")
endif()
if(error MATCHES "missing")
  message(FATAL_ERROR "A failure names the file: ${error}")
endif()

# --- A command that makes no sense ------------------------------------------

run(result output error "${TOOL}")
if(NOT result EQUAL 2)
  message(FATAL_ERROR "No argument gave status ${result}, not 2")
endif()
run(result output error "${TOOL}" --no-such-option "${volume}")
if(NOT result EQUAL 2)
  message(FATAL_ERROR "An unknown option gave status ${result}, not 2")
endif()

message(STATUS "ors-volume-info: passed")
