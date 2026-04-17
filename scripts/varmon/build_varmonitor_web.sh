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
PIP="$VENV/bin/pip"
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
"$PIP" install -q -r requirements-docker.txt -r requirements-build.txt
if [[ "${VARMON_PLUGINS_RELEASE:-0}" == "1" ]]; then
    "$PIP" install -q -r requirements-plugins-release.txt
    if [[ -z "${VARMON_PLUGINS_WHEEL:-}" || ! -f "$VARMON_PLUGINS_WHEEL" ]]; then
        echo "[build_varmonitor_web] VARMON_PLUGINS_RELEASE=1 requiere VARMON_PLUGINS_WHEEL apuntando a un .whl existente." >&2
        exit 1
    fi
    echo "[build_varmonitor_web] Instalando wheel de plugins: $VARMON_PLUGINS_WHEEL" >&2
    "$PIP" install -q --force-reinstall "$VARMON_PLUGINS_WHEEL"
    # Falla temprano si el entorno de build no tiene los módulos Pro esperados.
    "$PY" - <<'PY'
import importlib.util
import sys

required = [
    "varmonitor_plugins",
    "varmonitor_plugins.gdb_debug",
    "varmonitor_plugins.terminal_api",
    "varmonitor_plugins.pro_http",
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
print("[build_varmonitor_web] OK: módulos Pro detectados en .venv-build", file=sys.stderr)
PY
fi
export VARMON_PLUGINS_RELEASE="${VARMON_PLUGINS_RELEASE:-0}"
"$PY" -m PyInstaller --clean --noconfirm varmonitor-web.spec
echo "Listo: $WM/dist/varmonitor-web"
ls -la "$WM/dist/varmonitor-web" 2>/dev/null || ls -la "$WM/dist/"
