"""Carga de varmon.conf, directorio estático y URL del bundle JS del cliente."""

from __future__ import annotations

import os
import sys

# PyInstaller onefile: estáticos en sys._MEIPASS
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    _WM_ROOT = sys._MEIPASS
else:
    _WM_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(_WM_ROOT, "static")


def _web_app_js_script_src() -> str:
    """Solo la URL del script (sin etiqueta HTML). Por defecto módulo ES entry; override con VARMON_WEB_APP_JS."""
    raw = (os.environ.get("VARMON_WEB_APP_JS") or "").strip()
    if not raw:
        return "/static/js/entry.mjs"
    if any(c in raw for c in '"<>') or ".." in raw or raw.startswith(("javascript:", "data:")):
        print("[VarMonitor Web] VARMON_WEB_APP_JS inválida; usando /static/js/entry.mjs")
        return "/static/js/entry.mjs"
    if raw.startswith("/"):
        return raw
    return "/static/" + raw.lstrip("/")


def html_main_script_tag() -> str:
    """Etiqueta <script> completa para index.html (módulo ES o clásico si es bundle IIFE)."""
    src = _web_app_js_script_src()
    # Bundles minificados (p. ej. dist/app.bundle.min.js) suelen ser IIFE, no ES module.
    if src.endswith(".mjs") or "/js/entry.mjs" in src or src.endswith("/entry.mjs"):
        return f'<script type="module" src="{src}"></script>'
    return f'<script src="{src}"></script>'


PERF_LEASE_SEC = 2.5

DEFAULTS = {
    "web_port": 8080,
    "web_port_scan_max": 10,
    "lan_ip": "",
    "bind_host": "",
    "auth_password": "",
    "cycle_interval_ms": 100,
    "update_ratio_max": 512,
    "server_state_dir": "",
    "log_buffer_size": 5000,
    "log_file_cpp": "",
    "shm_max_vars": 2048,
    "shm_parse_max_hz": 0,
    "shm_parse_hz_sidecar_recording": 30,
    "shm_sidecar_sem_drain_interval_sec": 0.2,
    "shm_queue_max_size": 512,
    "visual_buffer_sec": 10,
    "recording_backend": "python",
    "recording_sidecar_bin": "",
    "alarms_backend": "sidecar_cpp",
    "sidecar_cpu_affinity": "",
    "data_root": "",
    "recordings_dir": "",
    # Si es true: el HTML inyecta un script que borra localStorage y sessionStorage del origen antes de cargar el cliente (arranque siempre limpio).
    "web_clear_browser_storage": False,
    # Si es true: además del .parquet canónico se escribe un .tsv espejo (interoperabilidad; más disco y CPU).
    "recordings_write_tsv": False,
}

CONFIG_ABS_PATH = ""


def load_config() -> dict:
    """Read varmon.conf (key = value). No external dependencies."""
    global CONFIG_ABS_PATH
    cfg = dict(DEFAULTS)
    path = (os.environ.get("VARMON_CONFIG") or "").strip()
    if not path:
        _repo = os.path.abspath(os.path.join(_WM_ROOT, ".."))
        for candidate in (
            "varmon.conf",
            os.path.join(_repo, "data", "varmon.conf"),
            os.path.join(_repo, "varmon.conf"),
        ):
            abs_candidate = os.path.abspath(candidate)
            if os.path.isfile(abs_candidate):
                path = abs_candidate
                break
        else:
            path = "varmon.conf"
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key, val = key.strip(), val.strip()
                if key in ("web_port", "web_port_scan_max", "cycle_interval_ms", "update_ratio_max"):
                    cfg[key] = int(val)
                elif key == "log_buffer_size":
                    cfg[key] = max(100, min(50000, int(val)))
                elif key == "shm_max_vars":
                    cfg[key] = max(64, min(100000, int(val)))
                elif key == "shm_parse_max_hz":
                    cfg[key] = max(0.0, min(5000.0, float(val)))
                elif key == "shm_parse_hz_sidecar_recording":
                    cfg[key] = max(0.0, min(500.0, float(val)))
                elif key == "shm_sidecar_sem_drain_interval_sec":
                    cfg[key] = max(0.05, min(5.0, float(val)))
                elif key == "shm_queue_max_size":
                    cfg[key] = max(0, min(100000, int(val)))
                elif key == "visual_buffer_sec":
                    cfg[key] = max(1, min(7200, int(val)))
                elif key in (
                    "lan_ip",
                    "bind_host",
                    "auth_password",
                    "server_state_dir",
                    "data_root",
                    "recordings_dir",
                    "log_file_cpp",
                    "recording_backend",
                    "recording_sidecar_bin",
                    "alarms_backend",
                    "sidecar_cpu_affinity",
                ):
                    cfg[key] = val
                elif key == "web_clear_browser_storage":
                    cfg[key] = val.strip().lower() in ("1", "true", "yes", "on")
                elif key == "recordings_write_tsv":
                    cfg[key] = val.strip().lower() in ("1", "true", "yes", "on")
        CONFIG_ABS_PATH = os.path.abspath(path)
        print(f"[VarMonitor Web] Config cargada desde {CONFIG_ABS_PATH}")
        if cfg.get("web_clear_browser_storage"):
            print(
                "[VarMonitor Web] web_clear_browser_storage=1: cada GET / borrará localStorage y sessionStorage del navegador para este origen (antes del JS)."
            )
        if (cfg.get("auth_password") or "").strip():
            print("[VarMonitor Web] Auth: activada (se requiere contraseña en el WebSocket)")
        else:
            print("[VarMonitor Web] Auth: desactivada")
    except FileNotFoundError:
        CONFIG_ABS_PATH = os.path.abspath(path)
        print("[VarMonitor Web] AVISO: No se encontro el archivo de configuracion.")
        print(f"  Buscado en: {os.path.abspath(path)}")
        print(f"  Usando valores por defecto (web_port={cfg['web_port']})")
        print("  Para cambiar la ruta:")
        print("    - Variable de entorno: VARMON_CONFIG=/ruta/a/varmon.conf")
        print("    - Colocar varmon.conf en el directorio de trabajo actual")
        print("    - O en <repo>/data/varmon.conf (desarrollo)")
        if getattr(sys, "frozen", False):
            print(
                "  Ejecutable empaquetado: coloca varmon.conf junto al ejecutable o "
                "export VARMON_CONFIG=/ruta/absoluta/varmon.conf"
            )
    return cfg


CONFIG = load_config()
