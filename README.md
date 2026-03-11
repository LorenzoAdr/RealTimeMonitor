# VarMonitor - Monitor de Variables en Tiempo Real

Sistema de monitorización de variables en tiempo real para aplicaciones C++20.
Usa TCP puro para la comunicación y una interfaz web para visualización, plotting, alarmas y más.

## Arquitectura

```
┌──────────────────┐     TCP (JSON)     ┌───────────────────────┐
│  Tu App C++20    │◄──────────────────►│  Monitor Web          │
│                  │    puerto 9100     │                       │
│  + libvarmonitor │                    │  Python FastAPI       │
└──────────────────┘                    │  + Plotly.js frontend │
                                        └───────────────────────┘
         ▲                                        ▲
         │          ┌──────────────┐              │
         └──────────┤ varmon.conf  ├──────────────┘
                    │  tcp_port    │
                    │  web_port    │
                    │  host        │
                    └──────────────┘
```

## Requisitos

- Ubuntu 22.04+ / WSL2
- CMake 3.16+
- GCC 11+ (C++20)
- Python 3.10+

## Instalación rápida

```bash
# 1. Instalar dependencias
chmod +x scripts/setup.sh
./scripts/setup.sh

# 2. Compilar
mkdir -p build && cd build
cmake .. && make -j$(nproc)

# 3. Lanzar el servidor demo
./demo_app/demo_server

# 4. En otra terminal, lanzar el monitor web
cd web_monitor
source .venv/bin/activate
python app.py

# 5. Abrir http://localhost:8080
```

## Configuración centralizada: varmon.conf

Toda la configuración de puertos e IPs está en un único archivo `varmon.conf`:

```
# VarMonitor configuration
tcp_port = 9100
web_port = 8080
host = localhost
```

- `tcp_port`: puerto TCP (C++ escucha, Python conecta)
- `web_port`: puerto del monitor web (solo Python)
- `host`: IP/hostname de la app C++ (solo Python)

### Cambiar la ruta del archivo

Por orden de prioridad:

1. Variable de entorno: `VARMON_CONFIG=/mi/ruta/varmon.conf`
2. En C++: `varmon::set_config_path("/mi/ruta/varmon.conf")` o macro `VARMON_SET_CONFIG("/mi/ruta/varmon.conf")`
3. Por defecto: `./varmon.conf` en el directorio de trabajo

Si el archivo no existe, se usan los defaults (tcp_port=9100, web_port=8080, host=localhost).

## Integración en tu proyecto

### Opción A: add_subdirectory (copiar carpeta)

```cmake
add_subdirectory(libvarmonitor)
target_link_libraries(tu_app PRIVATE varmonitor)
```

### Opción B: CMake FetchContent (desde repositorio Git)

```cmake
include(FetchContent)
FetchContent_Declare(
    varmonitor
    GIT_REPOSITORY https://github.com/tu-usuario/varmonitor.git
    GIT_TAG main
    SOURCE_SUBDIR libvarmonitor
)
FetchContent_MakeAvailable(varmonitor)

target_link_libraries(tu_app PRIVATE varmonitor::varmonitor)
```

### Código C++

```cpp
#include <var_monitor.hpp>

double temperatura = 0.0;
int32_t contador = 0;

varmon::VarMonitor monitor;
monitor.register_var("sensors.temperatura", &temperatura);
monitor.register_var("system.contador", &contador);

// Opcional: cambiar ruta del config antes de start()
varmon::set_config_path("/etc/mi_app/varmon.conf");

monitor.start();  // Lee varmon.conf y arranca TCP server

// Quitar una variable en caliente (ej. módulo descargado)
monitor.unregister_var("sensors.temperatura");
```

### Con macros (compilación condicional)

```cpp
#include <var_monitor_macros.hpp>

VARMON_SET_CONFIG("/etc/mi_app/varmon.conf");  // Opcional
VARMON_WATCH("sensors.temp", temperatura);
VARMON_START(100);

VARMON_UNWATCH("sensors.temp");
VARMON_STOP();
```

Compila con `-DVARMON_ENABLED=OFF` para que las macros sean no-ops (cero overhead).

## Docker Compose

Levanta solo el monitor web apuntando a tu app C++:

```bash
# La app C++ corre en la máquina host
# Edita varmon.conf para cambiar host/puertos
docker compose up -d
```

El `docker-compose.yml` monta automáticamente `varmon.conf` dentro del contenedor.

## Lanzar el monitor

```bash
# Directo
cd web_monitor && source .venv/bin/activate && python app.py

# Docker
docker compose up -d
```

## Funcionalidades del monitor web

- **3 columnas**: explorar variables, monitorizar con valores en vivo, graficar
- **Gráficos dinámicos** con Plotly: zoom, pan, autoscale, scroll zoom
- **Alarmas** con umbrales Hi/Lo, auto-TSV, banner visual y notificaciones push
- **Grabación TSV** de datos en vivo
- **Screenshots PNG** de gráficos
- **Variables computadas** (expresiones JS sobre variables reales)
- **Generador de funciones** (seno, rampa, escalón, etc.)
- **Guardar/cargar configuración** completa a JSON
- **Acceso remoto** desde otros equipos en red
- **Atajos de teclado**: Space, R, S, H, Escape

## Estructura del proyecto

```
monitor/
├── varmon.conf         ← Configuración centralizada (puertos, host)
├── libvarmonitor/      ← Librería C++ integrable (FetchContent-ready)
├── demo_app/           ← App demo con variables simuladas
├── web_monitor/        ← Monitor web standalone (FastAPI + Plotly.js)
│   ├── Dockerfile      ← Imagen Docker del monitor
│   └── static/         ← Frontend HTML/CSS/JS
├── docker-compose.yml  ← Despliegue del monitor con Docker
└── scripts/            ← Scripts de utilidad
```
