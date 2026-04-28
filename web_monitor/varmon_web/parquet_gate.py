"""Comprobación ligera de grabación Parquet (sin importar implementación Pro)."""

from __future__ import annotations

from typing import Any


def parquet_recording_enabled() -> bool:
    """True si la config lo permite, el plugin `parquet` está registrado y pyarrow existe."""
    from varmon_web.settings import CONFIG

    if not bool(CONFIG.get("parquet_recording_allowed")):
        return False
    import plugin_registry

    if not plugin_registry.has_plugin("parquet"):
        return False
    try:
        import pyarrow  # noqa: F401
    except ImportError:
        return False
    return True


def parquet_capability_status() -> dict[str, Any]:
    """Diagnóstico para `/api/connection_info` o soporte (por qué Parquet no está activo)."""
    from varmon_web.parquet_dispatch import get_recordings_parquet
    from varmon_web.settings import CONFIG

    import plugin_registry

    blockers: list[str] = []
    if not bool(CONFIG.get("parquet_recording_allowed")):
        blockers.append("parquet_recording_allowed=false en varmon.conf")
    if not plugin_registry.has_plugin("parquet"):
        blockers.append("plugin 'parquet' no registrado (¿pip install -e tool_plugins/python falló o otro venv?)")
    py_ok = False
    try:
        import pyarrow  # noqa: F401

        py_ok = True
    except ImportError:
        blockers.append("pyarrow no importable (pip install pyarrow)")
    rp = get_recordings_parquet()
    if rp is None:
        blockers.append(
            "Falta varmonitor_plugins.recordings_parquet. Suele haber dos pip (varmonitor-plugins + varmonitor-pro). "
            "pip uninstall -y varmonitor-plugins varmonitor-pro && pip install -e ../tool_plugins/python "
            "o reinstale la wheel desde la GUI (build)."
        )
    gate = parquet_recording_enabled()
    return {
        "gate_enabled": gate,
        "recordings_parquet_module": rp is not None,
        "pyarrow_ok": py_ok,
        "blockers": blockers,
    }
