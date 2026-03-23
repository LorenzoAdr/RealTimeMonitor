# Launch scripts (VarMonitor)

Same content as **[scripts/LAUNCH.md](../scripts/LAUNCH.md)**.

There are only **five** `.sh` files under `scripts/`; helpers live in **`scripts/varmon/`** (setup, Docker, PyInstaller, Python modules).

## Main scripts

| Script | Role |
|--------|------|
| `./scripts/launch_demo.sh` | **demo_server** (C++) only. |
| `./scripts/launch_web.sh` | **Web backend** only (venv + `app.py` or `VARMON_PACKAGED_WEB_BIN`). |
| `./scripts/launch_ui.sh` | **UI** only: picks the **highest** port in the `varmon.conf` range that responds, then opens pywebview or the system browser. |
| `./scripts/stop_varmonitor.sh` | Stops VarMonitor processes for the **current user** (see `scripts/LAUNCH.md`). |
| `./scripts/build_docs_pdf.sh` | Builds **PDF** from MkDocs nav into `dist-docs/pdf/`. |

**`VARMON_CONFIG`:** path to `varmon.conf` for the backend (Python or packaged binary); if unset, the usual search applies. See `LAUNCH.md`.

## Typical order

1. `launch_demo.sh` (or your VarMonitor-linked binary).
2. `launch_web.sh`.
3. `launch_ui.sh`.

## Local backup `scripts/_legacy_launch/`

**Gitignored** folder for old launcher copies; not pushed to the remote. See `scripts/LAUNCH.md`.
