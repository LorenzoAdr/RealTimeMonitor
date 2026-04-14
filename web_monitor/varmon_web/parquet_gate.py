"""Comprobación ligera de grabación Parquet (sin importar implementación Pro)."""

from __future__ import annotations


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
