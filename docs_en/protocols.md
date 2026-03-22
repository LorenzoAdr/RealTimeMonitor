# Protocols

## UDS message format

All Python ↔ C++ messages over UDS follow:

1. **Length (4 bytes, big-endian, unsigned)**  
   Byte length of the following JSON (not including these 4 bytes).

2. **Body (JSON)**  
   UTF-8 JSON object.

**Limit**: 10 MiB per message (C++ and `uds_client.py`).

### UDS packet layout

Each message is one packet with length header and body:

```mermaid
block-beta
  columns 2
  block:UDS packet
    block:Header 4 bytes
      A["Length (big-endian uint32)\nJSON byte length"]
    end
    block:Body N bytes
      B["JSON UTF-8\n{ \"cmd\": \"...\", ... }"]
    end
  end
end
```

| Offset | Size | Content |
|--------|------|---------|
| 0      | 4    | JSON length (network byte order, big-endian `!I`) |
| 4      | N    | JSON UTF-8 bytes; N = first 4 bytes |

### Sending from Python (UdsBridge)

- Build a `dict`, serialize with `json.dumps(..., separators=(",", ":"))`.
- Send `struct.pack("!I", len(raw)) + raw`.

### Receiving in C++ (uds_server)

- `recv_message()`: read 4 bytes, `ntohl` → `len`, then read `len` bytes (JSON).
- Parse JSON to extract `cmd` and parameters.

### Commands from Python (request)

| Command | Parameters (JSON) | Purpose |
|---------|---------------------|---------|
| `server_info` | (none) | Server info, uptime, shm_name, sem_name, sem_sidecar_name, uds_path, RAM/CPU |
| `list_names` | (none) | Variable name list |
| `list_vars` | (none) | Variables with type and current value |
| `get_var` | `"name": "<name>"` | Current value |
| `set_var` | `"name", "value", "type"` | Write variable (double, int32, bool, etc.) |
| `set_array_element` | `"name", "index", "value"` | Write array element |
| `unregister_var` | `"name"` | Hot-unregister variable |
| `set_shm_subscription` | `"names": ["a","b",...]` | SHM subscription: only write those variables to SHM; empty = write no entries (header only) |

History comes from SHM (live) and TSV recordings on disk; there are no `get_history` / `get_histories` commands in the current protocol.

### Responses from C++ (response)

C++ always returns JSON with at least `"type"`:

- `server_info`: `type`, `uptime_seconds`, `shm_name`, `sem_name`, **`sem_sidecar_name`** (second POSIX sem: the C++ publisher calls `sem_post` on both per snapshot; Python’s `ShmReader` uses `sem_name` only; **varmon_sidecar** should use `sem_sidecar_name` to avoid competing with Python), `uds_path`, optional `memory_rss_kb`, `cpu_percent`; when SHM is active, `shm_layout_version`: **2** (v2 layout).
- `list_names`: `type: "names"`, `data: ["name1", ...]`.
- `list_vars`: `type: "vars"`, `data: [{ "name", "type", "value", "timestamp" }, ...]`.
- `get_var`: `type: "var"`, `data: <var object or null>`.
- `set_var` / `set_array_element`: `type: "set_result", "ok": true|false`.
- `unregister_var`: `type: "unregister_result", "ok": true|false`.
- `set_shm_subscription`: `type: "shm_subscription_result", "ok": true`.
- Error: `type: "error", "message": "..."`.

---

## Shared memory (SHM): names, layout and cleanup

### Names

- **SHM segment** (under `/dev/shm/`): name `varmon-<user>-<pid>` (full path `/dev/shm/varmon-<user>-<pid>`).
- **POSIX semaphore**: name `/varmon-<user>-<pid>` (leading slash). Same `<user>` and `<pid>` as the segment.

Each C++ process has one segment and one semaphore; the same user/pid pair identifies UDS and SHM.

### Creation and destruction in C++

- **init()** (after `cleanup_stale_shm_for_user()`): `shm_open`, `ftruncate`, `mmap`, `sem_open`. On failure, resources are released.
- **shutdown()**: `sem_close`/`sem_unlink`, `munmap`/`close`, `shm_unlink`.

### Stale segment cleanup

- **cleanup_stale_shm_for_user()** (`shm_publisher.cpp`): lists `/dev/shm` entries with prefix `varmon-<user>-`, extracts PID, checks `kill(pid, 0)`; if the process is gone, `shm_unlink` and `sem_unlink`. Called at start of `init()`.

### Segment layout (C++ and Python)

**Version 2 (current):** same `magic`; `version` = **2**. First **32 bytes** match the v1 header layout. Extended header **64 bytes**; **N = min(|subscription|, shm_max_vars)** table rows of **176 bytes**; then a **ring arena** of `shm_max_vars × shm_ring_depth × 16` bytes (two `double`s per sample: time + value).

- **v2 header (64 B)**: bytes 0–31 as before; 32–35 `table_offset` (typically 64); 36–39 `table_stride` (176); 40–43 row capacity (`shm_max_vars`); 44–47 ring arena offset; 48–49 slot size (16); 50–51 `shm_ring_depth`. **52–59**: little-endian **`double` `publish_period_sec`**: seconds between this publish and the previous one (same clock as `timestamp` at +24); written by C++ on each `write_snapshot`; the backend can show the SHM cycle without inferring Δt from Python’s consumer timing.

- **Table row (176 B)**: `name[128]`; byte 128 **mode** (0 export snapshot, 1 import one-shot, 2 export ring); byte 129 type; offset 136 value `double`; 144 `ring_rel_off`; 148 `ring_capacity`; 152 `write_idx`; 160 `read_idx`; 168 `mirror_value`.

**Row order** matches `set_shm_subscription` (ordered, deduplicated). Empty subscription → `count = 0`, header + `sem_post` only.

**Import one-shot (mode 1):** a producer (e.g. backend with RW `mmap`) fills name/type/value and mode 1; on the next `write_shm_snapshot`, C++ applies `set_var`, restores default mode (`shm_default_export_mode` in `varmon.conf`: 0 snapshot or 2 ring).

**v1 compatibility:** old segments with `version` 1 use a 32-byte header and 137-byte entries; Python and `varmon_sidecar` still parse that layout.

**Size (v2):** `64 + shm_max_vars×176 + shm_max_vars×shm_ring_depth×16` bytes.

### Write path (C++)

Each cycle: `write_shm_snapshot(mon)` → seq, timestamp; rows per subscription (import → apply + reset; snapshot/ring → fill from `get_var`); `sem_post`.

### Read path (Python, ShmReader)

- Open segment with `os.open("/dev/shm/"+shm_name)` and `mmap.mmap(..., MAP_SHARED, PROT_READ)`.
- Open the monitor semaphore with `sem_open(sem_name, O_RDWR)` (ctypes). Native recording/alarms: `sem_open(sem_sidecar_name, …)` when present in `server_info`.
- Thread loop: `sem_timedwait(sem, timeout)`; on signal read header + entries, build `{name, type, value}` list, push to `Queue`. WebSocket loop consumes the queue.

### Monitored variable update system {: #monitored-variable-update-system }

Only **monitored** variables are updated and sent to the browser; others are not written to SHM (when subscribed) and not sent over WebSocket.

1. **Frontend**: user selects variables to show. List sent to backend as `monitored` (`names`).

2. **SHM subscription (C++)**: backend calls `set_shm_subscription(list(...))` over UDS (order preserved).
   - **Non-empty subscription** (v2): one **fixed row per index** (0…N−1) in list order.
   - **Empty subscription**: C++ writes **no** variable entries—only header (`seq`, `count = 0`, `timestamp`) and `sem_post`. Avoids dumping all variables each cycle when nothing is monitored. **Available** variables come from **UDS** (`list_names` / `list_vars`) when needed; more efficient than writing all names/values to SHM every cycle.

3. **Backend (Python)**: `ShmReader` reads whatever snapshot is in SHM (`count` entries; empty subscription → `data: []`). WebSocket `vars_update` includes only names in `monitored_names`.

4. **Rel act**: backend does not send `vars_update` every SHM cycle; minimum interval between sends (UI setting) reduces traffic and browser load.

**Summary**: non-monitored variables are not sent to the browser. Empty subscription → no SHM variable data (header only); non-empty → only subscribed variables, reducing C++ work and snapshot size.

---

## Alarms and recording in the backend

- **Alarms**: frontend sends `set_alarms` with `{ name: { lo, hi } }`. Backend evaluates each snapshot; threshold cross → `alarm_triggered`; back in range → `alarm_cleared`. Short rolling buffer (~1 s + 1 s) with **full snapshot** per sample; after trigger, 1 s later write TSV and `alarm_recording_ready`.
- **Recording**: `start_recording` / `stop_recording`. Backend queues snapshots. On stop, writes TSV under `web_monitor/recordings/`, sends `record_finished` with `path` (and optional `file_base64`). Toast shows path; file attachment only if "Send file when finished" is enabled.
