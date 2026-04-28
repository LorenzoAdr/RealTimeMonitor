"""Stub cuando no hay wheel `varmonitor_plugins` instalada.

El núcleo MIT solo descubre plugins opcionales; sin instalar el paquete Pro
(`pip install -e tool_plugins/python` o wheel), no hay IDs ni rutas extra.

Para desarrollo local con plugins embebidos en el stub (solo si hace falta):
  export VARMON_PLUGIN_STUB_FULL=1
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("varmon.plugins_stub")

_FULL = (os.environ.get("VARMON_PLUGIN_STUB_FULL") or "").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)


def register(register_hook, register_plugin):
    if not _FULL:
        return

    register_plugin("arinc", {"version": "dev", "source": "stub"})
    register_plugin("anomaly", {"version": "dev", "source": "stub"})
    register_plugin("segments", {"version": "dev", "source": "stub"})
    register_plugin("parquet", {"version": "dev", "source": "stub"})
    register_plugin("replay_ref_alarms", {"version": "dev", "source": "stub"})
    register_plugin("flight_viz", {"version": "0.1.0", "source": "stub"})

    register_hook("html_extra_scripts", _html_extra_scripts)


def _html_extra_scripts():
    return '<script type="module" src="/static/plugins/plugins-loader.mjs"></script>'
