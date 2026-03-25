"""Rutas de grabaciones, plantillas, sesiones y navegador de proyecto."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .settings import CONFIG, CONFIG_ABS_PATH


def web_monitor_dir() -> str:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return sys._MEIPASS
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _repo_root() -> str:
    return os.path.abspath(os.path.join(web_monitor_dir(), ".."))


def _install_dir() -> str | None:
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return None


def _resolve_data_layout(cfg: dict) -> tuple[str, str]:
    """Grabaciones y server_state: desarrollo → web_monitor/…; frozen → INSTALL_DIR/data/… salvo override."""
    cfg_dir = os.path.dirname(os.path.abspath(CONFIG_ABS_PATH)) if CONFIG_ABS_PATH else _repo_root()
    inst = _install_dir()
    env_data = (os.environ.get("VARMON_DATA_DIR") or "").strip()
    rec_key = (cfg.get("recordings_dir") or "").strip()
    st_key = (cfg.get("server_state_dir") or "").strip()
    data_root_key = (cfg.get("data_root") or "").strip()

    def norm(p: str, base: str) -> str:
        p = os.path.expanduser(p)
        if not p:
            return ""
        if os.path.isabs(p):
            return os.path.abspath(p)
        return os.path.abspath(os.path.join(base, p))

    rec = norm(rec_key, cfg_dir) if rec_key else ""
    st = norm(st_key, cfg_dir) if st_key else ""

    if rec and st:
        return rec, st

    if env_data:
        root = os.path.abspath(os.path.expanduser(env_data))
        if not rec:
            rec = os.path.join(root, "recordings")
        if not st:
            st = os.path.join(root, "server_state")
        return rec, st

    if data_root_key:
        root = norm(data_root_key, cfg_dir)
        if not rec:
            rec = os.path.join(root, "recordings")
        if not st:
            st = os.path.join(root, "server_state")
        return rec, st

    if inst:
        root = os.path.join(inst, "data")
        if not rec:
            rec = os.path.join(root, "recordings")
        if not st:
            st = os.path.join(root, "server_state")
        return rec, st

    wm = web_monitor_dir()
    if not rec:
        rec = os.path.join(wm, "recordings")
    if not st:
        st = os.path.join(wm, "server_state")
    return rec, st


RECORDINGS_DIR, STATE_ROOT_DIR = _resolve_data_layout(CONFIG)
_inst = _install_dir()
BROWSER_ROOT = Path(_inst) if _inst else Path(__file__).resolve().parent.parent.parent
TEMPLATES_DIR = os.path.join(STATE_ROOT_DIR, "templates")
SESSIONS_DIR = os.path.join(STATE_ROOT_DIR, "sessions")
# Registro aviónica importado (JSON); el cliente puede guardar/cargar vía API.
AVIONICS_REGISTRY_PATH = os.path.join(STATE_ROOT_DIR, "avionics_registry.json")

print(
    f"[VarMonitor Web] Rutas datos: recordings={os.path.abspath(RECORDINGS_DIR)} | state={os.path.abspath(STATE_ROOT_DIR)}",
    flush=True,
)
