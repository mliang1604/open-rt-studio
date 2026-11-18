# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# ors-register-rigid: finds the rigid transform between two volumes (#80).

add_executable(ors-register-rigid main.cxx)
target_include_directories(ors-register-rigid PRIVATE
  "${PROJECT_BINARY_DIR}/generated"
  "${PROJECT_SOURCE_DIR}/common"
  ${ELASTIX_INCLUDE_DIRS}
  ${ITK_INCLUDE_DIRS})
target_link_libraries(ors-register-rigid PRIVATE elastix_lib ${ITK_LIBRARIES})
ors_self_contained(ors-register-rigid)

install(TARGETS ors-register-rigid RUNTIME DESTINATION bin)
