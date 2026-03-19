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
| `server_info` | (none) | Server info, uptime, shm_name, sem_name, uds_path, RAM/CPU |
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

- `server_info`: `type`, `uptime_seconds`, `shm_name`, `sem_name`, `uds_path`, optional `memory_rss_kb`, `cpu_percent`.
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

- **Header (32 bytes)**:
  - 0–3:   magic (0x4D524156, "VARM" LE).
  - 4–7:   version (1).
  - 8–15:  seq (snapshot counter).
  - 16–19: count (entry count).
  - 20–23: padding.
  - 24–31: timestamp (double, Unix time).

- **Entries**: up to **shm_max_vars** (`varmon.conf`, default 2048); each: 128-byte name (C string), 1-byte type (0=double, 1=int32, 2=bool, 3=string, 4=array), 8-byte value (double).

Only **scalar** variables in SHM. `set_shm_subscription` restricts which variables are written: non-empty → only those; empty → C++ writes no variable entries (header with `count = 0` only). See **Monitored variable update system** below.

### SHM segment details

Fixed-size buffer in `/dev/shm/`: `HEADER_SIZE + shm_max_vars * ENTRY_SIZE` (32 + shm_max_vars×137 bytes). C++ reads `shm_max_vars` from `varmon.conf` at startup; Python must use the same value or reads truncate (remaining variables show "--").

**Serialization**

- **Header**: first 32 bytes (`struct.unpack` in Python, `memcpy` in C++). `count` is how many valid entries exist in this snapshot.
- **Each entry**: **137 bytes**:
  - **Name**: 128 bytes, C string (NUL-terminated); rest zero. Python reads up to first `\0`, UTF-8.
  - **Type**: 1 byte. 0=double, 1=int32, 2=bool, 3=string, 4=array. Only scalars (0,1,2) are written to SHM; string/array omitted.
  - **Value**: 8 bytes, little-endian `double`. Bool as 0.0/1.0; int32 promoted to double.

**Where C++ and Python read**

- **Base**: C++ `mmap` in `init()`; Python opens `/dev/shm/<name>` and `mmap(..., MAP_SHARED, PROT_READ)`.
- **Header**: offset **0**, 32 bytes.
- **Entries**: start offset **32**. Entry *i* at `32 + i * 137`. C++ walks subscribed variables; Python loops `for _ in range(count)` reading 137-byte chunks.

**POSIX semaphore** signals "new snapshot": C++ `sem_post` after write; Python `sem_wait` / `sem_timedwait` then reads.

```mermaid
block-beta
  columns 1
  block:SHM segment (/dev/shm/varmon-user-pid)
    block:Header 32 bytes
      H1["0-3: magic"]
      H2["4-7: version"]
      H3["8-15: seq"]
      H4["16-19: count"]
      H5["20-23: padding"]
      H6["24-31: timestamp (double)"]
    end
    block:Entry 0 (137 bytes)
      E0a["name[128]"]
      E0b["type[1]"]
      E0c["value double[8]"]
    end
    block:Entry 1 (137 bytes)
      E1["..."]
    end
    block:...
      E2["... up to count entries"]
    end
  end
end
```

| Offset | Size | Content |
|--------|------|---------|
| 0 | 4 | magic (0x4D524156) |
| 4 | 4 | version (1) |
| 8 | 8 | seq |
| 16 | 4 | count |
| 20 | 4 | padding |
| 24 | 8 | timestamp (double, Unix) |
| 32 | 137 | entry 0: name[128], type[1], value[8] |
| 169 | 137 | entry 1 |
| … | … | up to `count` entries (max `shm_max_vars`) |

### Write path (C++)

Each cycle: `write_shm_snapshot(mon)` → updates seq and timestamp. Empty subscription → `count = 0`, `sem_post` (no entries). Non-empty → write `count` and entries, `sem_post`.

### Read path (Python, ShmReader)

- Open segment with `os.open("/dev/shm/"+shm_name)` and `mmap.mmap(..., MAP_SHARED, PROT_READ)`.
- Open semaphore with `sem_open(sem_name, O_RDWR)` (ctypes).
- Thread loop: `sem_timedwait(sem, timeout)`; on signal read header + entries, build `{name, type, value}` list, push to `Queue`. WebSocket loop consumes the queue.

### Monitored variable update system {: #monitored-variable-update-system }

Only **monitored** variables are updated and sent to the browser; others are not written to SHM (when subscribed) and not sent over WebSocket.

1. **Frontend**: user selects variables to show. List sent to backend as `monitored` (`names`).

2. **SHM subscription (C++)**: backend calls `set_shm_subscription(list(monitored_names))` over UDS.
   - **Non-empty subscription**: `write_shm_snapshot()` writes only variables in that list.
   - **Empty subscription**: C++ writes **no** variable entries—only header (`seq`, `count = 0`, `timestamp`) and `sem_post`. Avoids dumping all variables each cycle when nothing is monitored. **Available** variables come from **UDS** (`list_names` / `list_vars`) when needed; more efficient than writing all names/values to SHM every cycle.

3. **Backend (Python)**: `ShmReader` reads whatever snapshot is in SHM (`count` entries; empty subscription → `data: []`). WebSocket `vars_update` includes only names in `monitored_names`.

4. **Rel act**: backend does not send `vars_update` every SHM cycle; minimum interval between sends (UI setting) reduces traffic and browser load.

**Summary**: non-monitored variables are not sent to the browser. Empty subscription → no SHM variable data (header only); non-empty → only subscribed variables, reducing C++ work and snapshot size.

---

## Alarms and recording in the backend

- **Alarms**: frontend sends `set_alarms` with `{ name: { lo, hi } }`. Backend evaluates each snapshot; threshold cross → `alarm_triggered`; back in range → `alarm_cleared`. Rolling buffer 10 s + 1 s; after trigger, 1 s later write TSV and `alarm_recording_ready`.
- **Recording**: `start_recording` / `stop_recording`. Backend queues snapshots. On stop, writes TSV under `web_monitor/recordings/`, sends `record_finished` with `path` (and optional `file_base64`). Toast shows path; file attachment only if "Send file when finished" is enabled.
