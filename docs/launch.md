# Lanzadores (VarMonitor)

Contenido alineado con **[scripts/LAUNCH.md](../scripts/LAUNCH.md)**.

Solo hay **cinco** `.sh` en la raíz de `scripts/`; el resto vive en **`scripts/varmon/`** (setup, Docker, PyInstaller, módulos Python).

## Scripts principales

| Script | Rol |
|--------|-----|
| `./scripts/launch_demo.sh` | Solo **demo_server** (C++). |
| `./scripts/launch_web.sh` | Solo **backend web** (venv + `app.py` o `VARMON_PACKAGED_WEB_BIN`). |
| `./scripts/launch_ui.sh` | Solo **interfaz**: elige el **puerto más alto** del rango en `varmon.conf` que responda y abre pywebview o el navegador. |
| `./scripts/stop_varmonitor.sh` | Detiene procesos VarMonitor del **usuario actual** (ver `scripts/LAUNCH.md`). |
| `./scripts/build_docs_pdf.sh` | Genera **PDF** del nav MkDocs en `dist-docs/pdf/`. |

**`VARMON_CONFIG`:** ruta al `varmon.conf` para el backend (Python o binario); si no está, se usa la búsqueda habitual. Ver `LAUNCH.md`.

## Orden típico

1. `launch_demo.sh` (o tu binario con VarMonitor).
2. `launch_web.sh`.
3. `launch_ui.sh`.

## Respaldo local `scripts/_legacy_launch/`

Carpeta **gitignored** para copias de lanzadores antiguos; no se sube al remoto. Ver `scripts/LAUNCH.md`.
