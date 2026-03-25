"""Descubrimiento de sockets UDS VarMonitor en /tmp."""

from __future__ import annotations

import glob
import os

from uds_client import UdsBridge


def _list_uds_instances(user_filter: str | None) -> list[dict]:
    """Lista instancias VarMonitor por UDS en /tmp (varmon-*.sock). Orden: más reciente primero (mtime)."""
    candidates: list[tuple[float, dict]] = []
    try:
        pattern = f"/tmp/varmon-{user_filter}-*.sock" if user_filter else "/tmp/varmon-*.sock"
        paths = glob.glob(pattern)
        path_mtimes: list[tuple[float, str]] = []
        for path in paths:
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                mtime = 0.0
            path_mtimes.append((mtime, path))
        # Probar primero los sockets más recientes: suele haber uno vivo y evita esperar timeouts
        # en ficheros basura antiguos antes de llegar al proceso actual.
        path_mtimes.sort(key=lambda x: -x[0])
        _probe_timeout = 0.25
        for mtime, path in path_mtimes:
            try:
                b = UdsBridge(path, timeout=_probe_timeout)
                info = b.get_server_info()
                b.disconnect()
            except Exception:
                continue
            if not info:
                continue
            name = path.rsplit("/", 1)[-1].replace(".sock", "")
            parts = name.split("-", 2)  # varmon, user, pid
            pid = int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else None
            candidates.append((mtime, {
                "uds_path": path,
                "pid": pid,
                "uptime_seconds": info.get("uptime_seconds"),
                "user": parts[1] if len(parts) >= 2 else None,
            }))
        candidates.sort(key=lambda x: -x[0])
        return [d for _, d in candidates]
    except Exception:
        pass
    return []


def _first_uds_bridge() -> UdsBridge | None:
    """Primera instancia UDS disponible. None si no hay ninguna."""
    inst = _list_uds_instances(None)
    if not inst:
        return None
    try:
        return UdsBridge(inst[0]["uds_path"], timeout=3.0)
    except Exception:
        return None
