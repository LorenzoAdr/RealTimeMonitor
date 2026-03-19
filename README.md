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
- [Backend (Python)](docs_en/backend.md) — Routes, WebSocket, UdsBridge, ShmReader, alarms and recording.
- [Frontend](docs_en/frontend.md) — `app.js` structure, columns, Plotly charts, state and persistence.
- [Protocols](docs_en/protocols.md) — UDS format, commands, SHM layout, alarms and recording.
- [C++ integration](docs_en/cpp-integration.md) — Linking libvarmonitor, basic usage, macros.
- [Troubleshooting](docs_en/troubleshooting.md) — WSL/semaphores, connection issues, empty charts.

---

## Quick install

```bash
# 1. Install dependencies
chmod +x scripts/setup.sh
./scripts/setup.sh

# 2. Build
mkdir -p build && cd build
cmake .. && make -j$(nproc)

# 3. Run the demo server (C++)
./demo_app/demo_server

# 4. In another terminal, run the web monitor (Python)
cd web_monitor
source .venv/bin/activate
python app.py

# 5. Open http://localhost:8080
```

## Configuration: varmon.conf

Minimal example:

```
web_port = 8080
```

Optional: `cycle_interval_ms`, `update_ratio_max`, `lan_ip`, `bind_host`, `auth_password`, `server_state_dir`, **`shm_max_vars`**.

- **shm_max_vars** (integer, default 2048): maximum variables that fit in the SHM segment. If you monitor more than this, only the first get values; the rest show "--". Segment size ≈ 32 + shm_max_vars×137 bytes (e.g. 2048 → ~274 KiB). Must match in C++ and Python; **restart the C++ process and the Python backend** after changing it.

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
├── varmon.conf
├── libvarmonitor/       # C++: VarMonitor, shm_publisher, uds_server
├── demo_app/
├── web_monitor/         # Python FastAPI, UdsBridge, ShmReader
│   ├── recordings/      # TSV recordings and alarms (generated)
│   └── static/
├── docs/                # MkDocs documentation (Spanish)
├── docs_en/             # MkDocs documentation (English)
└── scripts/
```
