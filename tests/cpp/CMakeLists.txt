cmake_minimum_required(VERSION 3.16)
project(varmonitor_tests LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(
    googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.14.0.zip
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

enable_testing()

set(REPO_ROOT "${CMAKE_SOURCE_DIR}/../..")
set(LIBVARMONITOR_BUILD "${REPO_ROOT}/build/libvarmonitor")
set(_VARMON_A "${LIBVARMONITOR_BUILD}/libvarmonitor.a")
set(_VARMON_SO "${LIBVARMONITOR_BUILD}/libvarmonitor.so")

if(EXISTS "${_VARMON_A}")
    add_library(varmonitor_imported STATIC IMPORTED)
    set_target_properties(varmonitor_imported PROPERTIES IMPORTED_LOCATION "${_VARMON_A}")
elseif(EXISTS "${_VARMON_SO}")
    add_library(varmonitor_imported SHARED IMPORTED)
    set_target_properties(varmonitor_imported PROPERTIES IMPORTED_LOCATION "${_VARMON_SO}")
else()
    message(FATAL_ERROR "Compila primero libvarmonitor en ${LIBVARMONITOR_BUILD} (libvarmonitor.a o libvarmonitor.so).")
endif()

add_executable(varmonitor_tests
    test_var_monitor.cpp
)

target_include_directories(varmonitor_tests PRIVATE
    ${REPO_ROOT}/libvarmonitor/include
)

target_link_libraries(varmonitor_tests PRIVATE
    varmonitor_imported
    GTest::gtest_main
    pthread
    rt
)

include(GoogleTest)
gtest_discover_tests(varmonitor_tests)
