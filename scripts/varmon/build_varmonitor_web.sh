#!/usr/bin/env bash
# Empaqueta web_monitor/app.py en un único binario (PyInstaller onefile).
# Ejecutar en la misma familia de SO/arquitectura que el destino (p. ej. Linux x86_64).
# Config: scripts/simple_config.sh
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"
set -euo pipefail
WM="$ROOT/web_monitor"
VENV="$WM/.venv-build"
PY="$VENV/bin/python"
cd "$WM"
if [[ "${VARMON_RELEASE_CLEAN:-0}" == "1" ]]; then
    echo "[build_varmonitor_web] VARMON_RELEASE_CLEAN=1: limpiando .venv-build y dist para build desde cero." >&2
    rm -rf "$VENV" "$WM/dist" "$WM/build"
fi
for req in requirements-docker.txt requirements-build.txt; do
    if [[ ! -f "$req" ]]; then
        echo "[build_varmonitor_web] No se encuentra $WM/$req (¿repo incompleto o ruta distinta?)" >&2
        exit 1
    fi
done
if [[ "${VARMON_PLUGINS_RELEASE:-0}" == "1" ]]; then
    if [[ ! -f requirements-plugins-release.txt ]]; then
        echo "[build_varmonitor_web] Falta requirements-plugins-release.txt" >&2
        exit 1
    fi
fi
if [[ ! -x "$PY" ]]; then
    python3 -m venv "$VENV"
fi
"$PY" -m pip install -q -r requirements-docker.txt -r requirements-build.txt
if [[ "${VARMON_PLUGINS_RELEASE:-0}" == "1" ]]; then
    "$PY" -m pip install -q -r requirements-plugins-release.txt
    if [[ -z "${VARMON_PLUGINS_WHEEL:-}" || ! -f "$VARMON_PLUGINS_WHEEL" ]]; then
        echo "[build_varmonitor_web] VARMON_PLUGINS_RELEASE=1 requiere VARMON_PLUGINS_WHEEL apuntando a un .whl existente." >&2
        exit 1
    fi
    echo "[build_varmonitor_web] Desinstalando distribuciones previas (varmonitor-plugins / varmonitor-pro)…" >&2
    "$PY" -m pip uninstall -y varmonitor-plugins varmonitor-pro 2>/dev/null || true
    echo "[build_varmonitor_web] Borrando restos en site-packages (evita dist-info parcial)…" >&2
    "$PY" - <<'PY'
import shutil
from pathlib import Path
import site

sp = Path(site.getsitepackages()[0])
for name in ("varmonitor_plugins", "varmonitor_pro"):
    p = sp / name
    if p.is_dir():
        shutil.rmtree(p, ignore_errors=True)
        print("removed", p)
for pat in ("varmonitor_plugins-*.dist-info", "varmonitor_pro-*.dist-info"):
    for p in sp.glob(pat):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
            print("removed", p)
PY
    echo "[build_varmonitor_web] Instalando wheel de plugins (sin caché pip): $VARMON_PLUGINS_WHEEL" >&2
    "$PY" -m pip install -q --force-reinstall --no-cache-dir "$VARMON_PLUGINS_WHEEL"
    # Falla temprano si el entorno de build no tiene los módulos Pro esperados (incl. Parquet para release).
    "$PY" - <<'PY'
import importlib.util
import sys

required = [
    "varmonitor_plugins",
    "varmonitor_plugins.gdb_debug",
    "varmonitor_plugins.terminal_api",
    "varmonitor_plugins.pro_http",
    "varmonitor_plugins.recordings_parquet",
]
missing = [m for m in required if importlib.util.find_spec(m) is None]
if missing:
    print(
        "[build_varmonitor_web] ERROR: faltan módulos Pro en .venv-build tras instalar el wheel:",
        ", ".join(missing),
        file=sys.stderr,
    )
    print(
        "[build_varmonitor_web] Sugerencia: reconstruir wheel en tool_plugins/dist y pasar VARMON_PLUGINS_WHEEL explícito.",
        file=sys.stderr,
    )
    raise SystemExit(1)
try:
    import pyarrow  # noqa: F401
except ImportError:
    print(
        "[build_varmonitor_web] ERROR: pyarrow no importable en .venv-build (release Pro requiere Parquet).",
        file=sys.stderr,
    )
    print(
        "[build_varmonitor_web] Instale: pip install -r requirements-plugins-release.txt",
        file=sys.stderr,
    )
    raise SystemExit(1) from None
print("[build_varmonitor_web] OK: módulos Pro + pyarrow en .venv-build", file=sys.stderr)
PY
fi
export VARMON_PLUGINS_RELEASE="${VARMON_PLUGINS_RELEASE:-0}"
"$PY" -m PyInstaller --clean --noconfirm varmonitor-web.spec
echo "Listo: $WM/dist/varmonitor-web"
ls -la "$WM/dist/varmonitor-web" 2>/dev/null || ls -la "$WM/dist/"
