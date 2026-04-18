# AGENTS.md

## Cursor Cloud specific instructions

### Overview

**VarMonitor** is a real-time variable monitoring system for C++20 applications with a browser-based web UI. The architecture: C++ app → POSIX shared memory + Unix domain sockets → Python FastAPI backend → WebSocket → browser.

### Project structure

- `libvarmonitor/` — C++ library (por defecto estática; `-DVARMON_LIB_SHARED=ON` genera `libvarmonitor.so` para la entrega `web_monitor_version/`)
- `demo_app/` — C++ demo application for development/testing
- `CoreNexus/` — ejecutable **corenexus** + **libcorenexus_core.so** + **libcorenexus_ingestor_mavlink.so** (MAVLink v2: cabeceras generadas con pymavlink desde el repo oficial). Build: `scripts/varmon/build_corenexus.sh` (requiere `pip install -r CoreNexus/requirements-mavlink.txt` o pymavlink en el `python3` del PATH). Entrega: también `libcorenexus_ingestor_mavlink.so` si se empaqueta corenexus. Ver `CoreNexus/docs/MAVLINK.md`.
- `varmon_sidecar/` — Optional native C++ recorder/alarm worker
- `web_monitor/` — Python FastAPI backend + browser frontend (HTML/JS/CSS)
- `data/varmon.conf` — Central configuration file
- `scripts/` — Launch and build scripts (see `scripts/LAUNCH.md`)

### Build (C++)

The default C++ compiler on this VM is Clang, which fails to link with `-lstdc++`. Use GCC explicitly:

```bash
mkdir -p build && cd build
cmake -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++ ..
make -j$(nproc)
```

`scripts/varmon/generate_webmonitor_version.sh` configura CMake con `-DVARMON_LIB_SHARED=ON`, compila `libvarmonitor.so` y empaqueta `web_monitor_version/{bin,data,include}/` (binarios, `varmon.conf`, cabeceras SDK). Desarrollo local sin entrega: omitir `VARMON_LIB_SHARED` (biblioteca estática `libvarmonitor.a`).

### Python backend

The venv lives at `web_monitor/.venv`. Core dependencies are in `web_monitor/requirements.txt`. Desktop-window dependencies (`requirements-desktop.txt`) are optional in headless/cloud environments.

```bash
cd web_monitor
source .venv/bin/activate
pip install -r requirements.txt
# Funcionalidad Pro (ARINC/MIL-STD-1553, Parquet, Git UI, terminal, GDB): paquete en tool_plugins
pip install -e ../tool_plugins/python
# Parquet en el plugin: pip install -e ../tool_plugins/python[parquet]  # instala pyarrow
```

### Running services (typical order)

All three services must point to the config. Set `export VARMON_CONFIG=/workspace/data/varmon.conf` or use the launch scripts which source `scripts/simple_config.sh`.

1. **C++ demo_server**: `VARMON_CONFIG=/workspace/data/varmon.conf ./build/demo_app/demo_server`
2. **Web backend**: `cd web_monitor && source .venv/bin/activate && VARMON_CONFIG=/workspace/data/varmon.conf python app.py`
   - Serves UI at `http://localhost:8080`
3. **Browser / UI**: open `http://localhost:8080` or use `./scripts/launch_ui.sh`

Alternatively, use the launch scripts: `./scripts/launch_demo.sh`, `./scripts/launch_corenexus.sh`, `./scripts/launch_web.sh`, `./scripts/launch_ui.sh` (these source `scripts/simple_config.sh` automatically).

### Linting and testing

The project has no formal test suite or lint configuration. For basic checks:

- **Unit tests**: `./scripts/run_tests.sh` (Python pytest bajo `tests/python/` y `tool_plugins/python/tests/`, C++ gtest, Vitest bajo `tests/js/`). Opcional `--coverage` usa `pytest-cov` sobre `perf_agg`, `uds_client`, `shm_reader`, `varmonitor_plugins`, y `app` (véase `scripts/LAUNCH.md`). El script instala en modo editable `tool_plugins/python` para cargar el paquete Pro.
- **Python syntax**: `python -m py_compile web_monitor/app.py`
- **Ruff** (ad-hoc): `ruff check web_monitor/ scripts/varmon/` — existing code has some minor findings (unused imports); these are pre-existing.
- **C++ build**: a clean `make` with no warnings is the primary validation.

### Key gotchas

- The demo_server won't find `varmon.conf` unless `VARMON_CONFIG` is set or you run from the repo root with `data/varmon.conf` present.
- Web port is configured in `data/varmon.conf` (`web_port = 8080`).
- `recording_backend = sidecar_cpp` in the default config requires the `varmon_sidecar` binary (built alongside demo_server); if not available, recording may fail. For development without native recording, change to `recording_backend = python`.
- The web backend must run from the `web_monitor/` directory so it can find `static/` and templates.

### Base de datos multi-protocolo (UI «BD protocolos»)

- La pantalla de registro usa **pestañas** (ARINC 429 y MIL-STD-1553). Cada protocolo tiene su propio fichero SQLite bajo el directorio de datos (`arinc_data/` por defecto): `arinc_registry.sqlite` y `m1553_registry.sqlite` (véase `varmon_web/paths.py`).
- **MIL-STD-1553 (convención de proyecto)**: la identidad lógica se codifica en el **nombre de variable** monitorizada como carga escalar, con el patrón por defecto `RT{n}_W{k}_suffix` (p. ej. `RT1_W3_ALT`). El registro almacena definiciones por `(grupo, RT, tipo de palabra W, sufijo)` y la UI/API siguen el mismo patrón que ARINC (`/api/m1553_db/*`, `/api/m1553_registry/*`). La lógica de decodificación/registro vive en `tool_plugins/js/src/m1553/m1553-registry.mjs` (desplegado como `static/plugins/m1553/m1553-registry.mjs`; import estable vía `static/js/modules/m1553-registry.mjs`). Qué plugins cargar el cliente: `plugin-selection.json` / `plugin-manifest.mjs` + `plugins-loader.js` (build en `static/plugins/build/`).
- **Roadmap de protocolos** (mismo patrón registro + carga/nombre): **CAN/CAN FD** (ID + payload; nombre tipo `CAN_<hex>_…`), **NMEA 0183** (frase + campos), **Modbus** (mapa holding/input por esclavo), **ARINC 664/AFDX** (más complejo; fase posterior).
