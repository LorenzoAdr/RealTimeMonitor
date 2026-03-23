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
| `set_shm_publish_slice` | `"count": N`, `"force_full": bool` | **Export** slicing: with `force_full: false` and `N>1`, each C++ cycle only updates export rows whose subscription index satisfies `i % N == phase` (phase rotates every cycle). `force_full: true` or `N=1` = all export rows every cycle. **IMPORT** rows (mode 1) are always processed. `count` is clamped to `update_ratio_max` in `varmon.conf`. |

History comes from SHM (live) and TSV recordings on disk; there are no `get_history` / `get_histories` commands in the current protocol.

### Responses from C++ (response)

C++ always returns JSON with at least `"type"`:

- `server_info`: `type`, `uptime_seconds`, `shm_name`, `sem_name`, **`sem_sidecar_name`** (second POSIX sem: the C++ publisher `sem_post`s **both** per snapshot; Python’s `ShmReader` waits on `sem_name` only; **varmon_sidecar** must wait on `sem_sidecar_name` so the two consumers do not share one counter), `uds_path`, optional `memory_rss_kb`, `cpu_percent`; when SHM is active, `shm_layout_version`: **2**, plus `shm_publish_slice_n`, `shm_publish_slice_force_full`, `shm_publish_slice_partial` (true when `n>1` and not `force_full`). **Note:** time between paired `sem_post` calls still follows the RT loop cadence; slicing reduces work *inside* each cycle, not how often semaphores fire.
- `list_names`: `type: "names"`, `data: ["name1", ...]`.
- `list_vars`: `type: "vars"`, `data: [{ "name", "type", "value", "timestamp" }, ...]`.
- `get_var`: `type: "var"`, `data: <var object or null>`.
- `set_var` / `set_array_element`: `type: "set_result", "ok": true|false`.
- `unregister_var`: `type: "unregister_result", "ok": true|false`.
- `set_shm_subscription`: `type: "shm_subscription_result", "ok": true`.
- `set_shm_publish_slice`: `type: "shm_publish_slice_result", "ok": true`.
- Error: `type: "error", "message": "..."`.

---

## Shared memory (SHM): names, layout and cleanup

### Names

- **POSIX semaphore (primary reader)**: name `/varmon-<user>-<pid>` (leading slash). Waited on by the Python **`ShmReader`** thread for each published snapshot.
- **Second POSIX semaphore (sidecar)**: name **`/varmon-<user>-<pid>-sc`**. Same `<user>` and `<pid>`. Waited on by **`varmon_sidecar`** (native recording and optional C++ alarm monitor).
- **SHM segment** (under `/dev/shm/`): name `varmon-<user>-<pid>` (full path `/dev/shm/varmon-<user>-<pid>`).

Each C++ process has **one SHM segment and two semaphores**; the user/pid pair identifies UDS and SHM. See [Second semaphore and independent consumers](#second-semaphore-and-independent-consumers).

### Creation and destruction in C++

- **init()** (after `cleanup_stale_shm_for_user()`): `shm_open`, `ftruncate`, `mmap`, `sem_open` for the **main** semaphore **and** `sem_open` for the **`-sc`** semaphore. On failure, resources are released.
- **shutdown()**: `sem_close`/`sem_unlink` for **both** semaphores, `munmap`/`close`, `shm_unlink`.

### Stale segment cleanup

- **cleanup_stale_shm_for_user()** (`shm_publisher.cpp`): lists `/dev/shm` entries with prefix `varmon-<user>-`, extracts PID, checks `kill(pid, 0)`; if the process is gone, `shm_unlink` and `sem_unlink`. Called at start of `init()`.

### Segment layout (C++ and Python)

**Version 2 (current):** same `magic`; `version` = **2**. First **32 bytes** match the v1 header layout. Extended header **64 bytes**; **N = min(|subscription|, shm_max_vars)** table rows of **176 bytes**; then a **ring arena** of `shm_max_vars × shm_ring_depth × 16` bytes (two `double`s per sample: time + value).

- **v2 header (64 B)**: bytes 0–31 as before; 32–35 `table_offset` (typically 64); 36–39 `table_stride` (176); 40–43 row capacity (`shm_max_vars`); 44–47 ring arena offset; 48–49 slot size (16); 50–51 `shm_ring_depth`. **52–59**: little-endian **`double` `publish_period_sec`**: seconds between this publish and the previous one (same clock as `timestamp` at +24); written by C++ on each `write_snapshot`; the backend can show the SHM cycle without inferring Δt from Python’s consumer timing.

- **Table row (176 B)**: `name[128]`; byte 128 **mode** (0 export snapshot, 1 import one-shot, 2 export ring); byte 129 type (scalar kind); **130–133** little-endian **`uint32` `row_pub_seq`**: copy of the global header `seq` the last time C++ wrote that row (partial slices / skip-unchanged can leave an older value → Python may reuse the decoded row); offset 136 value `double`; 144 `ring_rel_off`; 148 `ring_capacity`; 152 `write_idx`; 160 `read_idx` (consumer-owned, e.g. sidecar); 168 `mirror_value` (latest scalar for UI/alarms in ring mode).

**Row order** matches `set_shm_subscription` (ordered, deduplicated). Empty subscription → `count = 0`, header + `sem_post` only.

**Import one-shot (mode 1):** a producer (e.g. backend with RW `mmap`) fills name/type/value and mode 1; on the next `write_shm_snapshot`, C++ applies `set_var`, restores default mode (`shm_default_export_mode` in `varmon.conf`: 0 snapshot or 2 ring).

**v1 compatibility:** old segments with `version` 1 use a 32-byte header and 137-byte entries; Python and `varmon_sidecar` still parse that layout.

**Size (v2):** `64 + shm_max_vars×176 + shm_max_vars×shm_ring_depth×16` bytes. `shm_ring_depth` and `shm_default_export_mode` are read only by the C++ process from `varmon.conf`.

### Ring buffer arena: what it is and why

After the **row table** (one row per subscribed variable, up to `shm_max_vars`), the segment contains a **contiguous arena** for **per-variable ring buffers**.

- **Layout**: for each row in **export ring** mode (`mode = 2`), the row stores `ring_rel_off` and `ring_capacity` (= `shm_ring_depth`). That offset points into the arena to a block of **`depth × 16` bytes** (16 = two little-endian `doubles`: sample time + scalar value).
- **Producer (C++)**: on each publish, for ring mode it **pushes** into slot `(write_idx % depth)`, increments `write_idx`, and updates **`mirror_value`** with the latest scalar (UI, alarms, readers that only need the current value).
- **Goals**: (1) **Short embedded history** without heap allocations or a second segment; (2) **Recording**: the sidecar can emit TSV lines from **new ring slots** since last read (ring replay); (3) **Snapshot mode** remains a single scalar per cycle where ring mode is not used.

If `shm_ring_depth` is 0 or the row is not in ring mode, that variable does not use arena slots for time-series samples.

### Second semaphore and independent consumers

On each valid snapshot the C++ code calls **`post_shm_readers()`**: `sem_post` on the **main** semaphore and **`sem_post`** on the **sidecar** semaphore (`…-sc`).

- A **single** semaphore shared by Python and the sidecar would be awkward: both would `sem_wait` on the same counter—one consumer could **steal** wakeups meant for the other, or you would need ad-hoc draining. The intended contract is **one snapshot → one wakeup per consumer**.
- **Two semaphores** give **independent counters**. After one snapshot the producer issues **one post for Python** and **one for the sidecar**; each side waits on **its** semaphore only.
- **`ShmReader`** uses **`sem_name`**. **`varmon_sidecar`** must use **`sem_sidecar_name`** from `server_info`. Native recording and C++ alarm loops then do not contend with the web backend on POSIX wait queues.

Zombie cleanup should unlink **both** semaphore names for stale `varmon-<user>-<pid>` segments (as implemented in the publisher).

### Sidecar process (`varmon_sidecar`)

The **sidecar** is a separate C++ binary from the process running `VarMonitor` and your RT loop. It shares only the SHM segment (mmap) and the **`-sc`** semaphore—not the variable server’s UDS socket.

- **`sidecar_cpp` recording**: Python spawns the sidecar with `shm_name`, column list (`names-file`), and **`sem_sidecar_name`**. The sidecar waits on one `sem_post` per snapshot, reads the mmap (same layout as `shm_reader.py`), formats TSV rows, and writes to disk. Python may cap how often it **parses** mmap for the UI (`shm_parse_hz_sidecar_recording`) without slowing TSV writes in the sidecar.
- **Native alarms**: with rules in TSV, `--alarm-monitor` can evaluate thresholds on each sidecar semaphore wakeup.
- **Rationale**: move heavy SHM table scans and TSV formatting out of Python, and avoid sharing one semaphore between the web reader and the recorder. More detail in [Performance](performance.md) (native recording and sidecar phases).

### Write path (C++)

Each cycle: `write_shm_snapshot(mon)` → seq, timestamp; rows per subscription (import → apply + reset; snapshot/ring → fill from `get_var`); **`sem_post` on both semaphores**.

**Partial export slice:** if `set_shm_publish_slice` set `force_full: false` and `count = N > 1`, only export rows with `subscription_index % N == phase` are updated that cycle; other export rows keep their last mmap values. Header (`seq`, `timestamp`) always updates; readers must not assume every row changes on every post. Recording or alarms in Python typically force `force_full: true` so critical variables are not starved.

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

4. **Rel act**: backend does not send `vars_update` every SHM cycle; minimum interval between sends (UI setting) reduces traffic and browser load. The same factor **N** is often pushed to C++ as `set_shm_publish_slice` during passive monitoring (non-empty list, no REC/alarms), lowering per-cycle producer cost; REC or alarm rules force full SHM publish.

**Summary**: non-monitored variables are not sent to the browser. Empty subscription → no SHM variable data (header only); non-empty → only subscribed variables, reducing C++ work and snapshot size.

---

## Alarms and recording in the backend

- **Alarms**: frontend sends `set_alarms` with `{ name: { lo, hi } }`. Backend evaluates each snapshot; threshold cross → `alarm_triggered`; back in range → `alarm_cleared`. Short rolling buffer (~1 s + 1 s) with **full snapshot** per sample; after trigger, 1 s later write TSV and `alarm_recording_ready`.
- **Recording**: `start_recording` / `stop_recording`. With **`recording_backend = python`**, a writer thread queues snapshots and writes TSV. With **`sidecar_cpp`**, **`varmon_sidecar`** is spawned (same `shm_name`, semaphore **`sem_sidecar_name`**); it writes the TSV. On stop, `record_finished` with `path`, etc. Toast shows path; optional base64 if "Send file when finished" is enabled.
- **`GET /api/perf`**: JSON with `python`, `cpp`, `sidecar` layers. Sidecar reads the JSON file produced when the binary is launched with **`--perf-file`** (next to the temp TSV); not part of UDS/SHM wire format.
