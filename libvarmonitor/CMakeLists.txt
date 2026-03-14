cmake_minimum_required(VERSION 3.16)

if(NOT PROJECT_NAME)
    project(varmonitor VERSION 1.0.0 LANGUAGES CXX)
endif()

add_library(varmonitor STATIC
    src/var_monitor.cpp
    src/uds_server.cpp
    src/shm_publisher.cpp
)
add_library(varmonitor::varmonitor ALIAS varmonitor)

target_include_directories(varmonitor
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

target_compile_features(varmonitor PUBLIC cxx_std_20)
target_compile_options(varmonitor PRIVATE -Wall -Wextra)
target_link_libraries(varmonitor PUBLIC pthread)
if(UNIX AND NOT APPLE)
    target_link_libraries(varmonitor PUBLIC rt)
endif()

set_target_properties(varmonitor PROPERTIES
    POSITION_INDEPENDENT_CODE ON
)
