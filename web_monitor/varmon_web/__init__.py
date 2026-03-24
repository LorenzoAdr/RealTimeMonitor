"""Submódulos del backend VarMonitor (configuración, rutas, helpers)."""

from .settings import (
    CONFIG,
    CONFIG_ABS_PATH,
    DEFAULTS,
    PERF_LEASE_SEC,
    STATIC_DIR,
    html_main_script_tag,
    load_config,
    _web_app_js_script_src,
)

__all__ = [
    "CONFIG",
    "CONFIG_ABS_PATH",
    "DEFAULTS",
    "PERF_LEASE_SEC",
    "STATIC_DIR",
    "html_main_script_tag",
    "load_config",
    "_web_app_js_script_src",
]
