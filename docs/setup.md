# Instalación y configuración

## Requisitos

- Linux (UDS y SHM en `/dev/shm` y semáforos POSIX).
- CMake 3.16+, GCC 11+ (C++20).
- Python 3.10+.

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
# Puerto del monitor web (solo Python)
web_port = 8080
```

Opcional: `cycle_interval_ms`, `update_ratio_max`, `lan_ip`, `bind_host`, `auth_password`, `server_state_dir`.

Ruta del archivo: variable de entorno `VARMON_CONFIG` o en C++ `varmon::set_config_path(...)`.

## Estructura del proyecto

```
monitor/
├── varmon.conf
├── libvarmonitor/       # C++: VarMonitor, shm_publisher, uds_server
├── demo_app/
├── web_monitor/         # Python FastAPI, UdsBridge, ShmReader
│   ├── recordings/      # TSV de grabaciones y alarmas (generado)
│   └── static/
└── scripts/
```

## Documentación completa

Para generar y ver esta documentación en HTML:

```bash
pip install mkdocs mkdocs-material
mkdocs serve
```

Abrir `http://localhost:8000`.

**Desde el propio monitor**: Si genera la documentación con `mkdocs build` (en la raíz del proyecto) y luego arranca el servidor del monitor, la documentación quedará servida en `/docs/`. En la cabecera del monitor hay un botón **Docs** que abre la documentación en una nueva pestaña.
