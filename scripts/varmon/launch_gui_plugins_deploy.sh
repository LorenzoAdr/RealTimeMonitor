#!/usr/bin/env bash
# Lanza la GUI de selección de plugins y empaquetado (gui_plugins_deploy.py).
# Entorno: scripts/config.sh + venv de web_monitor si existe.
#
# Uso: ./scripts/varmon/launch_gui_plugins_deploy.sh
# Requisito opcional: python3-tk (sudo apt install python3-tk)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/config.sh"

pick_python() {
  if [[ -x "$ROOT/web_monitor/.venv/bin/python3" ]]; then
    echo "$ROOT/web_monitor/.venv/bin/python3"
    return
  fi
  if [[ -x "$ROOT/web_monitor/.venv/bin/python" ]]; then
    echo "$ROOT/web_monitor/.venv/bin/python"
    return
  fi
  command -v python3 || true
}

ensure_mavlink_deps() {
  local py="$1"
  local req="$ROOT/CoreNexus/requirements-mavlink.txt"
  [[ -x "$py" ]] || return 0
  [[ -f "$req" ]] || return 0
  if "$py" -c "import pymavlink, lxml" >/dev/null 2>&1; then
    return 0
  fi
  echo "[launch_gui_plugins_deploy] Instalando pymavlink/lxml en $py ..." >&2
  "$py" -m pip install -r "$req"
}

GUI_PY="$(pick_python)"
if [[ -z "$GUI_PY" ]]; then
  echo "[launch_gui_plugins_deploy] No se encontró python3 en PATH." >&2
  exit 1
fi
export VARMON_PYTHON3="$GUI_PY"
ensure_mavlink_deps "$GUI_PY"
exec "$GUI_PY" "$ROOT/scripts/varmon/gui_plugins_deploy.py" "$@"
