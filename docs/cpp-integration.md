# Integración C++

## Enlazar la biblioteca

```cmake
add_subdirectory(libvarmonitor)
target_link_libraries(tu_app PRIVATE varmonitor)
```

## Uso básico

```cpp
#include <var_monitor.hpp>

varmon::VarMonitor monitor;
monitor.register_var("sensors.temperatura", &temperatura);
monitor.start(100);  // 100 ms entre muestreos; arranca UDS y SHM

// En tu lazo de control (ej. 100 Hz):
monitor.write_shm_snapshot();
```

## Macros

Se pueden usar las macros de `var_monitor_macros.hpp`: `VARMON_WATCH`, `VARMON_START`, etc., para registrar variables y arrancar el monitor de forma conveniente.

## Configuración

- Ruta del archivo de configuración: `varmon::set_config_path(...)` o variable de entorno `VARMON_CONFIG`.
- En `varmon.conf` se puede definir `web_port`, `cycle_interval_ms`, etc.; el proceso C++ no sirve HTTP, solo crea el socket UDS y el segmento SHM que el backend Python utiliza.

## API C++ (referencia)

Para una referencia automática de clases y funciones públicas de `libvarmonitor`, se puede generar documentación con **Doxygen** desde el directorio `libvarmonitor/` y enlazar desde aquí o desde un `docs/api-cpp.md` que explique cómo ejecutar `doxygen` y dónde se genera el HTML.
