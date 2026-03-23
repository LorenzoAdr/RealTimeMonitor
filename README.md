# VarMonitor — Real-time variable monitor

Real-time variable monitoring for C++20 applications. Communication between your C++ app and the web monitor uses **Unix Domain Sockets (UDS)** and **shared memory (SHM)** with POSIX semaphores. Web UI for visualization, charts, alarms, TSV recording, and more.

> **Spanish:** detailed docs in Spanish live under [`docs/`](docs/); this README is in English for the default GitHub landing page.

## Full documentation

Detailed docs are in **[docs/](docs/)** (Spanish) and **[docs_en/](docs_en/)** (English), built with [MkDocs](https://www.mkdocs.org/):

```bash
pip install mkdocs mkdocs-material
mkdocs serve                    # Spanish preview
mkdocs serve -f mkdocs.en.yml   # English preview
```

Static build for the web monitor:

```bash
mkdocs build
mkdocs build -f mkdocs.en.yml
```

Outputs: `site/` → **`/docs/es/`**, `site_en/` → **`/docs/en/`**. The monitor’s **Docs** button opens a language picker.

**English (Markdown in repo):**

- [Architecture](docs_en/architecture.md) — Components, data flow, instance discovery, visual vs internal rates.
- [Installation and configuration](docs_en/setup.md) — Requirements, quick install, `varmon.conf`.
- [Docker](docs_en/docker.md) — Container image, bridge vs host mode.
- [Packaged binary (PyInstaller)](docs_en/build-binary.md) — Single executable without pip on the target.
- [Launch scripts](scripts/LAUNCH.md) — `launch_demo` / `launch_web` / `launch_ui`; `stop_varmonitor`; `build_docs_pdf`.
- [Backend (Python)](docs_en/backend.md) — Routes, WebSocket, UdsBridge, ShmReader, alarms and recording.
- [Frontend](docs_en/frontend.md) — `app.js` structure, columns, Plotly charts, state and persistence.
- [Protocols](docs_en/protocols.md) — UDS format, commands, SHM layout, alarms and recording.
- [C++ integration](docs_en/cpp-integration.md) — Linking libvarmonitor, basic usage, macros.
- [Troubleshooting](docs_en/troubleshooting.md) — WSL/semaphores, connection issues, empty charts.

---

## Quick install

```bash
# 1. Install dependencies
chmod +x scripts/varmon/setup.sh
./scripts/varmon/setup.sh

# 2. Build
mkdir -p build && cd build
cmake .. && make -j$(nproc)

# 3–5. Three terminals (or run in background): demo C++, web backend, UI
cd ..   # back to repo root
./scripts/launch_demo.sh
./scripts/launch_web.sh
./scripts/launch_ui.sh   # picks highest responding port in varmon.conf range
```

See **[scripts/LAUNCH.md](scripts/LAUNCH.md)**.

## Docker

Run only the web backend in a container (browser on the host):

```bash
docker compose up --build
# or: ./scripts/varmon/docker-run.sh
```

For **live** monitoring against the **host C++ process** on **Linux** (shared `/tmp` UDS + SHM), use the host-network compose file:

```bash
docker compose -f docker-compose.host.yml up --build
# or: ./scripts/varmon/docker-run.sh host
```

See **[docs/docker.md](docs/docker.md)** (Spanish) or **[docs_en/docker.md](docs_en/docker.md)** (English). To embed the monitor in another image without depending on submodule paths, install the three runtime packages listed in **`web_monitor/requirements-docker.txt`** via `RUN pip install ...` in your Dockerfile (see docs); that file is the version reference.

## Standalone binary (no Python on target)

Build a single executable with PyInstaller (details: **[docs_en/build-binary.md](docs_en/build-binary.md)**):

```bash
./scripts/varmon/build_varmonitor_web.sh
# → web_monitor/dist/varmonitor-web
```

To run the PyInstaller build: **`export VARMON_PACKAGED_WEB_BIN=.../varmonitor-web`** then **`./scripts/launch_web.sh`**; open the UI with **`./scripts/launch_ui.sh`** (needs `python3` for these launcher scripts only; see [docs_en/build-binary.md](docs_en/build-binary.md)).

## Configuration: varmon.conf

Minimal example:

```
web_port = 8080
```

Optional: `cycle_interval_ms`, `update_ratio_max`, `lan_ip`, `bind_host`, `auth_password`, `server_state_dir`, **`shm_max_vars`**, **`recording_backend`**, **`shm_parse_hz_sidecar_recording`**, `recording_sidecar_bin`, `sidecar_cpu_affinity`, etc.

- **shm_max_vars** (integer, default 2048): maximum SHM v2 table rows. Segment size ≈ 64 + shm_max_vars×176 + shm_max_vars×shm_ring_depth×16 (default ring depth 64). Must match in C++ and Python; **restart both** after changing `shm_max_vars` or `shm_ring_depth`.
- **Native recording**: with **`recording_backend = sidecar_cpp`**, the **`varmon_sidecar`** binary writes the TSV while Python keeps updating the UI from SHM at a capped rate (**`shm_parse_hz_sidecar_recording`**, default 30 Hz; `0` = pump-only on the main sem). The **Perf** panel merges Python, C++, and sidecar phase timings via **`GET /api/perf`**. See **`docs/performance.md`** / **`docs_en/performance.md`** and **`docs/backend.md`** / **`docs_en/backend.md`**.

Config file path: environment variable `VARMON_CONFIG` or in C++ `varmon::set_config_path(...)`.

## Integrating into your C++ project

```cmake
add_subdirectory(libvarmonitor)
target_link_libraries(your_app PRIVATE varmonitor)
```

```cpp
#include <var_monitor.hpp>

varmon::VarMonitor monitor;
monitor.register_var("sensors.temperature", &temperature);
monitor.start(100);  // 100 ms between samples; starts UDS and SHM

// In your control loop (e.g. 100 Hz):
monitor.write_shm_snapshot();
```

With macros: `var_monitor_macros.hpp`, `VARMON_WATCH`, `VARMON_START`, etc.

## Web monitor features

- Three columns: available variables, live monitor, charts.
- **Live**, **Analysis**, and **hybrid Replay** modes (TSV + SHM/C++ with per-variable imposition).
- Dynamic charts (Plotly), Hi/Lo alarms, TSV recording (backend), notifications, computed variables, save/load settings, remote access via `web_port`, keyboard shortcuts (R record, S screenshot, etc.).

## Project layout

```
monitor/
├── data/
│   └── varmon.conf      # Config (también: VARMON_CONFIG o ./varmon.conf en cwd)
├── libvarmonitor/       # C++: VarMonitor, shm_publisher, uds_server
├── demo_app/
├── web_monitor/         # Python FastAPI, UdsBridge, ShmReader
│   ├── recordings/      # TSV recordings and alarms (generated)
│   └── static/
├── docs/                # MkDocs documentation (Spanish)
├── docs_en/             # MkDocs documentation (English)
└── scripts/
```
