#!/usr/bin/env python3
"""
Interfaz gráfica ligera: selección de plugins (plugin-selection.json), build y empaquetado.

Tras cada build_all.sh exitoso se reinstala la wheel recién generada en web_monitor/.venv
(python -m pip install --force-reinstall --no-cache-dir) para que el backend local no use un
varmonitor_plugins antiguo de site-packages.

Opción «Generar entrega final»: si está desmarcada, solo se ejecuta build_all.sh (wheel + JS);
no se llama a generate_webmonitor_version.sh (CMake, PyInstaller, carpeta web_monitor_version/).

Limpieza de web_monitor/static/ antes de build_all.sh (evita assets obsoletos en modo code):
- Por defecto: vaciar static/plugins y static/dist (mantiene static/js/modules canónico).
- Opcional (checkbox): solicitar borrado total (usa limpieza segura salvo FORCE; véase tool_plugins/scripts/build_all.sh).

El núcleo OSS (index.html, js/entry.mjs, js/app-legacy.mjs, CSS) no lo genera el build de plugins.
Tras copy_to_mit se ejecuta scripts/varmon/sync_oss_web_client.sh: si existe web_monitor/client_oss/
con esos ficheros, se copian sobre static/. Véase web_monitor/client_oss/README.txt.

Checkboxes opcionales «Compilar demo_server / corenexus»: solo aplican a la entrega final;
activan VARMON_BUILD_DEMO_SERVER / VARMON_BUILD_CORENEXUS en generate_webmonitor_version.sh
(binarios en web_monitor_version/bin/).

Si «Compilar corenexus» está marcado, antes del build se ejecuta
`pip install -r CoreNexus/requirements-mavlink.txt` en el mismo Python que `web_monitor/.venv`
(si existe) o en `python3`, para que mavgen (CMake) encuentre pymavlink.

Requisito en muchos Linux: paquete del sistema `python3-tk` (p. ej. apt install python3-tk).

Uso:
  ./scripts/varmon/launch_gui_plugins_deploy.sh
  # o: python3 scripts/varmon/gui_plugins_deploy.py
"""
from __future__ import annotations

import json
import os
import queue
import re
import socket
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

# Distribuciones pip que pueden instalar el paquete importable `varmonitor_plugins`.
# Si conviven (p. ej. varmonitor-pro + varmonitor-plugins), una puede dejar el árbol incompleto.
_KNOWN_VARMON_PLUGIN_DIST_NAMES = (
    "varmonitor-plugins",
    "varmonitor-pro",
)

try:
    import tkinter as tk
    from tkinter import messagebox, scrolledtext, ttk
except ImportError as e:
    print(
        "Error: tkinter no está disponible. En Debian/Ubuntu: sudo apt install python3-tk",
        file=sys.stderr,
    )
    print(e, file=sys.stderr)
    raise SystemExit(1) from e

# Raíz del repo: .../scripts/varmon/este_fichero.py -> parents[2]
ROOT = Path(__file__).resolve().parents[2]
TOOL_PLUGINS_BUILD_ALL = ROOT / "tool_plugins" / "scripts" / "build_all.sh"
HAS_TOOL_PLUGINS = TOOL_PLUGINS_BUILD_ALL.is_file()
# Proyecto CoreNexus opcional (CMake en subdirectorio).
HAS_CORENEXUS = (ROOT / "CoreNexus" / "CMakeLists.txt").is_file()
SELECTION_PATH = (
    ROOT / "tool_plugins" / "plugin-selection.json"
    if HAS_TOOL_PLUGINS
    else ROOT / "scripts" / "varmon" / "plugin-selection.clean.json"
)

# Paleta (fondo claro, inclusión = acento verde inequívoco)
BG_APP = "#e8edf3"
BG_CARD_OFF = "#f8fafc"
BORDER_CARD = "#d1d9e6"
ACCENT_ON = "#16a34a"
ACCENT_ON_LIGHT = "#dcfce7"
TEXT_MAIN = "#0f172a"
TEXT_MUTED = "#64748b"

DEFAULTS: dict[str, dict[str, bool]] = {
    "ids": {
        "arinc": True,
        "m1553": True,
        "replay_alias": True,
        "anomaly": True,
        "segments": True,
        "parquet": True,
        "replay_ref_alarms": True,
        "analysis_report": True,
        "mavlink_scan": True,
    },
    "hooks": {
        "arincImportValidation": True,
        "replayAlias": True,
        "m1553Api": True,
        "arincFormatExtras": True,
    },
    "ui": {
        "fileEdit": True,
        "gitWorkspace": True,
        "terminal": True,
        "flightViz": True,
        "mavlinkScan": True,
        "protocolRegistry": True,
    },
    "build": {
        "demo_server": False,
        "corenexus": False,
    },
}

LABELS: dict[str, str] = {
    "arinc": "ARINC 429 (ids)",
    "m1553": "MIL-STD-1553",
    "replay_alias": "Replay / alias de columnas",
    "anomaly": "Detección de anomalías",
    "segments": "Segmentos",
    "parquet": "Parquet (grabación / análisis)",
    "replay_ref_alarms": "Alarmas replay vs referencia",
    "analysis_report": "Informe PDF (modo análisis)",
    "mavlink_scan": "MAVLink (API escaneo / Sentinel; wheel Pro)",
    "arincImportValidation": "Validación importación ARINC tabular",
    "replayAlias": "Hook replay alias",
    "m1553Api": "Hook API MIL-STD-1553",
    "arincFormatExtras": "Formato ARINC extras (BD)",
    "fileEdit": "Editor de ficheros",
    "gitWorkspace": "Workspace Git",
    "terminal": "Terminal embebida",
    "flightViz": "Visualización de vuelo",
    "mavlinkScan": "UI SCAN MAVLink (cabecera, modal, histogramas/FFT)",
    "protocolRegistry": "BD protocolos (ARINC / 1553)",
    "demo_server": "Compilar demo_server (CMake → web_monitor_version/bin/)",
    "corenexus": "Compilar corenexus (CMake → web_monitor_version/bin/; instala pymavlink/lxml en el venv)",
}

TAB_TITLES = {"ids": "Módulos (ids)", "hooks": "Hooks", "ui": "UI"}


def _selection_base() -> dict[str, dict[str, bool]]:
    """Base de selección: con tool_plugins usa DEFAULTS; sin tool_plugins todo ids/hooks/ui en false."""
    if HAS_TOOL_PLUGINS:
        return json.loads(json.dumps(DEFAULTS))
    return {
        "ids": {k: False for k in DEFAULTS["ids"]},
        "hooks": {k: False for k in DEFAULTS["hooks"]},
        "ui": {k: False for k in DEFAULTS["ui"]},
        "build": dict(DEFAULTS["build"]),
    }


def load_selection() -> dict[str, dict[str, bool]]:
    out = _selection_base()
    if not SELECTION_PATH.is_file():
        return out
    try:
        data = json.loads(SELECTION_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return out
    # Sin árbol tool_plugins: no fusionar ids/hooks/ui desde disco (siempre false para el worker).
    merge_secs = ("ids", "hooks", "ui", "build") if HAS_TOOL_PLUGINS else ("build",)
    for sec in merge_secs:
        if isinstance(data.get(sec), dict):
            for k, v in data[sec].items():
                if k in out[sec] and isinstance(v, bool):
                    out[sec][k] = v
    return out


def _client_oss_missing_warning() -> str:
    """Texto de aviso si falta el cliente principal en static/ (no generado por build_all)."""
    entry = ROOT / "web_monitor" / "static" / "js" / "entry.mjs"
    leg = ROOT / "web_monitor" / "static" / "js" / "app-legacy.mjs"
    if entry.is_file() and leg.is_file():
        return ""
    lines = [
        "",
        "[AVISO] Falta el cliente web OSS completo en web_monitor/static/ "
        "(js/entry.mjs y/o js/app-legacy.mjs). El build de plugins no los crea.",
        "  Coloque index.html, js/entry.mjs, js/app-legacy.mjs, css/, etc. en "
        "web_monitor/client_oss/ (fuente versionada en el repo; misma estructura que static/); "
        "copy_to_mit ejecuta sync_oss_web_client.sh y los fusionará.",
        f"  Guía: {ROOT / 'web_monitor' / 'client_oss' / 'README.txt'}",
    ]
    return "\n".join(lines)


def verify_root() -> bool:
    return (ROOT / "scripts" / "varmon" / "generate_webmonitor_version.sh").is_file()


def run_bash(script_rel: str, extra_env: dict[str, str] | None = None) -> tuple[int, str]:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    cmd = ["bash", str(ROOT / script_rel)]
    r = subprocess.run(
        cmd,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        env=env,
        timeout=None,
    )
    out = (r.stdout or "") + ("\n" if r.stdout and r.stderr else "") + (r.stderr or "")
    tail = "\n".join(out.splitlines()[-50:])
    return r.returncode, tail


def _selection_wants_parquet() -> bool:
    """Lee tool_plugins/plugin-selection.json (tras guardar desde la GUI)."""
    try:
        data = json.loads(SELECTION_PATH.read_text(encoding="utf-8"))
        return bool(data.get("ids", {}).get("parquet"))
    except (OSError, json.JSONDecodeError, TypeError):
        return False


def _wheel_has_required_modules(whl: Path, *, require_parquet: bool = False) -> tuple[bool, list[str]]:
    required = {
        "varmonitor_plugins/gdb_debug.py",
        "varmonitor_plugins/terminal_api.py",
        "varmonitor_plugins/pro_http.py",
    }
    if require_parquet:
        required |= {
            "varmonitor_plugins/recordings_parquet.py",
            "varmonitor_plugins/parquet_recording.py",
        }
    try:
        with zipfile.ZipFile(whl) as zf:
            names = set(zf.namelist())
    except Exception:
        return False, ["wheel_unreadable"]
    missing = sorted(m for m in required if m not in names)
    return (len(missing) == 0), missing


def _latest_valid_dist_wheel(*, require_parquet: bool | None = None) -> tuple[Path | None, str]:
    if require_parquet is None:
        require_parquet = _selection_wants_parquet()
    dist = ROOT / "tool_plugins" / "dist"
    cands = sorted(dist.glob("varmonitor_plugins-*.whl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not cands:
        return None, f"No hay wheels en {dist}"
    for whl in cands:
        ok, missing = _wheel_has_required_modules(whl, require_parquet=require_parquet)
        if ok:
            return whl, ""
        miss = ", ".join(missing)
        print(f"[gui_plugins_deploy] wheel descartada (incompleta): {whl} | faltan: {miss}", file=sys.stderr)
    what = "gdb/terminal/pro_http"
    if require_parquet:
        what += " + Parquet (recordings_parquet, parquet_recording)"
    return None, f"Todas las wheels de tool_plugins/dist están incompletas para backend Pro ({what})."


def _site_packages_for_venv_python(py: Path) -> Path | None:
    r = subprocess.run(
        [str(py), "-c", "import site; print(site.getsitepackages()[0])"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if r.returncode != 0:
        return None
    line = (r.stdout or "").strip().splitlines()
    return Path(line[0]) if line else None


def _nuke_varmonitor_site_packages(site_pkgs: Path) -> list[str]:
    """Borra árboles de paquetes y *.dist-info de varmonitor (pip uninstall a veces deja RECORD parcial)."""
    removed: list[str] = []
    for name in ("varmonitor_plugins", "varmonitor_pro"):
        p = site_pkgs / name
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
            removed.append(str(p))
    for pat in (
        "varmonitor_plugins-*.dist-info",
        "varmonitor_pro-*.dist-info",
        "varmonitor_plugins-*.egg-info",
    ):
        for p in site_pkgs.glob(pat):
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
                removed.append(str(p))
    return removed


def _pip_uninstall_varmonitor_distributions(py: Path) -> tuple[int, str]:
    """Desinstala todas las distribuciones pip conocidas que aportan `varmonitor_plugins`.

    Usa `python -m pip` (no el ejecutable `pip`) para que el destino sea siempre el
    site-packages del intérprete indicado; con venv duplicados por ruta, `pip` suelto
    puede instalar en otro prefijo y el import falla aunque la wheel sea correcta.
    """
    chunks: list[str] = []
    for name in _KNOWN_VARMON_PLUGIN_DIST_NAMES:
        r = subprocess.run(
            [str(py), "-m", "pip", "uninstall", "-y", name],
            capture_output=True,
            text=True,
        )
        chunks.append((r.stdout or "") + (r.stderr or ""))
    return 0, "\n".join(chunks)


def _prepare_web_monitor_venv() -> tuple[int, str]:
    """Crea web_monitor/.venv si no existe e instala web_monitor/requirements.txt."""
    wm = ROOT / "web_monitor"
    req = wm / "requirements.txt"
    if not req.is_file():
        return 1, f"[gui_plugins_deploy] No existe {req}\n"
    venv_dir = wm / ".venv"
    py = venv_dir / "bin" / "python"
    if not py.is_file():
        r = subprocess.run(
            ["python3", "-m", "venv", str(venv_dir)],
            cwd=str(wm),
            capture_output=True,
            text=True,
        )
        out = (r.stdout or "") + (r.stderr or "")
        if r.returncode != 0:
            return r.returncode, f"[gui_plugins_deploy] python3 -m venv falló:\n{out[-4000:]}\n"
    pip = venv_dir / "bin" / "pip"
    if not pip.is_file():
        return 1, f"[gui_plugins_deploy] No hay pip en {pip}\n"
    _, tail_pre = _pip_uninstall_varmonitor_distributions(py)
    sp0 = _site_packages_for_venv_python(py)
    nuked_pre: list[str] = []
    if sp0:
        nuked_pre = _nuke_varmonitor_site_packages(sp0)
    r = subprocess.run(
        [str(py), "-m", "pip", "install", "-q", "-U", "pip"],
        cwd=str(wm),
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        out = (r.stdout or "") + (r.stderr or "")
        return r.returncode, f"[gui_plugins_deploy] pip -U falló:\n{out[-4000:]}\n"
    r = subprocess.run(
        [str(py), "-m", "pip", "install", "-r", str(req)],
        cwd=str(wm),
        capture_output=True,
        text=True,
    )
    out = (r.stdout or "") + ("\n" if r.stdout and r.stderr else "") + (r.stderr or "")
    tail = "\n".join(out.splitlines()[-50:])
    if r.returncode == 0:
        _, tail_un = _pip_uninstall_varmonitor_distributions(py)
        nuked_post: list[str] = []
        if sp0:
            nuked_post = _nuke_varmonitor_site_packages(sp0)
        tail = (
            "[gui_plugins_deploy] Antes de requirements: pip uninstall + borrado site-packages:\n"
            + tail_pre
            + ("\nBorrado: " + "; ".join(nuked_pre) if nuked_pre else "")
            + "\n\n"
            + tail
            + "\n\n[gui_plugins_deploy] Tras requirements: pip uninstall + borrado:\n"
            + tail_un
            + ("\nBorrado: " + "; ".join(nuked_post) if nuked_post else "")
        )
    else:
        tail = (
            "[gui_plugins_deploy] Antes de requirements: pip uninstall + borrado site-packages:\n"
            + tail_pre
            + ("\nBorrado: " + "; ".join(nuked_pre) if nuked_pre else "")
            + "\n\n"
            + tail
        )
    return r.returncode, tail


def _python_for_corenexus_mavlink_deps() -> Path | None:
    """Usar exclusivamente web_monitor/.venv para CoreNexus (evita pip en Python del sistema)."""
    v = ROOT / "web_monitor" / ".venv" / "bin" / "python"
    if v.is_file():
        return v
    env_py = os.environ.get("VARMON_PYTHON3", "").strip()
    if env_py:
        p = Path(env_py)
        if p.is_file() and "/.venv/" in str(p):
            return p
    return None


def _install_corenexus_mavlink_deps() -> tuple[int, str]:
    """Instala pymavlink/lxml para generar cabeceras MAVLink en CMake (CoreNexus)."""
    req = ROOT / "CoreNexus" / "requirements-mavlink.txt"
    if not req.is_file():
        return 1, f"[gui_plugins_deploy] No existe {req}\n"
    py = _python_for_corenexus_mavlink_deps()
    if py is None:
        return (
            1,
            "[gui_plugins_deploy] CoreNexus requiere web_monitor/.venv para instalar pymavlink/lxml "
            "(se evita pip en Python del sistema por PEP 668).\n"
            "  Cree/prepárelo con:\n"
            "    cd web_monitor && python3 -m venv .venv && . .venv/bin/activate && python -m pip install -r requirements.txt\n",
        )
    r = subprocess.run(
        [str(py), "-m", "pip", "install", "-q", "-r", str(req)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    out = (r.stdout or "") + ("\n" if r.stdout and r.stderr else "") + (r.stderr or "")
    tail = "\n".join(out.splitlines()[-40:])
    if r.returncode != 0:
        return r.returncode, (
            f"[gui_plugins_deploy] pip install CoreNexus/requirements-mavlink.txt falló ({py}):\n{tail}\n"
        )
    return 0, (
        f"[gui_plugins_deploy] Dependencias MAVLink (pymavlink/lxml) instaladas con:\n  {py}\n"
        f"  ({req.name})\n\n"
        + tail
    )


def _reinstall_fresh_wheel_into_web_venv(wheel: Path) -> tuple[int, str]:
    """Instala la wheel indicada en web_monitor/.venv (desarrollo: python app.py).

    Desinstala antes varmonitor-plugins / varmonitor-pro y borra restos incompletos para evitar
    dos distribuciones compitiendo por el mismo nombre de paquete.
    """
    py = ROOT / "web_monitor" / ".venv" / "bin" / "python"
    if not py.is_file():
        return (
            1,
            "[gui_plugins_deploy] ERROR: hace falta web_monitor/.venv (python) para reinstalar la wheel generada.\n"
            "  cd web_monitor && python3 -m venv .venv && source .venv/bin/activate && python -m pip install -r requirements.txt\n",
        )
    wheel_abs = wheel.resolve()
    if not wheel_abs.is_file():
        return 1, f"[gui_plugins_deploy] Wheel inexistente: {wheel_abs}\n"

    _, tail_un = _pip_uninstall_varmonitor_distributions(py)
    sp = _site_packages_for_venv_python(py)
    nuked: list[str] = []
    if sp:
        nuked = _nuke_varmonitor_site_packages(sp)

    r = subprocess.run(
        [
            str(py),
            "-m",
            "pip",
            "install",
            "--force-reinstall",
            "--no-cache-dir",
            str(wheel_abs),
        ],
        cwd=str(ROOT / "web_monitor"),
        capture_output=True,
        text=True,
    )
    out = (r.stdout or "") + ("\n" if r.stdout and r.stderr else "") + (r.stderr or "")
    tail = "\n".join(out.splitlines()[-40:])
    full = (
        "[gui_plugins_deploy] pip uninstall (varmonitor-plugins + varmonitor-pro):\n"
        + tail_un
        + ("\n[gui_plugins_deploy] Borrado físico en site-packages:\n" + "\n".join(nuked) if nuked else "")
        + "\n\n[gui_plugins_deploy] pip install wheel:\n"
        + tail
    )
    if r.returncode != 0:
        return r.returncode, full

    r2 = subprocess.run(
        [
            str(py),
            "-c",
            "import importlib.util as u; "
            "raise SystemExit(0 if u.find_spec('varmonitor_plugins.recordings_parquet') else 1)",
        ],
        cwd=str(ROOT / "web_monitor"),
        capture_output=True,
        text=True,
    )
    if r2.returncode != 0:
        return (
            1,
            full
            + "\n\n[gui_plugins_deploy] ERROR: con el Python del venv, recordings_parquet no importa."
            + "\nSi la wheel contiene recordings_parquet (unzip -l … | grep recordings_parquet), "
            "suele quedar un site-packages corrupto: el script ya desinstala pip y borra "
            "varmonitor_plugins/, varmonitor_pro/ y *.dist-info antes de instalar."
            + "\nCompruebe: unzip -l "
            + str(wheel_abs)
            + " | grep recordings_parquet\n",
        )
    return 0, full


def _ensure_shipped_conf_parquet_enabled() -> None:
    """Si la entrega incluye Parquet, activa parquet_recording_allowed en data/varmon.conf empaquetado."""
    cfg_path = ROOT / "web_monitor_version" / "data" / "varmon.conf"
    if not cfg_path.is_file() or not _selection_wants_parquet():
        return
    text = cfg_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    out: list[str] = []
    replaced = False
    for ln in lines:
        if re.match(r"^\s*parquet_recording_allowed\s*=", ln):
            out.append("parquet_recording_allowed = true")
            replaced = True
        else:
            out.append(ln)
    if not replaced:
        out.append("parquet_recording_allowed = true")
    cfg_path.write_text("\n".join(out) + "\n", encoding="utf-8")


def _clean_release_workspace() -> None:
    """Limpieza agresiva para release desde cero (sin reutilizar artefactos previos)."""
    targets = [
        ROOT / "web_monitor" / ".venv-build",
        ROOT / "web_monitor" / "dist",
        ROOT / "web_monitor" / "build",
        ROOT / "web_monitor_version",
        ROOT / "tool_plugins" / "dist",
        ROOT / "tool_plugins" / "python" / ".venv-build",
        ROOT / "tool_plugins" / "python" / "dist",
        ROOT / "tool_plugins" / "js" / "dist",
    ]
    for p in targets:
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)


def _pick_free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return int(s.getsockname()[1])


def _write_probe_config(base_cfg: Path, port: int) -> Path:
    text = base_cfg.read_text(encoding="utf-8")
    lines = text.splitlines()
    replaced = False
    out_lines: list[str] = []
    for ln in lines:
        if re.match(r"^\s*web_port\s*=", ln):
            out_lines.append(f"web_port = {port}")
            replaced = True
        else:
            out_lines.append(ln)
    if not replaced:
        out_lines.append(f"web_port = {port}")
    tmp = tempfile.NamedTemporaryFile("w", delete=False, suffix=".conf", encoding="utf-8")
    try:
        tmp.write("\n".join(out_lines) + "\n")
    finally:
        tmp.close()
    return Path(tmp.name)


def _probe_packaged_features(
    timeout_s: float = 20.0,
    *,
    require_parquet: bool = False,
) -> tuple[bool, str]:
    exe = ROOT / "web_monitor_version" / "bin" / "varmonitor-web"
    cfg = ROOT / "web_monitor_version" / "data" / "varmon.conf"
    if not exe.is_file():
        return False, f"No existe binario empaquetado: {exe}"
    if not cfg.is_file():
        return False, f"No existe config empaquetada: {cfg}"

    port = _pick_free_local_port()
    probe_cfg = _write_probe_config(cfg, port)
    env = os.environ.copy()
    env["VARMON_CONFIG"] = str(probe_cfg)
    proc: subprocess.Popen[str] | None = None
    url = f"http://127.0.0.1:{port}/api/plugins/features"
    deadline = time.time() + timeout_s
    last_err = "sin respuesta"
    try:
        proc = subprocess.Popen(
            [str(exe)],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            env=env,
        )
        while time.time() < deadline:
            if proc.poll() is not None:
                return False, f"El binario terminó prematuramente durante la validación (código {proc.returncode})."
            try:
                with urllib.request.urlopen(url, timeout=1.5) as resp:
                    if resp.status != 200:
                        last_err = f"HTTP {resp.status}"
                        time.sleep(0.2)
                        continue
                    data = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
                    feats = data.get("features")
                    if not isinstance(feats, list):
                        return False, "Respuesta inválida en /api/plugins/features (sin lista features)."
                    if "file_edit" not in feats:
                        return False, (
                            "Release generada sin plugin file_edit en runtime. "
                            f"features={sorted(str(x) for x in feats)}"
                        )
                    msg = f"OK runtime plugins en puerto {port}: {sorted(str(x) for x in feats)}"
                    if require_parquet:
                        if "parquet" not in feats:
                            return False, (
                                "Parquet estaba marcado en la GUI pero el plugin «parquet» no está registrado. "
                                f"features={sorted(str(x) for x in feats)}"
                            )
                        pc = data.get("parquet_capability")
                        if not isinstance(pc, dict):
                            return False, (
                                "Binario sin campo parquet_capability en /api/plugins/features "
                                "(reconstruya con backend actualizado)."
                            )
                        if not pc.get("pyarrow_ok"):
                            return False, f"Parquet: pyarrow no disponible en el binario: {pc}"
                        if not pc.get("recordings_parquet_module"):
                            return False, f"Parquet: módulo recordings_parquet no cargado: {pc}"
                        bl = pc.get("blockers") or []
                        if isinstance(bl, list) and bl:
                            msg += f" | parquet aviso blockers: {bl}"
                    return True, msg
            except urllib.error.URLError as e:
                last_err = str(e)
                time.sleep(0.25)
            except Exception as e:  # noqa: BLE001
                last_err = str(e)
                time.sleep(0.25)
        return False, f"Timeout validando /api/plugins/features en {url}: {last_err}"
    finally:
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        try:
            probe_cfg.unlink(missing_ok=True)
        except Exception:
            pass


def _setup_ttk_style() -> ttk.Style:
    st = ttk.Style()
    try:
        st.theme_use("clam")
    except tk.TclError:
        pass
    st.configure("App.TFrame", background=BG_APP)
    st.configure("Header.TLabel", background=BG_APP, foreground=TEXT_MAIN, font=("Segoe UI", 13, "bold"))
    st.configure("Sub.TLabel", background=BG_APP, foreground=TEXT_MUTED, font=("Segoe UI", 9))
    st.configure("Path.TLabel", background=BG_APP, foreground=TEXT_MUTED, font=("Consolas", 8))
    st.configure("Status.TLabel", background=BG_APP, foreground=TEXT_MAIN, font=("Segoe UI", 9))
    st.configure("TNotebook", background=BG_APP, borderwidth=0)
    st.configure("TNotebook.Tab", padding=(14, 8), font=("Segoe UI", 10))
    st.configure("TButton", font=("Segoe UI", 10), padding=(14, 8))
    st.configure("Accent.TButton", font=("Segoe UI", 10, "bold"), padding=(16, 9))
    st.map("Accent.TButton", background=[("active", "#1d4ed8")])
    try:
        st.configure("Accent.TButton", background="#2563eb", foreground="white")
    except tk.TclError:
        st.configure("Accent.TButton", background="#2563eb")
    st.configure("Horizontal.TProgressbar", thickness=8)
    return st


def _add_option_row(parent: tk.Widget, label: str, var: tk.BooleanVar) -> None:
    """Fila tipo tarjeta: banda de color + etiqueta Incluido/Excluido + checkbox con selectcolor verde."""
    row = tk.Frame(parent, bg=BG_CARD_OFF, highlightthickness=1, highlightbackground=BORDER_CARD)
    row.pack(fill=tk.X, pady=4, padx=2)

    stripe = tk.Frame(row, width=5, bg="#94a3b8")
    stripe.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 10), pady=0)

    inner = tk.Frame(row, bg=BG_CARD_OFF)
    inner.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(0, 10), pady=8)

    badge = tk.Label(inner, text="", font=("Segoe UI", 8, "bold"), bg=BG_CARD_OFF)
    badge.pack(anchor=tk.W)

    cb = tk.Checkbutton(
        inner,
        text=label,
        variable=var,
        font=("Segoe UI", 10),
        fg=TEXT_MAIN,
        anchor=tk.W,
        highlightthickness=0,
        selectcolor=ACCENT_ON,
        indicatoron=True,
    )

    def sync(*_a: Any) -> None:
        on = var.get()
        bg = ACCENT_ON_LIGHT if on else BG_CARD_OFF
        stripe_bg = ACCENT_ON if on else "#94a3b8"
        row.configure(bg=bg, highlightbackground=(ACCENT_ON if on else BORDER_CARD))
        stripe.configure(bg=stripe_bg)
        inner.configure(bg=bg)
        badge.configure(
            text="Incluido" if on else "Excluido",
            fg=ACCENT_ON if on else TEXT_MUTED,
            bg=bg,
        )
        cb.configure(
            bg=bg,
            activebackground=bg,
            activeforeground=TEXT_MAIN,
            selectcolor=ACCENT_ON,
        )

    cb.config(command=sync)
    cb.pack(anchor=tk.W, fill=tk.X)
    try:
        var.trace_add("write", lambda *_: sync())
    except AttributeError:
        var.trace("w", lambda *_: sync())
    sync()


class App:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title(
            "VarMonitor — empaquetado de plugins"
            if HAS_TOOL_PLUGINS
            else "VarMonitor — empaquetado web_monitor_version"
        )
        self.root.minsize(1020 if HAS_TOOL_PLUGINS else 720, 480)
        self.root.configure(bg=BG_APP)

        self._vars: dict[str, dict[str, tk.BooleanVar]] = {
            "ids": {},
            "hooks": {},
            "ui": {},
            "build": {},
        }
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._busy = False

        _setup_ttk_style()

        if not verify_root():
            messagebox.showerror(
                "Error",
                f"No se encontró el repositorio esperado junto a:\n{ROOT}",
            )
            self.root.after(100, self.root.destroy)
            return

        outer = ttk.Frame(self.root, style="App.TFrame", padding=12)
        outer.grid(row=0, column=0, sticky=tk.NSEW)
        self.root.grid_rowconfigure(0, weight=1)
        self.root.grid_columnconfigure(0, weight=1)

        header = ttk.Frame(outer, style="App.TFrame")
        _hspan = 3 if HAS_TOOL_PLUGINS else 2
        header.grid(row=0, column=0, columnspan=_hspan, sticky=tk.EW, pady=(0, 8))
        ttk.Label(
            header,
            text=(
                "Plugins y entrega web_monitor_version"
                if HAS_TOOL_PLUGINS
                else "Entrega web_monitor_version"
            ),
            style="Header.TLabel",
        ).pack(anchor=tk.W)
        ttk.Label(
            header,
            text=(
                "Wheel + bundle JS; izquierda: opciones. Centro: módulos Pro. Derecha: salida."
                if HAS_TOOL_PLUGINS
                else "Izquierda: opciones de empaquetado. Derecha: acciones y registro de salida."
            ),
            style="Sub.TLabel",
        ).pack(anchor=tk.W, pady=(2, 0))
        ttk.Label(header, text=str(ROOT), style="Path.TLabel").pack(anchor=tk.W, pady=(4, 0))

        col_left = ttk.LabelFrame(outer, text="Opciones de build", padding=8)
        col_mid = ttk.Frame(outer, style="App.TFrame")
        col_right = ttk.LabelFrame(outer, text="Salida (últimas líneas)", padding=4)
        col_left.grid(row=1, column=0, sticky=tk.NSEW, padx=(0, 8))
        if HAS_TOOL_PLUGINS:
            col_mid.grid(row=1, column=1, sticky=tk.NSEW, padx=(0, 8))
            col_right.grid(row=1, column=2, sticky=tk.NSEW)
        else:
            col_right.grid(row=1, column=1, sticky=tk.NSEW)
        outer.grid_rowconfigure(1, weight=1)
        outer.grid_columnconfigure(0, weight=0, minsize=300)
        if HAS_TOOL_PLUGINS:
            outer.grid_columnconfigure(1, weight=1, minsize=320)
            outer.grid_columnconfigure(2, weight=2, minsize=360)
        else:
            outer.grid_columnconfigure(1, weight=2, minsize=400)

        self._var_full_package = tk.BooleanVar(value=True)
        self._cb_full_package = ttk.Checkbutton(
            col_left,
            text="Entrega final (CMake + PyInstaller → web_monitor_version/)",
            variable=self._var_full_package,
        )
        self._cb_full_package.pack(
            anchor=tk.W,
            pady=(0, 8) if not HAS_TOOL_PLUGINS else (0, 0),
        )
        if HAS_TOOL_PLUGINS:
            ttk.Label(
                col_left,
                text="Desmarcar: solo build local (wheel + JS), sin empaquetado.",
                style="Sub.TLabel",
                wraplength=280,
            ).pack(anchor=tk.W, pady=(2, 8))

        self._var_prepare_venv = tk.BooleanVar(value=True)
        self._cb_prepare_venv = ttk.Checkbutton(
            col_left,
            text="Preparar web_monitor/.venv + pip install -r requirements.txt",
            variable=self._var_prepare_venv,
        )
        self._cb_prepare_venv.pack(anchor=tk.W)
        ttk.Label(
            col_left,
            text="Más lento; desmarcar si el venv ya está listo.",
            style="Sub.TLabel",
            wraplength=280,
        ).pack(anchor=tk.W, pady=(2, 8))

        self._var_clean_static_artifacts = tk.BooleanVar(value=HAS_TOOL_PLUGINS)
        self._cb_clean_static_artifacts = ttk.Checkbutton(
            col_left,
            text="Vaciar static/plugins y static/dist antes del build",
            variable=self._var_clean_static_artifacts,
        )
        if HAS_TOOL_PLUGINS:
            self._cb_clean_static_artifacts.pack(anchor=tk.W)
            ttk.Label(
                col_left,
                text="Recomendado. Mantiene static/js/modules canónico.",
                style="Sub.TLabel",
                wraplength=280,
            ).pack(anchor=tk.W, pady=(2, 8))

        self._var_wipe_web_static = tk.BooleanVar(value=False)
        self._cb_wipe_web_static = ttk.Checkbutton(
            col_left,
            text="Solicitar borrado total de web_monitor/static (si no hay FORCE, usa limpieza segura)",
            variable=self._var_wipe_web_static,
        )
        if HAS_TOOL_PLUGINS:
            self._cb_wipe_web_static.pack(anchor=tk.W)
            ttk.Label(
                col_left,
                text="Compatibilidad build: por defecto limpia plugins/js/modules/dist. Borrado total real solo con FORCE.",
                style="Sub.TLabel",
                wraplength=280,
            ).pack(anchor=tk.W, pady=(2, 8))

        sel_build = load_selection()
        build_frame = ttk.LabelFrame(col_left, text="C++ (solo entrega final)", padding=6)
        build_frame.pack(fill=tk.X, pady=(4, 0))
        for key in DEFAULTS["build"]:
            if key == "corenexus" and not HAS_CORENEXUS:
                continue
            var = tk.BooleanVar(value=bool(sel_build.get("build", {}).get(key, DEFAULTS["build"][key])))
            self._vars["build"][key] = var
            _add_option_row(build_frame, LABELS.get(key, key), var)

        control_parent = col_mid if HAS_TOOL_PLUGINS else col_right
        if not HAS_TOOL_PLUGINS:
            ctrl_wrap = ttk.Frame(control_parent, style="App.TFrame", padding=(0, 0, 0, 8))
            ctrl_wrap.pack(fill=tk.X, side=tk.TOP)

        nb: ttk.Notebook | None = None
        if HAS_TOOL_PLUGINS:
            nb = ttk.Notebook(col_mid)
            for sec, tab_title in (
                ("ids", TAB_TITLES["ids"]),
                ("hooks", TAB_TITLES["hooks"]),
                ("ui", TAB_TITLES["ui"]),
            ):
                tab_outer = tk.Frame(nb, bg=BG_APP)
                nb.add(tab_outer, text=tab_title)
                canvas = tk.Canvas(tab_outer, bg=BG_APP, highlightthickness=0, borderwidth=0)
                scroll_y = ttk.Scrollbar(tab_outer, orient=tk.VERTICAL, command=canvas.yview)
                tab = tk.Frame(canvas, bg=BG_APP)
                inner_win = canvas.create_window((0, 0), window=tab, anchor=tk.NW)

                def _on_tab_configure(_event: tk.Event, c=canvas) -> None:
                    c.configure(scrollregion=c.bbox("all"))

                def _on_canvas_configure(event: tk.Event, c=canvas, wid=inner_win) -> None:
                    c.itemconfigure(wid, width=event.width)

                tab.bind("<Configure>", _on_tab_configure)
                canvas.bind("<Configure>", _on_canvas_configure)
                canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
                scroll_y.pack(side=tk.RIGHT, fill=tk.Y)
                canvas.configure(yscrollcommand=scroll_y.set)

                def _wheel(event: tk.Event, c=canvas) -> str | None:
                    if event.delta:
                        c.yview_scroll(int(-event.delta / 120), "units")
                    return "break"

                def _wheel_linux_up(_event: tk.Event, c=canvas) -> None:
                    c.yview_scroll(-3, "units")

                def _wheel_linux_down(_event: tk.Event, c=canvas) -> None:
                    c.yview_scroll(3, "units")

                canvas.bind("<MouseWheel>", _wheel)
                canvas.bind("<Button-4>", _wheel_linux_up)
                canvas.bind("<Button-5>", _wheel_linux_down)

                data = load_selection()[sec]
                for key in DEFAULTS[sec]:
                    var = tk.BooleanVar(value=data.get(key, DEFAULTS[sec][key]))
                    self._vars[sec][key] = var
                    label = LABELS.get(key, key)
                    _add_option_row(tab, label, var)

        btn_parent = col_mid if HAS_TOOL_PLUGINS else ctrl_wrap
        btn_row = ttk.Frame(btn_parent, style="App.TFrame")
        self._btn_save: ttk.Button | None = None
        if HAS_TOOL_PLUGINS:
            self._btn_save = ttk.Button(btn_row, text="Guardar selección", command=self._save_only)
            self._btn_save.pack(side=tk.LEFT, padx=(0, 10))
        self._btn_deploy = ttk.Button(btn_row, text="Build y desplegar", command=self._deploy, style="Accent.TButton")
        self._btn_deploy.pack(side=tk.LEFT)

        status_parent = col_mid if HAS_TOOL_PLUGINS else ctrl_wrap
        self._status = ttk.Label(status_parent, text="Listo.", style="Status.TLabel")
        self._progress = ttk.Progressbar(status_parent, mode="determinate", maximum=6, length=200)
        self._progress["value"] = 0

        self._status.pack(side=tk.BOTTOM, fill=tk.X, pady=(4, 0))
        self._progress.pack(side=tk.BOTTOM, fill=tk.X, pady=(4, 0))
        btn_row.pack(side=tk.BOTTOM, fill=tk.X, pady=(0, 6))
        if nb is not None:
            nb.pack(side=tk.TOP, fill=tk.BOTH, expand=True)

        log_frame = tk.Frame(col_right, bg=BORDER_CARD, padx=1, pady=1)
        log_frame.pack(fill=tk.BOTH, expand=True)
        self._log = scrolledtext.ScrolledText(
            log_frame,
            height=12,
            state=tk.DISABLED,
            wrap=tk.WORD,
            font=("Consolas", 9),
            bg="#f1f5f9",
            fg=TEXT_MAIN,
            insertbackground=TEXT_MAIN,
            relief=tk.FLAT,
        )
        self._log.pack(fill=tk.BOTH, expand=True, padx=6, pady=6)

        self.root.after(150, self._poll_queue)

    def _append_log(self, text: str) -> None:
        self._log.configure(state=tk.NORMAL)
        self._log.delete("1.0", tk.END)
        self._log.insert(tk.END, text)
        self._log.configure(state=tk.DISABLED)

    def _selection_dict(self) -> dict[str, dict[str, bool]]:
        if HAS_TOOL_PLUGINS:
            ids = {k: self._vars["ids"][k].get() for k in DEFAULTS["ids"]}
            hooks = {k: self._vars["hooks"][k].get() for k in DEFAULTS["hooks"]}
            ui = {k: self._vars["ui"][k].get() for k in DEFAULTS["ui"]}
        else:
            ids = {k: False for k in DEFAULTS["ids"]}
            hooks = {k: False for k in DEFAULTS["hooks"]}
            ui = {k: False for k in DEFAULTS["ui"]}
        build: dict[str, bool] = {}
        for k in DEFAULTS["build"]:
            if k in self._vars["build"]:
                build[k] = self._vars["build"][k].get()
            else:
                build[k] = False
        return {"ids": ids, "hooks": hooks, "ui": ui, "build": build}

    def _save_only(self) -> None:
        if self._busy:
            return
        SELECTION_PATH.parent.mkdir(parents=True, exist_ok=True)
        SELECTION_PATH.write_text(
            json.dumps(self._selection_dict(), indent=2) + "\n",
            encoding="utf-8",
        )
        self._status.configure(text=f"Guardado: {SELECTION_PATH}")
        messagebox.showinfo("Guardado", str(SELECTION_PATH))

    def _set_busy(self, busy: bool) -> None:
        self._busy = busy
        state = tk.DISABLED if busy else tk.NORMAL
        if self._btn_save is not None:
            self._btn_save.configure(state=state)
        self._btn_deploy.configure(state=state)
        self._cb_full_package.configure(state=tk.DISABLED if busy else tk.NORMAL)
        self._cb_prepare_venv.configure(state=state)
        if HAS_TOOL_PLUGINS:
            self._cb_clean_static_artifacts.configure(state=state)
            self._cb_wipe_web_static.configure(state=state)

    def _deploy(self) -> None:
        if self._busy:
            return
        self._set_busy(True)
        self._progress["value"] = 0
        do_full = self._var_full_package.get()
        prepare_venv = self._var_prepare_venv.get()
        cnx_var = self._vars["build"].get("corenexus")
        want_cnx = bool(cnx_var and cnx_var.get())
        # Pasos advance(): full sin venv=5, con venv=6; local sin venv=3, con venv=4;
        # +1 si instalar deps MAVLink para corenexus.
        if do_full:
            base_max = 6 if prepare_venv else 5
        else:
            base_max = 4 if prepare_venv else 3
        if want_cnx:
            base_max += 1
        self._progress["maximum"] = base_max
        self._status.configure(text="Trabajando…")
        self._append_log("")

        do_full_package = do_full

        def worker() -> None:
            try:
                doc = self._selection_dict()
                p = 0

                def advance() -> None:
                    nonlocal p
                    p += 1
                    self._queue.put(("progress", p))

                if do_full_package:
                    self._queue.put(("status", "Limpiando artefactos previos (release desde cero)…"))
                    _clean_release_workspace()

                if prepare_venv:
                    self._queue.put(("status", "Preparando web_monitor/.venv (venv + requirements.txt)…"))
                    code_venv, tail_venv = _prepare_web_monitor_venv()
                    self._queue.put(("log", tail_venv))
                    if code_venv != 0:
                        self._queue.put(
                            ("error", ("Entorno web_monitor/.venv", f"Código {code_venv}\n\n{tail_venv}")),
                        )
                        return
                    advance()

                if isinstance(doc.get("build"), dict) and doc["build"].get("corenexus"):
                    self._queue.put(
                        ("status", "Instalando dependencias MAVLink (pymavlink/lxml) para CoreNexus…"),
                    )
                    code_mx, tail_mx = _install_corenexus_mavlink_deps()
                    self._queue.put(("log", tail_mx))
                    if code_mx != 0:
                        self._queue.put(
                            (
                                "error",
                                (
                                    "Dependencias CoreNexus (MAVLink)",
                                    f"Código {code_mx}\n\n{tail_mx}",
                                ),
                            ),
                        )
                        return
                    advance()

                self._queue.put(("status", "Escribiendo plugin-selection.json…"))
                SELECTION_PATH.parent.mkdir(parents=True, exist_ok=True)
                SELECTION_PATH.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
                advance()

                want_pq = bool(doc.get("ids", {}).get("parquet")) if HAS_TOOL_PLUGINS else False
                wheel: Path | None = None
                if HAS_TOOL_PLUGINS:
                    self._queue.put(("status", "Ejecutando build_all.sh (puede tardar varios minutos)…"))
                    build_env: dict[str, str] = {}
                    if self._var_wipe_web_static.get():
                        build_env["VARMON_GUI_WIPE_WEB_STATIC"] = "1"
                    elif self._var_clean_static_artifacts.get():
                        build_env["VARMON_CLEAN_STATIC_ARTIFACTS"] = "1"
                    code, tail = run_bash("tool_plugins/scripts/build_all.sh", extra_env=build_env or None)
                    self._queue.put(("log", tail))
                    if code != 0:
                        self._queue.put(("error", ("build_all.sh", f"Código {code}\n\n{tail}")))
                        return
                    warn_oss = _client_oss_missing_warning()
                    if warn_oss:
                        self._queue.put(("log", warn_oss))
                    advance()

                    wheel, err = _latest_valid_dist_wheel(require_parquet=want_pq)
                    if wheel is None:
                        self._queue.put(("error", ("Wheel Pro inválida", err)))
                        return

                    self._queue.put(
                        ("status", f"Reinstalando wheel en web_monitor/.venv: {wheel.name}…"),
                    )
                    code_pip, tail_pip = _reinstall_fresh_wheel_into_web_venv(wheel)
                    self._queue.put(("log", tail_pip))
                    if code_pip != 0:
                        self._queue.put(
                            ("error", ("pip install wheel → web_monitor/.venv", f"Código {code_pip}\n\n{tail_pip}")),
                        )
                        return
                    advance()
                else:
                    self._queue.put(
                        (
                            "log",
                            "[gui_plugins_deploy] tool_plugins no está presente: se genera entrega limpia sin plugins.",
                        ),
                    )
                    advance()

                if not do_full_package:
                    self._queue.put(("status", "Hecho (solo build de plugins; sin web_monitor_version)."))
                    self._queue.put(("done_local", None))
                    return

                self._queue.put(("status", "Ejecutando generate_webmonitor_version.sh (CMake + PyInstaller)…"))
                env = {"VARMON_RELEASE_CLEAN": "1"}
                if HAS_TOOL_PLUGINS and wheel is not None:
                    env["VARMON_PLUGINS_RELEASE"] = "1"
                    # Ruta absoluta a la wheel recién validada (misma que se acaba de instalar en .venv).
                    env["VARMON_PLUGINS_WHEEL"] = str(wheel.resolve())
                else:
                    env["VARMON_PLUGINS_RELEASE"] = "0"
                bsel = doc.get("build")
                if isinstance(bsel, dict):
                    if bsel.get("demo_server"):
                        env["VARMON_BUILD_DEMO_SERVER"] = "1"
                    if bsel.get("corenexus"):
                        env["VARMON_BUILD_CORENEXUS"] = "1"
                        py_cnx = _python_for_corenexus_mavlink_deps()
                        if py_cnx is not None:
                            env["VARMON_PYTHON3"] = str(py_cnx.resolve())
                code, tail = run_bash("scripts/varmon/generate_webmonitor_version.sh", extra_env=env)
                self._queue.put(("log", tail))
                if code != 0:
                    self._queue.put(("error", ("generate_webmonitor_version.sh", f"Código {code}\n\n{tail}")))
                    return
                advance()

                if want_pq:
                    self._queue.put(("status", "Activando parquet_recording_allowed en la entrega data/varmon.conf…"))
                    _ensure_shipped_conf_parquet_enabled()

                if HAS_TOOL_PLUGINS:
                    self._queue.put(("status", "Validando runtime empaquetado (/api/plugins/features)…"))
                    ok_probe, msg_probe = _probe_packaged_features(require_parquet=want_pq)
                    if not ok_probe:
                        self._queue.put(("error", ("Validación post-build", msg_probe)))
                        return
                    self._queue.put(("log", msg_probe))
                else:
                    self._queue.put(
                        ("log", "[gui_plugins_deploy] Validación de plugins omitida (entrega clean sin tool_plugins)."),
                    )

                advance()
                self._queue.put(("status", "Hecho. Salida: web_monitor_version/{bin,data,include}/"))
                self._queue.put(("done", None))
            except Exception as ex:  # noqa: BLE001
                self._queue.put(("error", ("Error", str(ex))))

        threading.Thread(target=worker, daemon=True).start()

    def _poll_queue(self) -> None:
        try:
            while True:
                kind, payload = self._queue.get_nowait()
                if kind == "progress":
                    self._progress["value"] = int(payload)
                elif kind == "status":
                    self._status.configure(text=str(payload))
                elif kind == "log":
                    self._append_log(str(payload))
                elif kind == "error":
                    title, msg = payload
                    messagebox.showerror(title, msg[:8000])
                    self._status.configure(text="Error.")
                    self._progress["value"] = 0
                    self._set_busy(False)
                elif kind == "done_local":
                    self._set_busy(False)
                    messagebox.showinfo(
                        "Build (local)",
                        "Completado: wheel, bundle JS y sincronización a web_monitor/static/plugins/\n"
                        "(copy_to_mit al final de build_all.sh).\n"
                        "La wheel generada se ha reinstalado en web_monitor/.venv (python -m pip --force-reinstall --no-cache-dir).\n"
                        "No se ha ejecutado generate_webmonitor_version (sin CMake/PyInstaller ni carpeta web_monitor_version).",
                    )
                elif kind == "done":
                    self._set_busy(False)
                    messagebox.showinfo(
                        "Despliegue",
                        f"Completado.\nEntrega: {ROOT / 'web_monitor_version'}\n"
                        f"(bin/, data/, include/, libvarmonitor.so)",
                    )
        except queue.Empty:
            pass
        self.root.after(200, self._poll_queue)

    def run(self) -> None:
        self.root.mainloop()


def main() -> int:
    if not verify_root():
        print(f"ERROR: raíz de repo no válida: {ROOT}", file=sys.stderr)
        return 1
    App().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
