# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# The test of ors-register-deformable, run by CTest:
#
#   cmake -DTOOL=<ors-register-deformable> -DPAIR=<ors-make-deformed-pair>
#         -DPRESETS=<native/presets/deformable> -DWORK=<folder> -P register_deformable_test.cmake
#
# The pair is a phantom full of blobs, in the fixed volume deformed by slow
# waves of up to 5 mm and in the moving volume turned and moved into a
# frame of its own (synthetic_deformation.h). How near a result is, is
# measured at some three thousand points all through the inside of the
# phantom: how far what was found puts a point from where the formulas do.

foreach(needed TOOL PAIR PRESETS WORK)
  if(NOT DEFINED ${needed})
    message(FATAL_ERROR "${needed} is not given")
  endif()
endforeach()

# How near, in millimetres: on average, and for 95 points of a hundred. The
# voxels of the pair are 3 to 3.5 mm, and the deformation moves the points
# 3.6 mm on average.
set(MEAN_MM 1.0)
set(P95_MM 2.0)
# From a start that is 2 mm off, or from none (centre on centre, with the
# turn of 4 degrees left to the field): the field has to make up for it.
set(MEAN_FROM_AFAR_MM 1.5)
set(P95_FROM_AFAR_MM 3.0)

# A folder whose name is not ASCII, as a user's folder may be.
set(folder "${WORK}/déformation-変形")
file(REMOVE_RECURSE "${WORK}")
file(MAKE_DIRECTORY "${folder}")
set(fixed "${folder}/fixed.mha")
set(moving "${folder}/moving.mha")
set(rigid "${folder}/rigid.json")
set(pair --fixed "${fixed}" --moving "${moving}")

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

# Run the tool on the pair, writing <name>.json and <name>.mha, and expect it to end well.
function(registered name)
  run(result output error "${TOOL}" ${pair} --output "${folder}/${name}.json" --field "${folder}/${name}.mha" --threads 2 ${ARGN})
  if(NOT result EQUAL 0)
    message(FATAL_ERROR "${name}: the registration failed (${result}): ${error}\n${output}")
  endif()
  if(NOT error STREQUAL "")
    message(FATAL_ERROR "${name}: the tool wrote to standard error on success: ${error}")
  endif()
  set(output "${output}" PARENT_SCOPE)
endfunction()

# Hold what a run found against the formulas.
function(near name mean most)
  run(result measured error "${PAIR}" check "${folder}/${name}.json" "${folder}/${name}.mha" ${mean} ${most})
  message(STATUS "${name}: ${measured}")
  if(NOT result EQUAL 0)
    message(FATAL_ERROR "${name}: the deformation found is not the one the pair was made with: ${measured} ${error}")
  endif()
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
  if(error MATCHES "変形" OR error MATCHES "\\.mha" OR error MATCHES "\\.json" OR error MATCHES "\\.txt")
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
run(result output error "${PAIR}" rigid "${rigid}")
run(result output error "${PAIR}" nearby "${folder}/nearby.json")

# --- The known deformation is found, with each preset --------------------------

registered(ct-ct --preset "${PRESETS}/ct-ct.txt" --initial "${rigid}" --seed 7)
set(first_output "${output}")
near(ct-ct ${MEAN_MM} ${P95_MM})
registered(cbct-ct --preset "${PRESETS}/cbct-ct.txt" --initial "${rigid}" --seed 7)
near(cbct-ct ${MEAN_MM} ${P95_MM})
registered(mr-ct --preset "${PRESETS}/mr-ct.txt" --initial "${rigid}" --seed 7)
near(mr-ct ${MEAN_MM} ${P95_MM})

# --- It reports as a job's worker does ------------------------------------------

string(REPLACE "\r" "" lines "${first_output}")
string(REPLACE ";" "," lines "${lines}")
string(REPLACE "\n" ";" lines "${lines}")
set(results 0)
set(steps 0)
foreach(line IN LISTS lines)
  if(line MATCHES "^@result {\"fixedToMovingAfterField\":\\[")
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
if(steps LESS 40)
  message(FATAL_ERROR "Expected progress all the way through, found ${steps} lines:\n${first_output}")
endif()
if(NOT first_output MATCHES "@progress 1\\.000 Done")
  message(FATAL_ERROR "The last progress is not 1: ${first_output}")
endif()
message(STATUS "progress lines: ${steps}")

file(READ "${folder}/ct-ct.json" written)
string(STRIP "${written}" written)
string(FIND "${first_output}" "@result ${written}" same)
if(same EQUAL -1)
  message(FATAL_ERROR "The file and the result line differ.\n  file: ${written}")
endif()
# The matrix that stays in the result is the one it was started from, and
# a field as smooth as this one folds nowhere.
file(READ "${rigid}" started)
string(REGEX MATCH "\\[[^]]*\\]" started_matrix "${started}")
string(FIND "${written}" "\"fixedToMovingAfterField\":${started_matrix}" kept)
if(kept EQUAL -1)
  message(FATAL_ERROR "The matrix in the result is not the one given to start from.\n  given: ${started_matrix}\n  result: ${written}")
endif()
if(NOT written MATCHES "\"foldedPoints\":0,")
  message(FATAL_ERROR "A smooth deformation was found folded: ${written}")
endif()
if(NOT written MATCHES "\"size\":\\[49,49,43\\]")
  message(FATAL_ERROR "The field is not laid over the fixed volume 4 mm apart: ${written}")
endif()

# --- What the field is where the fixed volume shows something (#351) ------------------

# The phantom fills a little under a quarter of its volume; the deformation
# moves its points 3.6 mm on average and none more than 7.3 mm, and what is
# found may be a millimetre or two off (P95_MM).
foreach(preset ct-ct cbct-ct mr-ct)
  file(READ "${folder}/${preset}.json" said)
  if(NOT said MATCHES "\"largestMm\":([0-9.]+),\"points\":([0-9]+),\"insidePoints\":([0-9]+),\"largestInsideMm\":([0-9.]+),\"meanInsideMm\":([0-9.]+),")
    message(FATAL_ERROR "${preset}: the result does not say what the field is inside the outline: ${said}")
  endif()
  set(largest "${CMAKE_MATCH_1}")
  set(points "${CMAKE_MATCH_2}")
  set(inside "${CMAKE_MATCH_3}")
  set(largest_inside "${CMAKE_MATCH_4}")
  set(mean_inside "${CMAKE_MATCH_5}")
  message(STATUS "${preset}: ${inside} of ${points} points inside the outline, longest ${largest_inside} mm, mean ${mean_inside} mm; longest of all ${largest} mm")
  math(EXPR share "100 * ${inside} / ${points}")
  if(share LESS 15 OR share GREATER 30)
    message(FATAL_ERROR "${preset}: the outline holds ${share} % of the field, which is not the phantom: ${said}")
  endif()
  if(largest_inside GREATER largest)
    message(FATAL_ERROR "${preset}: the longest vector inside is longer than the longest of all: ${said}")
  endif()
  if(largest_inside GREATER 9.5 OR mean_inside LESS 2.6 OR mean_inside GREATER 4.6)
    message(FATAL_ERROR "${preset}: the field inside the outline is not the deformation the pair was made with: ${said}")
  endif()
endforeach()

# --- The same seed gives the same field ------------------------------------------

registered(again --preset "${PRESETS}/ct-ct.txt" --initial "${rigid}" --seed 7)
file(SHA256 "${folder}/ct-ct.mha" first_field)
file(SHA256 "${folder}/again.mha" second_field)
if(NOT first_field STREQUAL second_field)
  message(FATAL_ERROR "The same seed gave another field")
endif()
file(READ "${folder}/again.json" again)
string(STRIP "${again}" again)
if(NOT again STREQUAL written)
  message(FATAL_ERROR "The same seed gave another result.\n  first:  ${written}\n  second: ${again}")
endif()

# --- From a start that is near, and from none --------------------------------------

registered(nearby --preset "${PRESETS}/ct-ct.txt" --initial "${folder}/nearby.json")
near(nearby ${MEAN_FROM_AFAR_MM} ${P95_FROM_AFAR_MM})
registered(unstarted --preset "${PRESETS}/ct-ct.txt")
near(unstarted ${MEAN_FROM_AFAR_MM} ${P95_FROM_AFAR_MM})
# Without a start the matrix only moves: centre on centre.
file(READ "${folder}/unstarted.json" unstarted)
if(NOT unstarted MATCHES "\"fixedToMovingAfterField\":\\[1,0,0,[-0-9.e]+,0,1,0,[-0-9.e]+,0,0,1,[-0-9.e]+,0,0,0,1\\]")
  message(FATAL_ERROR "Without a start the matrix is not a plain move: ${unstarted}")
endif()

# --- A parameter set over the preset, a region, a coarser field ---------------------

registered(short --preset "${PRESETS}/ct-ct.txt" --initial "${rigid}" --set MaximumNumberOfIterations=5 --set "GridSpacingSchedule=4 2" --set NumberOfResolutions=2 --field-spacing 12 --roi -60,-60,-50,60,60,50)
file(READ "${folder}/short.json" short)
if(NOT short MATCHES "\"resolutions\":2,\"iterations\":5}")
  message(FATAL_ERROR "What was set over the preset was not used: ${short}")
endif()
if(NOT short MATCHES "\"size\":\\[17,17,15\\]")
  message(FATAL_ERROR "The field is not 12 mm apart: ${short}")
endif()

# --- What it cannot use is refused, and no file is named ----------------------------

file(WRITE "${folder}/text.mha" "This is not a volume.\n")
file(WRITE "${folder}/empty.txt" "// A preset that says nothing.\n")
file(WRITE "${folder}/sheared.json" "{\"fixedToMoving\":[1,0.3,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}\n")
set(out --output "${folder}/no.json" --field "${folder}/no.mha")
set(preset --preset "${PRESETS}/ct-ct.txt")

refused(3 unreadable-fixed --fixed "${folder}/text.mha" --moving "${moving}" ${preset} ${out})
refused(3 unreadable-moving --fixed "${fixed}" --moving "${folder}/missing.mha" ${preset} ${out})
refused(3 bad-preset ${pair} --preset "${folder}/missing.txt" ${out})
refused(3 bad-preset ${pair} --preset "${folder}/empty.txt" ${out})
refused(3 bad-initial ${pair} ${preset} ${out} --initial "${folder}/sheared.json")
refused(3 roi-empty ${pair} ${preset} ${out} --roi 900,900,900,950,950,950)
refused(2 usage ${pair} ${out})
refused(2 usage ${pair} ${preset} --output "${folder}/no.json")
refused(2 usage ${pair} ${preset} ${out} --field-spacing 0)
refused(2 fixed-parameter ${pair} ${preset} ${out} --set Transform=EulerTransform)
refused(2 fixed-parameter ${pair} ${preset} ${out} --set WriteResultImage=true)
refused(2 fixed-parameter ${pair} ${preset} ${out} --set InitialTransformParameterFileName=x)
refused(2 bad-parameter ${pair} ${preset} ${out} --set "Bad Key=1")
refused(2 bad-parameter ${pair} ${preset} ${out} --set "MaximumNumberOfIterations=5)(x")
refused(2 usage ${pair} ${preset} ${out} --set MaximumNumberOfIterations)
foreach(left no.json no.mha)
  if(EXISTS "${folder}/${left}")
    message(FATAL_ERROR "A refused run wrote ${left}")
  endif()
endforeach()

message(STATUS "ors-register-deformable: passed")
