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
fi
export VARMON_PLUGINS_RELEASE="${VARMON_PLUGINS_RELEASE:-0}"
"$PY" -m PyInstaller --clean --noconfirm varmonitor-web.spec
echo "Listo: $WM/dist/varmonitor-web"
ls -la "$WM/dist/varmonitor-web" 2>/dev/null || ls -la "$WM/dist/"
