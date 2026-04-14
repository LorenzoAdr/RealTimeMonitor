#!/usr/bin/env python3
"""
Abre la UI (navegador / pywebview) apuntando al monitor web ya en marcha.

Escanea el rango [web_port, web_port + web_port_scan_max] del varmon.conf
(de mayor a menor puerto) y usa el **primero** que responda a GET /api/uptime
(es decir, el puerto más alto ocupado por una instancia VarMonitor).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

ROOT = Path(__file__).resolve().parent.parent.parent

from varmon_browser import open_varmonitor_ui
from varmon_config import read_web_port_settings, resolve_varmon_config_path


def _resolve_actual_web_port(port: int) -> int:
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/uptime")
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            data = json.loads(resp.read().decode())
        ap = data.get("actual_web_port")
        if isinstance(ap, int) and 1 <= ap <= 65535:
            return ap
    except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError, TypeError):
        pass
    return port


def _port_responds(port: int) -> bool:
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/uptime")
        with urllib.request.urlopen(req, timeout=0.5) as resp:
            return resp.status == 200
    except (OSError, urllib.error.URLError, ValueError):
        return False


def find_highest_varmonitor_port(base: int, scan_max: int) -> int | None:
    """Puerto más alto del rango con backend VarMonitor respondiendo."""
    for offset in range(scan_max, -1, -1):
        port = base + offset
        if _port_responds(port):
            return _resolve_actual_web_port(port)
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Abrir UI VarMonitor en el puerto detectado.")
    ap.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Ruta a varmon.conf (por defecto: VARMON_CONFIG o búsqueda estándar)",
    )
    args = ap.parse_args()
    if args.config:
        os.environ["VARMON_CONFIG"] = str(args.config.resolve())

    cfg_path = resolve_varmon_config_path(ROOT)
    base, scan_max = read_web_port_settings(cfg_path)
    print(f"[launch_ui] Rango: {base}…{base + scan_max} (desde {cfg_path})", flush=True)

    if (os.environ.get("VARMON_WEB_APP_JS") or "").strip():
        print(
            "[launch_ui] Nota: VARMON_WEB_APP_JS solo la usa el servidor web; "
            "arráncalo con el mismo valor (p. ej. ./scripts/launch_web.sh --web-app-js …).",
            flush=True,
        )

    port = find_highest_varmonitor_port(base, scan_max)
    if port is None:
        print(
            f"[launch_ui] No hay ningún VarMonitor web respondiendo en {base}–{base + scan_max}. "
            "Arranca antes: ./scripts/launch_web.sh (o el binario empaquetado).",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"[launch_ui] Usando puerto {port}", flush=True)
    open_varmonitor_ui(port)


if __name__ == "__main__":
    main()
