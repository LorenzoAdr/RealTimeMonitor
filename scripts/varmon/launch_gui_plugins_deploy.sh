#!/usr/bin/env bash
# Lanza la GUI de selección de plugins y empaquetado (gui_plugins_deploy.py).
# Entorno: scripts/simple_config.sh + venv de web_monitor si existe.
#
# Uso: ./scripts/varmon/launch_gui_plugins_deploy.sh
# Requisito opcional: python3-tk (sudo apt install python3-tk)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/simple_config.sh"

VENV_PY="$ROOT/web_monitor/.venv/bin/python3"
if [[ -x "$VENV_PY" ]]; then
  exec "$VENV_PY" "$ROOT/scripts/varmon/gui_plugins_deploy.py" "$@"
fi

if [[ -x "$ROOT/web_monitor/.venv/bin/python" ]]; then
  exec "$ROOT/web_monitor/.venv/bin/python" "$ROOT/scripts/varmon/gui_plugins_deploy.py" "$@"
fi

exec python3 "$ROOT/scripts/varmon/gui_plugins_deploy.py" "$@"
