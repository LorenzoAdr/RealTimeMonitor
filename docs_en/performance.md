# Performance

The stack targets **maximum performance**: low latency and low CPU/network use between the publishing C++ process and the browser.

## Low-cost transport: SHM and UDS

- **C++ ↔ Python**: no TCP. Local communication via:
  - **Shared memory (SHM)**: C++ writes snapshots to `/dev/shm/` and signals with a POSIX semaphore. Python maps the same segment and reads without extra copies or network serialization.
  - **Unix domain sockets (UDS)**: commands (list variables, read/write, SHM subscription) go over a local socket. Lower overhead than TCP and no network stack.

This avoids network and CPU overhead on the live data path.

## Measures to limit load

### Monitored variables only

- Only user-selected **monitored** variables are sent over WebSocket to the browser.
- C++ only writes to SHM for subscribed variables (`set_shm_subscription`): if the subscription has names, only those are written (by name via `get_var`); if **empty**, no variable entries are written (header only with `count = 0` and `sem_post`), avoiding dumping every variable each cycle when nothing is monitored. Available variables are fetched via UDS (`list_names` / `list_vars`) on demand.
- Non-monitored variables are not included in client updates.
- Maximum variables in the SHM segment is **shm_max_vars** (`varmon.conf`; C++ and Python must match). If you monitor more than that, only the first get values; the rest show "--". See [Troubleshooting](troubleshooting.md) (section on many variables showing "--").

See [Protocols — Monitored variable update system](protocols.md#monitored-variable-update-system).

### Rel act (browser update period)

- The backend does not send `vars_update` on every SHM cycle.
- A minimum interval between WebSocket sends (UI **Rel act**) limits message rate and browser redraw without losing usefulness.

### Virtualized variable browser

- The add-variables panel can show hundreds or thousands of names.
- The list is **virtualized**: only visible rows (plus overscan) are rendered, keeping the DOM small.

### Chart downsampling

- Time series do not draw every history point.
- **Downsample** (configurable max points per series) limits canvas work.

### Adaptive load

- When the tab is hidden (`document.hidden`), the frontend can skip or throttle chart/table updates.

### Large files (offline analysis)

- Very large TSVs are not read entirely at once:
  - **Preview**: reads an initial chunk to estimate size and row count.
  - **Risk estimation**: decides whether **safe mode** is recommended.
  - **Safe mode**: work in **segments** (byte ranges); only needed segments load into memory.

### Visual buffer and history

- Frontend `historyCache` follows the same window as the header **Visual buffer** control (and the advanced default): time-based trimming, a sample budget scaled to those seconds, and live chart X range. The server can set an initial default via `visual_buffer_sec` in `varmon.conf` (see `docs_en/setup.md`) when the user has no saved preference.

Together, these allow many variables and high update rates without saturating the machine or network.
