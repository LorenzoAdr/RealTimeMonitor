# Docker

The web backend (FastAPI + static files) can run in a container. There are **two modes** depending on whether you need to talk to the **host C++ process** (UDS + shared memory).

## Bridge mode (recommended for offline analysis without host C++)

From the repository root:

```bash
docker compose up --build
# or:
./scripts/varmon/docker-run.sh
```

- Open **http://localhost:8080** (or the port printed in the log if autodiscovery is used).
- The repo file `data/varmon.conf` is mounted read-only.
- **`web_monitor/recordings`** on the host is mounted into the container for persistence.

## Host mode (Linux: live with C++ on the same machine)

The container shares the host network and IPC namespace so it sees the same **Unix sockets under `/tmp`** and **shm** as the C++ process.

```bash
docker compose -f docker-compose.host.yml up --build
# or:
./scripts/varmon/docker-run.sh host
```

Then open **http://127.0.0.1:&lt;web_port&gt;** (default `8080` from `varmon.conf`).

**Requirements:** Linux (behaviour differs on Docker Desktop for macOS/Windows). The C++ binary and Python backend must share the same SHM configuration (`varmon.conf`).

**Security:** Mounting host `/tmp` into the container exposes those files to the container; use only in dev or trusted environments.

## Environment

| Variable | Description |
|----------|-------------|
| `VARMON_CONFIG` | Path to `varmon.conf` (compose sets `/app/varmon.conf`). |

## Limitations

- **Sidecar / native recording**: `varmon_sidecar` is not in the default image; recording usually needs the native stack or an extended image with the binary and deps.
- **Optional Pro package (`varmonitor_plugins`)**: the minimal image (`requirements-docker.txt`) does not install the editable wheel; Pro routes (ARINC/MIL-1553 registries, server-side Parquet, Git UI, terminal, GDB) are only available if you add `pip install` of `tool_plugins/python` in a derived image (see [Backend (Python)](backend.md)).
- **Non-8080 port:** if the backend picks another port, the `Dockerfile` `HEALTHCHECK` may fail; adjust or remove `HEALTHCHECK` in a derived image.

## Image

`web_monitor/Dockerfile` installs only **`requirements-docker.txt`** (FastAPI, uvicorn, websockets; not MkDocs or PySide6 / `requirements-desktop.txt`). Open a browser on the **host** pointing at the service URL; you **do not** need Chromium/Firefox inside the container.

## Embedding in another project’s Dockerfile

If this repo lives as a subfolder (submodule or copy) inside a larger project and you only need the web monitor in the same image:

1. **pip (recommended with Git submodules):** do not rely on `COPY` paths under `web_monitor/` — if someone clones without `--recurse-submodules`, those files won’t exist and the build breaks. Pin the minimal runtime **in the parent Dockerfile** (no MkDocs, no desktop stack):

   ```dockerfile
   RUN pip install --no-cache-dir \
       "fastapi>=0.104.0" \
       "uvicorn[standard]>=0.24.0" \
       "websockets>=12.0"
   ```

   After bumping the monitor submodule, keep these lines in sync with `web_monitor/requirements-docker.txt` in this repo (that file is the version reference).

   **Alternative** (only if `web_monitor/` is always in the build context, e.g. after `git submodule update --init`):

   ```dockerfile
   COPY web_monitor/requirements-docker.txt /tmp/requirements-varmon.txt
   RUN pip install --no-cache-dir -r /tmp/requirements-varmon.txt
   ```

2. **Do not** install `requirements-desktop.txt` in the image unless you have a real GUI stack (DISPLAY, etc.); embedded-window mode is not the usual path in Docker.

3. **apt:** `python:*-slim` + pip wheels are usually enough for FastAPI/uvicorn/websockets. Add `build-essential` / `gcc` only if a future dependency lacks a wheel and builds from source.

4. **Run:** `WORKDIR` where `app.py` lives and `CMD`/`ENTRYPOINT` equivalent to `python app.py`. **Expose** the port (`EXPOSE` / `-p`) and open `http://localhost:<port>` from the **host** browser (or the host’s IP on the LAN).

5. **Live with host C++ (Linux):** same pattern as [Host mode](#host-mode-linux-live-with-c-on-the-same-machine): `network_mode: host`, `ipc: host`, mount `/tmp`, and align `varmon.conf` with the native binary.
