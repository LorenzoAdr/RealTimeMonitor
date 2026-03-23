# VarMonitor

Real-time variable monitoring for C++20 applications. Communication between your C++ app and the web monitor uses **Unix Domain Sockets (UDS)** and **shared memory (SHM)** with POSIX semaphores.

**Source code**: [VarMonitor on GitHub](https://github.com/LorenzoAdr/RealTimeMonitor).

## What you will find in this documentation

- **[Architecture](architecture.md)**: Components (C++, Python, frontend), data flow, visual vs internal rates.
- **[Installation and configuration](setup.md)**: Requirements, quick install, `varmon.conf`.
- **[Launch scripts](launch.md)**: `launch_demo`, `launch_web`, `launch_ui`; local backup under `scripts/_legacy_launch/`.
- **[Docker](docker.md)**: Web monitor container (bridge or host mode for C++ on the same Linux host).
- **[Backend (Python)](backend.md)**: `app.py`, instance discovery, WebSocket, UdsBridge, ShmReader, alarms and recording.
- **[Frontend](frontend.md)**: `app.js` structure, columns, Plotly charts, state and persistence.
- **[Protocols](protocols.md)**: UDS format (length + JSON), commands, SHM layout, WebSocket messages.
- **[Performance](performance.md)**: SHM/UDS, Perf panel, `/api/perf`, native recording sidecar optimizations.
- **[C++ integration](cpp-integration.md)**: Linking `libvarmonitor`, VarMonitor, `write_shm_snapshot`, macros.
- **[Troubleshooting](troubleshooting.md)**: WSL/semaphores, connection issues, empty charts, etc.

## Quick links

- [VarMonitor on GitHub](https://github.com/LorenzoAdr/RealTimeMonitor) — source, issues and contributions.
- The repository [README](../README.md) has a project overview and layout.
- To build and view this documentation locally: `mkdocs serve -f mkdocs.en.yml` (from the repo root) and open `http://localhost:8000`.
