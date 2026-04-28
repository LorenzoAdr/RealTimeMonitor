"""Sistema de plugins para VarMonitor — permite extender el core con funcionalidad adicional.

Uso desde un plugin Python empaquetado (p. ej. el wheel de módulos externos):
    def register(reg_hook):
        reg_hook("on_recording_start", my_on_recording_start)
        reg_hook("register_api_routes", my_register_api_routes)
        ...

Uso desde el core (app.py):
    from plugin_registry import fire_hook, get_registered_plugin_ids, discover_plugins
    discover_plugins()
    fire_hook("on_recording_start", snapshot, var_names)
"""

from __future__ import annotations

import logging
from typing import Any, Callable

logger = logging.getLogger("varmon.plugins")

_hooks: dict[str, list[Callable]] = {}
_plugins: dict[str, dict[str, Any]] = {}

# ── Registro ──

def register_hook(name: str, fn: Callable) -> None:
    """Registra un callback para un hook. Puede haber múltiples callbacks por hook."""
    _hooks.setdefault(name, []).append(fn)


def register_plugin(plugin_id: str, meta: dict[str, Any] | None = None) -> None:
    """Registra un plugin por su ID (p.ej. 'arinc', 'parquet'). Meta es info opcional."""
    _plugins[plugin_id] = meta or {}
    logger.info("Plugin registrado: %s", plugin_id)


# ── Ejecución ──

def fire_hook(name: str, *args: Any, **kwargs: Any) -> list[Any]:
    """Ejecuta todos los callbacks registrados para un hook. Devuelve lista de resultados."""
    results = []
    for fn in _hooks.get(name, []):
        try:
            results.append(fn(*args, **kwargs))
        except Exception:
            logger.exception("Error en hook %s (%s)", name, fn)
    return results


def fire_hook_chain(name: str, value: Any, *args: Any, **kwargs: Any) -> Any:
    """Ejecuta callbacks en cadena: cada uno recibe el resultado del anterior.
    Útil para hooks de transformación (p.ej. format_value, extend_connection_info).
    """
    for fn in _hooks.get(name, []):
        try:
            result = fn(value, *args, **kwargs)
            if result is not None:
                value = result
        except Exception:
            logger.exception("Error en hook chain %s (%s)", name, fn)
    return value


# ── Consulta ──

def has_plugin(plugin_id: str) -> bool:
    """Devuelve True si un plugin está registrado."""
    return plugin_id in _plugins


def get_registered_plugin_ids() -> list[str]:
    """Devuelve la lista de IDs de plugins registrados."""
    return sorted(_plugins.keys())


def get_plugin_meta(plugin_id: str) -> dict[str, Any] | None:
    """Devuelve la meta info de un plugin, o None si no está registrado."""
    return _plugins.get(plugin_id)


def get_hooks() -> dict[str, int]:
    """Devuelve un resumen de hooks registrados (nombre → nº de callbacks)."""
    return {name: len(fns) for name, fns in _hooks.items() if fns}


# ── Descubrimiento ──

def discover_plugins() -> None:
    """Intenta importar plugins conocidos. Si no están instalados, se ignora.

    Busca: varmonitor_plugins (wheel instalado) o varmonitor_plugins_stub (desarrollo local).
    En el futuro se puede extender a entry_points o un directorio plugins/.
    """
    _try_load_varmonitor_plugins()


def _try_load_varmonitor_plugins() -> None:
    for module_name in ("varmonitor_plugins", "varmonitor_plugins_stub"):
        try:
            mod = __import__(module_name)
            if hasattr(mod, "register"):
                mod.register(register_hook, register_plugin)
                logger.info("%s cargado correctamente", module_name)
                return
            else:
                logger.warning("%s importado pero sin función register()", module_name)
        except ImportError:
            continue
        except Exception:
            logger.exception("Error al cargar %s", module_name)


# ── Reset (para tests) ──

def _reset() -> None:
    """Limpia todo el estado de plugins y hooks (solo para tests)."""
    _hooks.clear()
    _plugins.clear()
