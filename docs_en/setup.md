# Installation and configuration

## Requirements

- Linux (UDS and SHM under `/dev/shm`, POSIX semaphores).
- CMake 3.16+, GCC 11+ (C++20).
- Python 3.10+.

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
# Web monitor port (Python only)
web_port = 8080
```

Optional: `cycle_interval_ms`, `update_ratio_max`, `lan_ip`, `bind_host`, `auth_password`, `server_state_dir`, `log_buffer_size`, `log_file_cpp`, **`shm_max_vars`**, **`visual_buffer_sec`**.

- **visual_buffer_sec** (integer, default 10, range 1–7200): default visual buffer seconds in the browser when no `timeWindow` is stored in `localStorage`. Exposed in `GET /api/connection_info`; larger values increase client RAM use.
- **shm_max_vars** (integer, default 2048): maximum variables that fit in the SHM segment (C++ and Python). If you monitor more than this limit, only the first ones get values; the rest show "--" in the UI. Segment size = 32 + shm_max_vars×137 bytes (e.g. 2048 → ~274 KiB, 5120 → ~686 KiB). **Must match in C++ and Python**; after changing it, **restart the C++ process and the Python backend** so both use the new limit.
- **log_buffer_size** (integer, default 5000): max lines the backend keeps in memory for the built-in log viewer (between 100 and 50000).
- **log_file_cpp** (path): if set, the log viewer can also show C++ process output. Redirect stderr to a file (e.g. `./my_app 2> /tmp/varmon_cpp.log`) and set `log_file_cpp = /tmp/varmon_cpp.log`. In the UI, use source "C++" or "Both".

Config file path: environment variable `VARMON_CONFIG` or in C++ `varmon::set_config_path(...)`.

## Built-in log viewer

From the monitor UI you can read server logs without the terminal:

- **Log** button (header): panel with recent lines from the Python backend (and, if `log_file_cpp` is set, from the C++ process).
- **Refresh**: fetches log again from the server.
- **Auto-refresh**: updates every few seconds while the panel is open.
- **Source**: Python only, C++ only, or Both.

`GET /api/log?tail=2000&source=python|cpp|all` returns JSON `{ "lines": [ {"ts", "level", "msg"}, ... ], "source": "..." }`. With `Accept: text/plain` you get plain text.

## Project layout

```
monitor/
├── varmon.conf
├── libvarmonitor/       # C++: VarMonitor, shm_publisher, uds_server
├── demo_app/
├── web_monitor/         # Python FastAPI, UdsBridge, ShmReader
│   ├── recordings/      # TSV recordings and alarms (generated)
│   └── static/
└── scripts/
```

## Full documentation (HTML)

From the repository root:

```bash
pip install mkdocs mkdocs-material
mkdocs build                    # Spanish → site/
mkdocs build -f mkdocs.en.yml   # English → site_en/
```

Open with `mkdocs serve` or `mkdocs serve -f mkdocs.en.yml`.

**From the monitor**: After building, start the monitor server. Documentation is served at **`/docs/es/`** (Spanish) and **`/docs/en/`** (English). The header **Docs** button opens a language picker, then the chosen site in a new tab.
