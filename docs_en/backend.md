# Backend (Python)

The backend lives in [web_monitor/app.py](../web_monitor/app.py): FastAPI, WebSocket, UDS and SHM integration.

## Main routes

| Route | Handler | Purpose |
|------|---------|---------|
| `GET /` | `index()` | Main page (static HTML). |
| `GET /api/vars` | `api_list_vars()` | Variable list (via UdsBridge). |
| `GET /api/var/{name}` | `api_get_var()` | Current variable value. |
| `POST /api/var/{name}` | `api_set_var()` | Write variable (query: value, var_type). |
| `GET /api/uds_instances` | `api_uds_instances()` | UDS instance list (optional `?user=`). |
| `GET /api/recordings` | `api_recordings()` | Recording list (TSV and/or **Parquet** when the plugin is installed). |
| `GET /api/recordings/{filename}` | `api_recording_download()` | Download TSV or Parquet by extension. |
| `GET /api/recordings/{filename}/history` | `api_recording_var_history()` | Variable history (TSV or Parquet via pyarrow). |
| `GET /api/recordings/{filename}/window` | `api_recording_var_window()` | Time window for one variable. |
| `GET /api/recordings/{filename}/window_batch` | `api_recording_var_window_batch()` | Multiple variables in one window (batch). |
| `GET /api/recordings/{filename}/bounds` | `api_recording_time_bounds()` | Time bounds of the file. |
| `GET /api/browse` | `api_browse()` | Remote file browser (path relative to project). |
| `GET /api/browse/download` | `api_browse_download()` | Download a project file. |
| `POST /api/browse/mkdir` | `api_browse_mkdir()` | Create folder in project. |
| `GET /api/admin/storage` | `api_admin_storage()` | Paths and state for advanced admin. |
| `POST /api/admin/storage/delete` | `api_admin_storage_delete()` | Delete recording or template. |
| `POST /api/admin/runtime_config` | `api_admin_runtime_config()` | Save web_port / web_port_scan_max. |
| `GET /api/auth_required` | `api_auth_required()` | Whether password is required. |
| `GET /api/uptime` | `api_uptime()` | Backend uptime. |
| `GET /api/connection_info` | `api_connection_info()` | Connection info (port, etc.). |
| `GET /api/instance_info` | `api_instance_info()` | C++ instance info (pid, user, etc.). |
| `GET /api/advanced_stats` | `api_advanced_stats()` | RAM/CPU (HTML, Python, C++). Query `perf=1` renews the perf-measurement lease (same session as the Perf panel). |
| `GET /api/perf` | `api_perf()` | JSON: `ts`, `lease_active`, `layers.python\|cpp\|sidecar` with `phases[{id,last_us,ema_us,samples}]`. Python = `perf_agg`; C++ = publisher `shm_perf_us`; sidecar = JSON from `varmon_sidecar --perf-file` during `sidecar_cpp` REC. **Renews** the measurement lease; without the panel or `advanced_stats?perf=1`, C++ stops reporting after ~1 s. |
| `WebSocket /ws` | `websocket_endpoint()` | Live connection (vars_update, alarms, recording). |

### Optional `varmonitor_plugins` package (Pro)

**ARINC / MIL-STD-1553** registry APIs (SQLite), **Git UI**, **restricted terminal**, **GDB**, **Parquet upload preview** (`POST /api/recordings/parquet_preview_upload`), and the Python Parquet I/O used with the plugin live in the installable package under [`tool_plugins/python/`](../tool_plugins/python/) (e.g. `pip install -e tool_plugins/python`, optional `[parquet]` for pyarrow). The MIT core registers them at startup through `plugin_registry` when the package is installed; without it, the server still provides monitoring, TSV, and the core routes above.

## Configuration

- **load_config()**: Reads `varmon.conf` (or `VARMON_CONFIG` path). Returns a dict with `web_port`, `auth_password`, `cycle_interval_ms`, **`shm_max_vars`**, etc. Called at startup; result stored in `_config`. The `shm_max_vars` value (default 2048) is passed to **ShmReader** so it reads up to that many entries from SHM; if omitted, the backend uses 2048 and truncates larger snapshots (variables beyond that show "--" in the frontend).

## UDS instance discovery

- **_list_uds_instances(user_filter)**: Lists sockets under `/tmp/varmon-*.sock` (or `varmon-<user>-*.sock` if `user_filter` is set). For each path opens `UdsBridge(path, timeout=0.6)`, calls `get_server_info()`, closes. Returns only responding instances. Order: socket **mtime** (newest first). Returns list of dicts with `uds_path`, `pid`, `uptime_seconds`, `user`.

## WebSocket: flow in `websocket_endpoint()`

1. **Accept and auth**: `ws.accept()`. If `auth_password` is set, require `?password=...` in the URL; on failure send `error` with `message: "auth_required"` and close.
2. **Pick UDS instance**: If `uds_path` is missing in the query, call `_list_uds_instances(None)` and take the first. If none, send `error` and close.
3. **Connect UDS and server_info**: Create `UdsBridge(query_uds, 5.0)` and call `bridge.get_server_info()`. Read `shm_name` and `sem_name`.
4. **ShmReader**: If `shm_name` and `sem_name` exist, create a `Queue` and `ShmReader(...)` with `max_vars` from config and `sample_interval_ms` from C++ `server_info`. Call `shm_reader.start()`. With a working semaphore, each publisher `post` wakes the reader and one snapshot is parsed (monitor cadence). If the semaphore cannot open (e.g. WSL), polling mode spaces reads using `sample_interval_ms` (not a fixed 5 ms). Optionally `shm_parse_max_hz` > 0 caps parses/s in monitoring-only mode (default 0 = no cap). With **`recording_backend = sidecar_cpp`** and the sidecar running, **`shm_parse_hz_sidecar_recording`** (default **30** in `DEFAULTS`) caps mmap parses/s for **`vars_update`** while the sidecar writes the TSV on **`sem_sidecar_name`**; Python keeps using **`sem_name`**. Set it to **0** to **only drain** the main semaphore on a timer (`shm_sidecar_sem_drain_interval_sec`) without parsing: C++ variable values on screen **stop** updating from SHM (telemetry and recording progress still update).
5. **Main loop**: A task `_shm_drain_loop()` drains the SHM queue (FIFO; `shm_queue_max_size`, 0 = unbounded; when full the reader thread blocks on `put`). For each snapshot: update `latest_snapshot`, evaluate alarms (`_evaluate_alarms`), fill rolling `alarm_buffer` (short window ~1 s + 1 s, full snapshots), and if recording is active in **Python** mode enqueue the snapshot for the TSV writer thread. In **sidecar_cpp** mode a separate process writes the file (see below). At **visual** rate (every `update_ratio` cycles) send `vars_update` to the browser with the current snapshot.
6. **Client messages**: In parallel, receive JSON from the frontend: `monitored`, `set_alarms`, `start_recording`, `stop_recording`, `update_ratio`, `send_file_on_finish`, etc. Update `monitored_names`, `alarms_config`, `recording`, etc.
7. **Alarms**: After `set_shm_subscription`, C++ publishes to SHM the **union** of monitored variables and variables with an alarm (`_shm_subscription_real_names`). With `alarms_backend = sidecar_cpp` (default) and rules **only** on SHM variables (not synthetic telemetry), the backend runs **`varmon_sidecar --alarm-monitor`**: it waits on **`sem_sidecar_name`** (`sem_timedwait` + drain; if `sem_open` fails, `seq` polling). It does not compete with `ShmReader`, which uses `sem_name` only. The ~2.2 s window and threshold logic run in C++, and `alarm_*.tsv` is written after 1 s more of context. With `alarms_backend = python` or any telemetry alarm, Python handles evaluation and TSV (`_evaluate_alarms`, `alarm_buffer`). The UDS fallback (`get_var` ~every 0.2 s) runs only while the SHM reader is paused. The alarm sidecar is **stopped** while **recording** and restarted when recording stops.
8. **Recording**: By default (`recording_backend = python`), `start_recording` starts `_recording_writer_thread` writing TSV rows from the queue. With `recording_backend = sidecar_cpp` and SHM active, the backend spawns **`varmon_sidecar`** with the same `shm_name` as `ShmReader` and **`sem_sidecar_name`** from `server_info` (dedicated sem: one `sem_post` per snapshot for the sidecar only; Python keeps `sem_name`). Older monitors without `sem_sidecar_name`: fallback to `sem_name`. It mmap-reads the segment in C++, writes the temp TSV and a `.stat` file with the row count for `recording_progress`. On `stop_recording` SIGTERM is sent to the sidecar, the TSV is renamed, and `record_finished` is sent. If **alarms** are set on C++ variables (not synthetic telemetry), the backend writes a rules TSV (`*.alarms.tsv`) and the sidecar evaluates thresholds each snapshot (same rules as `_evaluate_alarms`); on the **first confirmed trigger** it flushes the TSV, writes `*.alarm_exit` (JSON), and exits. The WebSocket loop sees `poll()` and sends `alarm_triggered` then `record_finished` without SIGTERM. Telemetry-only alarms are still evaluated in Python during that recording. The binary is resolved via `VARMON_SIDECAR_BIN`, `recording_sidecar_bin` in `varmon.conf`, `PATH`, or typical build paths under `build-sidecar/` or `build/` relative to `web_monitor/`. On Linux, **`sidecar_cpu_affinity`** (e.g. `3` or `2,5` or `4-7`) applies `sched_setaffinity` to both the recording and alarm-monitor sidecar processes so they can run on CPUs separate from the Python backend.

## `varmon_sidecar` executable (native recording)

- **CMake**: target `varmon_sidecar` in [varmon_sidecar/CMakeLists.txt](../varmon_sidecar/CMakeLists.txt); build: `cmake -S . -B build && cmake --build build --target varmon_sidecar`.
- **SHM layout**: [web_monitor/shm_reader.py](../web_monitor/shm_reader.py) — v2: 64-byte header, 176-byte rows, ring arena; still parses v1 (137-byte entries) when `version` is 1.
- **CLI**: **Recording:** `--shm-name`, `--sem-name` (sidecar sem from `server_info`), `--output` (`.part`), `--names-file`, `--max-vars`, optional `--status-file`, optional `--alarms-file` / `--alarm-exit-file`, optional `--shm-health-file` (NDJSON: `seq` gaps, ring overflow), optional **`--perf-file`** (JSON overwritten each cycle for the **Perf** panel → sidecar layer in `/api/perf`). **Live alarm monitor:** `--alarm-monitor` (same `--sem-name`; falls back to `seq` polling if no sem).
- **SHM v2 ring replay**: If **all** `names-file` columns are ring mode and there are pending samples without overflow, the sidecar writes **multiple TSV rows** and advances `read_idx`. Lines are built **directly** from ring slots when no per-row map is needed; with sidecar alarm rules, a small map is filled per row for evaluation only.
- **Recording layout cache**: After header/name validation, the sidecar avoids scanning all N SHM rows every cycle when only k TSV columns are recorded; snapshot path is O(k). See [Performance](performance.md).
- **Environment**: `VARMON_SIDECAR_PERF_FLUSH_EVERY` (1–512) throttles how often the `--perf-file` JSON is rewritten (less hot-path I/O).
- **`time_s` column**: C++ SHM timestamp minus the first row’s (header +24 in snapshot mode; per-slot in v2 ring replay).
- **libvarmonitor** does not handle recording; the sidecar only **consumes** SHM on the same host as the web monitor.

## Helper modules

- **uds_client.py**: `UdsBridge` class. Unix socket connection, commands (4-byte big-endian length + JSON), responses. Methods: `get_server_info()`, `list_names`, `list_vars`, `get_var(name)`, `set_var(...)`, etc.
- **shm_reader.py**: `ShmReader` class. Opens `/dev/shm/<shm_name>` with `mmap` and semaphore via ctypes. Thread runs `sem_timedwait` (or polling on failure), reads header + segment entries, builds `{name, type, value}` lists and enqueues each snapshot (FIFO). The WebSocket consumes the queue in `_shm_drain_loop`.

## Key functions for alarms and recording

- **_evaluate_alarms(...)**: Evaluates lo/hi thresholds per variable; returns updated state and `triggered` / `cleared` lists.
- **_write_snapshots_tsv(filepath, snapshots, var_names)**: Writes a TSV from snapshots (alarms or legacy recording).
- **_flush_record_buffer_to_tsv**, **_recording_writer_thread**, **_finalize_recording_temp_file**: Streaming TSV write to temp file and final rename.
