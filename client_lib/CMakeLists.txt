add_library(monitor_client SHARED
    monitor_client_wrapper.c
)

add_dependencies(monitor_client rpc_generated)

target_link_libraries(monitor_client PRIVATE rpc_client_stubs)

set_target_properties(monitor_client PROPERTIES
    C_STANDARD 11
    OUTPUT_NAME monitor_client
    SOVERSION 1
)
