# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# ors-volume-info: reads a volume and prints its geometry as JSON.

add_executable(ors-volume-info main.cxx)
target_include_directories(ors-volume-info PRIVATE
  "${PROJECT_BINARY_DIR}/generated"
  "${PROJECT_SOURCE_DIR}/common"
  ${ITK_INCLUDE_DIRS})
# All of ITK that was built is offered; the linker takes what the tool uses.
target_link_libraries(ors-volume-info PRIVATE ${ITK_LIBRARIES})
ors_self_contained(ors-volume-info)
ors_warnings(ors-volume-info)

install(TARGETS ors-volume-info RUNTIME DESTINATION bin)
