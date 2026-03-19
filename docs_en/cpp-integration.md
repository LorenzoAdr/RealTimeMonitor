# C++ integration

## Link the library

```cmake
add_subdirectory(libvarmonitor)
target_link_libraries(your_app PRIVATE varmonitor)
```

## Basic usage

```cpp
#include <var_monitor.hpp>

varmon::VarMonitor monitor;
monitor.register_var("sensors.temperature", &temperature);
monitor.start(100);  // 100 ms sampling; starts UDS and SHM

// In your control loop (e.g. 100 Hz):
monitor.write_shm_snapshot();
```

## Macros

You can use macros from `var_monitor_macros.hpp`: `VARMON_WATCH`, `VARMON_START`, etc., for convenient registration and startup.

## Configuration

- Config file path: `varmon::set_config_path(...)` or environment variable `VARMON_CONFIG`.
- `varmon.conf` can define `web_port`, `cycle_interval_ms`, etc.; the C++ process does not serve HTTP—it only creates the UDS socket and SHM segment used by the Python backend.

## C++ API reference

For auto-generated class/function documentation for `libvarmonitor`, run **Doxygen** from `libvarmonitor/` and link from here or from a `docs/api-cpp.md` describing how to run `doxygen` and where HTML is emitted.
