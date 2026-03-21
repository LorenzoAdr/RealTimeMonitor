cmake_minimum_required(VERSION 3.16)
project(varmonitor_system VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(VARMON_ENABLED "Enable variable monitor (set OFF for zero-overhead no-ops)" ON)
option(VARMON_BUILD_DEMO "Build demo application" ON)

add_subdirectory(libvarmonitor)
add_subdirectory(varmon_sidecar)

if(VARMON_BUILD_DEMO)
    add_subdirectory(demo_app)
endif()

# Documentación MkDocs (usa el venv de web_monitor; ejecutar ./scripts/setup.sh antes)
if(WIN32)
    set(MKDOCS_PYTHON "${CMAKE_SOURCE_DIR}/web_monitor/.venv/Scripts/python.exe")
else()
    set(MKDOCS_PYTHON "${CMAKE_SOURCE_DIR}/web_monitor/.venv/bin/python")
endif()
add_custom_target(docs
    COMMAND "${MKDOCS_PYTHON}" -m mkdocs build
    COMMAND "${MKDOCS_PYTHON}" -m mkdocs build -f mkdocs.en.yml
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
    COMMENT "Generando documentación MkDocs en site/ (ES) y site_en/ (EN)"
)
