# Troubleshooting

## Semaphore will not open (WSL / ENOENT / EACCES)

In some environments (e.g. **WSL**) the Python backend may fail to open the POSIX semaphore created by C++. Backend logs will show **errno** (e.g. `ENOENT` or `EACCES`).

### ENOENT

The semaphore file does not exist for the Python process. On Linux it lives under `/dev/shm/sem.<name_without_leading_slash>` (e.g. `/dev/shm/sem.varmon-user-10229`).

Check:

- `ls /dev/shm/sem.*` — the semaphore should exist while C++ is running.
- Python runs as the **same user** as C++, and on WSL preferably the same session/distro.

### EACCES

Permission issues. C++ creates the semaphore with `0666`. Check for namespace or different `/dev/shm` mounts.

### Fallback

If the semaphore cannot open, the backend uses **polling**: reads SHM every ~5 ms and detects new data via the header `seq` field. Recording stays real-time; you lose blocking wait (slightly higher CPU in the reader thread).

---

## App will not connect

- Ensure C++ is running and `/tmp/varmon-<user>-<pid>.sock` exists.
- Ensure the Python backend is listening on the configured port (`web_port` in `varmon.conf`).
- If using a password (`auth_password`), the frontend must send it on the WebSocket URL: `?password=...`.
- Check the browser console (F12) and backend logs for WebSocket or auth errors.

---

## Empty charts or missing curves after F5

- The frontend stores config in `localStorage`. After reload, layout is restored and a second paint runs at 500 ms so WebSocket data can draw. If curves still missing:
  - Check UDS instance selection and connection status in the header.
  - Ensure variables are in the Monitor column and assigned to a chart.
- If the chart area is full size but empty, the first paint often had no data; the automatic second paint at 500 ms should fill curves once history exists.

---

## Some variables show "--" when monitoring many

If adding many variables at once (e.g. thousands) shows "--" for some, but a single one of those works alone, the cause is usually the **SHM limit**:

1. **C++** only writes up to **shm_max_vars** variables (`varmon.conf`). If the subscription is larger, only the first get values.
2. **Python** must read the same `shm_max_vars`; if missing from config, default 2048 **truncates** SHM reads (variables beyond never reach the frontend).

**Fix:**

- Set **shm_max_vars** in `varmon.conf` ≥ max simultaneous monitored variables (e.g. 5120 for 5000 vars).
- Ensure the backend actually loads that key (otherwise it defaults to 2048).
- **Restart C++** (recreate segment) and **restart Python** (reload limit).

If the subscription exceeds the limit, C++ prints a one-time stderr warning that only the first `shm_max_vars` are written.

---

## Debugging

- **Log viewer**: Header **Log** opens Python backend lines (and optional C++ file if `log_file_cpp` is set). See [Installation — Log viewer](setup.md#built-in-log-viewer).
- **Backend**: `app.py` logs show UDS connections, SHM/semaphore errors, WebSocket messages.
- **Frontend**: Browser console (F12); Network tab → WS filter.
- **C++**: Call `write_shm_snapshot()` at the desired rate. To see C++ output in the log viewer, redirect stderr to a file and set `log_file_cpp` in `varmon.conf`.
