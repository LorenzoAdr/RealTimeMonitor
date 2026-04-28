add_executable(demo_server main.cpp)
target_link_libraries(demo_server PRIVATE varmonitor)
target_compile_features(demo_server PRIVATE cxx_std_20)
# Símbolos de depuración: necesarios para breakpoints por línea (GDB / UI). Opcional: quitar en release mínimo.
target_compile_options(demo_server PRIVATE -g)

if(VARMON_ENABLED)
    target_compile_definitions(demo_server PRIVATE VARMON_ENABLED)
endif()
