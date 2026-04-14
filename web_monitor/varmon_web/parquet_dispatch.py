"""Acceso perezoso al módulo `recordings_parquet` del paquete Pro `varmonitor_plugins`."""

from __future__ import annotations

from typing import Any


def get_recordings_parquet() -> Any | None:
    """Devuelve el módulo `varmonitor_plugins.recordings_parquet` o None si no hay wheel."""
    try:
        from varmonitor_plugins import recordings_parquet as rp

        return rp
    except ImportError:
        return None


def is_parquet_path(path: str) -> bool:
    """True si la ruta parece un fichero Parquet (misma heurística que el módulo Pro)."""
    return str(path).lower().endswith(".parquet")
