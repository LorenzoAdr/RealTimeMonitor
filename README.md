# VarMonitor - Monitor de Variables en Tiempo Real

Sistema de monitorización de variables en tiempo real para aplicaciones C++20. La comunicación entre la aplicación C++ y el monitor web usa **Unix Domain Sockets (UDS)** y **memoria compartida (SHM)** con semáforos POSIX. Interfaz web para visualización, gráficos, alarmas, grabación TSV y más.

## Documentación completa

La documentación detallada (arquitectura, protocolos UDS/SHM, backend Python, frontend, integración C++, resolución de problemas) está en el directorio **docs/** y se puede generar y consultar con [MkDocs](https://www.mkdocs.org/):

```bash
pip install mkdocs mkdocs-material
mkdocs serve
```

Abrir **http://localhost:8000** para navegar por la documentación.

- [Arquitectura](docs/architecture.md) — Componentes, flujo de datos, descubrimiento de instancias, tasas visual e interna.
- [Instalación y configuración](docs/setup.md) — Requisitos, instalación rápida, `varmon.conf`.
- [Backend (Python)](docs/backend.md) — Rutas, WebSocket, UdsBridge, ShmReader, alarmas y grabación.
- [Frontend](docs/frontend.md) — Estructura de `app.js`, columnas, gráficos Plotly, estado y persistencia.
- [Protocolos](docs/protocols.md) — Formato UDS, comandos, layout SHM, alarmas y grabación.
- [Integración C++](docs/cpp-integration.md) — Enlazar libvarmonitor, uso básico, macros.
- [Resolución de problemas](docs/troubleshooting.md) — WSL/semáforos, "no conecta", gráficos vacíos.

---

## Instalación rápida

```bash
# 1. Instalar dependencias
chmod +x scripts/setup.sh
./scripts/setup.sh

# 2. Compilar
mkdir -p build && cd build
cmake .. && make -j$(nproc)

# 3. Lanzar el servidor demo (C++)
./demo_app/demo_server

# 4. En otra terminal, lanzar el monitor web (Python)
cd web_monitor
source .venv/bin/activate
python app.py

# 5. Abrir http://localhost:8080
```

## Configuración: varmon.conf

Ejemplo mínimo:

```
web_port = 8080
```

Opcional: `cycle_interval_ms`, `update_ratio_max`, `lan_ip`, `bind_host`, `auth_password`, `server_state_dir`, **`shm_max_vars`**.

- **shm_max_vars** (entero, defecto 2048): máximo de variables que caben en el segmento SHM. Si monitorizas más variables que este valor, solo las primeras reciben valor; el resto muestran "--". Tamaño del segmento ≈ 32 + shm_max_vars×137 bytes (ej. 2048 → ~274 KiB). Debe coincidir en C++ y Python; **reinicia el proceso C++ y el backend Python** tras cambiarlo.

Ruta del archivo: variable de entorno `VARMON_CONFIG` o en C++ `varmon::set_config_path(...)`.

## Integración en tu proyecto C++

```cmake
add_subdirectory(libvarmonitor)
target_link_libraries(tu_app PRIVATE varmonitor)
```

```cpp
#include <var_monitor.hpp>

varmon::VarMonitor monitor;
monitor.register_var("sensors.temperatura", &temperatura);
monitor.start(100);  // 100 ms entre muestreos; arranca UDS y SHM

// En tu lazo de control (ej. 100 Hz):
monitor.write_shm_snapshot();
```

Con macros: `var_monitor_macros.hpp`, `VARMON_WATCH`, `VARMON_START`, etc.

## Funcionalidades del monitor web

- Tres columnas: variables disponibles, monitor en vivo, gráficos.
- Gráficos dinámicos (Plotly), alarmas Hi/Lo, grabación TSV (backend), notificaciones, variables computadas, guardar/cargar configuración, acceso remoto por web_port, atajos de teclado (R grabación, S screenshot, etc.).

## Estructura del proyecto

```
monitor/
├── varmon.conf
├── libvarmonitor/       # C++: VarMonitor, shm_publisher, uds_server
├── demo_app/
├── web_monitor/         # Python FastAPI, UdsBridge, ShmReader
│   ├── recordings/     # TSV de grabaciones y alarmas (generado)
│   └── static/
├── docs/                # Documentación (MkDocs)
└── scripts/
```
