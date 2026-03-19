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
| `GET /api/recordings` | `api_recordings()` | TSV recording list. |
| `GET /api/recordings/{filename}` | `api_recording_download()` | Download a TSV. |
| `GET /api/recordings/{filename}/history` | `api_recording_var_history()` | Variable history in a TSV (offline analysis). |
| `GET /api/recordings/{filename}/window` | `api_recording_var_window()` | Time window for one variable. |
| `GET /api/recordings/{filename}/window_batch` | `api_recording_var_window_batch()` | Multiple variables in one window (batch). |
| `GET /api/recordings/{filename}/bounds` | `api_recording_time_bounds()` | Time bounds of a TSV. |
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
| `GET /api/advanced_stats` | `api_advanced_stats()` | RAM/CPU (HTML, Python, C++). |
| `WebSocket /ws` | `websocket_endpoint()` | Live connection (vars_update, alarms, recording). |

## Configuration

- **load_config()**: Reads `varmon.conf` (or `VARMON_CONFIG` path). Returns a dict with `web_port`, `auth_password`, `cycle_interval_ms`, **`shm_max_vars`**, etc. Called at startup; result stored in `_config`. The `shm_max_vars` value (default 2048) is passed to **ShmReader** so it reads up to that many entries from SHM; if omitted, the backend uses 2048 and truncates larger snapshots (variables beyond that show "--" in the frontend).

## UDS instance discovery

- **_list_uds_instances(user_filter)**: Lists sockets under `/tmp/varmon-*.sock` (or `varmon-<user>-*.sock` if `user_filter` is set). For each path opens `UdsBridge(path, timeout=0.6)`, calls `get_server_info()`, closes. Returns only responding instances. Order: socket **mtime** (newest first). Returns list of dicts with `uds_path`, `pid`, `uptime_seconds`, `user`.

## WebSocket: flow in `websocket_endpoint()`

1. **Accept and auth**: `ws.accept()`. If `auth_password` is set, require `?password=...` in the URL; on failure send `error` with `message: "auth_required"` and close.
2. **Pick UDS instance**: If `uds_path` is missing in the query, call `_list_uds_instances(None)` and take the first. If none, send `error` and close.
3. **Connect UDS and server_info**: Create `UdsBridge(query_uds, 5.0)` and call `bridge.get_server_info()`. Read `shm_name` and `sem_name`.
4. **ShmReader**: If `shm_name` and `sem_name` exist, create a `Queue` and `ShmReader(shm_name, sem_name, shm_queue, max_vars=_config["shm_max_vars"])`. Call `shm_reader.start()`. `max_vars` is how many entries to read per snapshot (must match C++). If the semaphore cannot open (e.g. WSL), ShmReader may use polling (~5 ms SHM reads, change detection via `seq`).
5. **Main loop**: A task `_shm_drain_loop()` drains the SHM queue. For each snapshot: update `latest_snapshot`, evaluate alarms (`_evaluate_alarms`), fill rolling `alarm_buffer` (10 s + 1 s), and if recording is active enqueue the snapshot for the TSV writer thread. At **visual** rate (every `update_ratio` cycles) send `vars_update` to the browser with the current snapshot.
6. **Client messages**: In parallel, receive JSON from the frontend: `monitored`, `set_alarms`, `start_recording`, `stop_recording`, `update_ratio`, `send_file_on_finish`, etc. Update `monitored_names`, `alarms_config`, `recording`, etc.
7. **Alarms**: In `_shm_drain_loop`, if `_evaluate_alarms` detects threshold crossing, send `alarm_triggered`; when back in range, `alarm_cleared`. After trigger, 1 s later write alarm TSV buffer and send `alarm_recording_ready` (path and optional `file_base64`).
8. **Recording**: On `start_recording` start a writer thread (`_recording_writer_thread`) writing TSV rows. On `stop_recording` finalize the file and send `record_finished` with `path` and optional `file_base64`.

## Helper modules

- **uds_client.py**: `UdsBridge` class. Unix socket connection, commands (4-byte big-endian length + JSON), responses. Methods: `get_server_info()`, `list_names`, `list_vars`, `get_var(name)`, `set_var(...)`, etc.
- **shm_reader.py**: `ShmReader` class. Opens `/dev/shm/<shm_name>` with `mmap` and semaphore via ctypes. Thread runs `sem_timedwait` (or polling on failure), reads header + segment entries, builds `{name, type, value}` lists and pushes to the queue. The WebSocket consumes the queue in `_shm_drain_loop`.

## Key functions for alarms and recording

- **_evaluate_alarms(...)**: Evaluates lo/hi thresholds per variable; returns updated state and `triggered` / `cleared` lists.
- **_write_snapshots_tsv(filepath, snapshots, var_names)**: Writes a TSV from snapshots (alarms or legacy recording).
- **_flush_record_buffer_to_tsv**, **_recording_writer_thread**, **_finalize_recording_temp_file**: Streaming TSV write to temp file and final rename.
