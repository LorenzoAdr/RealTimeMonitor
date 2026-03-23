"""Lectura mínima de varmon.conf (web_port, web_port_scan_max) para scripts de lanzamiento."""
from __future__ import annotations

import os
from pathlib import Path

DEFAULT_WEB_PORT = 8080
DEFAULT_SCAN_MAX = 10


def resolve_varmon_config_path(root: Path) -> Path:
    """
    Alineado con app.py: si existe VARMON_CONFIG, esa ruta tiene prioridad (aunque el fichero aún no exista).
    Si no, ./varmon.conf en cwd, luego <raíz-repo>/data/varmon.conf, luego <raíz-repo>/varmon.conf.
    """
    env = os.environ.get("VARMON_CONFIG", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    for candidate in (Path.cwd() / "varmon.conf", root / "data" / "varmon.conf", root / "varmon.conf"):
        try:
            abs_c = candidate.resolve()
        except OSError:
            continue
        if abs_c.is_file():
            return abs_c
    return (root / "data" / "varmon.conf").resolve()


def read_web_port_settings(config_path: Path) -> tuple[int, int]:
    """Devuelve (web_port, web_port_scan_max) con el mismo criterio que app.py."""
    base = DEFAULT_WEB_PORT
    scan_max = DEFAULT_SCAN_MAX
    if not config_path.is_file():
        return base, scan_max
    try:
        with open(config_path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key, val = key.strip(), val.strip()
                if key == "web_port":
                    base = max(1, min(65535, int(val)))
                elif key == "web_port_scan_max":
                    scan_max = max(0, min(1000, int(val)))
    except (OSError, ValueError):
        pass
    return base, scan_max
