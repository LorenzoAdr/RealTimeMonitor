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
if [[ ! -x "$PY" ]]; then
    python3 -m venv "$VENV"
fi
"$PIP" install -q -r requirements-docker.txt -r requirements-build.txt
"$PY" -m PyInstaller --clean --noconfirm varmonitor-web.spec
echo "Listo: $WM/dist/varmonitor-web"
ls -la "$WM/dist/varmonitor-web" 2>/dev/null || ls -la "$WM/dist/"
