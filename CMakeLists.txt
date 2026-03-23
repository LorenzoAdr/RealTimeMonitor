cmake_minimum_required(VERSION 3.16)
project(varmonitor_system VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(VARMON_ENABLED "Enable variable monitor (set OFF for zero-overhead no-ops)" ON)
option(VARMON_BUILD_DEMO "Build demo application" ON)
option(VARMON_BUILD_DOCS "Register MkDocs custom target docs (requires web_monitor/.venv)" OFF)

add_subdirectory(libvarmonitor)

if(EXISTS "${CMAKE_SOURCE_DIR}/varmon_sidecar/CMakeLists.txt")
    add_subdirectory(varmon_sidecar)
else()
    message(STATUS "varmon_sidecar: fuentes no presentes; omitido")
endif()

if(VARMON_BUILD_DEMO)
    add_subdirectory(demo_app)
endif()

if(VARMON_BUILD_DOCS)
    if(WIN32)
        set(MKDOCS_PYTHON "${CMAKE_SOURCE_DIR}/web_monitor/.venv/Scripts/python.exe")
    else()
        set(MKDOCS_PYTHON "${CMAKE_SOURCE_DIR}/web_monitor/.venv/bin/python")
    endif()
    if(EXISTS "${MKDOCS_PYTHON}")
        add_custom_target(docs
            COMMAND "${MKDOCS_PYTHON}" -m mkdocs build
            COMMAND "${MKDOCS_PYTHON}" -m mkdocs build -f mkdocs.en.yml
            WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
            COMMENT "Generando documentación MkDocs en site/ (ES) y site_en/ (EN)"
        )
    else()
        message(STATUS "MkDocs: intérprete no encontrado (${MKDOCS_PYTHON}); target docs omitido")
    endif()
endif()
