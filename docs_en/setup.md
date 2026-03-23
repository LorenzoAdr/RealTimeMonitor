# Installation and configuration

## Requirements

- Linux (UDS and SHM under `/dev/shm`, POSIX semaphores).
- CMake 3.16+, GCC 11+ (C++20).
- Python 3.10+.

## Quick install

```bash
# 1. Install dependencies
chmod +x scripts/varmon/setup.sh
./scripts/varmon/setup.sh

# 2. Build
mkdir -p build && cd build
cmake .. && make -j$(nproc)

# 3–5. Three terminals (see scripts/LAUNCH.md)
cd ..
./scripts/launch_demo.sh
./scripts/launch_web.sh
./scripts/launch_ui.sh
```

**Stop** VarMonitor processes for the current user: `./scripts/stop_varmonitor.sh` (optional `VARMON_STOP_DRY_RUN=1`).

**PDF** docs (MkDocs nav): `./scripts/build_docs_pdf.sh` → `dist-docs/pdf/` (requires `pandoc` and a PDF engine; see `scripts/varmon/build_docs_pdf.py`).

## Configuration: varmon.conf

Minimal example:

```
# Web monitor port (Python only)
web_port = 8080
```

Optional: `cycle_interval_ms`, `update_ratio_max`, `lan_ip`, `bind_host`, `auth_password`, `server_state_dir`, `log_buffer_size`, `log_file_cpp`, **`shm_max_vars`**, **`visual_buffer_sec`**, **recording / sidecar** (Python backend only; see [Backend](backend.md)).

- **visual_buffer_sec** (integer, default 10, range 1–7200): default visual buffer seconds in the browser when no `timeWindow` is stored in `localStorage`. Exposed in `GET /api/connection_info`; larger values increase client RAM use.
- **shm_max_vars** (integer, default 2048): maximum table rows in SHM v2 (C++ and Python). Approximate size = 64 + shm_max_vars×176 + shm_max_vars×shm_ring_depth×16 bytes (`shm_ring_depth` in the C++ `varmon.conf`, default 64). **Must match in C++ and Python**; restart C++ and the Python backend after changing `shm_max_vars` or `shm_ring_depth`.
- **SHM publisher (C++ only)**: `shm_publish_dirty_mode`, `shm_publish_full_refresh_cycles`, `shm_publish_skip_unchanged`, `shm_publish_slice_count`, `shm_async_publish`, `shm_default_export_mode` (default snapshot vs ring). See [Performance](performance.md) (C++ publisher section) and [Protocols / SHM](protocols.md).
- **log_buffer_size** (integer, default 5000): max lines the backend keeps in memory for the built-in log viewer (between 100 and 50000).
- **log_file_cpp** (path): if set, the log viewer can also show C++ process output. Redirect stderr to a file (e.g. `./my_app 2> /tmp/varmon_cpp.log`) and set `log_file_cpp = /tmp/varmon_cpp.log`. In the UI, use source "C++" or "Both".
- **`recording_backend`**: `python` (TSV from a Python writer thread) or **`sidecar_cpp`** (`varmon_sidecar`; lower Python CPU). Requires active SHM and a reachable binary (`recording_sidecar_bin`, `VARMON_SIDECAR_BIN`, or `PATH` / usual build paths).
- **`shm_parse_hz_sidecar_recording`**: with `sidecar_cpp` and a running sidecar, caps Python SHM mmap parses/s for **`vars_update`** (default **30** in code; **`0`** = do not parse, only drain `sem_name` — C++ values on screen freeze). The TSV is written by the sidecar on **`sem_sidecar_name`**.
- **`shm_sidecar_sem_drain_interval_sec`**: sleep interval between main-sem drain bursts when using pump-only mode (`shm_parse_hz_sidecar_recording = 0`).
- **`recording_sidecar_bin`**: absolute path to `varmon_sidecar` if not on `PATH`.
- **`sidecar_cpu_affinity`**: Linux — CPU list for `sched_setaffinity` on sidecar processes (recording and `--alarm-monitor`), e.g. `3` or `2,5` or `4-7`.

**Sidecar (environment, not `varmon.conf`)**: `VARMON_SIDECAR_BIN`, **`VARMON_SIDECAR_PERF_FLUSH_EVERY`** (1–512): how often the `--perf-file` JSON is flushed (Perf panel sidecar layer).

Config file path: environment variable `VARMON_CONFIG`; otherwise `./varmon.conf` in the cwd, then `data/varmon.conf` at the repo root, then legacy `varmon.conf` at the repo root. In C++: `varmon::set_config_path(...)`.

**On-disk data (recordings, templates, sessions):** by default, in development under `web_monitor/recordings/`, `web_monitor/server_state/`. With the PyInstaller binary, defaults are `INSTALL_DIR/data/recordings/` and `INSTALL_DIR/data/server_state/` (next to the executable). Override with `VARMON_DATA_DIR` or keys `data_root`, `recordings_dir`, `server_state_dir` in `varmon.conf`.

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
├── data/
│   └── varmon.conf      # Recommended config location in the repo
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
