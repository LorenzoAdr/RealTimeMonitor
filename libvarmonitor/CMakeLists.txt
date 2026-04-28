cmake_minimum_required(VERSION 3.16)

if(NOT PROJECT_NAME)
    project(varmonitor VERSION 1.0.0 LANGUAGES CXX)
endif()

# ON: libvarmonitor.so para entrega SDK (generate_webmonitor_version.sh). OFF: .a (desarrollo/CI típico).
option(VARMON_LIB_SHARED "Build libvarmonitor as a shared library (libvarmonitor.so)" ON)
# Rama legacy/core-shm-v2-py-js: OFF por defecto para compilar solo VarMonitor + SHM v2 sin árbol CoreNexus local.
set(VARMON_CORENEXUS_APPENDAGE "OFF" CACHE STRING "Enable embedded CoreNexus appendage in libvarmonitor (AUTO|ON|OFF)")
set_property(CACHE VARMON_CORENEXUS_APPENDAGE PROPERTY STRINGS AUTO ON OFF)

set(_VARMON_CORENEXUS_ENABLED FALSE)
set(_VARMON_CORENEXUS_ROOT "${CMAKE_SOURCE_DIR}/CoreNexus")
set(_VARMON_CORENEXUS_MAVLINK_GEN "${_VARMON_CORENEXUS_ROOT}/build/generated_mavlink")
if(VARMON_CORENEXUS_APPENDAGE STREQUAL "ON")
    set(_VARMON_CORENEXUS_ENABLED TRUE)
elseif(VARMON_CORENEXUS_APPENDAGE STREQUAL "AUTO")
    if(EXISTS "${_VARMON_CORENEXUS_ROOT}/core/include/corenexus/var_broker.hpp" AND
       EXISTS "${_VARMON_CORENEXUS_ROOT}/ingestors/mavlink/mavlink_ingestor.hpp" AND
       EXISTS "${_VARMON_CORENEXUS_MAVLINK_GEN}/common/mavlink.h")
        set(_VARMON_CORENEXUS_ENABLED TRUE)
    endif()
endif()

set(_VARMON_EXTRA_SOURCES)
if(_VARMON_CORENEXUS_ENABLED)
    list(APPEND _VARMON_EXTRA_SOURCES
        "${_VARMON_CORENEXUS_ROOT}/core/src/var_broker.cpp"
        "${_VARMON_CORENEXUS_ROOT}/entropy/src/entropy_engine.cpp"
        "${_VARMON_CORENEXUS_ROOT}/ingestors/mavlink/mavlink_ingestor.cpp"
        "${_VARMON_CORENEXUS_ROOT}/ingestors/mavlink/mavlink_ingestor_publish.cpp"
        "${_VARMON_CORENEXUS_ROOT}/ingestors/mavlink/mavlink_generic_fields.c"
        "${_VARMON_CORENEXUS_ROOT}/ingestors/mavlink/mavlink_link_health.cpp"
    )
endif()

if(VARMON_LIB_SHARED)
    add_library(varmonitor SHARED
        src/var_monitor.cpp
        src/uds_server.cpp
        src/shm_publisher.cpp
        ${_VARMON_EXTRA_SOURCES}
    )
    set_target_properties(varmonitor PROPERTIES
        VERSION 1.0.0
        SOVERSION 1
    )
else()
    add_library(varmonitor STATIC
        src/var_monitor.cpp
        src/uds_server.cpp
        src/shm_publisher.cpp
        ${_VARMON_EXTRA_SOURCES}
    )
endif()
add_library(varmonitor::varmonitor ALIAS varmonitor)

target_include_directories(varmonitor
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

target_compile_features(varmonitor PUBLIC cxx_std_20)
target_compile_options(varmonitor PRIVATE -Wall -Wextra)
target_link_libraries(varmonitor PUBLIC pthread)
if(_VARMON_CORENEXUS_ENABLED)
    target_compile_definitions(varmonitor PRIVATE VARMON_CORENEXUS_APPENDAGE_ENABLED=1)
    target_include_directories(varmonitor PRIVATE
        "${_VARMON_CORENEXUS_ROOT}/core/include"
        "${_VARMON_CORENEXUS_ROOT}/entropy/include"
        "${_VARMON_CORENEXUS_ROOT}/ingestors/mavlink"
        "${_VARMON_CORENEXUS_MAVLINK_GEN}"
    )
    message(STATUS "libvarmonitor: CoreNexus appendage embebido habilitado")
else()
    message(STATUS "libvarmonitor: CoreNexus appendage embebido deshabilitado")
endif()
if(UNIX AND NOT APPLE)
    target_link_libraries(varmonitor PUBLIC rt)
endif()

set_target_properties(varmonitor PROPERTIES
    POSITION_INDEPENDENT_CODE ON
)
