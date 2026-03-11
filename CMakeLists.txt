cmake_minimum_required(VERSION 3.16)
project(varmonitor_system VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(VARMON_ENABLED "Enable variable monitor (set OFF for zero-overhead no-ops)" ON)
option(VARMON_BUILD_DEMO "Build demo application" ON)

add_subdirectory(libvarmonitor)

if(VARMON_BUILD_DEMO)
    add_subdirectory(demo_app)
endif()
