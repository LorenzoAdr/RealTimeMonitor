add_executable(demo_server main.cpp)
target_link_libraries(demo_server PRIVATE varmonitor)
target_compile_features(demo_server PRIVATE cxx_std_20)

if(VARMON_ENABLED)
    target_compile_definitions(demo_server PRIVATE VARMON_ENABLED)
endif()
