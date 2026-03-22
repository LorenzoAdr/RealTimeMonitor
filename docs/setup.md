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

Opcional: `cycle_interval_ms`, `update_ratio_max`, `lan_ip`, `bind_host`, `auth_password`, `server_state_dir`, `log_buffer_size`, `log_file_cpp`, **`shm_max_vars`**, **`visual_buffer_sec`**, **grabación / sidecar** (solo backend Python; véase también [Backend](backend.md)).

- **visual_buffer_sec** (entero, defecto 10, rango 1–7200): segundos de buffer visual por defecto en el navegador si no hay `timeWindow` guardado en `localStorage`. Se expone en `GET /api/connection_info`; valores altos aumentan el uso de RAM del cliente.
- **shm_max_vars** (entero, defecto 2048): máximo de filas en la tabla SHM v2 (C++ y Python). Tamaño aproximado = 64 + shm_max_vars×176 + shm_max_vars×shm_ring_depth×16 bytes (`shm_ring_depth` en `varmon.conf` del C++, por defecto 64). **Debe coincidir en C++ y Python**; reinicia C++ y el backend tras cambiar `shm_max_vars` o `shm_ring_depth`.
- **log_buffer_size** (entero, defecto 5000): número máximo de líneas que el backend guarda en memoria para el visor de log integrado (entre 100 y 50000).
- **log_file_cpp** (ruta): si se define, el visor de log puede mostrar también la salida del proceso C++. Para ello, redirija stderr del proceso C++ a un archivo (ej. `./mi_app 2> /tmp/varmon_cpp.log`) y configure `log_file_cpp = /tmp/varmon_cpp.log`. En la interfaz, use el selector de fuente "C++" o "Ambos".
- **`recording_backend`**: `python` (TSV desde hilo Python) o **`sidecar_cpp`** (binario `varmon_sidecar`; menos CPU Python). Requiere SHM activo y ejecutable accesible (`recording_sidecar_bin`, `VARMON_SIDECAR_BIN` o `PATH` / rutas de build típicas).
- **`shm_parse_hz_sidecar_recording`**: con `sidecar_cpp` y sidecar en marcha, tope Hz de parseo SHM en Python para **`vars_update`** (por defecto **30** en código; `0` = no parsear, solo drenar `sem_name` — UI C++ congelada en valores SHM). El TSV lo escribe el sidecar en **`sem_sidecar_name`**.
- **`shm_sidecar_sem_drain_interval_sec`**: intervalo entre ráfagas de drenaje del sem principal cuando el modo anterior es “solo pump” (`shm_parse_hz_sidecar_recording = 0`).
- **`recording_sidecar_bin`**: ruta absoluta al ejecutable `varmon_sidecar` si no está en `PATH`.
- **`sidecar_cpu_affinity`**: Linux — lista de CPUs para `sched_setaffinity` en procesos sidecar (grabación y `--alarm-monitor`), p. ej. `3` o `2,5` o `4-7`.

**Sidecar (entorno, no `varmon.conf`)**: `VARMON_SIDECAR_BIN`, **`VARMON_SIDECAR_PERF_FLUSH_EVERY`** (1–512): frecuencia de escritura del JSON de `--perf-file` (panel Perf, capa sidecar).

Ruta del archivo: variable de entorno `VARMON_CONFIG` o en C++ `varmon::set_config_path(...)`.

## Visor de log integrado

Desde la interfaz del monitor puede consultar el registro del servidor sin acceder al terminal:

- **Botón Log** (cabecera): abre un panel con las últimas líneas del log del backend Python (y, si está configurado `log_file_cpp`, del proceso C++).
- **Actualizar**: vuelve a pedir el log al servidor.
- **Auto-actualizar**: actualiza el contenido cada pocos segundos mientras el panel esté abierto.
- **Fuente**: Python (solo backend), C++ (solo archivo configurado) o Ambos.

La API `GET /api/log?tail=2000&source=python|cpp|all` devuelve JSON con `{ "lines": [ {"ts", "level", "msg"}, ... ], "source": "..." }`. Con `Accept: text/plain` se devuelve el log en texto plano.

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
mkdocs serve              # español (preview en http://localhost:8000)
mkdocs serve -f mkdocs.en.yml   # inglés
```

Para generar los sitios estáticos que sirve el monitor:

```bash
mkdocs build              # salida en site/  → URL /docs/es/
mkdocs build -f mkdocs.en.yml   # salida en site_en/  → URL /docs/en/
```

También puede usar el objetivo CMake `docs` (desde `build/`: `make docs`), que ejecuta ambos builds.

**Desde el propio monitor**: Tras `mkdocs build` y `mkdocs build -f mkdocs.en.yml`, reinicie el servidor. La documentación queda en **`/docs/es/`** (español) y **`/docs/en/`** (inglés). La petición a **`/docs`** o **`/docs/`** redirige a `/docs/es/`. El botón **Docs** de la cabecera abre un selector de idioma y luego la guía MkDocs en una pestaña nueva.
