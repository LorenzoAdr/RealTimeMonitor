# Packaged binary (PyInstaller)

On machines where you **cannot install** Python dependencies with `pip`, you can build a **single executable** that bundles the interpreter and libraries (`fastapi`, `uvicorn`, static assets, etc.).

## Requirements

- **Build machine only:** Python 3.12+ (recommended), `python3-venv` if your distro requires it.
- Build for the **same OS/arch** as the target (e.g. Linux x86_64 → Linux x86_64). Test if you target older glibc.

## Build

From the repository root:

```bash
chmod +x scripts/varmon/build_varmonitor_web.sh
./scripts/varmon/build_varmonitor_web.sh
```

Output: `web_monitor/dist/varmonitor-web` (console, onefile).

The script creates `web_monitor/.venv-build/`, installs `requirements-docker.txt` + `requirements-build.txt`, and runs PyInstaller with `web_monitor/varmonitor-web.spec`.

## Running on the target

- Copy the executable (and optionally `varmon.conf` next to it, or set `VARMON_CONFIG`).
- Run: `./varmonitor-web` (no system Python needed).
- Open the browser at the URL printed on startup (port from `varmon.conf` / autodiscovery).

## Launch with browser (PyInstaller)

After building the binary, on a machine that **does** have `python3` for the launcher scripts (and optionally `requirements-desktop.txt` for the embedded window):

```bash
export VARMON_PACKAGED_WEB_BIN="$PWD/web_monitor/dist/varmonitor-web"
./scripts/launch_web.sh      # packaged backend only
./scripts/launch_ui.sh       # pywebview / system browser on detected port
```

See **[scripts/LAUNCH.md](../scripts/LAUNCH.md)** for the full flow (`launch_demo` / `launch_web` / `launch_ui`).

## Delivery bundle (`web_monitor_version/`)

To build minified JS (if `npx` is available), `varmon_sidecar`, and the PyInstaller binary in one step and copy them to `web_monitor_version/`:

```bash
chmod +x scripts/varmon/generate_webmonitor_version.sh
./scripts/varmon/generate_webmonitor_version.sh
```

Optional: `VARMON_SKIP_JS=1` if Node is unavailable; `VARMON_BUILD_DIR` for the CMake build directory (default `build/`).

On the target system, place `varmonitor-web`, `varmon_sidecar`, and `varmon.conf` in the same install directory. By default, recordings and state go to `INSTALL_DIR/data/recordings/` and `INSTALL_DIR/data/server_state/` (override with `VARMON_DATA_DIR` or keys in `varmon.conf`).

## Notes

- **Onefile** extracts to a temp directory at startup; first launch may be slightly slower.
- Native helpers like **`varmon_sidecar`** are **not** bundled inside the Python executable; ship them next to the binary and point paths in `varmon.conf`.
- If startup fails with a missing module, add it to `hiddenimports` in `varmonitor-web.spec` and rebuild.
