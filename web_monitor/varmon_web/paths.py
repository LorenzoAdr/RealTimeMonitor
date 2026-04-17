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
        exe = os.path.abspath(sys.executable)
        bindir = os.path.dirname(exe)
        # Entrega generate_webmonitor_version: INSTALL_DIR/bin/varmonitor-web → raíz = INSTALL_DIR (hermano de data/)
        if os.path.basename(bindir) == "bin":
            return os.path.abspath(os.path.join(bindir, ".."))
        return bindir
    return None


def _resolve_data_layout(cfg: dict) -> tuple[str, str, str]:
    """Grabaciones, server_state y arinc_data (registros aviónica nombrados, hermano de recordings)."""
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

    def with_arinc(rec_dir: str, state_dir: str) -> tuple[str, str, str]:
        arinc = os.path.join(os.path.dirname(os.path.abspath(rec_dir)), "arinc_data")
        return rec_dir, state_dir, arinc

    if rec and st:
        return with_arinc(rec, st)

    if env_data:
        root = os.path.abspath(os.path.expanduser(env_data))
        if not rec:
            rec = os.path.join(root, "recordings")
        if not st:
            st = os.path.join(root, "server_state")
        return with_arinc(rec, st)

    if data_root_key:
        root = norm(data_root_key, cfg_dir)
        if not rec:
            rec = os.path.join(root, "recordings")
        if not st:
            st = os.path.join(root, "server_state")
        return with_arinc(rec, st)

    if inst:
        root = os.path.join(inst, "data")
        if not rec:
            rec = os.path.join(root, "recordings")
        if not st:
            st = os.path.join(root, "server_state")
        return with_arinc(rec, st)

    wm = web_monitor_dir()
    if not rec:
        rec = os.path.join(wm, "recordings")
    if not st:
        st = os.path.join(wm, "server_state")
    return with_arinc(rec, st)


RECORDINGS_DIR, STATE_ROOT_DIR, ARINC_DATA_DIR = _resolve_data_layout(CONFIG)
_inst = _install_dir()


def _default_browser_root() -> Path:
    return Path(_inst) if _inst else Path(__file__).resolve().parent.parent.parent


def _resolve_browser_root() -> Path:
    """Raíz del explorador de archivos / modo edición. Override: `browser_root` en varmon.conf (absoluta recomendada)."""
    raw = (CONFIG.get("browser_root") or "").strip()
    if not raw:
        return _default_browser_root()
    cfg_base = os.path.dirname(os.path.abspath(CONFIG_ABS_PATH)) if CONFIG_ABS_PATH else _repo_root()
    exp = os.path.expanduser(raw)
    if os.path.isabs(exp):
        return Path(os.path.abspath(exp))
    return Path(os.path.abspath(os.path.join(cfg_base, exp)))


BROWSER_ROOT = _resolve_browser_root()


def _resolve_git_workspace_root() -> Path:
    """Raíz para listar repos Git y operaciones git_ui; vacío en config = BROWSER_ROOT."""
    raw = (CONFIG.get("git_workspace_root") or "").strip()
    if not raw:
        return BROWSER_ROOT.resolve()
    cfg_base = os.path.dirname(os.path.abspath(CONFIG_ABS_PATH)) if CONFIG_ABS_PATH else _repo_root()
    exp = os.path.expanduser(raw)
    if os.path.isabs(exp):
        return Path(os.path.abspath(exp))
    return Path(os.path.abspath(os.path.join(cfg_base, exp)))


GIT_WORKSPACE_ROOT = _resolve_git_workspace_root()
TEMPLATES_DIR = os.path.join(STATE_ROOT_DIR, "templates")
SESSIONS_DIR = os.path.join(STATE_ROOT_DIR, "sessions")
ARINC_SQLITE_PATH = os.path.join(ARINC_DATA_DIR, "arinc_registry.sqlite")
M1553_SQLITE_PATH = os.path.join(ARINC_DATA_DIR, "m1553_registry.sqlite")
# Compat: registro único antiguo en server_state (migrar a ARINC_DATA_DIR).
AVIONICS_REGISTRY_PATH = os.path.join(STATE_ROOT_DIR, "avionics_registry.json")

print(
    f"[VarMonitor Web] Rutas datos: recordings={os.path.abspath(RECORDINGS_DIR)} | "
    f"state={os.path.abspath(STATE_ROOT_DIR)} | arinc_data={os.path.abspath(ARINC_DATA_DIR)}",
    flush=True,
)
print(
    f"[VarMonitor Web] Explorador proyecto (browser_root)={BROWSER_ROOT.resolve()} | Git (git_workspace_root)={GIT_WORKSPACE_ROOT.resolve()}",
    flush=True,
)
