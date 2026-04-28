"""Acceso perezoso al módulo `recordings_parquet` del paquete Pro `varmonitor_plugins`."""

from __future__ import annotations

import importlib
import importlib.util
import logging
from typing import Any

logger = logging.getLogger("varmon.parquet")

_recordings_parquet_import_error_logged = False


def _hint_recordings_parquet_missing() -> str:
    """Mensaje si hay un varmonitor_plugins incompleto (p. ej. wheel antigua en site-packages)."""
    return (
        "Desinstale todas las distribuciones que aportan el mismo paquete y vuelva a instalar una sola: "
        "pip uninstall -y varmonitor-plugins varmonitor-pro  "
        "&& pip install -e ../tool_plugins/python   "
        "(o la wheel recién generada en tool_plugins/dist)."
    )


def get_recordings_parquet() -> Any | None:
    """Devuelve el módulo `varmonitor_plugins.recordings_parquet` o None si no está instalado."""
    global _recordings_parquet_import_error_logged
    spec = importlib.util.find_spec("varmonitor_plugins.recordings_parquet")
    if spec is None:
        if not _recordings_parquet_import_error_logged:
            _recordings_parquet_import_error_logged = True
            pkg = importlib.util.find_spec("varmonitor_plugins")
            if pkg is None:
                logger.warning(
                    "No está instalado el paquete varmonitor_plugins. "
                    "Desde web_monitor/:  pip install -e ../tool_plugins/python"
                )
            else:
                logger.warning(
                    "varmonitor_plugins está instalado pero falta recordings_parquet. "
                    "Causa frecuente: conviven dos paquetes pip (p. ej. varmonitor-plugins + varmonitor-pro). %s",
                    _hint_recordings_parquet_missing(),
                )
        return None
    try:
        return importlib.import_module("varmonitor_plugins.recordings_parquet")
    except ImportError as e:
        if not _recordings_parquet_import_error_logged:
            _recordings_parquet_import_error_logged = True
            logger.warning(
                "Error al cargar varmonitor_plugins.recordings_parquet: %s. %s",
                e,
                _hint_recordings_parquet_missing(),
            )
        return None


def is_parquet_path(path: str) -> bool:
    """True si la ruta parece un fichero Parquet (misma heurística que el módulo Pro)."""
    return str(path).lower().endswith(".parquet")
